// Small shared utilities. DAP positions are 1-indexed when the client
// advertises linesStartAt1 (we do), so display needs no arithmetic.

import { createServer } from "node:net";
import { relative } from "node:path";

/** Normalize an absolute path to a workspace-relative display string. */
export function relPath(abs: string, ws: string): string {
  if (!abs) return abs;
  let r = relative(ws, abs);
  if (r.startsWith("..")) {
    // Outside the workspace: show absolute.
    r = abs;
  }
  return r ? r : ".";
}

/** Pick a free TCP port by listening on port 0 and reading the OS-assigned
 *  port, then closing the listener. There's a small TOCTOU window between
 *  close() and the runtime re-binding, but in practice the kernel doesn't
 *  reissue the port that fast. */
export function pickFreePort(): number {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  srv.close();
  if (!port) throw new Error("failed to pick a free port");
  return port;
}

/** Debounce-ish: wait ms. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
