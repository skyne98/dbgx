// Focused subset of the Debug Adapter Protocol (DAP) type surface.
//
// Unlike LSP (where lspx re-exports the canonical `vscode-languageserver-
// protocol` package, ubiquitous and large), DAP has no equally ubiquitous
// npm package we want to lean on, and the subset dbgx uses is small. So we
// hand-roll just the interfaces we send/receive. This mirrors lspx's
// philosophy — "only the surface an agent needs" — expressed here as a
// tight, self-contained module rather than a re-export.
//
// DAP is NOT JSON-RPC: its envelope is
//   request :  { seq, type:"request",  command, arguments }
//   response:  { seq, type:"response", request_seq, success, body?, message? }
//   event   :  { seq, type:"event",    event, body }
// so the client (./client.ts) hand-rolls framing + a seq-based dispatcher
// instead of reusing vscode-jsonrpc (which speaks JSON-RPC proper).
//
// Positions: DAP is 1-indexed for line/column when the client advertises
// linesStartAt1 / columnsStartAt1 (we do), so no +1 conversion is needed
// for display — unlike LSP, which is 0-indexed on the wire.

// ---- Capabilities (initialize response) ----

export interface Capabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsLogPoints?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsStepBack?: boolean;
  supportsSetVariable?: boolean;
  supportsRestartFrame?: boolean;
  supportsGotoTargetsRequest?: boolean;
  supportsStepInTargetsRequest?: boolean;
  supportsCompletionsRequest?: boolean;
  supportsModulesRequest?: boolean;
  supportsTerminateRequest?: boolean;
  supportsTerminateDebuggee?: boolean;
  supportsDelayedStackTraceLoading?: boolean;
  supportsLoadedSourcesRequest?: boolean;
  supportsExceptionInfoRequest?: boolean;
  supportsExceptionOptions?: boolean;
  supportsValueFormattingOptions?: boolean;
  supportsSingleThreadExecutionRequests?: boolean;
  supportsMultipleBreakpointsPerLine?: boolean;
  exceptionBreakpointFilters?: ExceptionBreakpointsFilter[];
}

export interface ExceptionBreakpointsFilter {
  filter: string;
  label: string;
  default?: boolean;
  description?: string;
  supportsCondition?: boolean;
}

// ---- Sources + frames ----

export interface Source {
  name?: string;
  path?: string;
  sourceReference?: number;
  presentationHint?: "normal" | "emphasize" | "deemphasize";
  origin?: string;
}

export interface StackFrame {
  id: number;
  name: string;
  source?: Source;
  line: number; // 1-indexed
  column: number; // 1-indexed
  endLine?: number;
  endColumn?: number;
  canRestart?: boolean;
  presentationHint?: "normal" | "label" | "subtle";
}

export interface Thread {
  id: number;
  name: string;
}

export interface Scope {
  name: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  expensive: boolean;
  source?: Source;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  evaluateName?: string;
  memoryReference?: string;
  presentationHint?: VariablePresentationHint;
}

export interface VariablePresentationHint {
  kind?: string;
  attributes?: string[];
  visibility?: string;
  lazy?: boolean;
}

// ---- Breakpoints ----

export interface Breakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: Source;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  /** "pending" = set but not yet bound (target not running there). */
  reason?: "pending" | "changed" | "removed";
}

export interface BreakpointLocation {
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

// ---- Evaluate ----

export interface EvaluateResponse {
  result: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
  presentationHint?: VariablePresentationHint;
}

export interface SetVariableArgs {
  variablesReference: number;
  name: string;
  value: string;
}

export interface SetVariableResponse {
  value: string;
  type?: string;
  variablesReference?: number;
  namedVariables?: number;
  indexedVariables?: number;
}

// ---- Events (body shapes) ----

export interface StoppedEvent {
  reason: string; // "step" | "breakpoint" | "exception" | "pause" | "entry" | "thread start" | …
  description?: string;
  threadId?: number;
  preserveFocusHint?: boolean;
  allThreadsStopped?: boolean;
  /** "only" = only this thread stopped; "all" = all threads stopped. */
  hitBreakpointIds?: number[];
}

export interface ContinuedEvent {
  threadId?: number;
  allThreadsContinued?: boolean;
}

export interface OutputEvent {
  category?: "console" | "important" | "stdout" | "stderr" | "telemetry";
  output: string;
  group?: "start" | "startCollapsed" | "end";
  variablesReference?: number;
  source?: Source;
  line?: number;
  column?: number;
  data?: unknown;
}

export interface TerminatedEvent {
  restart?: boolean;
}

export interface ExitedEvent {
  exitCode: number;
}

export interface BreakpointEvent {
  reason: "changed" | "new" | "removed";
  breakpoint: Breakpoint;
}

export interface ThreadEvent {
  reason: "started" | "exited";
  threadId: number;
}

export interface ModuleEvent {
  reason: "new" | "changed" | "removed";
}

// ---- Generic request args (subset) ----

export interface InitializeArgs {
  clientID?: string;
  clientName?: string;
  adapterID: string;
  locale?: string;
  linesStartAt1?: boolean;
  columnsStartAt1?: boolean;
  pathFormat?: "path" | "uri";
  supportsVariableType?: boolean;
  supportsVariablePaging?: boolean;
  supportsRunInTerminalRequest?: boolean;
  supportsMemoryReferences?: boolean;
  supportsProgressReporting?: boolean;
  supportsInvalidatedEvent?: boolean;
  supportsMemoryEvent?: boolean;
}

/** Launch/attach args are adapter-specific; we pass the common fields plus
 *  any adapter extras. dbgx normalizes {program, args, cwd, env, stopOnEntry}
 *  and merges adapter defaults from the registry. */
export interface LaunchArgs {
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  console?: "internalConsole" | "integratedTerminal" | "externalTerminal";
  /** Adapter-specific extras (mode, python, port, …) merged on top. */
  [key: string]: unknown;
}

export interface AttachArgs extends LaunchArgs {
  pid?: number | string;
  port?: number | string;
  [key: string]: unknown;
}

export interface SetBreakpointsArgs {
  source: { path?: string; name?: string; sourceReference?: number };
  breakpoints?: { line: number; column?: number; condition?: string; hitCondition?: string; logMessage?: string }[];
  lines?: number[];
  sourceModified?: boolean;
}

export interface SetBreakpointsResponse {
  breakpoints: Breakpoint[];
}

export interface StackTraceArgs {
  threadId: number;
  startFrame?: number;
  levels?: number;
  format?: { parameters?: boolean; parameterTypes?: boolean; parameterValues?: boolean; line?: boolean; module?: boolean; includeAll?: boolean };
}

export interface StackTraceResponse {
  stackFrames: StackFrame[];
  totalFrames?: number;
}

export interface ScopesResponse {
  scopes: Scope[];
}

export interface VariablesArgs {
  variablesReference: number;
  filter?: "named" | "indexed";
  start?: number;
  count?: number;
  format?: { hex?: boolean };
}

export interface VariablesResponse {
  variables: Variable[];
}

export interface SetFunctionBreakpointsArgs {
  breakpoints: { name: string; condition?: string; hitCondition?: string }[];
}

export interface SetFunctionBreakpointsResponse {
  breakpoints: Breakpoint[];
}
