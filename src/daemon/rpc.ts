// Client-side RPC over the daemon's Unix socket.
//
// `ensureDaemon()` auto-spawns the daemon for the current workspace if it
// isn't already running (agent-browser style). `call()` sends one request
// and reads the final response, forwarding any interleaved progress notes
// to an `onProgress` sink so the agent sees latency as it happens.
//
// There are NO strict kill-timeouts here: connect errors are immediate
// (local sockets refuse synchronously when no listener is present), and
// the caller's own timeout (e.g. the bash tool) governs how long a slow
// request may take. The only hard cap is a generous readiness wait for the
// daemon process itself, which fails fast if that process exits.

import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { SOCKET_PATH, LOG_PATH, ensureDirs, workspaceHash } from "../paths.ts";
import { isProgressNote, type DaemonRequest, type DaemonResponse } from "./protocol.ts";
import { phase, type ProgressSink } from "../progress.ts";
import { sleep } from "../util.ts";

export interface DaemonHandle {
  workspaceRoot: string;
  socketPath: string;
  /** True iff a daemon process was freshly spawned by this call. */
  spawned: boolean;
}

/** Per-workspace socket path (matches the daemon's scheme). */
export function socketForWorkspace(ws: string): string {
  return SOCKET_PATH.replace("daemon.sock", `daemon-${workspaceHash(ws)}.sock`);
}

/** Is the daemon's socket currently connectable (i.e. a process is listening)? */
function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Connect (and auto-spawn if needed) to the daemon for a workspace.
 * Reports "starting daemon…" if the spawn phase is slow. Does NOT wait for
 * the debug adapter to boot — that happens lazily on the first request
 * (launch/attach), which streams its own progress. Fails fast if the
 * spawned daemon exits before its socket appears.
 */
export async function ensureDaemon(
  workspaceRoot: string,
  opts: { adapterId?: string; languageId?: string } = {},
  onProgress?: ProgressSink,
): Promise<DaemonHandle> {
  ensureDirs();
  const ws = resolve(workspaceRoot);
  const sock = socketForWorkspace(ws);

  if (await isListening(sock)) {
    return { workspaceRoot: ws, socketPath: sock, spawned: false };
  }

  // Spawn a fresh daemon (detached; it manages its own lifetime).
  const args = [
    process.argv[1] ?? "",
    "daemon",
    "--workspace",
    ws,
    ...(opts.adapterId ? ["--adapter", opts.adapterId] : []),
    ...(opts.languageId ? ["--language", opts.languageId] : []),
  ];
  const child = spawn(process.execPath, args, {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, DBGX_DAEMON: "1" },
  });
  child.unref();

  let exitCode: number | null = null;
  child.on("exit", (code) => {
    exitCode = code;
  });

  // Wait for the socket to appear + become connectable.
  await phase(
    "starting daemon",
    async () => {
      while (exitCode === null && !(await isListening(sock))) {
        await sleep(80);
      }
    },
    onProgress,
  );

  if (exitCode !== null) {
    throw new Error(
      `daemon exited (code ${exitCode}) before becoming ready.\n` +
        tailLog(),
    );
  }

  return { workspaceRoot: ws, socketPath: sock, spawned: true };
}

/** Send one request, reading progress notes until the final response. */
export function call(
  socketPath: string,
  req: DaemonRequest,
  onProgress?: ProgressSink,
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    sock.setEncoding("utf-8");
    sock.on("connect", () => {
      sock.write(JSON.stringify(req) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // skip malformed lines
        }
        if (isProgressNote(obj)) {
          onProgress?.(obj.progress);
          continue;
        }
        sock.destroy();
        resolve(obj as DaemonResponse);
        return;
      }
    });
    sock.on("error", (err) => {
      reject(
        new Error(`cannot reach daemon at ${socketPath}: ${err.message}`),
      );
    });
  });
}

/** Last ~30 lines of the daemon log, for surfacing boot failures. */
export function tailLog(): string {
  try {
    if (!existsSync(LOG_PATH)) return "";
    const text = readFileSync(LOG_PATH, "utf-8");
    const lines = text.split("\n").filter(Boolean);
    return "--- daemon.log (tail) ---\n" + lines.slice(-30).join("\n");
  } catch {
    return "";
  }
}
