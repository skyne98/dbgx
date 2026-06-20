# dbgx

**DAP-powered debug assistant CLI for AI agents.**

Wraps and unifies many debug adapters (debugpy, `dlv`, `lldb-dap`, …) behind
one terse, snippet-rich interface. The Debug Adapter Protocol is to debuggers
what the Language Server Protocol is to editors — so dbgx is the debugging
sibling of [`lspx`](https://github.com/skyne98/lspx): a persistent
per-workspace daemon owns the debug session; every stop carries the source
line(s) at the stopped position, so an agent never round-trips a `read_file`
just to see where execution is. Output is terse; waits are explicit.
Progress goes to stderr so stdout stays clean for piping and `--json`.

```
$ dbgx break examples/hello.c 6
+ examples/hello.c:6
$ dbgx continue
● stopped  (breakpoint) thread hello#174984
[#0] sum  examples/hello.c:6:15
  5 │     for (int i = 1; i <= n; i++) {
◆ 6 │         total += i;            /* breakpoint here */
  7 │     }
[#1] main  examples/hello.c:13:18
  12 │     int n = 10;
▸ 13 │     int result = sum(n);
```

## Why

Agents debug the way humans do: *launch, set a breakpoint, run until it
fires, inspect locals, step.* Each of those is one short command; every
result carries the source at the stop so the model sees execution context
without a separate file read.

- **One tool, the whole loop** — `launch` → `break` → `continue`
  (run-until-next-stop) → `where` → `locals`/`var`/`eval` → `step` →
  `disconnect`. The daemon persists across `&&`-chained calls, so the
  long-lived, stateful debug session survives between commands exactly the
  way a human's IDE session does.
- **Run-until-next-stop** — `continue`/`next`/`step`/`stepOut`/`pause` send
  the DAP request, then block until the next `stopped` (or `terminated`)
  and return the new stop location + top frames. No fire-and-forget, no
  polling — one command tells the agent exactly where it landed.
- **Snippets at every stop** — each stack frame ships the source line(s)
  around the stopped line, with a focus marker (`◆`) on the current frame.
  `--json` adds a structured `snippet`.
- **Silent when fast, explicit when slow** — a warm `continue` prints
  nothing but the result; a cold adapter boot reports `dbgx: starting
  lldb-dap…` / `launching target…` on stderr so the LLM knows what it's
  waiting on. No spinners, no kill timers.
- **Persistent per-workspace daemon** — auto-spawns on first command,
  survives `&&` chains and repeated calls. One adapter boot per session.
- **Stateful by design** — unlike `lspx` (whose LSP queries are mostly
  stateless), a debug session is inherently stateful, so the daemon owning
  it isn't a convenience — it's essential. The adapter boots lazily on the
  first `launch`/`attach` (there's no target until then).
- **Helix-style `doctor`** — known vs installed debug adapters at a glance.

## Install

Requires [Bun](https://bun.sh) (`>=1.1.0`) and at least one debug adapter
on `$PATH` (e.g. `lldb-dap`, `debugpy`, `dlv`, `netcoredbg`, …).

```bash
bun install -g skyne98/dbgx
```

Then check what's wired up:

```bash
dbgx doctor          # known vs installed adapters
dbgx doctor rust     # filter to one language
```

Debug adapters are provided by your system — install the ones you use
(`pip install debugpy`, `go install github.com/go-delve/delve/cmd/dlv@latest`,
`brew install llvm` for `lldb-dap`, …). dbgx finds them on `$PATH` via the
registry in `src/registry/debuggers.toml`.

## Quick start (the agent loop)

An agent wants to launch a program, stop at a breakpoint, inspect a
variable, and step. Every command after `launch` operates on the same
daemon-owned session, so chain with `&&`:

```bash
# 1. Launch the target, breaking on entry. Boots the adapter (cold) once.
dbgx launch c examples/hello
#   ● stopped  (entry) thread hello#174984

# 2. Set a line breakpoint. (--condition / --hit / --log supported.)
dbgx break examples/hello.c 6 --condition "i > 3"

# 3. Continue → runs until the breakpoint fires, returns where it landed.
dbgx continue
#   ● stopped  (breakpoint)  [#0] sum  examples/hello.c:6:15  …

# 4. Inspect state at the stop.
dbgx where                    # full backtrace (each frame w/ source snippet)
dbgx locals                   # variables in the current frame's scopes
dbgx var total --depth 2      # a structured variable
dbgx eval "i * 2"             # evaluate an expression in the frame

# 5. Step (run-until-next-stop again), then finish up.
dbgx next
dbgx clear examples/hello.c 6
dbgx continue                 # → terminated (exit 0)
dbgx disconnect                # end the session (target killed on launch)
```

Chain with `&&` — the daemon (and the live debug session) persists between
commands, so only the first is cold:

```bash
dbgx continue && dbgx locals && dbgx eval "total"
```

## Commands

Positions are **1-indexed** (line:col), like editors. DAP is 1-indexed on
the wire too (we advertise `linesStartAt1`), so no arithmetic is needed.

### Session

```
dbgx launch <lang> <program> [-- <args>...]   Launch the target (break on entry by default).
        --stop-on-entry / --no-stop-on-entry   (default: stop on entry)
        --cwd <dir>  --env KEY=VAL (repeatable)
dbgx attach <lang> --pid <N> [--program <f>]   Attach to a running process.
dbgx attach <lang> --port <N> [--program <f>]   Attach to a debug port (e.g. node --inspect).
dbgx disconnect [--terminate]                  End the session (detach; --terminate kills target).
dbgx status                                     Session state + capabilities.
```

`<lang>` selects the adapter from the registry (e.g. `python` → `debugpy`,
`go` → `dlv`, `c`/`cpp`/`rust` → `lldb-dap`). Override with `--adapter <id>`.

### Breakpoints

```
dbgx break <f> <l> [--condition <expr>] [--hit <n>] [--log <msg>]   Line breakpoint / logpoint.
dbgx break --func <name> [--condition <expr>] [--hit <n>]           Function breakpoint.
dbgx breaks                                     List breakpoints + verified state.
dbgx clear <f> <l> | clear --func <name> | clear --all   Remove breakpoints.
```

Breakpoints set before `launch` are buffered and bound during the launch
sequence; ones set after launch are applied live (`setBreakpoints` replaces
the per-source set on each call — DAP semantics). A breakpoint shows `+`
when verified/bound and `○` when pending (target not yet running there).

### Execution  (run-until-next-stop)

```
dbgx continue                Continue; stop at next breakpoint/exception/pause.
dbgx next                    Step over.
dbgx step | stepin           Step into.
dbgx stepout                 Step out of the current function.
dbgx stepback                Step backward (if the adapter supports it).
dbgx pause                   Break (pause) the running target.
```

Each of these sends the DAP request, then blocks until the next `stopped`
event (or `terminated`/`exited`) and returns the new stop location + top
frames (with source snippets). If the target terminates, the command
returns `terminated (exit N)`. `pause` works on a running target (e.g. one
launched with `--no-stop-on-entry`) and resolves the thread to pause from the
thread list. When `continue` lands on a `reason=step` stop, dbgx treats it as
a stale thread-plan completion (an interrupted step that lldb keeps pending)
and auto-continues past it, re-waiting for the next real stop — so `continue`
always means "run to the next breakpoint," never "finish a step you abandoned."

### Inspect  (state at a stop — each frame carries a source snippet)

```
dbgx where | bt | backtrace [--depth N]   Stack trace at the stop.
dbgx frame <n>                            Select frame n as the eval/locals context.
dbgx up | down                            Move the frame context up/down.
dbgx threads                              List threads + their state.
dbgx thread <id>                          Switch inspection context (where/locals/eval) to thread <id>.
dbgx exceptions [filter,...|none]          List/enable exception-breakpoint filters (e.g. 'raised,uncaught').
dbgx locals                               Variables in the current frame's scopes.
dbgx var <name> [--depth N]               A specific variable (structured, expandable).
dbgx expand <ref>                         Expand a child by its variablesReference.
dbgx eval <expr> [--depth N]              Evaluate an expression in the current frame.
dbgx setvar <name> <value>                Modify a variable in the current frame.
dbgx output [--tail]                      Drained debuggee stdout/stderr.
```

Structured variables render as a tree (`├─`/`└─`); a variable with children
you haven't expanded shows its `variablesReference` as `⟶N` for
`dbgx expand N`. `--depth N` (capped at 5) expands children recursively.

### Daemon / discovery

```
dbgx daemon              Run the per-workspace daemon in the foreground.
dbgx close [--all]       Stop the daemon (current workspace, or --all).
dbgx doctor [lang]       Known vs installed debug adapters.
dbgx version
dbgx help
```

### Flags

```
--json                     Machine-readable output (normalized result).
--workspace <dir>          Operate on a different workspace (default: $PWD).
--adapter <id>             Force a specific adapter id (see 'doctor').
--language <id>            Force a language id (overrides program-extension detection).
--color / --no-color       Force ANSI colors on/off.
--no-snippet               Omit source snippets (default: include them).
--depth N                  Variable expansion depth / stack-trace frame count.
--condition <expr>         Conditional breakpoint.
--hit <n>                  Hit-count breakpoint.
--log <msg>                Logpoint message.
--stop-on-entry            Break immediately on launch (default).
--no-stop-on-entry         Don't break on entry; run until a breakpoint.
--pid <N>                  Attach by process id.
--port <N>                 Attach to a debug port.
--cwd <dir>                Working directory for the launched target.
--env KEY=VAL              Environment variable for the target (repeatable).
--terminate                With 'disconnect': kill the target instead of detaching.
```

## How it works

```
┌────────┐  unix socket  ┌─────────┐  stdio (DAP)  ┌──────────┐  spawns  ┌────────┐
│ dbgx   │ ───────────▶  │ daemon  │ ────────────▶ │ debug    │ ───────▶ │ target │
│ (CLI)  │  ◀── progress │ (per    │                │ adapter  │          │ (prog) │
│        │               │  ws)    │  ◀── events ── │ (lldb-dap│          └────────┘
└────────┘               └─────────┘  (stopped,…)   │  /debugpy│
                                                        └──────────┘
```

- **Per-workspace daemon** on a Unix socket (`~/.local/share/dbgx/runtime/`).
  Auto-spawns on first command; subsequent commands connect to the same
  one. `dbgx close` tears it down.
- **Lazy adapter boot**: the daemon listens immediately, but the debug
  adapter subprocess only starts on the first `launch`/`attach` (there's
  no target until then). The first command streams its own progress.
- **DAP, not JSON-RPC**: DAP's envelope uses `command`/`arguments`/`type`
  and `event`/`body`, so dbgx hand-rolls the Content-Length framing and a
  seq-based request/response + event dispatcher in `src/dap/client.ts`
  (unlike `lspx`, which leans on `vscode-jsonrpc` because LSP *is*
  JSON-RPC). One subprocess per session; `initialize` → `setBreakpoints` →
  `launch` → `configurationDone` → run.
- **Run-until-next-stop**: execution commands set a single-slot stop waiter
  before sending the DAP request, then await the next `stopped`/
  `terminated`/`exited` event. The caller's own timeout (e.g. the bash
  tool) governs how long a running target may take; a timed-out CLI command
  does NOT lose the session — the daemon keeps it alive, and the next
  command sees the current state.
- **Event-driven state**: `stopped`/`continued`/`terminated`/`exited`/
  `output`/`breakpoint` events update the daemon's session state (current
  thread/frame, captured output, breakpoint verified-ness), so a follow-up
  `where`/`locals`/`status` reflects reality.

## Supported languages

~31 languages are wired in the registry
(`src/registry/debuggers.toml`), mirroring Helix's `languages.toml` schema.
An adapter is "installed" when its binary resolves on `$PATH` via
`Bun.which`. Run `dbgx doctor` to see yours.

| Language | Adapter(s) |
|---|---|
| python | debugpy |
| go | dlv (`dlv dap`) |
| c / c++ / cuda / objective-c | lldb-dap, codelldb, gdb-dap |
| rust / zig / swift / nim | lldb-dap, codelldb, gdb-dap |
| javascript / typescript / jsx / tsx | js-debug-adapter |
| c-sharp / f-sharp | netcoredbg |
| ruby | rdbg (Ruby `debug` gem) |
| java / kotlin | java-debug, kotlin-debug-adapter |
| dart | dart (`dart debug_adapter`) |
| elixir | elixir-ls |
| php | php-debug (Xdebug) |
| haskell | haskell-debugger |
| ocaml | ocaml-earlybird |
| perl | perl-debug (Perl::LanguageServer) |
| r | r-debugger (vscDebugger) |
| lua | lua-debug |
| gdscript | godot-dap |
| powershell | powershell (EditorServices) |
| scala | scala-debug-adapter |

5 adapters are fully tested end-to-end (lldb-dap, debugpy, gdb-dap, dlv,
js-debug-adapter). The remaining 18 are registered with correct invocations
and launch-arg handling; install the toolchain (many via `nix shell`) and run
`dbgx doctor` to verify.

## Adapter transport

Most adapters speak DAP over **stdio** (the daemon spawns them and reads
frames from their stdout). Four transport modes are supported:

| Mode | How it works | Examples |
|---|---|---|
| `stdio` (default) | DAP over the child's stdin/stdout | debugpy, lldb-dap, gdb-dap, dart, haskell-debugger |
| `tcp` | Adapter prints a listening line; dbgx parses host:port and connects | js-debug-adapter, dlv |
| `tcp-allocate` | Adapter takes a `--port` arg; dbgx allocates a free port, substitutes `{port}`, and connects | probe-rs, perl-debug, rdbg |
| `tcp-attach` | Attach-only: dbgx does NOT spawn a process. The user starts the DAP server themselves; dbgx connects to `--port` (or `defaultPort`) | godot-dap |

For `tcp`, dbgx parses host:port from either listening-line format
(js-debug's `listening at HOST:PORT` and dlv's `listening at: HOST:PORT`, plus
IPv6 brackets). For `tcp-allocate`, the `{port}` placeholder in the adapter's
`args` is substituted with a free port dbgx allocates by binding to `:0`.
For `tcp-attach`, the adapter's `defaultPort` in the registry is used if the
caller doesn't pass `--port`.

## Adapter notes

- **dlv** builds the Go package in its spawned process's cwd (the launch
  `cwd` arg only sets the debuggee's runtime cwd, not the build dir). dbgx
  spawns dlv in the program's directory so `go build` finds the module's
  `go.mod`; if `go` isn't on PATH it's looked up in standard locations.
  Requires Go ≥ 1.24 for dlv 1.26+. Exception filters:
  `unrecovered-panic`, `runtime-fatal-throw`.
- **gdb-dap** uses GDB 14+'s built-in DAP interpreter
  (`gdb --interpreter=dap`). Exception filters use bare names
  (`throw`/`catch`/`rethrow`). Threads register late after
  `--no-stop-on-entry`; `pause` retries briefly. Function breakpoints are
  supported.
- **lldb-dap** emits the `launch` response only after `configurationDone`
  is processed, so dbgx fires both without awaiting the launch response.
  Eval uses the `watch` context (not `repl`, which interprets expressions
  as debugger commands).
- **js-debug-adapter** (vscode-js-debug) is TCP-only and uses **nested DAP
  sessions**: the main session is a router that sends a `startDebugging`
  reverse request; dbgx transparently starts a nested session on the same
  TCP server (where breakpoints bind `verified:true`) and re-emits its
  `initialized` event. The main session's early `initialized` is swallowed
  so breakpoints only set on the nested session.
- **dart / flutter**: `dart debug_adapter` / `flutter debug_adapter` (stdio).
  Breakpoints resolve asynchronously after the VM starts.
- **php-debug** (vscode-php-debug): standalone `node out/phpDebug.js`. Needs
  Xdebug configured in `php.ini` (`xdebug.mode=debug`,
  `xdebug.start_with_request=yes`).
- **probe-rs** / **perl-debug** / **rdbg**: TCP adapters that take a `--port`
  arg (tcp-allocate transport). probe-rs needs a physical debug probe + chip
  config. rdbg is both adapter and launcher (the program is passed via the
  `script` launch arg).
- **kotlin-debug-adapter**: a standalone JAR (`java -jar`). dbgx locates the
  JAR via `{kotlinAdapterJar}` placeholder resolution. Needs `mainClass` +
  classpath in the launch config.
- **scala-debug-adapter**: runs inside an SBT session (an sbt plugin), not as
  a standalone spawn — requires the `sbt-debug-adapter` plugin in
  `build.sbt`.
- **godot-dap**: Attach-only (`tcp-attach` transport). dbgx does NOT spawn
  the editor — the user starts it themselves, then attaches:
  ```bash
  godot --editor --dap-port 6006 --path /my/project   # terminal 1
  dbgx launch gdscript --port 6006                     # terminal 2
  ```
  The editor runs the DAP server; the `launch` DAP request tells the editor
  to start the game with debugging. Requires a display (the game can't run
  headless). Default port 6006 (overridable via `--port`).
- **powershell**: pwsh runs `Start-EditorServices.ps1`, which opens a DAP
  server and writes the port to a session-details JSON.

## License

Apache-2.0.
