// Tiny JSON-line protocol over the daemon's Unix socket.
//
// Request:  a single JSON object terminated by '\n'.
// The daemon may emit zero or more *progress* lines before the final
// response, to stream latency information to the caller:
//   {"progress": "launching debugpy…"}
// Response: a single JSON object terminated by '\n'.
//
// Kept minimal and stable. New methods are additive; never reuse a method
// name for a different shape. DAP bodies are passed through close to raw;
// the CLI layer renders 1-indexed positions for human display.

export interface DaemonRequest {
  /** Method name, e.g. "launch", "break", "continue", "where". */
  m: string;
  /** Positional args, method-specific. */
  a?: unknown[];
}

export interface DaemonResponse {
  ok: boolean;
  /** Result payload on success. */
  r?: unknown;
  /** Error message on failure. */
  e?: string;
}

/** Interleaved progress note, sent before the final DaemonResponse. */
export interface ProgressNote {
  progress: string;
}

/** Type guard distinguishing a progress note from the final response. */
export function isProgressNote(v: unknown): v is ProgressNote {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ProgressNote).progress === "string" &&
    !("ok" in v)
  );
}
