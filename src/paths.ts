// Runtime paths for the dbgx daemon and per-workspace state.

import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const XDG_RUNTIME = process.env.XDG_RUNTIME_DIR || tmpdir();
const XDG_DATA = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");

/** Root dir for all dbgx runtime artifacts. */
export const DBGX_DIR = process.env.DBGX_DIR || join(XDG_DATA, "dbgx");

/** Directory holding the daemon socket, pid file, and logs. */
export const RUNTIME_DIR = join(DBGX_DIR, "runtime");

/** Directory holding per-workspace state (session dumps, output logs). */
export const WORKSPACE_DIR = join(DBGX_DIR, "workspaces");

/** Directory holding saved profiling samples (perf.data + metadata).
 *  Global (not per-workspace) so a GUID from any session resolves here. */
export const PROFILES_DIR = join(DBGX_DIR, "profiles");

/** Path to the single daemon Unix socket (per-workspace variants derived). */
export const SOCKET_PATH = join(RUNTIME_DIR, "daemon.sock");

/** PID file used for health-checking and auto-restart. */
export const PID_PATH = join(RUNTIME_DIR, "daemon.pid");

/** Daemon stdout/stderr log. */
export const LOG_PATH = join(RUNTIME_DIR, "daemon.log");

export function ensureDirs(): void {
  for (const dir of [DBGX_DIR, RUNTIME_DIR, WORKSPACE_DIR, PROFILES_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** A short, filesystem-safe hash of a workspace path (for cache keys). */
export function workspaceHash(ws: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < ws.length; i++) {
    h ^= ws.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function workspaceDir(ws: string): string {
  return join(WORKSPACE_DIR, workspaceHash(ws));
}
