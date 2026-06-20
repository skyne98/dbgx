// The dbgx daemon: one per workspace. Listens on a Unix socket and
// dispatches the wire protocol defined in ./protocol.ts. Auto-spawned by
// client commands (see ./rpc.ts); run in the foreground with `dbgx daemon`.
//
// KEY DIFFERENCE from lspx: a debug session is STATEFUL and long-lived
// (the target process runs between commands), so the daemon owning the
// session is not just a convenience — it's essential. The adapter boots
// LAZILY on the first `launch`/`attach` (there's no target until then),
// unlike lspx which boots its language server eagerly. Subsequent
// commands (break / continue / where / locals / eval) operate on the
// established session and persist across `&&`-chained CLI calls.
//
// The "run-until-next-stop" pattern: `continue`/`next`/`stepIn`/`stepOut`/
// `pause` send the DAP request, then block until the next `stopped`
// event (or `terminated`/`exited`), returning the new stop location + a
// compact backtrace whose top frames carry source snippets — so an agent
// sees where execution landed without a separate read_file. This is the
// direct analog of lspx's "snippet at every nav location".
//
// Boot model (mirrors lspx): the socket listens IMMEDIATELY (clients
// connect at once); adapter boot + launch happen on the first request and
// stream progress to any waiting client.

import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, dirname, basename, relative, join } from "node:path";
import {
  SOCKET_PATH,
  PID_PATH,
  LOG_PATH,
  ensureDirs,
  workspaceHash,
} from "../paths.ts";
import { DapClient } from "../dap/client.ts";
import { pickFreePort } from "../util.ts";
import type {
  Capabilities,
  StackFrame,
  StoppedEvent,
  LaunchArgs,
  AttachArgs,
  Variable,
  Thread,
} from "../dap/types.ts";
import {
  getAdapter,
  getLanguage,
  whichAdapter,
  languages as allLanguages,
  languageAdapters,
  type LanguageDef,
  type AdapterDef,
} from "../registry/index.ts";
import type { DaemonRequest, DaemonResponse } from "./protocol.ts";
import { phase, type ProgressSink } from "../progress.ts";
import { readContext, type Snippet } from "../snippet.ts";

function log(...a: unknown[]): void {
  try {
    appendFileSync(LOG_PATH, a.map(String).join(" ") + "\n");
  } catch {
    /* best-effort logging only */
  }
}

// ---- Session state ----

interface LineBreak {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  verified: boolean;
  message?: string;
  bpId?: number;
}

interface FuncBreak {
  name: string;
  condition?: string;
  hitCondition?: string;
  verified: boolean;
  message?: string;
  bpId?: number;
}

type StopOutcome =
  | { kind: "stopped"; stop: StoppedEvent; stack: StackFrame[] }
  | { kind: "terminated"; exitCode?: number };

// ---- Wire result shapes (consumed by src/format.ts) ----

export interface FrameView {
  id: number;
  name: string;
  file?: string;
  sourceName?: string;
  line: number;
  column: number;
  snippet?: Snippet;
  presentation?: string;
}

export interface LaunchResult {
  state: "stopped" | "running" | "terminated";
  adapter: string;
  language?: string;
  mode: string;
  threadId?: number;
  threadName?: string;
  stopReason?: string;
  frames: FrameView[];
}

export interface ContinueResult {
  state: "stopped" | "terminated";
  threadId?: number;
  threadName?: string;
  stopReason?: string;
  frames: FrameView[];
  exitCode?: number;
}

export interface WhereResult {
  threadId: number;
  threadName?: string;
  frames: FrameView[];
  total?: number;
  current: number;
  stopReason?: string;
  allThreadsStopped?: boolean;
}

export interface ThreadsResult {
  threads: { id: number; name: string; current: boolean }[];
  current?: number;
  stopped?: boolean;
}

export interface ExceptionsResult {
  /** Filters the adapter reported in its initialize response. */
  available: { filter: string; label: string; default?: boolean; description?: string }[];
  /** Currently-enabled filter IDs. */
  enabled: string[];
}

export interface VarView {
  name: string;
  value: string;
  type?: string;
  ref: number;
  named?: number;
  indexed?: number;
  children?: VarView[];
}

export interface LocalsResult {
  scopes: { name: string; expensive: boolean; variables: VarView[] }[];
}

export interface EvalResult {
  result: string;
  type?: string;
  ref: number;
  children?: VarView[];
}

export interface SetVarResult {
  name: string;
  value: string;
  type?: string;
}

export interface BreakView {
  kind: "line" | "func";
  file?: string;
  line?: number;
  name?: string;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  verified: boolean;
  message?: string;
}

export interface BreaksResult {
  breaks: BreakView[];
}

export interface StatusResult {
  adapter?: string;
  language?: string;
  mode?: string;
  state: string;
  thread?: number;
  frame?: number;
  stopReason?: string;
  breakpointCount: number;
  outputBytes: number;
  caps: Record<string, boolean>;
}

export interface OutputResult {
  bytes: number;
  text: string;
  truncated: boolean;
}

export interface DaemonOptions {
  workspaceRoot: string;
  adapterId?: string;
  languageId?: string;
}

const OUTPUT_CAP = 512 * 1024; // 512KB ring buffer of debuggee output

export class Daemon {
  readonly workspaceRoot: string;
  readonly workspaceHash: string;
  private server: ReturnType<typeof createTcpServer> | null = null;

  // Debug session state (null until launch/attach boots the adapter).
  private client: DapClient | null = null;
  private adapterId: string | undefined;
  private languageId: string | undefined;
  private mode: "launch" | "attach" | undefined;
  private stopped = false;
  private terminated: { exitCode?: number } | undefined;
  private initialized = false;
  private initializedRes: (() => void) | null = null;
  private currentThreadId: number | undefined;
  private currentFrameId: number | undefined;
  private lastFrames: StackFrame[] = [];
  private lastStop: StoppedEvent | undefined;
  /** Enabled exception-breakpoint filter IDs (e.g. debugpy "raised"/"uncaught").
   *  Applied at boot and re-applied live when changed. */
  private exceptionFilters: string[] = [];

  // Breakpoint tables (persist before launch so pre-launch breaks apply).
  private lineBreaks = new Map<string, Map<number, LineBreak>>();
  private funcBreaks: FuncBreak[] = [];

  private outputBuffer = "";
  private stopWaiter: ((o: StopOutcome) => void) | null = null;
  /** For bun: the WebKit→CDP translating proxy (so `disconnect` closes it). */
  private webkitProxy: import("../dap/webkit-proxy.js").WebKitProxy | null = null;

  /** Close the bun proxy (if any). */
  private cleanupBunRuntime(): void {
    if (this.webkitProxy) {
      try { this.webkitProxy.close(); } catch { /* */ }
      this.webkitProxy = null;
    }
  }

  /** For bun: start the WebKit→CDP translating proxy. Spawns bun with
   *  --inspect-brk, parses the ws:// URL, connects, sends Inspector.enable,
   *  and starts a local WS server that js-debug attaches to. Returns the
   *  proxy port + /json shim port (same port — the proxy serves /json too).
   *  See WebKitProxy for the protocol translation details. */
  private async spawnBunWithShim(t: LaunchTarget): Promise<{ shimPort: number }> {
    const { WebKitProxy } = await import("../dap/webkit-proxy.js");
    const program = this.abs(t.program);
    const cwd = t.cwd ?? this.workspaceRoot;
    const proxy = new WebKitProxy();
    // The proxy serves BOTH /json discovery AND WS translation on one port.
    // js-debug attaches to this port, fetches /json, then upgrades to WS.
    const proxyPort = await proxy.start(program, t.args ?? [], cwd, t.env ?? {});
    this.webkitProxy = proxy;
    return { shimPort: proxyPort };
  }

  constructor(private opts: DaemonOptions) {
    this.workspaceRoot = resolve(opts.workspaceRoot);
    this.workspaceHash = workspaceHash(this.workspaceRoot);
  }

  socketPath(): string {
    return SOCKET_PATH.replace("daemon.sock", `daemon-${this.workspaceHash}.sock`);
  }

  /** Listen on the socket, write the PID file. The adapter boots lazily on
   *  the first launch/attach request — there is no target until then. */
  async start(): Promise<void> {
    ensureDirs();
    const sock = this.socketPath();
    if (existsSync(sock)) {
      try { unlinkSync(sock); } catch { /* listen() surfaces real conflict */ }
    }
    this.server = createTcpServer((s) => this.handle(s));
    await new Promise<void>((res, rej) => {
      this.server!.listen(sock, () => res());
      this.server!.on("error", rej);
    });
    writeFileSync(PID_PATH, String(process.pid));
    log(`daemon pid=${process.pid} socket=${sock} workspace=${this.workspaceRoot}`);
  }

  private handle(socket: Socket): void {
    socket.setEncoding("utf-8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        await this.dispatch(socket, line);
      }
    });
    socket.on("error", () => { /* client disconnects are expected */ });
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    const req = parseRequest(line);
    if (!req) { this.reply(socket, { ok: false, e: "invalid request line" }); return; }
    // 'shutdown' stops the whole daemon (matches `dbgx close`).
    if (req.m === "shutdown") {
      try { await this.stop(); } catch (err) {
        this.reply(socket, { ok: false, e: err instanceof Error ? err.message : String(err) });
        return;
      }
      this.reply(socket, { ok: true, r: { stopped: true } });
      return;
    }
    try {
      const r = await this.route(socket, req);
      this.reply(socket, { ok: true, r });
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      log(`error: ${req.m}: ${e}`);
      this.reply(socket, { ok: false, e });
    }
  }

  private reply(socket: Socket, res: DaemonResponse): void {
    socket.write(JSON.stringify(res) + "\n");
  }

  private progressTo(socket: Socket, msg: string): void {
    try { socket.write(JSON.stringify({ progress: msg }) + "\n"); } catch { /* gone */ }
  }

  private async route(socket: Socket, req: DaemonRequest): Promise<unknown> {
    const { m, a = [] } = req;
    switch (m) {
      case "ping": return { workspace: this.workspaceRoot, adapter: this.adapterId ?? "none" };
      case "status": return this.status();
      // ---- session lifecycle ----
      case "launch": return await this.handleLaunch(socket, toLaunch(a));
      case "attach": return await this.handleAttach(socket, toAttach(a));
      case "disconnect": return await this.handleDisconnect(Boolean(a[0]));
      // ---- breakpoints ----
      case "break": return await this.handleSetBreakpoint(a);
      case "breaks": return this.handleListBreakpoints();
      case "clear": return await this.handleClearBreakpoint(a);
      // ---- execution (run-until-next-stop) ----
      case "continue": return await this.handleStep(socket, "continue");
      case "next": return await this.handleStep(socket, "next");
      case "stepIn": return await this.handleStep(socket, "stepIn");
      case "stepOut": return await this.handleStep(socket, "stepOut");
      case "stepBack": return await this.handleStep(socket, "stepBack");
      case "pause": return await this.handleStep(socket, "pause");
      // ---- inspection ----
      case "where": return await this.handleWhere(socket, a);
      case "frame": return this.handleFrame(a);
      case "up": return this.handleUpDown(1);
      case "down": return this.handleUpDown(-1);
      case "threads": return await this.handleThreads();
      case "thread": return await this.handleThread(a);
      case "exceptions": return await this.handleExceptions(a);
      case "locals": return await this.handleLocals();
      case "var": return await this.handleVar(a);
      case "expand": return await this.handleExpand(a);
      case "eval": return await this.handleEval(a);
      case "setvar": return await this.handleSetVar(a);
      case "output": return this.handleOutput(a);
      default: throw new Error(`unknown method: ${m}`);
    }
  }

  // ---- Session boot ----

  private requireSession(): void {
    if (!this.client) {
      throw new Error("no active debug session — run 'dbgx launch <lang> <program>' first");
    }
  }

  /** Like requireSession, but also rejects when the target has terminated or
   *  is still running (no stop to inspect). Gives a clean agent-facing error
   *  instead of forwarding adapter internals like `'NoneType' has no attr`. */
  private requireStopped(): void {
    this.requireSession();
    if (this.terminated) {
      const ex = this.terminated.exitCode;
      throw new Error(`target terminated${ex != null ? ` (exit ${ex})` : ""} — nothing to inspect`);
    }
    if (!this.stopped) {
      throw new Error("target is running — use 'dbgx continue' or 'dbgx pause' to stop first");
    }
  }

  private async bootAdapter(socket: Socket, adapterId: string, languageId?: string, spawnCwd?: string, program?: string, attachPort?: number): Promise<void> {
    const def = getAdapter(adapterId);
    if (!def) throw new Error(`unknown adapter '${adapterId}' in registry`);
    // tcp-attach adapters don't spawn a process (the user starts the DAP server
    // themselves), so a missing binary isn't fatal — but warn via doctor.
    const path = whichAdapter(def);
    if (!path && def.transport !== "tcp-attach") {
      throw new Error(
        `adapter '${adapterId}' (${def.command}) not found on $PATH — run 'dbgx doctor ${languageId ?? adapterId}' for install hints`,
      );
    }
    this.client = new DapClient({
      command: path ?? def.command,
      args: this.resolveAdapterArgs(def),
      env: { ...(def.env ?? {}), ...(adapterId === "dlv" ? this.dlvSpawnEnv() : undefined) },
      workspaceRoot: this.workspaceRoot,
      cwd: spawnCwd,
      transport: def.transport,
      program,
      // For tcp-attach: the host/port to connect to (user starts the server).
      // Falls back to the registry's defaultPort if the caller didn't pass one.
      connectPort: attachPort ?? def.defaultPort,
      // vscode-js-debug bootstraps each target via a `startDebugging` reverse
      // request that starts a nested DAP session. The client handles that
      // transparently so the daemon sees a single session.
      supportsStartDebugging: adapterId === "js-debug-adapter",
    });
    this.client.onMessage = (s) => log(`[dap] ${s}`);
    this.adapterId = adapterId;
    this.languageId = languageId;
    const sink: ProgressSink = (m) => this.progressTo(socket, m);
    await phase(`starting ${adapterId}`, () => this.client!.start((s) => log(`[${adapterId} stderr] ${s.trimEnd()}`)), sink);
    // Wire events before initialize so none are lost.
    this.installEventHandlers();
    await phase(`initializing ${adapterId}`, async () => {
      this.caps = await this.client!.initialize({ adapterID: adapterId });
    }, sink);
    // Apply the adapter's current exception-filter selection (empty by default).
    // Some adapters (e.g. Godot DAP) don't respond to setExceptionBreakpoints,
    // so wrap in a timeout to avoid hanging bootAdapter forever.
    try {
      await Promise.race([
        this.client.setExceptionBreakpoints(this.exceptionFilters),
        new Promise((_, reject) => setTimeout(() => reject(new Error("setExceptionBreakpoints timeout")), 5000)),
      ]);
    } catch { /* optional — adapter may not support it */ }
  }
  private caps: Capabilities | null = null;

  /** Subscribe to the DAP events dbgx cares about. Idempotent. */
  private installEventHandlers(): void {
    const c = this.client!;
    c.on("initialized", () => { this.initialized = true; this.initializedRes?.(); this.initializedRes = null; });
    c.on("stopped", (body: StoppedEvent) => void this.onStopped(body));
    c.on("continued", () => { this.stopped = false; });
    c.on("terminated", () => { this.terminated = {}; this.currentFrameId = undefined; this.resolveStop({ kind: "terminated" }); });
    c.on("exited", (body: { exitCode: number }) => {
      this.terminated = { exitCode: body.exitCode };
      this.currentFrameId = undefined;
      this.resolveStop({ kind: "terminated", exitCode: body.exitCode });
    });
    c.on("output", (body: { output: string; category?: string }) => this.onOutput(body));
    c.on("breakpoint", (body: { reason: string; breakpoint: { id?: number; verified?: boolean; message?: string; line?: number; source?: { path?: string } } }) => {
      this.onBreakpointEvent(body);
    });
    c.on("thread", () => { /* thread list refreshes lazily on demand */ });
  }

  /** A `stopped` event arrived. If we're waiting on a run-until-stop, fetch
   *  the stack + resolve the waiter; otherwise just update idle state. */
  private async onStopped(body: StoppedEvent): Promise<void> {
    this.stopped = true;
    if (body.threadId != null) this.currentThreadId = body.threadId;
    this.lastStop = body;
    let stack: StackFrame[] = [];
    try {
      const tid = body.threadId ?? this.currentThreadId;
      if (tid != null && this.client) {
        const r = await this.client.stackTrace({ threadId: tid, levels: 20 });
        stack = r.stackFrames;
        this.lastFrames = stack;
        this.currentFrameId = stack[0]?.id;
      }
    } catch { /* adapter may be mid-transition; state still reflects stop */ }
    this.resolveStop({ kind: "stopped", stop: body, stack });
  }

  private onOutput(body: { output: string; category?: string }): void {
    this.outputBuffer += body.output;
    if (this.outputBuffer.length > OUTPUT_CAP) {
      this.outputBuffer = this.outputBuffer.slice(-OUTPUT_CAP);
    }
  }

  private onBreakpointEvent(body: { reason: string; breakpoint: { id?: number; verified?: boolean; message?: string; line?: number; source?: { path?: string } } }): void {
    const bp = body.breakpoint;
    if (bp.id == null) return;
    // Update by id across both tables.
    for (const fileMap of this.lineBreaks.values()) {
      for (const lb of fileMap.values()) {
        if (lb.bpId === bp.id) {
          lb.verified = bp.verified ?? lb.verified;
          if (bp.message) lb.message = bp.message;
          return;
        }
      }
    }
    const fb = this.funcBreaks.find((f) => f.bpId === bp.id);
    if (fb) {
      fb.verified = bp.verified ?? fb.verified;
      if (bp.message) fb.message = bp.message;
    }
  }

  private beginWait(): Promise<StopOutcome> {
    return new Promise((resolve) => { this.stopWaiter = resolve; });
  }

  private resolveStop(o: StopOutcome): void {
    const w = this.stopWaiter;
    this.stopWaiter = null;
    if (w) w(o);
  }

  /** Wait for the DAP `initialized` event, which the adapter sends after it
   *  receives launch/attach and is ready to accept breakpoint configuration.
   *  Per the DAP spec, breakpoints set before this event (or before the
   *  target exists) come back `verified=false` and never bind in adapters
   *  like lldb-dap. */
  private waitForInitialized(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    return new Promise((r) => { this.initializedRes = r; });
  }

  /** Send a DAP execution request, then block until the next stop or
   *  termination. Returns the new stop location + top frames (with
   *  snippets) — the run-until-next-stop pattern.
   *
   *  When `skipStepStops` is true (i.e. the caller is `continue`, not a
   *  step command), a `reason=step` stop is treated as a stale lldb thread
   *  plan completing (an interrupted step-out/next lingers on lldb's plan
   *  stack and `process.Continue()` resumes it) and we auto-continue past
   *  it, re-waiting for the next real stop (breakpoint/exception/pause/
   *  entry/terminated). This makes `continue` behave as users expect: run
   *  to the next breakpoint, not to the target of a step you started
   *  earlier and abandoned. */
  private async runUntilStop(
    socket: Socket,
    action: () => Promise<void>,
    kind: "continue" | "step" = "step",
  ): Promise<ContinueResult> {
    this.requireSession();
    if (this.terminated) {
      return { state: "terminated", exitCode: this.terminated.exitCode, frames: [] };
    }
    const tid = this.currentThreadId;
    if (tid == null) throw new Error("no current thread — the target may not have stopped yet");
    const skipStepStops = kind === "continue";
    let outcome: StopOutcome;
    // Cap auto-continues so a pathological adapter can't loop forever.
    for (let hop = 0; hop < 16; hop++) {
      const p = this.beginWait();
      this.stopped = false;
      await action();
      outcome = await p;
      if (outcome.kind === "terminated") {
        return { state: "terminated", exitCode: outcome.exitCode, frames: [] };
      }
      // A `continue` that lands on a step (plan-complete) stop is a stale
      // lldb thread plan surfacing — skip it and re-continue.
      if (!(skipStepStops && outcome.stop.reason === "step")) break;
      log(`[continue] skipping stale step-plan stop at ${outcome.stack?.[0]?.name ?? "?"} (auto-continue)`);
    }
    // Loop exited either via break (non-step stop, or a step command's result)
    // or by hitting the hop cap while still on a step stop. Either way the
    // outcome is a `stopped`; surface it.
    if (outcome!.kind === "terminated") {
      return { state: "terminated", exitCode: outcome!.exitCode, frames: [] };
    }
    const threadName = await this.threadName(tid);
    return {
      state: "stopped",
      threadId: tid,
      threadName,
      stopReason: outcome!.stop.reason,
      frames: this.frameViews(outcome!.stack ?? this.lastFrames, 6),
    };
  }

  // ---- Launch / attach ----

  async handleLaunch(socket: Socket, t: LaunchTarget): Promise<LaunchResult> {
    if (this.client && !this.terminated) {
      throw new Error("a session is already active — run 'dbgx disconnect' first");
    }
    this.resetSession();
    const adapterId = t.adapterId ?? this.opts.adapterId ?? this.detectAdapter(t.languageId, t.program);
    if (!adapterId) {
      throw new Error(
        "no debug adapter configured. Pass a language: 'dbgx launch <lang> <program>' " +
          "or run 'dbgx doctor' to see available adapters.",
      );
    }
    const languageId = t.languageId ?? this.opts.languageId ?? this.languageForAdapter(adapterId);
    // dlv builds the Go program in the spawned process's cwd (its `cwd` launch
    // arg only sets the debuggee's runtime cwd, not the build dir). Spawn dlv
    // in the program's directory so `go build` finds the module's go.mod.
    const spawnCwd = adapterId === "dlv" && t.program ? this.dlvSpawnCwd(t.program) : undefined;
    const args = this.buildLaunchArgs(t, adapterId);
    return this.runSession(socket, adapterId, languageId, "launch", async () => {
      // Bun: spawn the runtime ourselves (bun's /json discovery is incomplete),
      // start a /json shim that serves the ws:// URL from bun's stderr, then
      // tell js-debug to *attach* to the shim port (instead of launch). Bun
      // speaks V8 CDP over the WS, so js-debug can set breakpoints, evaluate,
      // step, etc. once it discovers the target via the shim.
      if (adapterId === "js-debug-adapter" && languageId === "bun") {
        const { shimPort } = await this.spawnBunWithShim(t);
        await this.client!.attach({
          type: "pwa-node",
          address: "127.0.0.1",
          cwd: t.cwd ?? this.workspaceRoot,
          // `attachSimplePort` triggers js-debug's /json discovery path
          // (Fc → dS → /json/version + /json/list). Using `port` alone may
          // not trigger discovery in the nested-session attach path.
          attachSimplePort: shimPort,
        });
      } else {
        await this.client!.launch(args);
      }
    }, {
      spawnCwd,
      programForBoot: t.program,
      port: t.port,
      stopOnEntry: t.stopOnEntry,
      // Some adapters (ElixirLS) start the debuggee on `launch` (not
      // `configurationDone`), so breakpoints must be set BEFORE launch —
      // otherwise the program runs to completion before `initialized` arrives.
      earlyBreaks: getAdapter(adapterId)?.breakpointsBeforeLaunch === true,
      phaseLabel: "launching target",
      failLabel: `launch failed for ${this.abs(t.program)}`,
    });
  }

  async handleAttach(socket: Socket, t: AttachTarget): Promise<LaunchResult> {
    if (this.client && !this.terminated) {
      throw new Error("a session is already active — run 'dbgx disconnect' first");
    }
    this.resetSession();
    const adapterId = t.adapterId ?? this.opts.adapterId ?? this.detectAdapter(t.languageId, t.program);
    if (!adapterId) throw new Error("no debug adapter configured (pass a language or --adapter)");
    const languageId = t.languageId ?? this.opts.languageId ?? this.languageForAdapter(adapterId);
    const args = this.buildAttachArgs(t, adapterId);
    return this.runSession(socket, adapterId, languageId, "attach", async () => {
      await this.client!.attach(args);
    }, {
      port: t.port,
      stopOnEntry: t.stopOnEntry,
      phaseLabel: "attaching to target",
      failLabel: `attach failed (pid=${t.pid ?? "?"} port=${t.port ?? "?"})`,
    });
  }

  /** Shared launch/attach flow: boot the adapter, race the start action
   *  against `initialized`, bind breakpoints, send configurationDone, then
   *  run-until-first-stop (or return running/terminated). `startAction` fires
   *  the DAP launch/attach request — for launch this includes the bun
   *  WebKit-shim special case. The start response is NOT awaited before
   *  configurationDone: some adapters (lldb-dap) only emit it after
   *  configurationDone + the first stop, so awaiting would deadlock. The
   *  outcome is tracked separately so a failure (e.g. bad program path:
   *  success=false with no stop event) surfaces instead of hanging. */
  private async runSession(
    socket: Socket,
    adapterId: string,
    languageId: string | undefined,
    mode: "launch" | "attach",
    startAction: () => Promise<void>,
    opts: {
      spawnCwd?: string;
      programForBoot?: string;
      port?: number;
      stopOnEntry?: boolean;
      earlyBreaks?: boolean;
      phaseLabel: string;
      failLabel: string;
    },
  ): Promise<LaunchResult> {
    const sink: ProgressSink = (m) => this.progressTo(socket, m);
    await this.bootAdapter(socket, adapterId, languageId, opts.spawnCwd, opts.programForBoot, opts.port);
    try {
      this.mode = mode;
      const stopOnEntry = opts.stopOnEntry !== false; // default: break on entry
      // Set up the stop waiter BEFORE starting so a fast stop can't race past us.
      const wait = this.beginWait();
      if (opts.earlyBreaks) await this.applyAllBreakpoints(socket);
      let startErr: Error | null = null;
      const settled = startAction().then(
        () => { /* success — the stop (if any) arrives separately */ },
        (e) => { startErr = e instanceof Error ? e : new Error(String(e)); },
      );
      // Race `initialized` against the start settling: a start failure
      // surfaces instead of hanging on an `initialized` event that won't come.
      await Promise.race([
        this.waitForInitialized(),
        settled.then(() => { if (startErr) throw startErr; return new Promise<void>(() => {}); }),
      ]);
      // Standard DAP flow: bind breakpoints AFTER `initialized` (when not
      // early-bound), then configDone.
      if (!opts.earlyBreaks) await this.applyAllBreakpoints(socket);
      await phase(opts.phaseLabel, () => this.client!.configurationDone(), sink);
      if (!stopOnEntry) {
        await settled;
        if (startErr) throw startErr;
        return { state: "running", adapter: adapterId, language: languageId, mode, frames: [] };
      }
      // Race the first stop against the start settling. For a bad program the
      // start fails with no stop event — surface the failure instead of hanging.
      const outcome = await phase("waiting for first stop", () =>
        Promise.race([
          wait,
          settled.then(() => { if (startErr) throw startErr; return new Promise<StopOutcome>(() => {}); }),
        ]), sink);
      if (outcome.kind === "terminated") {
        return { state: "terminated", adapter: adapterId, language: languageId, mode, frames: [], exitCode: outcome.exitCode } as LaunchResult;
      }
      const tid = outcome.stop.threadId ?? this.currentThreadId;
      const threadName = tid != null ? await this.threadName(tid) : undefined;
      return {
        state: "stopped",
        adapter: adapterId,
        language: languageId,
        mode,
        threadId: tid,
        threadName,
        stopReason: outcome.stop.reason,
        frames: this.frameViews(outcome.stack ?? this.lastFrames, 6),
      };
    } catch (e) {
      // Tear down the half-booted adapter so 'status' doesn't dangle as 'running'.
      await this.client?.dispose().catch(() => {});
      this.resetSession();
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${opts.failLabel}: ${msg}`);
    }
  }

  async handleDisconnect(terminate: boolean): Promise<{ disconnected: true }> {
    if (this.client) {
      // Default: terminate the target on launch, detach on attach.
      const terminateDebuggee = terminate || this.mode === "launch";
      await this.client.disconnect(terminateDebuggee);
      await this.client.dispose();
    }
    // For bun: dbgx spawned the runtime itself, so js-debug's `disconnect`
    // can't reach it (it only attached to the inspector via the shim). Kill it
    // explicitly so `disconnect --terminate` actually stops the process.
    // Also close the /json shim server.
    this.cleanupBunRuntime();
    this.resetSession();
    return { disconnected: true };
  }

  // ---- Breakpoints ----

  async handleSetBreakpoint(a: unknown[]): Promise<BreakView> {
    // Forms:
    //   break <file> <line> [condition] [hit] [log]
    //   break --func <name> [condition] [hit]
    const funcName = strOpt(a, "func");
    if (funcName) {
      const fb: FuncBreak = {
        name: funcName,
        condition: strOpt(a, "condition"),
        hitCondition: strOpt(a, "hit"),
        verified: false,
      };
      this.funcBreaks.push(fb);
      if (this.client) await this.syncFuncBreaks();
      return { kind: "func", name: fb.name, condition: fb.condition, hitCondition: fb.hitCondition, verified: fb.verified, message: fb.message };
    }
    const file = String(a[0] ?? "");
    const line = Number(a[1]);
    if (!file || !line) throw new Error("expected <file> <line> (1-indexed) or --func <name>");
    const abs = this.abs(file);
    const lb: LineBreak = {
      line,
      condition: strOpt(a, "condition"),
      hitCondition: strOpt(a, "hit"),
      logMessage: strOpt(a, "log"),
      verified: false,
    };
    let fileMap = this.lineBreaks.get(abs);
    if (!fileMap) { fileMap = new Map(); this.lineBreaks.set(abs, fileMap); }
    fileMap.set(line, lb);
    if (this.client) await this.syncFileBreaks(abs);
    return {
      kind: "line",
      file: abs,
      line,
      condition: lb.condition,
      hitCondition: lb.hitCondition,
      logMessage: lb.logMessage,
      verified: lb.verified,
      message: lb.message,
    };
  }

  handleListBreakpoints(): BreaksResult {
    const breaks: BreakView[] = [];
    for (const [file, fileMap] of this.lineBreaks) {
      for (const [line, lb] of fileMap) {
        breaks.push({
          kind: "line", file, line,
          condition: lb.condition, hitCondition: lb.hitCondition, logMessage: lb.logMessage,
          verified: lb.verified, message: lb.message,
        });
      }
    }
    for (const fb of this.funcBreaks) {
      breaks.push({ kind: "func", name: fb.name, condition: fb.condition, hitCondition: fb.hitCondition, verified: fb.verified, message: fb.message });
    }
    return { breaks };
  }

  async handleClearBreakpoint(a: unknown[]): Promise<{ cleared: number }> {
    const all = boolOpt(a, "all");
    const funcName = strOpt(a, "func");
    let cleared = 0;
    if (all) {
      cleared = this.countBreaks();
      // Capture the files/funcs that currently have breakpoints BEFORE
      // clearing. applyAllBreakpoints() only syncs files still in the map,
      // so after lineBreaks.clear() it would iterate nothing and the adapter
      // would silently retain all the stale breakpoints. Instead, re-send
      // each captured source with an empty set (DAP: clearing) and an empty
      // function-breakpoint set.
      const filesToClear = [...this.lineBreaks.keys()];
      const hadFunc = this.funcBreaks.length > 0;
      this.lineBreaks.clear();
      this.funcBreaks = [];
      if (this.client) {
        await phase("clearing breakpoints", async () => {
          for (const abs of filesToClear) await this.syncFileBreaks(abs);
          if (hadFunc) await this.syncFuncBreaks();
        });
      }
      return { cleared };
    }
    if (funcName) {
      const before = this.funcBreaks.length;
      this.funcBreaks = this.funcBreaks.filter((f) => f.name !== funcName);
      cleared = before - this.funcBreaks.length;
      if (this.client) await this.syncFuncBreaks();
      return { cleared };
    }
    const file = String(a[0] ?? "");
    const line = Number(a[1]);
    if (!file) throw new Error("expected <file> <line>, --func <name>, or --all");
    const abs = this.abs(file);
    const fileMap = this.lineBreaks.get(abs);
    if (fileMap && fileMap.has(line)) {
      fileMap.delete(line);
      cleared = 1;
      if (fileMap.size === 0) this.lineBreaks.delete(abs);
      if (this.client) await this.syncFileBreaks(abs);
    }
    return { cleared };
  }

  /** Send the full per-file breakpoint set to the adapter (replaces all
   *  breakpoints for that source on each call — DAP semantics). */
  private async syncFileBreaks(abs: string): Promise<void> {
    if (!this.client) return;
    const fileMap = this.lineBreaks.get(abs);
    const breakpoints = fileMap
      ? [...fileMap.values()].map((lb) => ({
          line: lb.line,
          condition: lb.condition,
          hitCondition: lb.hitCondition,
          logMessage: lb.logMessage,
        }))
      : [];
    try {
      const r = await this.client.setBreakpoints({
        source: { path: abs, name: abs.split("/").pop() },
        breakpoints: breakpoints.length ? breakpoints : undefined,
        lines: undefined,
      });
      if (fileMap) {
        const arr = r.breakpoints ?? [];
        let i = 0;
        for (const lb of fileMap.values()) {
          const bp = arr[i++];
          if (bp) {
            lb.verified = bp.verified;
            lb.message = bp.message;
            lb.bpId = bp.id;
          }
        }
      }
    } catch (err) {
      // Mark this file's breaks as unverified with the error message.
      if (fileMap) for (const lb of fileMap.values()) { lb.verified = false; lb.message = err instanceof Error ? err.message : String(err); }
    }
  }

  private async syncFuncBreaks(): Promise<void> {
    if (!this.client) return;
    if (!this.caps?.supportsFunctionBreakpoints) return;
    try {
      const r = await this.client.setFunctionBreakpoints({
        breakpoints: this.funcBreaks.map((f) => ({ name: f.name, condition: f.condition, hitCondition: f.hitCondition })),
      });
      const arr = r.breakpoints ?? [];
      this.funcBreaks.forEach((f, i) => {
        const bp = arr[i];
        if (bp) { f.verified = bp.verified; f.message = bp.message; f.bpId = bp.id; }
      });
    } catch (err) {
      this.funcBreaks.forEach((f) => { f.verified = false; f.message = err instanceof Error ? err.message : String(err); });
    }
  }

  /** Re-send every file's breakpoints + function breakpoints. Used at launch
   *  (bind early breaks before the target runs) and after `clear --all`. */
  private async applyAllBreakpoints(socket?: Socket): Promise<void> {
    if (!this.client) return;
    const sink: ProgressSink | undefined = socket ? (m) => this.progressTo(socket, m) : undefined;
    await phase("setting breakpoints", async () => {
      for (const abs of this.lineBreaks.keys()) await this.syncFileBreaks(abs);
      if (this.funcBreaks.length) await this.syncFuncBreaks();
    }, sink);
  }

  // ---- Execution ----

  async handleStep(socket: Socket, kind: "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "pause"): Promise<ContinueResult> {
    this.requireSession();
    if (kind === "stepBack" && !this.caps?.supportsStepBack) {
      throw new Error("this adapter does not support reverse debugging (stepBack)");
    }
    // `pause` targets a RUNNING process, which may have no current thread yet
    // (e.g. launched with --no-stop-on-entry). Resolve one from the thread
    // list; the resulting `stopped` event populates currentThreadId.
    if (kind === "pause") {
      const tid = this.currentThreadId ?? (await this.pickThread());
      if (tid == null) throw new Error("no threads to pause (is the target running?)");
      this.currentThreadId = tid;
      return this.runUntilStop(socket, async () => { await this.client!.pause(tid); }, "step");
    }
    const execKind: "continue" | "step" = kind === "continue" ? "continue" : "step";
    return this.runUntilStop(socket, async () => {
      const tid = this.currentThreadId!;
      switch (kind) {
        case "continue": await this.client!.continue(tid); break;
        case "next": await this.client!.next(tid); break;
        case "stepIn": await this.client!.stepIn(tid); break;
        case "stepOut": await this.client!.stepOut(tid); break;
        case "stepBack": await this.client!.stepBack(tid); break;
      }
    }, execKind);
  }

  // ---- Inspection ----

  async handleWhere(socket: Socket, a: unknown[]): Promise<WhereResult> {
    this.requireStopped();
    const tid = this.currentThreadId ?? (await this.pickThread());
    if (tid == null) throw new Error("no current thread (is the target stopped?)");
    const levels = Number(a[0] ?? 20);
    const r = await this.client!.stackTrace({ threadId: tid, levels });
    this.lastFrames = r.stackFrames;
    this.currentFrameId = r.stackFrames[0]?.id ?? this.currentFrameId;
    const currentIdx = r.stackFrames.findIndex((f) => f.id === this.currentFrameId);
    const threadName = await this.threadName(tid);
    return {
      threadId: tid,
      threadName,
      frames: this.frameViews(r.stackFrames, 20),
      total: r.totalFrames,
      current: currentIdx < 0 ? 0 : currentIdx,
      stopReason: this.lastStop?.reason,
      allThreadsStopped: this.lastStop?.allThreadsStopped,
    };
  }

  handleFrame(a: unknown[]): { index: number; frame?: FrameView } {
    this.requireSession();
    const n = Number(a[0] ?? 0);
    const frames = this.lastFrames;
    if (!frames.length) throw new Error("no cached stack — run 'dbgx where' first");
    if (n < 0 || n >= frames.length) throw new Error(`frame ${n} out of range (0..${frames.length - 1})`);
    this.currentFrameId = frames[n].id;
    return { index: n, frame: this.frameViews([frames[n]], 1)[0] };
  }

  handleUpDown(dir: 1 | -1): { index: number; frame?: FrameView } {
    this.requireSession();
    const frames = this.lastFrames;
    if (!frames.length) throw new Error("no cached stack — run 'dbgx where' first");
    const cur = frames.findIndex((f) => f.id === this.currentFrameId);
    const idx = Math.max(0, Math.min(frames.length - 1, (cur < 0 ? 0 : cur) + dir));
    this.currentFrameId = frames[idx].id;
    return { index: idx, frame: this.frameViews([frames[idx]], 1)[0] };
  }

  async handleThreads(): Promise<ThreadsResult> {
    this.requireSession();
    const r = await this.client!.threads();
    const cur = this.currentThreadId;
    return {
      threads: r.threads.map((t: Thread) => ({ id: t.id, name: t.name, current: t.id === cur })),
      current: cur,
      stopped: this.stopped,
    };
  }

  /** Switch the current thread (for `where`/`locals`/`eval` context) and
   *  refresh its cached stack so frame selection works on the new thread. */
  async handleThread(a: unknown[]): Promise<{ index: number; frame?: FrameView }> {
    this.requireSession();
    const id = Number(a[0]);
    if (!Number.isFinite(id)) throw new Error("usage: dbgx thread <id>");
    const r = await this.client!.threads();
    const exists = r.threads.some((t: Thread) => t.id === id);
    if (!exists) throw new Error(`no thread #${id} (use 'dbgx threads' to list)`);
    this.currentThreadId = id;
    // Refresh the stack for this thread so frame up/down/eval target it.
    const sr = await this.client!.stackTrace({ threadId: id, levels: 20 });
    this.lastFrames = sr.stackFrames;
    this.currentFrameId = sr.stackFrames[0]?.id;
    return { index: 0, frame: this.frameViews([sr.stackFrames[0]], 1)[0] };
  }

  /** List or set exception-breakpoint filters. With no args, lists the
   *  adapter's available filters + the currently-enabled set. With a
   *  comma-separated list (or `--none`), replaces the enabled set and
   *  re-sends `setExceptionBreakpoints` live. */
  async handleExceptions(a: unknown[]): Promise<ExceptionsResult> {
    this.requireSession();
    const available = this.caps?.exceptionBreakpointFilters ?? [];
    if (a.length && String(a[0])) {
      const arg = String(a[0]);
      if (arg === "none" || arg === "--none") {
        this.exceptionFilters = [];
      } else {
        const wanted = arg.split(",").map((s) => s.trim()).filter(Boolean);
        const known = new Set(available.map((f) => f.filter));
        const unknown = wanted.filter((f) => !known.has(f));
        if (unknown.length) {
          const valid = available.map((f) => f.filter).join(", ");
          throw new Error(`unknown exception filter(s): ${unknown.join(", ")} — valid: ${valid}`);
        }
        this.exceptionFilters = wanted;
      }
      try { await this.client!.setExceptionBreakpoints(this.exceptionFilters); } catch { /* re-applied at next launch */ }
    }
    return {
      available: available.map((f) => ({ filter: f.filter, label: f.label, default: f.default, description: f.description })),
      enabled: this.exceptionFilters,
    };
  }

  async handleLocals(): Promise<LocalsResult> {
    this.requireStopped();
    const frameId = this.currentFrameId;
    if (frameId == null) throw new Error("no current frame — run 'dbgx where' first");
    const sr = await this.client!.scopes(frameId);
    const scopes = [];
    for (const scope of sr.scopes) {
      let variables: Variable[] = [];
      if (scope.variablesReference) {
        const vr = await this.client!.variables({ variablesReference: scope.variablesReference });
        variables = vr.variables;
      }
      scopes.push({
        name: scope.name,
        expensive: scope.expensive,
        variables: await Promise.all(variables.map((v) => this.toVarView(v, 0))),
      });
    }
    return { scopes };
  }

  async handleVar(a: unknown[]): Promise<VarView | null> {
    this.requireStopped();
    const name = String(a[0] ?? "");
    const depth = Math.max(0, Math.min(5, Number(a[1] ?? 1)));
    if (!name) throw new Error("expected <name> [--depth N]");
    const frameId = this.currentFrameId;
    if (frameId == null) throw new Error("no current frame — run 'dbgx where' first");
    const found = await this.findVariableInScopes(frameId, name);
    if (found) return this.toVarView(found.variable, depth);
    // Fall back to evaluating the name as an expression.
    try {
      const ev = await this.client!.evaluate(name, frameId, "watch");
      return { name, value: ev.result, type: ev.type, ref: ev.variablesReference, children: depth > 0 && ev.variablesReference ? await this.expandVar(ev.variablesReference, depth - 1) : undefined };
    } catch {
      return null;
    }
  }

  async handleExpand(a: unknown[]): Promise<VarView[]> {
    this.requireStopped();
    const ref = Number(a[0] ?? 0);
    if (!ref) throw new Error("expected <variablesReference> (a positive int)");
    const vr = await this.client!.variables({ variablesReference: ref });
    return await Promise.all(vr.variables.map((v) => this.toVarView(v, 0)));
  }

  async handleEval(a: unknown[]): Promise<EvalResult> {
    this.requireStopped();
    const expr = String(a[0] ?? "");
    const depth = Math.max(0, Math.min(5, Number(a[1] ?? 1)));
    if (!expr) throw new Error("expected <expression> [--depth N]");
    const frameId = this.currentFrameId;
    // "watch" context evaluates the expression in the current frame — the
    // DAP-correct semantic for `eval`. ("repl" would let GDB interpret bare
    // names like `i` as debugger commands, e.g. the `info` abbreviation.)
    const ev = await this.client!.evaluate(expr, frameId, "watch");
    return {
      result: ev.result,
      type: ev.type,
      ref: ev.variablesReference,
      children: depth > 0 && ev.variablesReference ? await this.expandVar(ev.variablesReference, depth - 1) : undefined,
    };
  }

  /** Set a variable's value via `setVariable`. Resolves the
   *  variablesReference from the current frame's scopes (searching for the
   *  named variable). Returns the new value + type. */
  async handleSetVar(a: unknown[]): Promise<SetVarResult> {
    this.requireStopped();
    const name = String(a[0] ?? "");
    const value = String(a[1] ?? "");
    if (!name || !value) throw new Error("expected <name> <value>");
    if (!this.caps?.supportsSetVariable) throw new Error("this adapter does not support setVariable");
    const frameId = this.currentFrameId;
    if (frameId == null) throw new Error("no current frame (use 'dbgx continue' to stop first)");
    const found = await this.findVariableInScopes(frameId, name);
    if (!found) throw new Error(`variable '${name}' not found in current scope`);
    const res = await this.client!.setVariable({
      variablesReference: found.variablesReference,
      name: found.variable.evaluateName ?? found.variable.name,
      value,
    });
    return { name, value: res.value, type: res.type };
  }

  handleOutput(a: unknown[]): OutputResult {
    const tail = Boolean(a[0]);
    const text = tail ? this.outputBuffer.split("\n").slice(-50).join("\n") : this.outputBuffer;
    return {
      bytes: this.outputBuffer.length,
      text,
      truncated: tail && this.outputBuffer.length > text.length,
    };
  }

  // ---- Helpers ----

  /** Search the current frame's scopes for a named variable. Returns the
   *  variable + its owning scope's variablesReference (needed for
   *  setVariable). Used by `var` and `setvar`. */
  private async findVariableInScopes(
    frameId: number,
    name: string,
  ): Promise<{ variable: Variable; variablesReference: number } | null> {
    const sr = await this.client!.scopes(frameId);
    for (const scope of sr.scopes) {
      if (!scope.variablesReference) continue;
      const vr = await this.client!.variables({ variablesReference: scope.variablesReference });
      const found = vr.variables.find((v) => v.name === name || v.evaluateName === name);
      if (found) return { variable: found, variablesReference: scope.variablesReference };
    }
    return null;
  }

  private async expandVar(ref: number, depth: number): Promise<VarView[]> {
    if (depth < 0 || !ref) return [];
    const vr = await this.client!.variables({ variablesReference: ref });
    return Promise.all(vr.variables.map(async (v) => this.toVarView(v, depth - 1)));
  }

  private async toVarView(v: Variable, depth: number): Promise<VarView> {
    const view: VarView = {
      name: v.name,
      value: v.value,
      type: v.type,
      ref: v.variablesReference,
      named: v.namedVariables,
      indexed: v.indexedVariables,
    };
    if (depth > 0 && v.variablesReference) {
      view.children = await this.expandVar(v.variablesReference, depth - 1);
    }
    return view;
  }


  /** Build DAP launch args from a normalized target + adapter defaults. */
  private buildLaunchArgs(t: LaunchTarget, adapterId: string): LaunchArgs {
    const def = getAdapter(adapterId);
    const program = this.abs(t.program);
    const args: LaunchArgs = {
      program,
      args: t.args ?? [],
      cwd: t.cwd ?? this.workspaceRoot,
      env: t.env,
      stopOnEntry: t.stopOnEntry !== false,
      console: "internalConsole",
    };
    if (def?.config) Object.assign(args, def.config);
    if (adapterId === "debugpy") {
      args.python = Bun.which("python3") ?? Bun.which("python") ?? "python3";
    } else if (adapterId === "js-debug-adapter") {
      // vscode-js-debug needs a `type` (pwa-node for plain Node), runs the
      // JS file via `runtimeExecutable`, and does NOT understand
      // stopOnEntry/console — drop those and translate stopOnEntry to
      // `stopOnEntry` under pwa-node's own schema.
      //
      // bun/deno: route through pwa-node *launch* with `runtimeExecutable`
      // + a pre-picked inspect port. js-debug spawns the runtime itself and
      // attaches to the port directly (bypassing the node-specific auto-attach
      // bootloader and the /json discovery endpoint that bun doesn't
      // implement). The recipe is `request: launch`, `runtimeExecutable`,
      // `runtimeArgs: [..., "--inspect-brk=127.0.0.1:PORT", ...]`, `port: PORT`.
      // `--inspect-brk` pauses on first line so breakpoints bind before the
      // script runs. References: vscode-js-debug's attachSimplePort; deno
      // docs recommend `--inspect-brk` + `attachSimplePort: 9229`; the SO
      // recipe `type: node, request: launch, runtimeExecutable: deno,
      // runtimeArgs: [run, --inspect-brk, -A, file], port: 9229` works.
      const lang = t.languageId;
      if (lang === "deno") {
        const port = pickFreePort();
        const exe = Bun.which("deno") ?? "deno";
        // `deno run --inspect-brk=HOST:PORT -A <file>`: pause on first line.
        // js-debug spawns deno via runtimeExecutable, then attaches to PORT.
        // deno implements /json/version + /json/list, so js-debug discovers the
        // target normally. (Breakpoints show "Unbound" until the script loads,
        // then bind + fire correctly — verified end-to-end.)
        const runtimeArgs = ["run", `--inspect-brk=127.0.0.1:${port}`, "-A", program, ...(t.args ?? [])];
        args.type = "pwa-node";
        args.runtimeExecutable = exe;
        args.runtimeArgs = runtimeArgs;
        args.port = port;
        args.console = "internalConsole";
        delete args.stopOnEntry;
        delete args.program;
        delete args.args;
      } else {
        args.type = "pwa-node";
        args.runtimeExecutable = t.runtimeExecutable ?? Bun.which("node") ?? "node";
        if (t.runtimeArgs) args.runtimeArgs = t.runtimeArgs;
        args.console = "internalConsole";
        // js-debug uses `stopOnEntry` too, but only on pwa-node — keep it.
      }
    } else if (adapterId === "dlv") {
      // dlv `mode: debug` (the registry default) builds + launches a Go
      // package. `program` must be the package directory (where go.mod lives),
      // not a .go file. Normalize a file path to its directory and mirror
      // that as the build cwd (the process cwd is set separately in bootAdapter).
      const pkgDir = this.dlvSpawnCwd(t.program);
      args.program = pkgDir;
      args.cwd = pkgDir;
    } else if (adapterId === "dart" || adapterId === "flutter") {
      // Dart/Flutter DAP: `program` is the .dart entry point, `cwd` must be
      // the project root (where pubspec.yaml lives). Drop console/stopOnEntry
      // quirks — Dart uses its own noDebug + toolArgs. Keep stopOnEntry.
      args.cwd = t.cwd ?? this.workspaceRoot;
      if (adapterId === "flutter") {
        // Flutter needs flutterMode (debug/profile/release). Default debug.
        args.flutterMode = "debug";
        // noDebug: false means we want the debugger attached.
        args.noDebug = t.stopOnEntry === false;
      }
    } else if (adapterId === "netcoredbg") {
      // netcoredbg uses `stopAtEntry` (not the DAP-spec `stopOnEntry`).
      // Drop the DAP-spec field; translate to the C# debugger's own.
      args.stopAtEntry = t.stopOnEntry !== false;
      args.justMyCode = false;
      delete args.stopOnEntry;
      delete args.console;
    } else if (adapterId === "godot-dap") {
      // Godot DAP (tcp-attach): the user started the editor with --dap-port;
      // dbgx connected without spawning. The `launch` request tells the
      // editor to start the game with debugging. `project` is the project
      // dir; `address`+`port` is where the game's debug server should listen
      // (the editor launches the game with --remote-debug to connect back).
      // Use the same port dbgx connected to — the editor multiplexes both.
      args.project = this.workspaceRoot;
      args.address = "127.0.0.1";
      args.port = t.port ?? getAdapter(adapterId)?.defaultPort ?? 6006;
      args.launch_game_instance = true;
      args.launch_scene = false;
      delete args.program;
      delete args.console;
    } else if (adapterId === "php-debug") {
      // php-debug (Xdebug) launches `php <program>`; runtimeExecutable is php.
      // The adapter listens on `port` for Xdebug connections from PHP. Use the
      // default Xdebug port (9003) so the adapter configures Xdebug correctly.
      // Pass Xdebug loading via runtimeArgs (works without php.ini).
      args.runtimeExecutable = Bun.which("php") ?? "php";
      args.port = 9003;
      args.runtimeArgs = ["-d", "zend_extension=xdebug", "-d", "xdebug.mode=debug", "-d", "xdebug.start_with_request=yes"];
    } else if (adapterId === "haskell-debugger") {
      // haskell-debugger launches a compiled binary directly; standard args.
      // noDebug mirrors stopOnEntry (false → debug, true → run without halting).
      args.noDebug = t.stopOnEntry === false ? false : undefined;
    } else if (adapterId === "ocaml-earlybird") {
      // earlybird launches a compiled OCaml binary; standard args.
      args.console = "internalConsole";
    } else if (adapterId === "perl-debug") {
      // Perl::LanguageServer: program is a .pl file; it spawns perl internally.
      args.perl = Bun.which("perl") ?? "perl";
    } else if (adapterId === "rdbg") {
      // rdbg gets the program on its command line (-- ruby {program}), so the
      // DAP launch request just configures the debugger. Drop `program` from
      // the launch args (rdbg doesn't understand it) and translate stopOnEntry
      // (the --stop-at-load flag is already on the CLI, so this is redundant
      // but harmless).
      delete args.program;
      delete args.console;
    } else if (adapterId === "elixir-ls") {
      // ElixirLS launches a mix task. For .ex files: require the module and call
      // its main/0. For .exs scripts: pass the script path to `mix run`.
      // ElixirLS starts the debuggee on `launch` (not `configurationDone`),
      // so breakpoints must be set BEFORE launch (breakpointsBeforeLaunch).
      const projectDir = this.findMixRoot(t.program);
      const isScript = t.program.endsWith(".exs");
      delete args.program;
      delete args.stopOnEntry;
      delete args.console;
      delete args.args;
      delete args.cwd;
      args.task = "run";
      args.projectDir = projectDir;
      args.noDebug = t.stopOnEntry === false;
      // Don't auto-interpret all loaded modules — only the ones in requireFiles.
      // Auto-interpretation can crash on internal modules (e.g. SchematicV.*).
      args.debugAutoInterpretAllModules = false;
      if (isScript) {
        // .exs: run directly via `mix run /path/to/script.exs`
        args.taskArgs = [this.abs(t.program)];
      } else {
        // .ex: require the module, call main/0
        const relPath = relative(projectDir, this.abs(t.program));
        const baseName = basename(t.program, ".ex");
        const moduleName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
        args.taskArgs = ["-e", `${moduleName}.main()`];
        args.requireFiles = [relPath];
      }
    } else if (adapterId === "r-debugger") {
      // vscDebugger: `file` is the .R path (not `program`); mainFunction
      // defaults to "main".
      args.file = program;
      args.mainFunction = "main";
    } else if (adapterId === "lua-debug") {
      // lua-debug launches a .lua file; needs the lua interpreter on PATH.
      args.interpreter = Bun.which("lua") ?? "lua";
    } else if (adapterId === "kotlin-debug-adapter") {
      // Kotlin DAP needs mainClass + classpath/projectRoot, not a program.
      // Use the program as projectRoot; the user must set mainClass via config.
      args.projectRoot = this.dlvSpawnCwd(t.program);
    }
    return args;
  }

  /** Resolve the Go package directory for a dlv target: if `program` is a
   *  .go file, use its parent directory; otherwise use the path as-is
   *  (it's already a package directory). */
  private dlvSpawnCwd(program: string): string {
    const abs = this.abs(program);
    try {
      if (statSync(abs).isFile()) return dirname(abs);
    } catch { /* fall through */ }
    return abs;
  }

  /** Walk up from a .ex/.exs file to find the nearest directory containing
   *  mix.exs — the ElixirLS project root. Falls back to the file's parent. */
  private findMixRoot(program: string): string {
    let dir = dirname(this.abs(program));
    for (let i = 0; i < 20; i++) {
      if (existsSync(join(dir, "mix.exs"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirname(this.abs(program));
  }

  /** dlv `mode: debug` runs `go build` in the spawned process's cwd, so the
   *  Go toolchain must be on PATH. Non-interactive shells (CI, agents) may
   *  not source ~/.bashrc, so if `go` isn't already resolvable, look in the
   *  standard install locations and prepend its bin dir to PATH for the spawn. */
  private dlvSpawnEnv(): Record<string, string> | undefined {
    if (Bun.which("go")) return undefined;
    for (const dir of ["/usr/local/go/bin", "/usr/lib/go/bin", "/snap/go/current/bin", "/opt/go/bin"]) {
      try {
        if (existsSync(`${dir}/go`)) return { PATH: `${dir}:${process.env.PATH ?? ""}` };
      } catch { /* ignore */ }
    }
    return undefined;
  }

  /** Resolve path placeholders in an adapter's spawn args: `{phpDebugPath}`
   *  (the vscode-php-debug DAP entry), `{kotlinAdapterJar}` (the fwcd JAR),
   *  `{psesStartScript}` (PowerShell EditorServices). Each is located by
   *  scanning known install locations (nix store, /opt, ~/.local, PATH).
   *  `{port}` is left intact — the DapClient substitutes it for tcp-allocate. */
  private resolveAdapterArgs(def: AdapterDef): string[] | undefined {
    const args = def.args;
    if (!args) return undefined;
    const subst = (placeholder: string, candidates: string[]): string => {
      for (const c of candidates) if (c && existsSync(c)) return c;
      return placeholder; // unresolved — surfaced as a clear spawn error
    };
    return args.map((a) => {
      if (a === "{phpDebugPath}") {
        return subst("{phpDebugPath}", this.findPhpDebug());
      }
      if (a === "{kotlinAdapterJar}") {
        return subst("{kotlinAdapterJar}", this.findKotlinAdapterJar());
      }
      if (a === "{psesStartScript}") {
        return subst("{psesStartScript}", this.findPsesStartScript());
      }
      return a;
    });
  }

  /** Locate vscode-php-debug's `out/phpDebug.js` across install layouts. */
  private findPhpDebug(): string[] {
    const found: string[] = [];
    // nix vscode extensions live at /nix/store/<hash>-vscode-extension-<publisher>.<name>-<ver>/share/vscode/extensions/<publisher>.<name>/out/phpDebug.js
    for (const base of ["/nix/store", "/usr/share/vscode/extensions", `${process.env.HOME}/.vscode/extensions`, "/opt/php-debug"]) {
      try {
        for (const name of readdirSync(base)) {
          if (!/php-debug|xdebug\.php-debug/i.test(name)) continue;
          // Try the nix layout (share/vscode/extensions/<pub>.<name>/out/...) and the flat layout (out/...).
          for (const sub of [`${base}/${name}/share/vscode/extensions`, `${base}/${name}`, base]) {
            try {
              for (const ext of readdirSync(sub)) {
                const p = `${sub}/${ext}/out/phpDebug.js`;
                if (existsSync(p)) found.push(p);
              }
            } catch { /* subdir missing */ }
          }
        }
      } catch { /* dir missing — skip */ }
    }
    return found;
  }

  /** Locate the kotlin-debug-adapter JAR across install layouts. */
  private findKotlinAdapterJar(): string[] {
    const found: string[] = [];
    const dirs = [
      "/opt/kotlin-debug-adapter",
      `${process.env.HOME}/.local/share/kotlin-debug-adapter`,
      `${process.env.HOME}/.cache/kotlin-debug-adapter`,
    ];
    for (const d of dirs) {
      try {
        for (const name of readdirSync(d)) {
          if (/kotlin-debug-adapter.*\.jar$/i.test(name)) found.push(`${d}/${name}`);
        }
      } catch { /* skip */ }
    }
    return found;
  }

  /** Locate PowerShell EditorServices' Start-EditorServices.ps1. */
  private findPsesStartScript(): string[] {
    const found: string[] = [];
    for (const base of ["/nix/store", `${process.env.HOME}/.local/share/powershell-editor-services`]) {
      try {
        for (const name of readdirSync(base)) {
          if (!/powershell-editor-services/i.test(name)) continue;
          // nix layout: <store>/.../lib/powershell-editor-services/PowerShellEditorServices/module/PowerShellEditorServices/Start-EditorServices.ps1
          const p = `${base}/${name}/lib/powershell-editor-services/PowerShellEditorServices/module/PowerShellEditorServices/Start-EditorServices.ps1`;
          if (existsSync(p)) found.push(p);
        }
      } catch { /* skip */ }
    }
    return found;
  }

  private buildAttachArgs(t: AttachTarget, adapterId: string): AttachArgs {
    const def = getAdapter(adapterId);
    const args: AttachArgs = {
      program: t.program ? this.abs(t.program) : undefined,
      cwd: t.cwd ?? this.workspaceRoot,
      env: t.env,
      stopOnEntry: t.stopOnEntry !== false,
    };
    if (t.pid != null) args.pid = t.pid;
    if (t.port != null) args.port = t.port;
    if (def?.config) Object.assign(args, def.config);
    if (adapterId === "js-debug-adapter") {
      // vscode-js-debug attach needs `type: pwa-node` (same as launch) plus an
      // `address` (default localhost) for port-based attach. localRoot/remoteRoot
      // enable source-map resolution for .ts programs debugged via compiled .js.
      // (The client's nested-attach handoff re-emits `initialized` so breakpoints
      // bind before configurationDone — without that handoff the main session's
      // `initialized` is swallowed and `waitForInitialized()` deadlocks.)
      args.type = "pwa-node";
      args.address = "127.0.0.1";
      args.localRoot = this.workspaceRoot;
      args.remoteRoot = this.workspaceRoot;
    }
    return args;
  }

  /** Render frames with source snippets at each frame's line (the
   *  "snippet at every stop" analog). Caps snippet-bearing frames to keep
   *  token usage bounded on deep stacks. */
  private frameViews(frames: StackFrame[], snippetBudget: number): FrameView[] {
    let snippetsLeft = snippetBudget;
    return frames.map((f) => {
      const file = f.source?.path;
      const view: FrameView = {
        id: f.id,
        name: f.name,
        file,
        sourceName: f.source?.name,
        line: f.line,
        column: f.column,
        presentation: f.presentationHint,
      };
      if (file && snippetsLeft > 0) {
        view.snippet = readContext(file, f.line, 2) ?? undefined;
        if (view.snippet) snippetsLeft--;
      }
      return view;
    });
  }

  private async threadName(threadId: number): Promise<string | undefined> {
    try {
      const r = await this.client!.threads();
      return r.threads.find((t: Thread) => t.id === threadId)?.name;
    } catch { return undefined; }
  }

  private async pickThread(): Promise<number | undefined> {
    // Some adapters (gdb-dap with --no-stop-on-entry) register the thread
    // slightly after the launch response. Retry briefly so `pause` works on a
    // freshly-launched running target instead of failing "no threads".
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await this.client!.threads();
        if (r.threads.length === 1) return r.threads[0].id;
        return r.threads[0]?.id;
      } catch { return undefined; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return undefined;
  }

  private countBreaks(): number {
    let n = 0;
    for (const m of this.lineBreaks.values()) n += m.size;
    n += this.funcBreaks.length;
    return n;
  }

  private detectAdapter(languageId?: string, program?: string): string | undefined {
    if (languageId) {
      const lang = getLanguage(languageId);
      if (lang && languageAdaptersInstalled(lang)) return (lang["debug-adapters"] ?? [])[0];
    }
    if (program) {
      const ext = program.split(".").pop()?.toLowerCase();
      if (ext) {
        for (const lang of allLanguages()) {
          const fts = lang["file-types"] ?? [];
          if (fts.some((ft) => (typeof ft === "string" ? ft === ext : false))) {
            if (languageAdaptersInstalled(lang)) return (lang["debug-adapters"] ?? [])[0];
          }
        }
      }
    }
    return undefined;
  }

  private languageForAdapter(adapterId: string): string | undefined {
    for (const lang of allLanguages()) {
      if ((lang["debug-adapters"] ?? []).includes(adapterId)) return lang.name;
    }
    return undefined;
  }

  private status(): StatusResult {
    const caps = this.caps ?? {};
    return {
      adapter: this.adapterId,
      language: this.languageId,
      mode: this.mode,
      state: this.terminated ? "terminated" : this.stopped ? "stopped" : this.client ? "running" : "none",
      thread: this.currentThreadId,
      frame: this.currentFrameId,
      stopReason: this.lastStop?.reason,
      breakpointCount: this.countBreaks(),
      outputBytes: this.outputBuffer.length,
      caps: {
        functionBreakpoints: Boolean(caps.supportsFunctionBreakpoints),
        conditionalBreakpoints: Boolean(caps.supportsConditionalBreakpoints),
        hitConditionalBreakpoints: Boolean(caps.supportsHitConditionalBreakpoints),
        logPoints: Boolean(caps.supportsLogPoints),
        evaluateForHovers: Boolean(caps.supportsEvaluateForHovers),
        stepBack: Boolean(caps.supportsStepBack),
        setVariable: Boolean(caps.supportsSetVariable),
        terminate: Boolean(caps.supportsTerminateRequest),
      },
    };
  }

  private abs(p: unknown): string {
    const s = String(p);
    if (s.startsWith("/")) return s; // absolute — use as-is
    // Prefer the workspace-relative interpretation when the file lives there
    // (the common `--workspace <dir>; break main.rs` case). If it doesn't,
    // try resolving relative to the invocation cwd — this fixes the
    // double-prefix footgun where `--workspace examples/rust` combined with
    // `break examples/rust/main.rs` would otherwise resolve to
    // `…/examples/rust/examples/rust/main.rs`. Finally fall back to the
    // workspace-relative path for pending breakpoints on files that don't
    // exist yet (e.g. set before the target is built).
    const wsRel = resolve(this.workspaceRoot, s);
    if (existsSync(wsRel)) return wsRel;
    const cwdRel = resolve(s);
    if (existsSync(cwdRel)) return cwdRel;
    return wsRel;
  }

  private resetSession(): void {
    this.client = null;
    this.caps = null;
    this.adapterId = undefined;
    this.languageId = undefined;
    this.mode = undefined;
    this.stopped = false;
    this.terminated = undefined;
    this.initialized = false;
    this.initializedRes = null;
    this.currentThreadId = undefined;
    this.currentFrameId = undefined;
    this.lastFrames = [];
    this.lastStop = undefined;
    this.outputBuffer = "";
    this.stopWaiter = null;
    this.cleanupBunRuntime();
    // Note: breakpoint tables are PRESERVED across sessions so a re-launch
    // re-binds the same set. `clear --all` empties them explicitly.
  }

  async stop(): Promise<void> {
    if (this.client) {
      try { await this.client.disconnect(true); } catch { /* adapter may be gone */ }
      try { await this.client.dispose(); } catch { /* ignore */ }
    }
    if (this.server) { this.server.close(); this.server = null; }
    try { if (existsSync(this.socketPath())) unlinkSync(this.socketPath()); } catch { /* ignore */ }
    try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch { /* ignore */ }
  }
}

// ---- Arg coercion helpers (the CLI builds typed targets; tests can too) ----

export interface LaunchTarget {
  adapterId?: string;
  languageId?: string;
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  /** For tcp-attach adapters (e.g. godot-dap): the port of the DAP server
   *  the user started (e.g. `godot --editor --dap-port 6006`). */
  port?: number;
  /** js-debug-adapter only: override the JS runtime executable (node/bun/deno).
   *  Defaults to node, unless languageId is `bun`/`deno` (resolved automatically). */
  runtimeExecutable?: string;
  /** js-debug-adapter only: extra args for the runtime (e.g. `run --inspect-brk=0` for deno). */
  runtimeArgs?: string[];
}

export interface AttachTarget {
  adapterId?: string;
  languageId?: string;
  program?: string;
  pid?: number;
  port?: number;
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
}

function toLaunch(a: unknown[]): LaunchTarget {
  // a = [target] where target is a LaunchTarget object.
  const t = a[0] as LaunchTarget;
  if (!t || typeof t !== "object" || !t.program) {
    throw new Error("launch requires { program, ... }");
  }
  return t;
}

function toAttach(a: unknown[]): AttachTarget {
  const t = a[0] as AttachTarget;
  if (!t || typeof t !== "object") {
    throw new Error("attach requires { pid|port, ... }");
  }
  return t;
}

/** Extract the trailing options object from a flat args array (the CLI
 *  appends a small Record<string,string|boolean>). Returns {} when absent. */
function optsOf(a: unknown[]): Record<string, unknown> {
  const opts = a[a.length - 1];
  return opts && typeof opts === "object" && !Array.isArray(opts)
    ? (opts as Record<string, unknown>)
    : {};
}

/** Read an optional string flag from the trailing options object. */
function strOpt(a: unknown[], key: string): string | undefined {
  const v = optsOf(a)[key];
  return typeof v === "string" ? (v || undefined) : undefined;
}

/** Read an optional boolean flag from the trailing options object. */
function boolOpt(a: unknown[], key: string): boolean {
  return Boolean(optsOf(a)[key]);
}

function languageAdaptersInstalled(lang: LanguageDef): boolean {
  return languageAdapters(lang).some((a: AdapterDef) => Boolean(whichAdapter(a)));
}

function parseRequest(line: string): DaemonRequest | null {
  const s = line.trim();
  if (!s) return null;
  try {
    return JSON.parse(s) as DaemonRequest;
  } catch {
    return null;
  }
}
