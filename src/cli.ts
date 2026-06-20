// dbgx command dispatch.
//
// The CLI is the only interface (no MCP). Following the agent-browser model:
// a persistent per-workspace daemon owns the debug-adapter session; each CLI
// command connects to it (auto-spawning on first use), issues one request,
// and prints compact output. `--json` gives machine-readable output.
//
// The debug loop is stateful and long-lived: launch a target (or attach),
// set breakpoints, step/continue (each run-until-next-stop), inspect state
// (where/locals/eval), then disconnect. Every stop carries a source snippet
// so an agent sees execution context without a separate read_file.

import { resolve, join } from "node:path";
import { readdirSync, unlinkSync } from "node:fs";
import { renderDoctor } from "./doctor.ts";
import { Daemon } from "./daemon/daemon.ts";
import type { LaunchTarget, AttachTarget } from "./daemon/daemon.ts";

/** Parsed flag value union. `string[]` is for repeatable args (e.g. --runtime-args). */
type Flags = Record<string, boolean | string | number | Record<string, string> | string[]>;

import { ensureDaemon, call, socketForWorkspace } from "./daemon/rpc.ts";
import { RUNTIME_DIR } from "./paths.ts";
import type { DaemonRequest } from "./daemon/protocol.ts";
import type { ProgressSink } from "./progress.ts";
import {
  formatLaunch,
  formatContinue,
  formatWhere,
  formatThreads,
  formatExceptions,
  formatLocals,
  formatVar,
  formatEval,
  formatSetVar,
  formatExpand,
  formatBreak,
  formatBreaks,
  formatStatus,
  formatOutput,
  formatFrameSelect,
  type FormatOpts,
} from "./format.ts";
import { c } from "./color.ts";

const VERSION = "0.1.0";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Flags;
  /** Tokens after a bare `--` (the debuggee's own args, for `launch`). */
  passthrough: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Flags = {};
  const positional: string[] = [];
  const passthrough: string[] = [];
  let inPassthrough = false;
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (inPassthrough) { passthrough.push(a); continue; }
    if (a === "--") { inPassthrough = true; continue; }
    if (a === "--color") flags.color = true;
    else if (a === "--no-color") flags.color = false;
    else if (a === "--no-snippet") flags.snippet = false;
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "-v" || a === "--version") flags.version = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--adapter") flags.adapter = argv[++i] ?? "";
    else if (a === "--language") flags.language = argv[++i] ?? "";
    else if (a === "--workspace" || a === "-w") flags.workspace = argv[++i] ?? "";
    else if (a === "--depth") flags.depth = Number(argv[++i]) || 1;
    else if (a === "--condition") flags.condition = argv[++i] ?? "";
    else if (a === "--hit") flags.hit = argv[++i] ?? "";
    else if (a === "--log") flags.log = argv[++i] ?? "";
    else if (a === "--func") flags.func = argv[++i] ?? "";
    else if (a === "--pid") flags.pid = Number(argv[++i]) || 0;
    else if (a === "--port") flags.port = Number(argv[++i]) || 0;
    else if (a === "--cwd") flags.cwd = argv[++i] ?? "";
    else if (a === "--runtime-executable") flags.runtimeExecutable = argv[++i] ?? "";
    else if (a === "--runtime-args") {
      const v = argv[++i] ?? "";
      const arr = Array.isArray(flags.runtimeArgs) ? flags.runtimeArgs as string[] : [];
      arr.push(v);
      flags.runtimeArgs = arr;
    }
    else if (a === "--env") { const kv = argv[++i] ?? ""; const eq = kv.indexOf("="); if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1); }
    else if (a === "--stop-on-entry") { flags.stopOnEntry = true; }
    else if (a === "--no-stop-on-entry") { flags.stopOnEntry = false; }
    else if (a === "--terminate") flags.terminate = true;
    else if (a === "--tail") flags.tail = true;
    else if (a === "--all") flags.all = true;
    else if (a.startsWith("--")) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  if (Object.keys(env).length) flags.env = env;
  return { command: positional[0] ?? "help", positional: positional.slice(1), flags, passthrough };
}

function workspaceRoot(flags: Flags): string {
  const w = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  return resolve(w);
}

function fmtOpts(flags: Flags): FormatOpts {
  return {
    workspaceRoot: workspaceRoot(flags),
    json: !!flags.json,
    snippet: flags.snippet !== false,
  };
}

function daemonOpts(flags: Flags): {
  adapterId?: string;
  languageId?: string;
} {
  return {
    adapterId: typeof flags.adapter === "string" ? flags.adapter : undefined,
    languageId: typeof flags.language === "string" ? flags.language : undefined,
  };
}

/** Progress sink for the CLI: one dim line to stderr. stdout stays clean
 *  for the result / --json output, so progress never corrupts JSON. */
function cliProgress(): ProgressSink {
  return (msg) => {
    process.stderr.write(`${c.dim("dbgx: ")}${c.dim(msg)}\n`);
  };
}

export function usage(): string {
  return [
    "dbgx — DAP-powered debugging for AI agents",
    "",
    "USAGE",
    "  dbgx <command> [args] [--json] [--workspace <dir>] [--adapter <id>]",
    "  dbgx <command> -h        # help for a command",
    "",
    "SESSION",
    "  launch <lang> <program> [-- <args>...]   Start a debug session (launch the target).",
    "          --stop-on-entry / --no-stop-on-entry   (default: stop on entry)",
    "          --cwd <dir>  --env KEY=VAL (repeatable)",
    "          --runtime-executable <path>  --runtime-args <arg> (repeatable)",
    "              (js-debug-adapter only: override node; e.g. bun, deno)",
    "  attach <lang> --pid <N> [--program <f>]  Attach to a running process by pid.",
    "  attach <lang> --port <N> [--program <f>]  Attach to a debug port (e.g. node --inspect).",
    "  disconnect [--terminate]                 End the session (detach; --terminate kills target).",
    "  status                                    Session state + capabilities.",
    "",
    "BREAKPOINTS",
    "  break <f> <l> [--condition <expr>] [--hit <n>] [--log <msg>]   Line breakpoint / logpoint.",
    "  break --func <name> [--condition <expr>] [--hit <n>]           Function breakpoint.",
    "  breaks                                     List breakpoints + verified state.",
    "  clear <f> <l> | clear --func <name> | clear --all   Remove breakpoints.",
    "",
    "EXECUTION  (run-until-next-stop; report where execution lands)",
    "  continue                Continue; stop at next breakpoint/exception/pause.",
    "  next                    Step over.",
    "  step | stepin           Step into.",
    "  stepout                 Step out of the current function.",
    "  stepback                Step backward (if the adapter supports it).",
    "  pause                   Break (pause) the running target.",
    "",
    "INSPECT  (state at a stop — each frame carries a source snippet)",
    "  where | bt | backtrace [--depth N]   Stack trace at the stop.",
    "  frame <n>                            Select frame n as the eval/locals context.",
    "  up | down                            Move the frame context up/down.",
    "  threads                              List threads + their state.",
    "  thread <id>                          Switch inspection context to thread <id>.",
    "  exceptions [filter,...|none]          List/set exception-breakpoint filters.",
    "  locals                               Variables in the current frame's scopes.",
    "  var <name> [--depth N]               A specific variable (structured).",
    "  expand <ref>                         Expand a child by its variablesReference.",
    "  eval <expr> [--depth N]              Evaluate an expression in the current frame.",
    "  setvar <name> <value>               Assign a new value to a variable (if supported).",
    "  output [--tail]                      Drained debuggee stdout/stderr.",
    "",
    "DAEMON / DISCOVERY",
    "  daemon                 Run the per-workspace daemon in the foreground.",
    "  close [--all]          Stop the daemon.",
    "  doctor [lang]          Known vs installed debug adapters.",
    "  version                Print version.",
    "  help                   Show this help.",
    "",
    "COMMON FLAGS",
    "  --json                 Machine-readable output (normalized result).",
    "  --workspace <dir>      Operate on a different workspace (default: $PWD).",
    "  --adapter <id>         Force a specific adapter (see 'doctor').",
    "  --language <id>         Force a language id.",
    "  --color/--no-color     Force ANSI colors on/off.",
    "  --no-snippet           Omit source snippets (default: include them).",
    "",
    "EXAMPLES",
    "  dbgx doctor                       # which adapters are installed?",
    "  dbgx launch python src/app.py     # stop on entry",
    "  dbgx break src/app.py 42 --condition 'x > 10'",
    "  dbgx continue                      # run → stops, shows frame + source line",
    "  dbgx where                         # full backtrace with snippets",
    "  dbgx locals | dbgx var cfg --depth 2",
    "  dbgx eval 'len(cfg.items)'",
    "  dbgx disconnect",
    "",
    "The daemon auto-starts on first use and persists between commands,",
    "so the session survives `&&` chains like:  dbgx continue && dbgx locals",
  ].join("\n");
}

export async function run(argv: string[]): Promise<number> {
  const { command, positional, flags, passthrough } = parseArgs(argv);

  if (flags.color !== undefined) {
    const { setColorEnabled } = await import("./color.ts");
    setColorEnabled(Boolean(flags.color));
  }

  if (flags.version || command === "version") {
    console.log(`dbgx ${VERSION}`);
    return 0;
  }
  if (flags.help || command === "help" || command === undefined) {
    console.log(usage());
    return 0;
  }

  switch (command) {
    case "doctor":
    case "health":
      console.log(renderDoctor(positional[0]));
      return 0;
    case "daemon":
      return runDaemon(flags);
    case "status":
      return await runSimple(flags, { m: "status" }, (r) => formatStatus(r as never, fmtOpts(flags)));
    case "close":
    case "stop":
    case "quit":
      return await runClose(flags);
    case "launch":
      return await runLaunch(flags, positional, passthrough);
    case "attach":
      return await runAttach(flags, positional);
    case "disconnect":
    case "detach":
      return await runSimple(flags, { m: "disconnect", a: [Boolean(flags.terminate)] }, (r) => {
        if (flags.json) return JSON.stringify(r);
        return c.green("✓ session ended");
      });
    case "break":
    case "bp":
      return await runBreak(flags, positional);
    case "breaks":
    case "breakpoints":
      return await runSimple(flags, { m: "breaks" }, (r) => formatBreaks(r as never, fmtOpts(flags)));
    case "clear":
    case "remove":
      return await runClear(flags, positional);
    case "continue":
    case "cont":
    case "c":
      return await runSimple(flags, { m: "continue" }, (r) => formatContinue(r as never, fmtOpts(flags)));
    case "next":
    case "over":
      return await runSimple(flags, { m: "next" }, (r) => formatContinue(r as never, fmtOpts(flags)));
    case "step":
    case "stepin":
    case "into":
      return await runSimple(flags, { m: "stepIn" }, (r) => formatContinue(r as never, fmtOpts(flags)));
    case "stepout":
    case "out":
      return await runSimple(flags, { m: "stepOut" }, (r) => formatContinue(r as never, fmtOpts(flags)));
    case "stepback":
    case "back":
      return await runSimple(flags, { m: "stepBack" }, (r) => formatContinue(r as never, fmtOpts(flags)));
    case "pause":
    case "break-now":
      return await runSimple(flags, { m: "pause" }, (r) => formatContinue(r as never, fmtOpts(flags)));
    case "where":
    case "bt":
    case "backtrace":
      return await runSimple(flags, { m: "where", a: [Number(flags.depth ?? 20)] }, (r) => formatWhere(r as never, fmtOpts(flags)));
    case "frame":
      return await runSimple(flags, { m: "frame", a: [Number(positional[0] ?? 0)] }, (r) => formatFrameSelect(r as never, fmtOpts(flags)));
    case "up":
      return await runSimple(flags, { m: "up" }, (r) => formatFrameSelect(r as never, fmtOpts(flags)));
    case "down":
      return await runSimple(flags, { m: "down" }, (r) => formatFrameSelect(r as never, fmtOpts(flags)));
    case "threads":
    case "ts":
      return await runSimple(flags, { m: "threads" }, (r) => formatThreads(r as never, fmtOpts(flags)));
    case "exceptions":
    case "exc":
      return await runSimple(flags, { m: "exceptions", a: [positional[0] ?? ""] }, (r) => formatExceptions(r as never, fmtOpts(flags)));
    case "thread":
      return await runSimple(flags, { m: "thread", a: [Number(positional[0] ?? 0)] }, (r) => formatFrameSelect(r as never, fmtOpts(flags)));
    case "locals":
    case "vars":
      return await runSimple(flags, { m: "locals" }, (r) => formatLocals(r as never, fmtOpts(flags)));
    case "var":
    case "p":
      return await runSimple(flags, { m: "var", a: [positional[0], Number(flags.depth ?? 1)] }, (r) => formatVar(r as never, Number(flags.depth ?? 1), fmtOpts(flags)));
    case "expand":
      return await runSimple(flags, { m: "expand", a: [Number(positional[0] ?? 0)] }, (r) => formatExpand(r as never, Number(flags.depth ?? 1), fmtOpts(flags)));
    case "eval":
    case "e":
      return await runEval(flags, positional);
    case "setvar":
      return await runSetVar(flags, positional);
    case "output":
    case "out":
      return await runSimple(flags, { m: "output", a: [Boolean(flags.tail)] }, (r) => formatOutput(r as never, fmtOpts(flags)));
    default:
      console.error(`${c.red("error")}: unknown command '${command}'\n`);
      console.error(usage());
      return 2;
  }
}

// ---- Command implementations ----

async function runDaemon(flags: Flags): Promise<number> {
  const ws = workspaceRoot(flags);
  const adapterId = typeof flags.adapter === "string" ? flags.adapter : undefined;
  const languageId = typeof flags.language === "string" ? flags.language : undefined;
  const daemon = new Daemon({ workspaceRoot: ws, adapterId, languageId });
  await daemon.start();
  console.error(`${c.green("✓")} dbgx daemon ready for ${c.cyan(ws)}`);
  console.error(`  socket: ${daemon.socketPath()}`);
  console.error(`  (Ctrl-C or 'dbgx close' to stop; launch a target to boot an adapter)`);
  const stopped = new Promise<void>((res) => {
    const handler = () => { void daemon.stop().then(res); };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  });
  await stopped;
  console.error(`${c.dim("daemon stopped")}`);
  return 0;
}

async function runLaunch(
  flags: Flags,
  positional: string[],
  passthrough: string[],
): Promise<number> {
  if (positional.length < 2) {
    console.error(`${c.red("error")}: expected <language> <program> [-- <args>...]`);
    return 1;
  }
  const target: LaunchTarget = {
    languageId: positional[0],
    program: positional[1],
    args: passthrough.length ? passthrough : undefined,
    cwd: typeof flags.cwd === "string" ? flags.cwd : undefined,
    env: typeof flags.env === "object" ? (flags.env as Record<string, string>) : undefined,
    stopOnEntry: flags.stopOnEntry === undefined ? undefined : Boolean(flags.stopOnEntry),
    adapterId: typeof flags.adapter === "string" ? flags.adapter : undefined,
    port: typeof flags.port === "number" && flags.port > 0 ? flags.port : undefined,
    runtimeExecutable: typeof flags.runtimeExecutable === "string" && flags.runtimeExecutable ? flags.runtimeExecutable : undefined,
    runtimeArgs: Array.isArray(flags.runtimeArgs) ? (flags.runtimeArgs as string[]) : undefined,
  };
  return await runSimple(flags, { m: "launch", a: [target] }, (r) => formatLaunch(r as never, fmtOpts(flags)));
}

async function runAttach(
  flags: Flags,
  positional: string[],
): Promise<number> {
  const pid = typeof flags.pid === "number" && flags.pid > 0 ? flags.pid : undefined;
  const port = typeof flags.port === "number" && flags.port > 0 ? flags.port : undefined;
  if (positional.length < 1 && !pid && !port) {
    console.error(`${c.red("error")}: expected <language> with --pid <N> or --port <N>`);
    return 1;
  }
  const target: AttachTarget = {
    languageId: positional[0],
    program: positional[1],
    pid,
    port,
    cwd: typeof flags.cwd === "string" ? flags.cwd : undefined,
    env: typeof flags.env === "object" ? (flags.env as Record<string, string>) : undefined,
    stopOnEntry: flags.stopOnEntry === undefined ? undefined : Boolean(flags.stopOnEntry),
    adapterId: typeof flags.adapter === "string" ? flags.adapter : undefined,
  };
  return await runSimple(flags, { m: "attach", a: [target] }, (r) => formatLaunch(r as never, fmtOpts(flags)));
}

async function runBreak(
  flags: Flags,
  positional: string[],
): Promise<number> {
  const opts: Record<string, unknown> = {};
  if (typeof flags.func === "string") opts.func = flags.func;
  if (typeof flags.condition === "string") opts.condition = flags.condition;
  if (typeof flags.hit === "string") opts.hit = flags.hit;
  if (typeof flags.log === "string") opts.log = flags.log;
  const a: unknown[] = [...positional, opts];
  return await runSimple(flags, { m: "break", a }, (r) => formatBreak(r as never, fmtOpts(flags)));
}

async function runClear(
  flags: Flags,
  positional: string[],
): Promise<number> {
  const opts: Record<string, unknown> = {};
  if (flags.all) opts.all = true;
  if (typeof flags.func === "string") opts.func = flags.func;
  const a: unknown[] = [...positional, opts];
  return await runSimple(flags, { m: "clear", a }, (r) => {
    if (flags.json) return JSON.stringify(r);
    const cleared = (r as { cleared?: number }).cleared ?? 0;
    return cleared ? c.green(`✓ cleared ${cleared} breakpoint${cleared === 1 ? "" : "s"}`) : c.yellow("(nothing to clear)");
  });
}

async function runEval(
  flags: Flags,
  positional: string[],
): Promise<number> {
  if (positional.length < 1) {
    console.error(`${c.red("error")}: expected <expression>`);
    return 1;
  }
  return await runSimple(
    flags,
    { m: "eval", a: [positional.join(" "), Number(flags.depth ?? 1)] },
    (r) => formatEval(r as never, Number(flags.depth ?? 1), fmtOpts(flags)),
  );
}

async function runSetVar(
  flags: Flags,
  positional: string[],
): Promise<number> {
  if (positional.length < 2) {
    console.error(`${c.red("error")}: expected <name> <value>`);
    return 1;
  }
  // value may contain spaces — join everything after the name.
  const name = positional[0];
  const value = positional.slice(1).join(" ");
  return await runSimple(
    flags,
    { m: "setvar", a: [name, value] },
    (r) => formatSetVar(r as never, fmtOpts(flags)),
  );
}

async function runSimple(
  flags: Flags,
  req: DaemonRequest,
  render: (r: unknown) => string,
): Promise<number> {
  try {
    const ws = workspaceRoot(flags);
    const onProgress = cliProgress();
    const handle = await ensureDaemon(ws, daemonOpts(flags), onProgress);
    const res = await call(handle.socketPath, req, onProgress);
    if (!res.ok) throw new Error(res.e ?? "daemon error");
    console.log(render(res.r));
    return 0;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runClose(flags: Flags): Promise<number> {
  if (flags.all) {
    // Enumerate every daemon socket in the runtime dir and shut them all down.
    let stopped = 0;
    let live = 0;
    for (const name of readdirSync(RUNTIME_DIR)) {
      if (!name.startsWith("daemon-") || !name.endsWith(".sock")) continue;
      const sock = join(RUNTIME_DIR, name);
      live++;
      try {
        const res = await call(sock, { m: "shutdown" });
        if (res.ok) stopped++;
      } catch {
        // stale socket (no listener) — remove the orphan.
        try { unlinkSync(sock); } catch { /* ignore */ }
      }
    }
    if (live === 0) { console.log(c.dim("no daemons running")); return 0; }
    console.log(c.green(`✓ stopped ${stopped}/${live} daemon(s)`));
    return stopped === live ? 0 : 1;
  }
  const ws = workspaceRoot(flags);
  const sock = socketForWorkspace(ws);
  try {
    const res = await call(sock, { m: "shutdown" });
    console.log(res.ok ? c.green("✓ daemon stopped") : c.red(`✘ ${res.e ?? "failed"}`));
    return res.ok ? 0 : 1;
  } catch (err) {
    console.error(`${c.red("error")}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
