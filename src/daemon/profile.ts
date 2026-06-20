// Profiling samples: bounded-window CPU profiling coordinated with a debug
// session. dbgx owns the bookend breakpoints + the debuggee PID; `perf`
// (Linux) is the sidecar sampler, spawned attached to the PID, continued
// across the resumed window, and stopped (SIGINT) at the exit breakpoint.
//
// Samples are stored globally (not per-workspace) in PROFILES_DIR, keyed by a
// GUID the caller references in subsequent `profile report/annotate/show`
// commands. Each sample is two files:
//   <guid>.perf.data   — the raw perf.data (binary, passed to perf report/annotate)
//   <guid>.meta.json   — metadata (PID, bookend frame, duration, sample count, …)
//
// Why perf: it samples via perf_event_open (a kernel API independent of
// ptrace), so it can sample a process that's ALSO being debugged by lldb/gdb.
// The bounded window (between two breakpoints) keeps output agent-friendly:
// not a whole-app flamegraph, but a micro-profile of one tick. perf annotate
// then gives per-instruction sample % mapped to source lines — the "did the
// compiler fuck us" view (inlining, branch misses, missed vectorization).
//
// Linux-only by design (perf is Linux). The disassembly-via-DAP half (the
// `annotate` command's live correlation) is cross-platform; this perf-backed
// sampling half is not.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { PROFILES_DIR } from "../paths.ts";

/** A saved profiling sample's metadata (sidecar to <guid>.perf.data). */
export interface ProfileMeta {
  /** The GUID handle the caller references this sample by. */
  id: string;
  /** When the sample was captured (ISO timestamp). */
  createdAt: string;
  /** The debuggee's OS PID at capture time. */
  pid: number;
  /** The adapter that owned the debuggee (e.g. "lldb-dap"). */
  adapter: string;
  /** The language being debugged (e.g. "rust"). */
  language?: string;
  /** The program path. */
  program?: string;
  /** The frame where sampling STARTED (entry bookend). */
  startFrame?: { name: string; file?: string; line: number; column: number };
  /** The frame where sampling STOPPED (exit bookend, or termination). */
  stopFrame?: { name: string; file?: string; line: number; column: number };
  /** Wall-clock duration the sampler ran (ms). */
  durationMs: number;
  /** perf's reported sample count (parsed from perf record's stderr). */
  sampleCount: number;
  /** perf's reported data size (human string, e.g. "0.004 MB"). */
  dataSize: string;
  /** Sampling rate in Hz. */
  rate: number;
  /** How the window ended: "breakpoint" (exit bookend fired), "terminated"
   *  (debuggee exited first), or "interrupted" (perf killed before a clean end). */
  endReason: "breakpoint" | "terminated" | "interrupted";
  /** The absolute path to the perf.data file. */
  perfDataPath: string;
}

export interface ProfileSummary {
  id: string;
  createdAt: string;
  adapter: string;
  language?: string;
  durationMs: number;
  sampleCount: number;
  endReason: string;
}

/** One row in the `profile report` hot-functions table. */
export interface HotFunction {
  /** Sample percentage (of total, not self). */
  overhead: number;
  /** Shared object / binary name (e.g. "demo", "libc.so.6"). */
  object: string;
  /** Symbol name (e.g. "demo::main", "main", "[unknown]"). */
  symbol: string;
  /** Source file (when perf resolved it), else undefined. */
  file?: string;
  /** Source line (when resolved). */
  line?: number;
}

/** One instruction in the `profile annotate` disassembly. */
export interface AnnotatedInstruction {
  /** Sample percentage on THIS instruction (self). */
  overhead: number;
  /** The address (hex string, e.g. "0x40047e"). */
  address: string;
  /** The raw ASM. */
  asm: string;
  /** Source file:line mapped by perf (-l), if any. */
  source?: string;
}

/** Generate a short GUID-style id (16 hex chars). */
function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Paths for a sample id. */
function pathsFor(id: string) {
  return {
    perfData: `${PROFILES_DIR}/${id}.perf.data`,
    meta: `${PROFILES_DIR}/${id}.meta.json`,
  };
}

// ---- Capture ----

/**
 * Run the bounded-window profiler. Assumes the debuggee is CURRENTLY STOPPED
 * at the entry bookend. Spawns `perf record -p <pid>`, calls `continueFn`
 * (which resumes the debuggee until the next stop/termination), then SIGINTs
 * perf, waits for it to flush, and saves the sample.
 *
 * Returns the saved sample's metadata. Throws on perf failure or if the PID
 * is unknown.
 */
export async function captureSample(
  pid: number,
  rate: number,
  continueFn: () => Promise<{ kind: "stopped" | "terminated"; frame?: { name: string; file?: string; line: number; column: number } }>,
  meta: { adapter: string; language?: string; program?: string; startFrame?: { name: string; file?: string; line: number; column: number } },
  onProgress?: (msg: string) => void,
): Promise<ProfileMeta> {
  if (!pid || pid <= 0) throw new Error("no debuggee PID — the adapter didn't report a `process` event");
  const id = newId();
  const { perfData, meta: metaPath } = pathsFor(id);
  const start = Date.now();

  onProgress?.(`starting perf (sampling at ${rate}Hz, pid ${pid})…`);
  // perf record: -F <rate> sample freq, -g call graphs, -o output, -p attach.
  // stderr is captured for parsing the sample count + data size summary line.
  const perf: ChildProcess = spawn("perf", ["record", "-F", String(rate), "-g", "-o", perfData, "-p", String(pid)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  perf.stderr?.setEncoding("utf-8");
  perf.stderr?.on("data", (chunk: string) => { stderrBuf += chunk; });

  // Wait for perf to actually start sampling (it prints nothing on success —
  // give it a beat). If it exits immediately (bad pid, permissions), bail.
  await new Promise<void>((resolve, reject) => {
    const failTimer = setTimeout(() => {
      // perf has been alive for 300ms without error — assume it's sampling.
      resolve();
    }, 300);
    perf.once("exit", (code) => {
      // An early exit (before failTimer) means perf failed to start.
      clearTimeout(failTimer);
      reject(new Error(`perf exited immediately (code ${code}). stderr:\n${stderrBuf.slice(-600)}`));
    });
  });

  // Resume the debuggee. Runs until the exit bookend (stopped) or termination.
  onProgress?.("sampling… (will stop at next breakpoint or termination)");
  const outcome = await continueFn();

  // Stop perf: SIGINT makes it flush + write the perf.data cleanly.
  onProgress?.("stopping perf (flushing samples)…");
  let perfExitCode: number | null = null;
  await new Promise<void>((resolve) => {
    perf.once("exit", (code) => { perfExitCode = code; resolve(); });
    try { perf.kill("SIGINT"); } catch { /* already gone */ }
    // Hard fallback if SIGINT doesn't land within 5s.
    setTimeout(() => { try { perf.kill("SIGKILL"); } catch { /* */ } }, 5000);
  });

  const durationMs = Date.now() - start;
  const { sampleCount, dataSize } = parsePerfRecordStderr(stderrBuf);
  const endReason: ProfileMeta["endReason"] =
    outcome.kind === "stopped" ? "breakpoint" : "terminated";

  const m: ProfileMeta = {
    id,
    createdAt: new Date().toISOString(),
    pid,
    adapter: meta.adapter,
    language: meta.language,
    program: meta.program,
    startFrame: meta.startFrame,
    stopFrame: outcome.frame,
    durationMs,
    sampleCount,
    dataSize,
    rate,
    endReason,
    perfDataPath: perfData,
  };
  writeFileSync(metaPath, JSON.stringify(m, null, 2) + "\n");
  return m;
}

/** Parse perf record's stderr for the "Captured and wrote X MB (N samples)" line. */
function parsePerfRecordStderr(stderr: string): { sampleCount: number; dataSize: string } {
  // [ perf record: Captured and wrote 0.004 MB /tmp/foo.perf.data (23 samples) ]
  const m = /Captured and wrote\s+([\d.]+\s*\w+)\s+\S+\s+\((\d+)\s+samples\)/.exec(stderr);
  if (m) return { sampleCount: parseInt(m[2], 10), dataSize: m[1] };
  return { sampleCount: 0, dataSize: "0 B" };
}

// ---- Store access ----

/** Load a sample's metadata by id. Throws if not found. */
export function loadMeta(id: string): ProfileMeta {
  const { meta } = pathsFor(id);
  if (!existsSync(meta)) throw new Error(`no profiling sample with id '${id}' — run 'dbgx profile list'`);
  return JSON.parse(readFileSync(meta, "utf-8")) as ProfileMeta;
}

/** List all saved samples (newest first). */
export function listSamples(): ProfileSummary[] {
  if (!existsSync(PROFILES_DIR)) return [];
  const out: ProfileSummary[] = [];
  for (const name of readdirSync(PROFILES_DIR)) {
    if (!name.endsWith(".meta.json")) continue;
    try {
      const m = JSON.parse(readFileSync(`${PROFILES_DIR}/${name}`, "utf-8")) as ProfileMeta;
      out.push({
        id: m.id, createdAt: m.createdAt, adapter: m.adapter, language: m.language,
        durationMs: m.durationMs, sampleCount: m.sampleCount, endReason: m.endReason,
      });
    } catch { /* corrupt meta — skip */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Delete a sample (both files). */
export function deleteSample(id: string): boolean {
  const { perfData, meta } = pathsFor(id);
  let removed = false;
  for (const p of [perfData, meta]) {
    if (existsSync(p)) { try { unlinkSync(p); removed = true; } catch { /* */ } }
  }
  return removed;
}

// ---- Analysis (perf report / perf annotate parsing) ----

/** Run `perf report --stdio` and parse the hot-functions table.
 *  Returns the top functions by self-overhead. */
export async function hotFunctions(id: string, limit: number = 20): Promise<HotFunction[]> {
  const m = loadMeta(id);
  const stdout = await runPerf(["report", "-i", m.perfDataPath, "--stdio", "--no-children"]);
  return parseHotFunctions(stdout, limit);
}

/** Run a perf command, collect all stdout, return it. Throws on non-zero exit. */
function runPerf(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("perf", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.setEncoding("utf-8");
    p.stdout.on("data", (c: string) => { stdout += c; });
    p.stderr.setEncoding("utf-8");
    p.stderr.on("data", (c: string) => { stderr += c; });
    p.on("error", (e) => reject(new Error(`failed to spawn perf: ${e.message}`)));
    p.on("exit", (code) => {
      // perf report/annotate exit non-zero on empty data; still return stdout.
      if (code && code !== 0 && !stdout) reject(new Error(`perf ${args.join(" ")} exited ${code}: ${stderr.slice(-400)}`));
      else resolve(stdout);
    });
  });
}

/** Parse perf report's --stdio output. The table looks like:
 *      100.00%  loop     loop                  [.] main
 *        0.00%  loop     ld-linux-x86-64.so.2  [.] __GI___tunables_init
 *  Lines before the first %-prefixed row are headers; stop at the first blank
 *  line after rows begin (the "Source code & Disassembly" section follows). */
function parseHotFunctions(report: string, limit: number): HotFunction[] {
  const rows: HotFunction[] = [];
  for (const line of report.split("\n")) {
    // Match:  leading %, then 3 tokens (overhead, object, binary), then [.] symbol
    const m = /^\s+([\d.]+)%\s+(\S+)\s+(\S+)\s+\[\.]\s+(.+)$/.exec(line);
    if (m) {
      const sym = m[4].trim();
      const fn: HotFunction = { overhead: parseFloat(m[1]), object: m[3], symbol: sym };
      // perf annotate -l sometimes appends " // file:line" to the symbol.
      const src = /(.+?)\s+\/\/\s+(.+?):(\d+)$/.exec(sym);
      if (src) { fn.symbol = src[1].trim(); fn.file = src[2]; fn.line = parseInt(src[3], 10); }
      rows.push(fn);
    }
  }
  return rows.slice(0, limit);
}

/** Run `perf annotate --stdio -l <symbol>` and parse the disassembly.
 *  Each instruction line: `    3.45 :   40047e:  movl -0x8(%rbp), %edx // loop.c:4` */
export async function annotateFunction(id: string, symbol: string, limit: number = 200): Promise<AnnotatedInstruction[]> {
  const m = loadMeta(id);
  const stdout = await runPerf(["annotate", "-i", m.perfDataPath, "--stdio", "-l", symbol]);
  return parseAnnotate(stdout, limit);
}

/** Parse perf annotate's --stdio output. Each instruction line:
 *      3.45 :   40047e:        movl -0x8(%rbp), %edx // loop.c:4
 *  The `// file:line` is the source mapping (only present with -l when perf
 *  resolved the address to source). */
function parseAnnotate(text: string, limit: number): AnnotatedInstruction[] {
  const rows: AnnotatedInstruction[] = [];
  for (const line of text.split("\n")) {
    //   63.23 :   40047e:        movl -0x8(%rbp), %edx // loop.c:4
    const m = /^\s+([\d.]+)\s*:\s+([0-9a-fx]+):\s*(.+?)(?:\s*\/\/\s*(.+))?$/.exec(line);
    if (m) {
      rows.push({
        overhead: parseFloat(m[1]),
        address: m[2],
        asm: m[3].trim(),
        source: m[4]?.trim(),
      });
    }
  }
  return rows.slice(0, limit);
}
