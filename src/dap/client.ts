// A focused Debug Adapter Protocol (DAP) client over stdio.
//
// Why hand-rolled: DAP is NOT JSON-RPC. Its envelope is
//   { seq, type:"request",  command, arguments }
//   { seq, type:"response", request_seq, success, body?, message? }
//   { seq, type:"event",    event, body }
// which differs from JSON-RPC's method/params/id/result/error. So we can't
// reuse vscode-jsonrpc's MessageConnection (lspx does, because LSP *is*
// JSON-RPC 2.0). The framing itself is the same Content-Length header
// scheme, so a ~40-line reader/writer covers the whole wire layer.
//
// One instance owns exactly one debug-adapter subprocess (debugpy-adapter,
// `dlv dap`, lldb-dap, …) and exposes the requests an agent needs:
//   initialize / launch / attach / disconnect / configurationDone
//   setBreakpoints / setFunctionBreakpoints / setExceptionBreakpoints
//   continue / next / stepIn / stepOut / stepBack / pause
//   threads / stackTrace / scopes / variables / evaluate
//
// Events (stopped, continued, terminated, exited, output, breakpoint,
// initialized, thread) are delivered to registered listeners; the session
// layer (../daemon/session.ts) uses them for run-until-stop + state.
//
// No hard kill-timeouts: connect/spawn errors are immediate; the caller's
// own timeout (e.g. the bash tool) governs slow requests.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, type Socket } from "node:net";
import { pickFreePort } from "../util.ts";
import type {
  Capabilities,
  InitializeArgs,
  LaunchArgs,
  AttachArgs,
  SetBreakpointsArgs,
  SetBreakpointsResponse,
  StackTraceArgs,
  StackTraceResponse,
  ScopesResponse,
  VariablesArgs,
  VariablesResponse,
  EvaluateResponse,
  SetVariableArgs,
  SetVariableResponse,
  SetFunctionBreakpointsArgs,
  SetFunctionBreakpointsResponse,
  BreakpointLocation,
} from "./types.ts";

export interface AdapterLaunch {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Workspace root, forwarded as cwd by default. */
  workspaceRoot: string;
  /** Override the spawned adapter process's working directory. Defaults to
   *  workspaceRoot. Some adapters (e.g. dlv) build in their process cwd, so
   *  the launch `cwd` alone isn't enough — the process must be spawned there. */
  cwd?: string;
  /** For adapters that use nested DAP sessions (vscode-js-debug): when true,
   *  the client declares `supportsStartDebuggingRequest` and handles the
   *  `startDebugging` reverse request by transparently starting a nested
   *  session on the same TCP server. The main session's `initialized` event
   *  is suppressed; the nested session's is emitted to handlers. */
  supportsStartDebugging?: boolean;
  /** "stdio" (default) speaks DAP over the child process's stdin/stdout.
   *  "tcp" spawns the adapter, waits for it to print a listening line
   *  (e.g. "Debug server listening at 127.0.0.1:PORT"), then connects a
   *  TCP socket and speaks DAP over it (vscode-js-debug, dlv).
   *  "tcp-allocate" is for adapters that take a --port arg and don't print a
   *  listening line: dbgx allocates a free port, substitutes `{port}` in
   *  args, and connects (probe-rs, perl-debug).
   *  "tcp-attach" is attach-only: dbgx does NOT spawn a process. The user
   *  starts the DAP server themselves (e.g. `godot --editor --dap-port`)
   *  and dbgx connects to {connectHost}:{connectPort} (godot-dap). */
  transport?: "stdio" | "tcp" | "tcp-allocate" | "tcp-attach";
  /** For tcp-attach: the host to connect to (default 127.0.0.1). */
  connectHost?: string;
  /** For tcp-attach: the port to connect to. Required for tcp-attach. */
  connectPort?: number;
  /** For adapters that need the program path on the command line (e.g.
   *  rdbg: `rdbg --open --port PORT -- ruby {program}`). Substituted into
   *  args alongside {port} in start(). Optional — most adapters receive the
   *  program via the DAP `launch` request, not as a CLI arg. */
  program?: string;
}

/** Minimal duplex transport the framing layer writes to and reads from.
 *  Implemented for both stdio (child pipes) and TCP (a net.Socket). */
interface DapTransport {
  write(data: string): void;
  /** Subscribe to incoming data. Returns a detach function. */
  onData(cb: (chunk: string) => void): () => void;
  onError(cb: (err: Error) => void): void;
  onEnd(cb: () => void): void;
  /** Close the underlying pipe/socket. */
  close(): void;
}

type Pending = {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
};

type EventHandler = (body: any) => void;

export class DapClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private transport: DapTransport | null = null;
  /** Detach handle for the active transport's data listener, so we can swap
   *  transports when entering a nested DAP session (vscode-js-debug). */
  private detachData: (() => void) | null = null;
  /** Optional DAP message logger (for debugging adapter exchanges). */
  onMessage?: (s: string) => void;

  private seq = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<EventHandler>>();
  private buffer = "";
  /** Resolves when the adapter process exits (the only true end-of-stream). */
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;

  // ---- Nested-session support (vscode-js-debug `startDebugging`) ----
  /** For TCP adapters, the host:port the adapter's listening line resolved to.
   *  A nested session connects here too. */
  private tcpServer: { host: string; port: number } | null = null;
  /** While non-null, `initialized` events are routed to this resolver instead
   *  of public handlers — used to drive the internal main→nested handoff. */
  private initializedSink: ((body: any) => void) | null = null;
  /** When true, the next `initialized` event is swallowed (not emitted to
   *  handlers). Set at start() for nested-session adapters so the main session's
   *  early `initialized` (js-debug fires it after `initialize`, before `launch`)
   *  doesn't prematurely wake the daemon's waitForInitialized(). */
  private swallowInitialized = false;
  /** Resolves with the next `startDebugging` reverse request's arguments. */
  private startDebuggingSink: ((args: any) => void) | null = null;
  /** The nested session's socket, tracked so dispose() can close it. */
  private nestedSocket: Socket | null = null;

  readonly rootUri: string;
  /** Capabilities reported by the adapter in its initialize response. */
  capabilities: Capabilities | null = null;

  constructor(private adapterLaunch: AdapterLaunch) {
    this.rootUri = adapterLaunch.workspaceRoot;
  }

  /** Spawn the adapter subprocess and begin reading framed messages. For
   *  TCP adapters, spawns the process, waits for it to print a listening
   *  line, then connects a TCP socket and reads frames from that instead.
   *  For tcp-allocate adapters, allocates a free port, substitutes `{port}`
   *  into args, and connects (the adapter doesn't report its port). */
  async start(onStderr?: (s: string) => void): Promise<void> {
    if (this.transport) return;
    let { command, args = [], env, workspaceRoot, cwd, transport: mode = "stdio" } = this.adapterLaunch;

    // tcp-attach: attach-only adapters. dbgx does NOT spawn a process — the
    // user starts the DAP server themselves (e.g. `godot --editor --dap-port`)
    // and dbgx connects to it. Bypass all the spawn/placeholder logic below.
    if (mode === "tcp-attach") {
      const host = this.adapterLaunch.connectHost ?? "127.0.0.1";
      const port = this.adapterLaunch.connectPort;
      if (!port) {
        throw new Error(
          `tcp-attach requires a port — pass --port <N> (or set defaultPort in the registry for this adapter)`,
        );
      }
      this.proc = null;
      this.exitPromise = null; // no child to watch; transport.onEnd covers teardown
      const sock = await this.retryConnect(host, port);
      this.transport = makeSocketTransport(sock);
      this.finishTransportSetup();
      return;
    }

    // Substitute {workspace} placeholder into args (e.g. godot --path {workspace}).
    // Done for all transport modes — {port} is added separately for tcp-allocate.
    if (workspaceRoot) {
      args = args.map((a) => a.replace("{workspace}", workspaceRoot));
    }

    if (mode === "tcp-allocate") {
      // Allocate a free TCP port: bind to :0, read the assigned port, close.
      const port = pickFreePort();
      // Substitute {port} and {program} placeholders into args (e.g. probe-rs
      // --port {port}, rdbg ... -- ruby {program}, godot --dap-port {port}).
      args = args.map((a) => a.replace("{port}", String(port)).replace("{program}", this.adapterLaunch.program ?? ""));
      this.tcpServer = { host: "127.0.0.1", port };
    } else if (this.adapterLaunch.program) {
      // stdio/tcp adapters may also use {program} (rare, but consistent).
      args = args.map((a) => a.replace("{program}", this.adapterLaunch.program!));
    }

    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cwd ?? workspaceRoot,
      env: { ...process.env, ...env },
    });
    this.exitPromise = new Promise((resolve) => {
      this.proc!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    this.proc.on("error", (err) => {
      for (const p of this.pending.values()) p.reject(new Error(`adapter error: ${err.message}`));
      this.pending.clear();
    });
    this.proc.stderr.setEncoding("utf-8");
    this.proc.stderr.on("data", (chunk: string) => onStderr?.(chunk));

    if (mode === "tcp") {
      // Wait for the adapter to print a listening line, parse host:port,
      // and connect a TCP socket to speak DAP over.
      const { host, port } = await this.waitForListening(this.proc!);
      this.tcpServer = { host, port };
      const sock = await this.connectTcp(host, port);
      this.transport = makeSocketTransport(sock);
    } else if (mode === "tcp-allocate") {
      // The adapter was spawned with our allocated port. Retry-connect: it may
      // take a moment to bind. (probe-rs prints a listening line on stderr
      // but doesn't report the port back, hence the pre-allocated port.)
      const sock = await this.retryConnect("127.0.0.1", this.tcpServer!.port);
      this.transport = makeSocketTransport(sock);
    } else {
      this.transport = makePipeTransport(this.proc);
    }
    this.finishTransportSetup();
  }

  /** Wire up the transport's data/error/end handlers after the transport is
   *  chosen. Shared by all spawn-based modes and the attach-only tcp-attach
   *  branch (which sets up its socket transport directly in start()). */
  private finishTransportSetup(): void {
    if (!this.transport) return;
    this.detachData = this.transport.onData((chunk: string) => this.onData(chunk));
    // For nested-session adapters (vscode-js-debug): swallow the main session's
    // `initialized` event. js-debug fires it after `initialize` (before `launch`),
    // and emitting it would let the daemon set breakpoints on the main session
    // (where they stay provisional). nestedHandoff re-emits the nested one instead.
    this.swallowInitialized = this.adapterLaunch.supportsStartDebugging ?? false;
    this.transport.onError((err) => {
      for (const p of this.pending.values()) p.reject(new Error(`transport error: ${err.message}`));
      this.pending.clear();
    });
    this.transport.onEnd(() => {
      for (const p of this.pending.values()) p.reject(new Error("adapter stream ended"));
      this.pending.clear();
    });
  }

  /** Retry-connect to a host:port with backoff, for tcp-allocate adapters
   *  that take a moment to bind after spawn. Times out after 20s. */
  private retryConnect(host: string, port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const tryConnect = () => {
        const sock = connect(port, host);
        sock.once("connect", () => resolve(sock));
        sock.once("error", () => {
          if (Date.now() > deadline) reject(new Error(`could not connect to adapter at ${host}:${port} within 20s`));
          else setTimeout(tryConnect, 100);
        });
      };
      tryConnect();
    });
  }

  /** Read the child's stdout until a "listening at <host>:<port>" line
   *  appears, then return the parsed endpoint. Times out after 20s. */
  private waitForListening(proc: ChildProcessWithoutNullStreams): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      let acc = "";
      const timer = setTimeout(() => {
        proc.stdout.removeAllListeners("data");
        reject(new Error("adapter did not print a listening line within 20s"));
      }, 20000);
      proc.stdout.setEncoding("utf-8");
      const onChunk = (chunk: string) => {
        acc += chunk;
        // vscode-js-debug: "Debug server listening at 127.0.0.1:40157"
        // dlv:            "DAP server listening at: 127.0.0.1:35713" (note the colon)
        // IPv6 brackets handled: "listening at: [::1]:35713"
        const m = /listening\s+at:?\s+(?:\[([0-9a-fA-F:.]+)\]|([0-9a-zA-Z._-]+)):(\d+)/i.exec(acc);
        if (m) {
          clearTimeout(timer);
          proc.stdout.removeListener("data", onChunk);
          resolve({ host: (m[1] ?? m[2]).replace(/[\[\]]/g, ""), port: parseInt(m[3], 10) });
        }
      };
      proc.stdout.on("data", onChunk);
    });
  }

  private connectTcp(host: string, port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = connect(port, host);
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`timed out connecting to ${host}:${port}`)); }, 10000);
      sock.once("connect", () => { clearTimeout(timer); resolve(sock); });
      sock.once("error", (err) => { clearTimeout(timer); reject(new Error(`tcp connect ${host}:${port} failed: ${err.message}`)); });
    });
  }

  /** True once the adapter process has exited. */
  get exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null {
    return this.exitPromise;
  }

  // ---- Wire framing ----

  /** Frame a request and write it to the adapter's stdin. */
  private send(command: string, args?: unknown, type: "request" = "request"): number {
    if (!this.transport) throw new Error("DapClient.start() not called");
    const seq = this.seq++;
    const msg = { seq, type, command, arguments: args };
    const json = JSON.stringify(msg);
    const frame = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
    this.transport.write(frame);
    this.onMessage?.(`→ ${type} ${command} seq=${seq}`);
    return seq;
  }

  /** Accumulate chunks, splitting out complete Content-Length-framed messages. */
  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd);
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Malformed header — drop everything up to the delimiter and continue.
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length - bodyStart < len) return; // wait for more
      const bodyText = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);
      let msg: any;
      try {
        msg = JSON.parse(bodyText);
      } catch {
        continue; // skip unparseable frames
      }
      this.dispatch(msg);
      this.onMessage?.(`← ${msg.type} ${msg.command ?? msg.event ?? ""} seq=${msg.seq ?? ""} req_seq=${msg.request_seq ?? ""} success=${msg.success ?? ""}`);
    }
  }

  /** Route one parsed message: response → pending request, event → listeners,
   *  reverse request → handler (we accept `startDebugging`, decline others). */
  private dispatch(msg: any): void {
    if (msg.type === "response") {
      const p = this.pending.get(msg.request_seq);
      if (!p) return; // orphan response (likely a late reply after timeout/exit)
      this.pending.delete(msg.request_seq);
      if (msg.success === false) {
        const text = msg.message || `DAP request '${msg.command}' failed`;
        p.reject(new Error(text));
      } else {
        p.resolve(msg.body);
      }
      return;
    }
    if (msg.type === "event") {
      // Swallow the main session's `initialized` for nested-session adapters
      // (set in start()); nestedHandoff re-emits the nested session's `initialized`
      // once the handoff completes, so the daemon's waitForInitialized() only
      // resolves when breakpoints will actually bind.
      if (msg.event === "initialized" && this.swallowInitialized) {
        this.swallowInitialized = false;
        return;
      }
      // While running the internal main→nested handoff, intercept `initialized`
      // via the sink (the nested session's `initialized`).
      if (msg.event === "initialized" && this.initializedSink) {
        this.initializedSink(msg.body);
        this.initializedSink = null;
        return;
      }
      const set = this.handlers.get(msg.event);
      if (set) for (const h of set) {
        try { h(msg.body); } catch { /* listener error shouldn't kill the loop */ }
      }
      return;
    }
    // Reverse requests: accept `startDebugging` (vscode-js-debug nested DAP),
    // decline everything else (e.g. runInTerminal).
    if (msg.type === "request") {
      if (msg.command === "startDebugging" && this.startDebuggingSink) {
        // Reply success — we'll honor it by starting a nested session.
        this.sendReverseResponse(msg.seq, msg.command, true, {});
        this.startDebuggingSink(msg.arguments);
        this.startDebuggingSink = null;
      } else {
        this.sendReverseResponse(msg.seq, msg.command, false, "not supported");
      }
    }
  }

  /** Send a response to a reverse request. `success` false with a message
   *  declines the request (e.g. runInTerminal); true with a body accepts it. */
  private sendReverseResponse(request_seq: number, command: string, success: boolean, bodyOrMessage: unknown): void {
    if (!this.transport) return;
    const seq = this.seq++;
    const msg = success
      ? { seq, type: "response", request_seq, command, success: true, body: bodyOrMessage }
      : { seq, type: "response", request_seq, command, success: false, message: bodyOrMessage };
    const json = JSON.stringify(msg);
    this.transport.write(`Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`);
  }

  /** Issue a request and await its response body. No timeout — the caller's
   *  own timeout governs. Rejects on `success:false` with the adapter's
   *  message, or on adapter process exit. */
  request<T = unknown>(command: string, args?: unknown): Promise<T> {
    if (!this.transport) return Promise.reject(new Error("DapClient not started"));
    const seq = this.send(command, args);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, {
        resolve: (body) => resolve(body as T),
        reject,
      });
      // If the adapter dies mid-request, fail the pending request rather
      // than hanging forever.
      if (this.exitPromise) {
        this.exitPromise.then(() => {
          if (this.pending.has(seq)) {
            this.pending.delete(seq);
            reject(new Error(`adapter exited during '${command}'`));
          }
        });
      }
    });
  }

  /** Subscribe to an event. Returns an unsubscribe handle. */
  on(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(handler);
    return () => set!.delete(handler);
  }

  // ---- Lifecycle ----

  async initialize(args: InitializeArgs): Promise<Capabilities> {
    const body = await this.request<Capabilities>("initialize", {
      clientID: "dbgx",
      clientName: "dbgx",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
      supportsMemoryReferences: false,
      // Advertise support for the `startDebugging` reverse request so adapters
      // that use nested DAP sessions (vscode-js-debug) will send it; we then
      // transparently start the nested session in launch().
      supportsStartDebuggingRequest: this.adapterLaunch.supportsStartDebugging ?? false,
      ...args,
    });
    this.capabilities = body;
    return body;
  }

  async launch(args: LaunchArgs): Promise<void> {
    if (this.adapterLaunch.supportsStartDebugging && this.tcpServer) {
      // vscode-js-debug uses a nested-session architecture: the main (outer)
      // session manages targets and sends a `startDebugging` reverse request;
      // the real debugging happens in a nested (inner) session on the same TCP
      // server. Run that handoff transparently so the daemon sees a single
      // client whose `initialized`/breakpoints/configDone land on the nested session.
      return this.nestedHandoff(args, "launch");
    }
    await this.request("launch", args);
  }

  async attach(args: AttachArgs): Promise<void> {
    if (this.adapterLaunch.supportsStartDebugging && this.tcpServer) {
      // js-debug uses the same nested-session architecture for attach as for
      // launch: the main session receives `attach`, sends a `startDebugging`
      // reverse request for the real target, and the nested session does the
      // actual debugging. Without this handoff the main `initialized` is
      // swallowed (see start()) and never re-emitted → waitForInitialized()
      // deadlocks. Route through the same handoff as launch.
      return this.nestedHandoff(args, "attach");
    }
    await this.request("attach", args);
  }

  /** vscode-js-debug nested-session handoff (used by BOTH launch and attach).
   *  The main (outer) session is a target manager: it fires `initialized`
   *  (right after `initialize`, before `launch`/`attach` — a js-debug quirk),
   *  needs a `configurationDone`, then sends a `startDebugging` reverse
   *  request whose `configuration` argument is the launch/attach config for
   *  the real (inner) session. We drive that whole flow here so callers
   *  interact with a single client whose subsequent breakpoints/configDone/
   *  stepping land on the nested session.
   *
   *  The main session's `initialized` is swallowed in dispatch() (flag set
   *  in start()) so the daemon's waitForInitialized() only resolves on the
   *  nested one, re-emitted here — by which point setBreakpoints binds for
   *  real. `kind` is "launch" or "attach" (the main + nested request type). */
  private async nestedHandoff(args: LaunchArgs, kind: "launch" | "attach"): Promise<void> {
    if (!this.tcpServer) throw new Error(`nested ${kind} requires a TCP adapter`);

    // The main `initialized` was already swallowed in dispatch(). Drive the
    // main session to the `startDebugging` handoff:
    //   <kind> → configurationDone (unblocks the response) → startDebugging.
    let mainErr: Error | null = null;
    const mainReq = this.request(kind, args).then(
      () => {},
      (e) => { mainErr = e instanceof Error ? e : new Error(String(e)); },
    );
    await this.request("configurationDone").catch(() => {});
    await mainReq;
    if (mainErr) throw mainErr;

    // Wait for `startDebugging`, racing against a timeout in case the adapter
    // advertised the capability but never uses it (then fall back to a plain
    // single-session flow by re-emitting a synthetic `initialized`).
    const startDebugging = this.nextStartDebugging();
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000));
    const sdArgs = await Promise.race([startDebugging, timeout]);
    if (!sdArgs) {
      this.emitToHandlers("initialized", {});
      return;
    }

    // Open a nested TCP connection to the same server and swap transports.
    const nestedSock = await this.connectTcp(this.tcpServer.host, this.tcpServer.port);
    this.nestedSocket = nestedSock;
    this.swapTransport(makeSocketTransport(nestedSock));

    // Nested initialize + <kind>(config) + await nested `initialized`.
    await this.request("initialize", {
      clientID: "dbgx", clientName: "dbgx", adapterID: "pwa-node",
      linesStartAt1: true, columnsStartAt1: true, pathFormat: "path",
      supportsVariableType: true, supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: true,
    });
    // Fire the nested request WITHOUT awaiting its response: the response is
    // gated by `configurationDone`, which the daemon only sends after we
    // re-emit `initialized` below. Awaiting here would deadlock. The response
    // lands once the daemon's setBreakpoints + configurationDone complete.
    const nestedInit = this.nextInitialized();
    let nestedErr: Error | null = null;
    this.request(kind, sdArgs.configuration).then(
      () => {},
      (e) => { nestedErr = e instanceof Error ? e : new Error(String(e)); },
    );
    const nestedInitBody = await nestedInit;
    // Re-emit the nested `initialized` so the daemon's waitForInitialized()
    // resolves and it sets breakpoints / sends configurationDone on the
    // (now-active) nested transport — where they actually bind. The nested
    // launch/attach response lands after that configurationDone.
    this.emitToHandlers("initialized", nestedInitBody);
    if (nestedErr) throw nestedErr;
  }

  /** Swap the active transport: detach the old data listener, install the new
   *  one, and wire its error/end handlers to fail pending requests. */
  private swapTransport(next: DapTransport): void {
    this.detachData?.();
    this.detachData = null;
    this.transport = next;
    this.detachData = next.onData((chunk: string) => this.onData(chunk));
    next.onError((err) => {
      for (const p of this.pending.values()) p.reject(new Error(`transport error: ${err.message}`));
      this.pending.clear();
    });
    next.onEnd(() => {
      for (const p of this.pending.values()) p.reject(new Error("adapter stream ended"));
      this.pending.clear();
    });
  }

  /** Resolve on the next `initialized` event, captured via the internal sink
   *  (so it isn't emitted to public handlers prematurely). */
  private nextInitialized(): Promise<any> {
    return new Promise((resolve) => { this.initializedSink = resolve; });
  }

  /** Resolve on the next `startDebugging` reverse request's arguments. */
  private nextStartDebugging(): Promise<any> {
    return new Promise((resolve) => { this.startDebuggingSink = resolve; });
  }

  /** Emit an event body to all registered handlers for that event. */
  private emitToHandlers(event: string, body: any): void {
    const set = this.handlers.get(event);
    if (set) for (const h of set) {
      try { h(body); } catch { /* listener error shouldn't kill the loop */ }
    }
  }

  async configurationDone(): Promise<void> {
    // Advertised as optional; some adapters still want the request. We always
    // send it (a capability-gated no-op when unsupported would be cleaner, but
    // sending it unconditionally works on every adapter we target).
    try {
      await this.request("configurationDone");
    } catch {
      /* adapters that don't handle it return an error — safe to ignore */
    }
  }

  async disconnect(terminateDebuggee?: boolean, restart?: boolean): Promise<void> {
    try {
      await this.request("disconnect", { terminateDebuggee, restart });
    } catch {
      /* adapter may be gone */
    }
  }

  async terminate(): Promise<void> {
    try {
      await this.request("terminate");
    } catch {
      /* fall back to disconnect */
      await this.disconnect(true);
    }
  }

  // ---- Breakpoints ----

  async setBreakpoints(args: SetBreakpointsArgs): Promise<SetBreakpointsResponse> {
    return this.request<SetBreakpointsResponse>("setBreakpoints", args);
  }

  async setFunctionBreakpoints(args: SetFunctionBreakpointsArgs): Promise<SetFunctionBreakpointsResponse> {
    return this.request<SetFunctionBreakpointsResponse>("setFunctionBreakpoints", args);
  }

  async setExceptionBreakpoints(filters: string[]): Promise<void> {
    await this.request("setExceptionBreakpoints", { filters });
  }

  // ---- Execution ----

  async continue(threadId: number): Promise<void> {
    await this.request("continue", { threadId });
  }

  async next(threadId: number): Promise<void> {
    await this.request("next", { threadId });
  }

  async stepIn(threadId: number): Promise<void> {
    await this.request("stepIn", { threadId });
  }

  async stepOut(threadId: number): Promise<void> {
    await this.request("stepOut", { threadId });
  }

  async stepBack(threadId: number): Promise<void> {
    await this.request("stepBack", { threadId });
  }

  async pause(threadId: number): Promise<void> {
    await this.request("pause", { threadId });
  }

  // ---- Inspection ----

  /** Forcefully tear down the adapter subprocess (disconnect/terminate
   *  already sent by the caller). Safe to call once or after exit. */
  async dispose(): Promise<void> {
    this.nestedSocket?.destroy();
    this.nestedSocket = null;
    this.transport?.close();
    this.transport = null;
    this.detachData = null;
    this.initializedSink = null;
    this.startDebuggingSink = null;
    if (this.proc && !this.proc.killed) {
      try { this.proc.stdin?.end(); } catch { /* ignore */ }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { this.proc?.kill("SIGKILL"); } catch { /* ignore */ } resolve(); }, 1500);
        this.proc?.once("exit", () => { clearTimeout(t); resolve(); });
      });
    }
    this.proc = null;
    this.pending.clear();
    this.handlers.clear();
  }

  async threads(): Promise<{ threads: import("./types.ts").Thread[] }> {
    return this.request("threads");
  }

  async stackTrace(args: StackTraceArgs): Promise<StackTraceResponse> {
    return this.request<StackTraceResponse>("stackTrace", args);
  }

  async scopes(frameId: number): Promise<ScopesResponse> {
    return this.request<ScopesResponse>("scopes", { frameId });
  }

  async variables(args: VariablesArgs): Promise<VariablesResponse> {
    return this.request<VariablesResponse>("variables", args);
  }

  async evaluate(expression: string, frameId?: number, context: "watch" | "repl" | "hover" = "repl"): Promise<EvaluateResponse> {
    return this.request<EvaluateResponse>("evaluate", { expression, frameId, context });
  }

  async setVariable(args: SetVariableArgs): Promise<SetVariableResponse> {
    return this.request<SetVariableResponse>("setVariable", args);
  }

  async breakpointLocations(file: string, line: number): Promise<{ breakpoints: BreakpointLocation[] }> {
    return this.request("breakpointLocations", {
      source: { path: file },
      line,
    });
  }
}

/** A transport backed by a child process's stdin/stdout pipes. */
function makePipeTransport(proc: ChildProcessWithoutNullStreams): DapTransport {
  const stdout = proc.stdout;
  stdout.setEncoding("utf-8");
  return {
    write: (data) => { proc.stdin.write(data); },
    onData: (cb) => { const h = (chunk: string) => cb(chunk); stdout.on("data", h); return () => stdout.removeListener("data", h); },
    onError: (cb) => { proc.on("error", (err) => cb(err)); },
    // Use stdout's 'end' event, NOT proc's 'exit': some adapters (ElixirLS)
    // spawn a child process (the BEAM VM) that inherits the pipes. The
    // parent (launch.sh) exits early, but the child keeps the pipes open.
    // proc.on('exit') would fire prematurely, rejecting pending requests.
    onEnd: (cb) => { stdout.on("end", () => cb()); },
    close: () => { /* pipes close with the process */ },
  };
}

/** A transport backed by a connected TCP socket. */
function makeSocketTransport(sock: Socket): DapTransport {
  sock.setEncoding("utf-8");
  return {
    write: (data) => { sock.write(data); },
    onData: (cb) => { const h = (chunk: string) => cb(chunk); sock.on("data", h); return () => sock.removeListener("data", h); },
    onError: (cb) => { sock.on("error", (err) => cb(err)); },
    onEnd: (cb) => { sock.on("close", () => cb()); },
    close: () => { sock.destroy(); },
  };
}

/** Human label for a stop reason (only `pause`→"paused" differs from the
 *  DAP reason string). */
export function stopReasonLabel(reason: string): string {
  return reason === "pause" ? "paused" : reason;
}
