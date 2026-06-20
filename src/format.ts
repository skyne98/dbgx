// Compact, agent-friendly formatting of DAP debug results.
//
// Design principles (copied from lspx's output philosophy):
//  - Human mode: terse, scannable, one finding per line, colorized.
//  - JSON mode (--json): the raw daemon result, lightly normalized.
//  - Snippets ON by default: every stop + every stack frame carries the
//    source line(s) at the stopped line, so an agent never round-trips a
//    read_file just to see where execution is. Disable with --no-snippet.
// Positions are rendered 1-indexed (line:col), matching editors. DAP is
// already 1-indexed on the wire (we advertise linesStartAt1), so no
// arithmetic is needed.

import { relative } from "node:path";
import { c, sym } from "./color.ts";
import { relPath } from "./util.ts";
import type { Snippet, SnippetLine } from "./snippet.ts";
import type {
  LaunchResult,
  ContinueResult,
  WhereResult,
  ThreadsResult,
  ExceptionsResult,
  LocalsResult,
  VarView,
  EvalResult,
  SetVarResult,
  BreakView,
  BreaksResult,
  StatusResult,
  OutputResult,
  FrameView,
} from "./daemon/daemon.ts";

export interface FormatOpts {
  workspaceRoot: string;
  json: boolean;
  /** Include source snippets at each frame. Default: true. */
  snippet?: boolean;
}

/** Workspace-relative path for display (absolute if outside ws). */
function rel(file: string | undefined, ws: string): string | undefined {
  if (!file) return undefined;
  return relPath(file, ws);
}

// ---- Snippet rendering (the focus line underlined by a marker) ----

function renderSnippet(snip: Snippet, focusLine: number, marker: string): string {
  const out: string[] = [];
  const width = String(Math.max(...snip.lines.map((l) => l.n))).length;
  for (const { n, t } of snip.lines) {
    const isFocus = n === focusLine;
    const num = c.dim(String(n).padStart(width));
    const mark = isFocus ? c.cyan(marker) + " " : "  ";
    const line = `${mark}${num} ${c.dim("│")} ${isFocus ? c.bold(t) : t}`;
    out.push(line);
  }
  if (snip.truncated) out.push(c.dim("  … (truncated)"));
  return out.join("\n");
}

/** Render a single frame + its snippet (if any). */
function renderFrame(frame: FrameView, o: FormatOpts, opts: { marker?: string; index?: number; showSnippet?: boolean } = {}): string[] {
  const marker = opts.marker ?? sym.frame;
  const lines: string[] = [];
  const idx = opts.index != null ? c.dim(`[#${opts.index}] `) : "";
  const loc = frame.file ? `${rel(frame.file, o.workspaceRoot)}:${frame.line}:${frame.column}` : `<no source>`;
  const head = `${idx}${c.bold(frame.name)}  ${c.dim(loc)}`;
  lines.push(head);
  if (o.snippet !== false && opts.showSnippet !== false && frame.snippet && frame.file) {
    lines.push(renderSnippet(frame.snippet, frame.line, marker));
  }
  return lines;
}

// ---- Launch / continue (run-until-next-stop) ----

function renderStateHead(r: LaunchResult | ContinueResult, o: FormatOpts): string {
  if (r.state === "terminated") {
    const code = "exitCode" in r && r.exitCode != null ? ` (exit ${r.exitCode})` : "";
    return `${c.red(sym.stop)} ${c.red("terminated")}${c.dim(code)}`;
  }
  if (r.state === "running") {
    return `${c.blue(sym.running)} ${c.blue("running")}`;
  }
  const reason = r.stopReason ? c.dim(`  (${r.stopReason})`) : "";
  const thread = r.threadName ? c.dim(` thread ${r.threadName}${r.threadId != null ? `#${r.threadId}` : ""}`) : "";
  return `${c.green(sym.stop)} ${c.green("stopped")}${reason}${thread}`;
}

/** Render the top frames of a stopped result (the run-until-next-stop
 *  display). Caps at 6 frames; `hint` is appended to the truncation line. */
function renderStoppedFrames(frames: FrameView[], o: FormatOpts, hint = ""): string[] {
  const out: string[] = [];
  frames.slice(0, 6).forEach((f, i) => {
    out.push(...renderFrame(f, o, { marker: i === 0 ? sym.diamond : sym.frame, index: i, showSnippet: i < 3 }));
  });
  if (frames.length > 6) out.push(c.dim(`  … +${frames.length - 6} more frame(s)${hint}`));
  return out;
}

export function formatLaunch(r: LaunchResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify(normalizeLaunch(r, o));
  const out: string[] = [];
  out.push(renderStateHead(r, o));
  out.push(c.dim(`  adapter: ${r.adapter}${r.language ? ` (${r.language})` : ""}  mode: ${r.mode}`));
  if (r.state === "stopped") out.push(...renderStoppedFrames(r.frames, o, " — 'dbgx where' for all"));
  return out.join("\n");
}

export function formatContinue(r: ContinueResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify(normalizeContinue(r, o));
  const out: string[] = [renderStateHead(r, o)];
  if (r.state === "stopped") out.push(...renderStoppedFrames(r.frames, o));
  return out.join("\n");
}

// ---- Where (backtrace) ----

export function formatWhere(r: WhereResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify(normalizeWhere(r, o));
  const out: string[] = [];
  const thread = r.threadName ? c.dim(` thread ${r.threadName}#${r.threadId}`) : c.dim(` thread #${r.threadId}`);
  const reason = r.stopReason ? c.dim(`  stopped: ${r.stopReason}`) : "";
  out.push(`${c.bold("backtrace")}${thread}${reason}`);
  if (!r.frames.length) { out.push(c.dim("  (no frames — is the target stopped?)")); return out.join("\n"); }
  r.frames.forEach((f, i) => {
    const cur = i === r.current;
    const marker = cur ? sym.diamond : sym.frame;
    out.push(...renderFrame(f, o, { marker, index: i, showSnippet: cur || i < 3 }));
  });
  if (r.total != null && r.total > r.frames.length) {
    out.push(c.dim(`  … +${r.total - r.frames.length} more frame(s)`));
  }
  return out.join("\n");
}

// ---- Threads ----

export function formatThreads(r: ThreadsResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify(normalizeThreads(r));
  if (!r.threads.length) return c.dim("(no threads)");
  const out: string[] = [c.bold("threads")];
  const width = String(Math.max(...r.threads.map((t) => t.id))).length;
  for (const t of r.threads) {
    const mark = t.current ? c.cyan(sym.diamond) : " ";
    const id = c.dim(String(t.id).padStart(width));
    // Text label (not a symbol) so it survives non-TTY without colliding with
    // the focus-line markers used in snippets.
    const state = r.stopped ? c.red("stopped") : c.dim("running");
    out.push(`${mark} ${id} ${state}  ${t.name}`);
  }
  return out.join("\n");
}

export function formatExceptions(r: ExceptionsResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify(r);
  const out: string[] = [c.bold("exception breakpoints")];
  if (!r.available.length) {
    out.push(c.dim("  (this adapter reports no exception filters)"));
    return out.join("\n");
  }
  for (const f of r.available) {
    const on = r.enabled.includes(f.filter);
    const mark = on ? c.green(sym.ok) : c.dim("○");
    out.push(`  ${mark} ${c.cyan(f.filter)} — ${f.label}${f.default ? c.dim(" (default)") : ""}`);
  }
  if (!r.enabled.length) out.push(c.dim("  (none enabled — pass a comma-separated list, e.g. 'dbgx exceptions raised,uncaught')"));
  return out.join("\n");
}

// ---- Variables / locals / eval ----

const TREE = { mid: "├─", last: "└─", vert: "│ ", blank: "  " };

function formatValue(v: VarView): string {
  const val = v.value.length > 80 ? v.value.slice(0, 79) + "…" : v.value;
  return v.type ? `${val} ${c.dim(`(${v.type})`)}` : val;
}

function renderVarTree(v: VarView, prefix: string, isLast: boolean, depth: number, maxDepth: number): string[] {
  const branch = isLast ? TREE.last : TREE.mid;
  const childPrefix = prefix + (isLast ? TREE.blank : TREE.vert);
  const name = c.cyan(v.name);
  const ref = v.ref ? c.dim(` ⟶${v.ref}`) : "";
  const line = `${prefix}${branch} ${name} ${c.dim("=")} ${formatValue(v)}${ref}`;
  const out = [line];
  if (depth < maxDepth && v.children && v.children.length) {
    v.children.forEach((c2, i) => {
      out.push(...renderVarTree(c2, childPrefix, i === v.children!.length - 1, depth + 1, maxDepth));
    });
  } else if (v.ref && depth >= maxDepth && (!v.children || !v.children.length)) {
    out.push(`${childPrefix}${c.dim("(expand: dbgx expand " + v.ref + ")")}`);
  }
  return out;
}

export function formatLocals(r: LocalsResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify(normalizeLocals(r));
  // Filter out noisy scopes the agent almost never wants by default:
  //  - "Registers" (lldb-dap exposes CPU register groups as scopes — pure noise
  //    in a `locals` dump; reachable via `expand <ref>` if truly needed)
  //  - scopes whose variables are all `<no-type>` placeholders
  const isNoise = (s: { name: string; variables: { type?: string }[] }) =>
    s.name === "Registers" ||
    (s.variables.length > 0 && s.variables.every((v) => !v.type || v.type === "<no-type>"));
  const scopes = r.scopes.filter((s) => !isNoise(s));
  if (!scopes.length) return c.dim("(no locals — is a frame selected? try 'dbgx where')");
  const out: string[] = [];
  for (const scope of scopes) {
    const tag = scope.expensive ? c.yellow(c.dim(`${scope.name} (expensive)`)) : c.bold(scope.name);
    out.push(tag);
    if (!scope.variables.length) { out.push(c.dim("  (empty)")); continue; }
    scope.variables.forEach((v, i) => {
      out.push(...renderVarTree(v, "", i === scope.variables.length - 1, 0, 1));
    });
  }
  return out.join("\n");
}

export function formatVar(v: VarView | null, depth: number, o: FormatOpts): string {
  if (o.json) return JSON.stringify(v);
  if (!v) return c.yellow("(not found)");
  return renderVarTree(v, "", true, 0, Math.max(1, depth)).join("\n");
}

export function formatEval(r: EvalResult, depth: number, o: FormatOpts): string {
  if (o.json) return JSON.stringify(r);
  const out: string[] = [];
  const type = r.type ? c.dim(` (${r.type})`) : "";
  out.push(`${c.bold("= ")} ${r.result}${type}`);
  if (r.children && r.children.length && depth > 0) {
    const children = r.children;
    children.forEach((v, i) => {
      out.push(...renderVarTree(v, "", i === children.length - 1, 0, depth));
    });
  } else if (r.ref) {
    out.push(c.dim(`(expand: dbgx expand ${r.ref})`));
  }
  return out.join("\n");
}

export function formatSetVar(r: SetVarResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify(r);
  const type = r.type ? c.dim(` (${r.type})`) : "";
  return `${c.green("✓")} ${c.cyan(r.name)} = ${c.bold(r.value)}${type}`;
}

export function formatExpand(vars: VarView[], depth: number, o: FormatOpts): string {
  if (o.json) return JSON.stringify({ variables: vars });
  if (!vars.length) return c.dim("(empty)");
  const last = vars.length - 1;
  return vars.flatMap((v, i) => renderVarTree(v, "", i === last, 0, Math.max(1, depth))).join("\n");
}

// ---- Breakpoints ----

export function formatBreak(b: BreakView, o: FormatOpts): string {
  if (o.json) return JSON.stringify(b);
  const glyph = b.verified ? c.green(sym.ok) : c.yellow("○");
  let loc: string;
  if (b.kind === "line") {
    loc = `${rel(b.file, o.workspaceRoot)}:${b.line}`;
  } else {
    loc = `fn ${b.name}`;
  }
  const extra = [b.condition && c.dim(`if ${b.condition}`), b.hitCondition && c.dim(`hit ${b.hitCondition}`), b.logMessage && c.magenta(`log ${b.logMessage}`)].filter(Boolean).join(" ");
  const state = b.verified ? "" : c.yellow(b.message ? ` (${b.message})` : " (pending)");
  return `${glyph} ${loc}${extra ? " " + extra : ""}${state}`;
}

export function formatBreaks(r: BreaksResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify(r);
  if (!r.breaks.length) return c.dim("(no breakpoints)");
  return r.breaks.map((b) => formatBreak(b, o)).join("\n");
}

// ---- Status ----

export function formatStatus(r: StatusResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify(r);
  const stateColor = r.state === "terminated" ? c.red : r.state === "stopped" ? c.green : r.state === "running" ? c.blue : c.dim;
  const stateSym = r.state === "running" ? sym.running : r.state === "terminated" ? sym.stop : sym.stop;
  const out: string[] = [
    `${c.bold("dbgx")} ${stateColor(stateSym + " " + r.state)}`,
    c.dim(`  adapter: ${r.adapter ?? "none"}${r.language ? ` (${r.language})` : ""}${r.mode ? `  mode: ${r.mode}` : ""}`),
  ];
  if (r.thread != null) out.push(c.dim(`  thread: #${r.thread}` + (r.stopReason ? `  reason: ${r.stopReason}` : "")));
  if (r.processId != null) out.push(c.dim(`  process: #${r.processId}`));
  out.push(c.dim(`  breakpoints: ${r.breakpointCount}  output: ${formatBytes(r.outputBytes)}`));
  if (r.adapter) {
    const caps = Object.entries(r.caps).filter(([, v]) => v).map(([k]) => k);
    out.push(c.dim(`  caps: ${caps.length ? caps.join(", ") : "(none beyond core)"}`));
  }
  return out.join("\n");
}

// ---- Output ----

export function formatOutput(r: OutputResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify({ bytes: r.bytes, truncated: r.truncated, text: r.text });
  if (!r.text) return c.dim(`(no output captured — ${formatBytes(r.bytes)} buffered)`);
  const head = c.dim(`--- debuggee output (${formatBytes(r.bytes)} buffered) ---`);
  return head + "\n" + r.text.trimEnd();
}

// ---- Single frame (frame / up / down) ----

export function formatFrameSelect(r: { index: number; frame?: FrameView }, o: FormatOpts): string {
  if (o.json) return JSON.stringify(r);
  if (!r.frame) return c.dim(`frame #${r.index} (no source)`);
  return renderFrame(r.frame, o, { marker: sym.diamond, index: r.index }).join("\n");
}

// ---- Normalization for --json ----

function normFrame(f: FrameView, ws: string): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    file: rel(f.file, ws),
    line: f.line,
    column: f.column,
    snippet: f.snippet ? f.snippet.lines.map((l: SnippetLine) => ({ n: l.n, t: l.t })) : undefined,
  };
}

function normalizeLaunch(r: LaunchResult, o: FormatOpts) {
  return { state: r.state, adapter: r.adapter, language: r.language, mode: r.mode, threadId: r.threadId, stopReason: r.stopReason, frames: r.frames.map((f) => normFrame(f, o.workspaceRoot)) };
}
function normalizeContinue(r: ContinueResult, o: FormatOpts) {
  return { state: r.state, threadId: r.threadId, stopReason: r.stopReason, exitCode: (r as { exitCode?: number }).exitCode, frames: r.frames.map((f) => normFrame(f, o.workspaceRoot)) };
}
function normalizeWhere(r: WhereResult, o: FormatOpts) {
  return { threadId: r.threadId, current: r.current, stopReason: r.stopReason, total: r.total, frames: r.frames.map((f) => normFrame(f, o.workspaceRoot)) };
}
function normalizeThreads(r: ThreadsResult) {
  return { threads: r.threads, current: r.current, stopped: r.stopped };
}
function normalizeLocals(r: LocalsResult) {
  return { scopes: r.scopes };
}

// ---- Profiling ----

import type { ProfileMeta, ProfileSummary, HotFunction, AnnotatedInstruction } from "./daemon/profile.ts";

export interface ProfileStartResult {
  id: string;
  createdAt: string;
  pid: number;
  adapter: string;
  language?: string;
  program?: string;
  durationMs: number;
  sampleCount: number;
  dataSize: string;
  rate: number;
  endReason: string;
  startFrame?: { name: string; file?: string; line: number; column: number };
  stopFrame?: { name: string; file?: string; line: number; column: number };
}

export function formatProfileStart(r: ProfileStartResult, o: FormatOpts): string {
  if (o.json) return JSON.stringify(r);
  const out: string[] = [];
  out.push(`${c.green("✓")} sample ${c.cyan(r.id)} saved`);
  out.push(c.dim(`  ${r.sampleCount} samples over ${formatMs(r.durationMs)} (${r.dataSize}, ${r.rate}Hz, ${r.endReason})`));
  if (r.startFrame) out.push(c.dim(`  window: ${frameLoc(r.startFrame)}  →  ${r.stopFrame ? frameLoc(r.stopFrame) : "(end)"}`));
  out.push(c.dim(`  next: dbgx profile report ${r.id}   |   dbgx profile annotate ${r.id} <symbol>`));
  return out.join("\n");
}

export function formatProfileList(r: ProfileSummary[], o: FormatOpts): string {
  if (o.json) return JSON.stringify({ samples: r });
  if (!r.length) return c.dim("(no profiling samples — run 'dbgx profile start' between two breakpoints)");
  const out: string[] = [c.bold("samples")];
  for (const s of r) {
    out.push(`  ${c.cyan(s.id)}  ${c.dim(s.createdAt)}  ${formatMs(s.durationMs)}  ${s.sampleCount} samples  ${c.dim(s.endReason)}  ${s.adapter}`);
  }
  out.push(c.dim("\n  report: dbgx profile report <id>   |   annotate: dbgx profile annotate <id> <symbol>"));
  return out.join("\n");
}

export function formatProfileShow(r: ProfileMeta, o: FormatOpts): string {
  if (o.json) return JSON.stringify(r);
  const out: string[] = [`${c.bold("sample")} ${c.cyan(r.id)}`];
  out.push(c.dim(`  created: ${r.createdAt}`));
  out.push(c.dim(`  adapter: ${r.adapter}${r.language ? ` (${r.language})` : ""}   pid: #${r.pid}${r.program ? `   program: ${r.program}` : ""}`));
  out.push(c.dim(`  ${r.sampleCount} samples over ${formatMs(r.durationMs)} (${r.dataSize}, ${r.rate}Hz, ${r.endReason})`));
  if (r.startFrame) out.push(c.dim(`  window start: ${frameLoc(r.startFrame)}`));
  if (r.stopFrame) out.push(c.dim(`  window stop:  ${frameLoc(r.stopFrame)}`));
  out.push(c.dim(`  perf.data: ${r.perfDataPath}`));
  return out.join("\n");
}

export function formatProfileReport(r: { id: string; hotFunctions: HotFunction[] }, o: FormatOpts): string {
  if (o.json) return JSON.stringify(r);
  const out: string[] = [`${c.bold("hot functions")} ${c.dim(`sample ${r.id}`)}`];
  if (!r.hotFunctions.length) { out.push(c.dim("  (no samples — window too short or perf failed)")); return out.join("\n"); }
  for (const f of r.hotFunctions) {
    const pct = `${f.overhead.toFixed(2)}%`.padStart(7);
    const loc = f.file ? c.dim(`  ${rel(f.file, o.workspaceRoot)}:${f.line}`) : "";
    out.push(`  ${c.yellow(pct)}  ${f.symbol}${loc}`);
  }
  out.push(c.dim(`\n  annotate: dbgx profile annotate ${r.id} <symbol>`));
  return out.join("\n");
}

export function formatProfileAnnotate(r: { id: string; symbol: string; instructions: AnnotatedInstruction[] }, o: FormatOpts): string {
  if (o.json) return JSON.stringify(r);
  const out: string[] = [`${c.bold("annotate")} ${c.cyan(r.symbol)} ${c.dim(`sample ${r.id}`)}`];
  if (!r.instructions.length) { out.push(c.dim("  (no instruction samples — try a different symbol, or check perf annotate)")); return out.join("\n"); }
  let curSource: string | undefined;
  for (const ins of r.instructions) {
    if (ins.source && ins.source !== curSource) {
      curSource = ins.source;
      out.push(c.dim(`  ── ${ins.source} ──`));
    }
    const pct = ins.overhead > 0 ? c.yellow(ins.overhead.toFixed(2).padStart(6) + "%") : c.dim("     .");
    out.push(`  ${c.dim(ins.address)}  ${pct}  ${ins.asm}`);
  }
  return out.join("\n");
}

export function formatProfileRm(r: { id: string; removed: boolean }, o: FormatOpts): string {
  if (o.json) return JSON.stringify(r);
  return r.removed ? c.green(`✓ sample ${r.id} removed`) : c.yellow(`(sample ${r.id} not found)`);
}

function frameLoc(f: { name: string; file?: string; line: number; column: number }): string {
  return `${f.name} ${f.file ?? "<no source>"}:${f.line}:${f.column}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

