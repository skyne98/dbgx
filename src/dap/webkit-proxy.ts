/**
 * WebKit Inspector Protocol → V8 CDP translating proxy for Bun.
 *
 * Bun speaks the WebKit Inspector Protocol (JavaScriptCore), not V8 CDP.
 * The two share the same JSON-RPC-over-WebSocket framing but differ in:
 *   1. Bun needs `Inspector.enable` before other domains, and
 *      `Inspector.initialized` to start JS execution (replaces
 *      `Runtime.runIfWaitingForDebugger`).
 *   2. `Runtime.getProperties` response uses `{properties: [...]}` instead
 *      of V8's `{result: [...]}`.
 *   3. Breakpoint conditions go in `options: {condition}` instead of a
 *      top-level `condition` field.
 *   4. `Debugger.setBreakpointsActive({active: true})` must be called after
 *      `Debugger.enable` or breakpoints silently never fire (bun quirk).
 *   5. `Debugger.getPossibleBreakpoints` → `Debugger.getBreakpointLocations`
 *      (different request/response shape).
 *   6. `Debugger.setBlackboxPatterns` → N × `Debugger.setShouldBlackboxURL`.
 *   7. Bun reports script URLs without `file://` prefix (e.g. `/path/x.ts`).
 *      js-debug sets breakpoints with `file://` URLs → translate.
 *
 * The proxy sits between js-debug-adapter (V8 CDP client) and Bun's
 * inspector WebSocket (WebKit server), translating messages in both
 * directions. This lets dbgx reuse js-debug-adapter for all the DAP work
 * (stepping, variables, source maps, etc.) while speaking WebKit to Bun.
 *
 * Architecture:
 *   dbgx → spawns bun --inspect-brk → parses ws:// URL from stderr
 *        → starts WebKitProxy on a local port (the "shim port")
 *        → serves /json shim pointing to the proxy port
 *        → js-debug attaches to the proxy port
 *        → proxy connects to bun's real ws:// URL
 *        → translates bidirectionally
 *
 * Uses Bun's built-in WebSocket (global) + Bun.serve for the server.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { pickFreePort } from "../util.ts";

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
interface JsonRpcEvent {
  method: string;
  params: Record<string, unknown>;
}
type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcEvent;

type WsServer = ReturnType<typeof Bun.serve>;
import type { ServerWebSocket } from "bun";
type WsSocket = ServerWebSocket<unknown>;
type WsClient = WebSocket;

/** A WebKit Inspector → V8 CDP translating proxy. Connects to bun's WS on
 *  construction; accepts one js-debug connection via `listen()`. */
export class WebKitProxy {
  private bunWs: WsClient | null = null;
  private jsDebugWs: WsSocket | null = null;
  private server: WsServer | null = null;
  private requestMap = new Map<number, string>(); // js-debug id → method
  private proxyIdCounter = 0;
  private pendingProxied = new Map<number, number>(); // proxy id → js-debug id
  private inspectorInitialized = false;
  private child: ChildProcess | null = null;
  private entryProgram: string | null = null;
  /** Temp entry breakpoint id (removed after first pause). */
  private tempBpId: string | null = null;
  /** Bun-initiated request handlers (for Inspector.enable etc.). */
  private bunRequestHandlers = new Map<number, (resp: JsonRpcResponse) => void>();

  /** bare url → scriptId (from scriptParsed events). Used to look up the
   *  scriptId for a setBreakpointByUrl request so the target location can be
   *  registered in `protectedLocations` (for probe-bp retention). */
  private urlToScriptId = new Map<string, string>();

  /** Resolved breakpoint locations: bpId → "scriptId:line" (from
   *  breakpointResolved events). Used to look up a bp's location when
   *  js-debug sends removeBreakpoint, to check if removal should be
   *  suppressed (see `protectedLocations`). */
  private bpLocations = new Map<string, string>();

  /** Locations where a real breakpoint is in-flight or failed to resolve
   *  (returned locations: []). When js-debug removes a *probe* bp whose
   *  resolved location is in this set, the removal is suppressed — the
   *  probe is acting as a stand-in for the unresolved real bp.
   *  Cleaned up when a response arrives with locations (resolved →
   *  remove from the set so the probe can be removed normally). */
  private protectedLocations = new Set<string>();

  /** proxyId → "scriptId:line" for in-flight setBreakpointByUrl requests,
   *  so the response handler can clean up `protectedLocations`. */
  private pendingBpKeys = new Map<number, string>();

  /** Spawn `bun --inspect-brk <program>`, parse the ws:// URL from stderr,
   *  connect to it, and send `Inspector.enable`. Returns the local port the
   *  proxy listens on for js-debug. */
  async start(program: string, args: string[], cwd: string, env: Record<string, string>): Promise<number> {
    const exe = (typeof Bun !== "undefined" ? Bun.which("bun") : null) ?? "bun";
    const inspectPort = pickFreePort();
    this.child = spawn(exe, [`--inspect-brk=127.0.0.1:${inspectPort}`, program, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.entryProgram = program;

    // Parse ws:// URL from bun's stderr.
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for bun inspector ws:// URL")), 15000);
      let stderrBuf = "";
      this.child!.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const m = stderrBuf.match(/ws:\/\/(?:127\.0\.0\.1|localhost):\d+\/\S+/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0].replace(/[` ].*$/, ""));
        }
      });
      this.child!.on("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(
          `bun exited (code=${code} signal=${signal}) before opening inspector — ` +
          (stderrBuf.trim() ? `stderr:\n${stderrBuf.trim().slice(-800)}` : "no output"),
        ));
      });
    });

    // Connect to bun's WS (Bun's built-in WebSocket client).
    this.bunWs = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout connecting to bun inspector WS")), 5000);
      this.bunWs!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.bunWs!.addEventListener("error", () => { clearTimeout(timer); reject(new Error("failed to connect to bun inspector WS")); }, { once: true });
    });

    // Set up bun→jsDebug message forwarding (with translation).
    this.bunWs.addEventListener("message", (event: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)) as JsonRpcMessage;
        this.translateBunToJsDebug(msg);
      } catch { /* ignore malformed */ }
    });

    // Send Inspector.enable (WebKit prerequisite).
    await this.sendToBun("Inspector.enable");

    // Start listening for js-debug via Bun.serve (WebSocket server).
    const port = this.listen();
    return port;
  }

  /** Start a Bun.serve WebSocket + HTTP server on a free port.
   *  Serves /json discovery endpoints AND handles WS upgrades on the same port. */
  private listen(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      websocket: {
        open: (ws: WsSocket) => {
          if (this.jsDebugWs) { ws.close(); return; }
          this.jsDebugWs = ws;
        },
        message: (ws: WsSocket, data: string | Buffer) => {
          try {
            const msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as JsonRpcMessage;
            this.translateJsDebugToBun(msg);
          } catch { /* ignore */ }
        },
      },
      fetch: (req, server) => {
        const path = new URL(req.url).pathname;
        // Serve /json discovery endpoints (so js-debug can find the target).
        const wsUrl = `ws://127.0.0.1:${server.port}/bun`;
        if (path === "/json/version") {
          return new Response(JSON.stringify({
            Browser: "Bun", "Protocol-Version": "1.3",
            webSocketDebuggerUrl: wsUrl,
          }), { headers: { "Content-Type": "application/json" } });
        }
        if (path === "/json" || path === "/json/list") {
          return new Response(JSON.stringify([{
            id: "bun-target", type: "node", title: "bun",
            url: "file://", webSocketDebuggerUrl: wsUrl,
          }]), { headers: { "Content-Type": "application/json" } });
        }
        // WebSocket upgrade.
        if (req.headers.get("upgrade") === "websocket") {
          server.upgrade(req, { data: null });
          return;
        }
        return new Response("Not found", { status: 404 });
      },
    });
    const port = this.server.port;
    if (!port) throw new Error("failed to bind proxy port");
    return port;
  }

  // ---- js-debug → Bun (request translation) ----

  private translateJsDebugToBun(msg: JsonRpcMessage): void {
    if (!("id" in msg) || !("method" in msg)) return;
    const { id, method, params } = msg as JsonRpcRequest;
    this.requestMap.set(id, method);

    switch (method) {
      // Start JS execution: translate to Inspector.initialized (once).
      // Also set breakpoints active + a temp entry breakpoint (line 1 of the
      // entry script via urlRegex) so the script pauses at entry — giving
      // js-debug's breakpoints time to bind before execution races past.
      // The temp bp is removed after the first pause.
      case "Runtime.runIfWaitingForDebugger": {
        if (!this.inspectorInitialized) {
          this.inspectorInitialized = true;
          this.handleInspectorInit(id);
        } else {
          this.sendResponseToJsDebug(id, {});
        }
        return;
      }

      // setBreakpointByUrl: Bun's `url` (exact match) doesn't resolve breakpoints
      // for already-parsed scripts (returns locations: [] + no breakpointResolved).
      // Convert `url` → `urlRegex` (exact-match regex works). Drop columnNumber
      // (Bun's setBreakpointByUrl doesn't honor it and it can cause conflicts).
      // If the response has locations: [], track it as unresolved so we can
      // suppress removal of probe bps at the same location.
      case "Debugger.setBreakpointByUrl": {
        const p = params ?? {};
        const condition = typeof p.condition === "string" ? p.condition : undefined;
        const translated: Record<string, unknown> = { lineNumber: p.lineNumber ?? 0 };
        let scriptId: string | undefined;
        if (p.urlRegex) {
          translated.urlRegex = p.urlRegex;
        } else if (typeof p.url === "string") {
          const bare = p.url.replace(/^file:\/\//, "");
          translated.urlRegex = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
          scriptId = this.urlToScriptId.get(bare);
        }
        if (condition) translated.options = { condition };
        // Forward, and if we know the scriptId, register the location as
        // protected so probe-bp removal at the same location is suppressed.
        const proxyId = ++this.proxyIdCounter;
        this.pendingProxied.set(proxyId, id);
        const req: JsonRpcRequest = { id: proxyId, method, params: translated };
        this.bunWs?.send(JSON.stringify(req));
        if (scriptId) {
          const key = `${scriptId}:${p.lineNumber ?? 0}`;
          this.protectedLocations.add(key);
          this.pendingBpKeys.set(proxyId, key);
        }
        return;
      }

      // removeBreakpoint: if this would remove a probe bp that's standing in
      // for an unresolved real bp at the same location, suppress the removal.
      case "Debugger.removeBreakpoint": {
        const p = params ?? {};
        const bpId = p.breakpointId as string;
        const loc = this.bpLocations.get(bpId);
        if (loc && this.protectedLocations.has(loc)) {
          // Suppress removal — this probe bp is acting as a stand-in.
          this.sendResponseToJsDebug(id, {});
          return;
        }
        this.forwardRequest(id, method, params);
        return;
      }

      // setBreakpoint (by scriptId): move condition to options.
      case "Debugger.setBreakpoint": {
        const p = params ?? {};
        const translated: Record<string, unknown> = { location: p.location };
        if (typeof p.condition === "string") translated.options = { condition: p.condition };
        else if (p.options) translated.options = p.options;
        this.forwardRequest(id, method, translated);
        return;
      }

      // getPossibleBreakpoints → getBreakpointLocations.
      case "Debugger.getPossibleBreakpoints": {
        const p = params ?? {};
        const start = p.start as { scriptId: string; lineNumber: number };
        const end = (p.end as { scriptId: string; lineNumber: number }) ?? start;
        this.forwardRequest(id, "Debugger.getBreakpointLocations", {
          start: { scriptId: start.scriptId, lineNumber: start.lineNumber },
          end: { scriptId: end.scriptId, lineNumber: end.lineNumber },
        });
        return;
      }

      // setBlackboxPatterns → N × setShouldBlackboxURL.
      case "Debugger.setBlackboxPatterns": {
        const patterns = (params?.patterns as string[]) ?? [];
        if (patterns.length === 0) { this.sendResponseToJsDebug(id, {}); return; }
        Promise.all(patterns.map((pat) =>
          this.sendToBun("Debugger.setShouldBlackboxURL", { url: pat, caseSensitive: false, shouldBlackbox: true }),
        )).then(() => this.sendResponseToJsDebug(id, {}))
          .catch((e) => this.sendResponseToJsDebug(id, undefined, { code: 0, message: String(e) }));
        return;
      }

      default:
        this.forwardRequest(id, method, params);
        return;
    }
  }

  /** Forward a request to bun, tracking proxy id → js-debug id. */
  private forwardRequest(jsDebugId: number, method: string, params: Record<string, unknown> | undefined): void {
    const proxyId = ++this.proxyIdCounter;
    this.pendingProxied.set(proxyId, jsDebugId);
    const req: JsonRpcRequest = { id: proxyId, method, params };
    this.bunWs?.send(JSON.stringify(req));
  }

  // ---- Bun → js-debug (response/event translation) ----

  private translateBunToJsDebug(msg: JsonRpcMessage): void {
    // Response: check if it's for a proxy-initiated request (Inspector.enable etc.)
    if ("id" in msg && !("method" in msg)) {
      const resp = msg as JsonRpcResponse;
      // Check proxy-initiated handler first.
      const handler = this.bunRequestHandlers.get(resp.id);
      if (handler) {
        this.bunRequestHandlers.delete(resp.id);
        handler(resp);
        return;
      }
      // Otherwise it's a response to a forwarded js-debug request.
      const jsDebugId = this.pendingProxied.get(resp.id);
      if (jsDebugId === undefined) {
        return;
      }
      this.pendingProxied.delete(resp.id);

      // Check if this was a tracked setBreakpointByUrl: clean up the
      // protected location. If the bp resolved (locations non-empty),
      // stop protecting so probe removal proceeds normally. If it didn't
      // resolve (locations: []), keep protecting — the probe stays as a
      // stand-in for the unresolved real bp.
      const bpKey = this.pendingBpKeys.get(resp.id);
      if (bpKey) {
        this.pendingBpKeys.delete(resp.id);
        const result = resp.result as Record<string, unknown> | undefined;
        const locations = (result?.locations as unknown[]) ?? [];
        if (locations.length > 0) {
          this.protectedLocations.delete(bpKey);
        }
      }

      const originalMethod = this.requestMap.get(jsDebugId);
      let result = resp.result;
      if (originalMethod === "Runtime.getProperties") {
        result = this.translateGetPropertiesResult(resp.result as Record<string, unknown>);
      } else if (originalMethod === "Debugger.getBreakpointLocations") {
        result = this.translateBreakpointLocationsResult(resp.result as Record<string, unknown>);
      }
      this.sendResponseToJsDebug(jsDebugId, result, resp.error);
      return;
    }

    // Event: translate as needed.
    const event = msg as JsonRpcEvent;
    if (event.method === "Debugger.scriptParsed" && event.params) {
      const url = event.params.url as string;
      // Track scriptId → url for setBreakpointByUrl → setBreakpoint conversion.
      if (url && url.startsWith("/")) {
        this.urlToScriptId.set(url, event.params.scriptId as string);
      }
      // Add file:// prefix so js-debug can match source files.
      if (url && url.startsWith("/") && !url.startsWith("bun:")) {
        event.params.url = `file://${url}`;
      }
    }
    // On first pause after init: remove the temp entry breakpoint so it
    // doesn't fire again (the real breakpoints are now set by js-debug).
    if (event.method === "Debugger.paused" && this.tempBpId) {
      const bpId = this.tempBpId;
      this.tempBpId = null;
      this.sendToBun("Debugger.removeBreakpoint", { breakpointId: bpId }).catch(() => { /* already gone */ });
    }
    // Track resolved breakpoint locations (for removeBreakpoint suppression).
    if (event.method === "Debugger.breakpointResolved" && event.params) {
      const loc = event.params.location as { scriptId: string; lineNumber: number } | undefined;
      if (loc) {
        this.bpLocations.set(event.params.breakpointId as string, `${loc.scriptId}:${loc.lineNumber}`);
      }
    }
    // Forward event to js-debug (paused, resumed, scriptParsed, etc. are shared).
    this.jsDebugWs?.send(JSON.stringify(event));
  }

  private async handleInspectorInit(jsDebugId: number): Promise<void> {
    try {
      await this.sendToBun("Debugger.setBreakpointsActive", { active: true });
      await this.sendToBun("Debugger.setPauseForInternalScripts", { shouldPause: false });
      if (this.entryProgram) {
        const filename = this.entryProgram.split("/").pop() ?? this.entryProgram;
        const urlRegex = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
        try {
          const r = await this.sendToBun("Debugger.setBreakpointByUrl", { lineNumber: 1, urlRegex }) as { breakpointId?: string };
          if (r?.breakpointId) this.tempBpId = r.breakpointId;
        } catch { /* temp bp optional */ }
      }
      await this.sendToBun("Inspector.initialized");
      this.sendResponseToJsDebug(jsDebugId, {});
    } catch (e) {
      this.sendResponseToJsDebug(jsDebugId, undefined, { code: 0, message: String(e) });
    }
  }

  private translateGetPropertiesResult(result: Record<string, unknown> | undefined): unknown {
    if (!result) return result;
    const r = { ...result } as Record<string, unknown>;
    if ("properties" in r && !("result" in r)) {
      r.result = r.properties;
      delete r.properties;
    }
    return r;
  }

  private translateBreakpointLocationsResult(result: Record<string, unknown> | undefined): unknown {
    if (!result) return result;
    const locations = (result.locations as Array<Record<string, unknown>>) ?? [];
    return {
      ...result,
      locations: locations.map((loc) => ({
        scriptId: loc.scriptId,
        lineNumber: loc.lineNumber,
        columnNumber: loc.columnNumber ?? 0,
      })),
    };
  }

  // ---- Low-level helpers ----

  /** Send a proxy-initiated request to bun (not from js-debug). */
  private sendToBun(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.proxyIdCounter;
      const req: JsonRpcRequest = { id, method, params };
      const timer = setTimeout(() => {
        this.bunRequestHandlers.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, 10000);
      this.bunRequestHandlers.set(id, (resp: JsonRpcResponse) => {
        clearTimeout(timer);
        if (resp.error) reject(new Error(resp.error.message));
        else resolve(resp.result);
      });
      this.bunWs?.send(JSON.stringify(req));
    });
  }

  private sendResponseToJsDebug(id: number, result: unknown, error?: JsonRpcResponse["error"]): void {
    const resp: JsonRpcResponse = { id, result, ...(error ? { error } : {}) };
    this.jsDebugWs?.send(JSON.stringify(resp));
  }

  close(): void {
    if (this.child) { try { this.child.kill("SIGTERM"); } catch { /* */ } this.child = null; }
    if (this.bunWs) { try { this.bunWs.close(); } catch { /**/ } this.bunWs = null; }
    if (this.server) { try { this.server.stop(); } catch { /**/ } this.server = null; }
    this.jsDebugWs = null;
  }
}
