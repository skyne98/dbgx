// Minimal progress reporting for agent-facing output.
//
// Rule: a phase is reported ONLY when it is slow (> SLOW_MS), so instant
// operations stay silent (token-efficient) and anything that actually
// waits is called out with one short dim line. No spinners, no in-place
// animation, no kill timers — `phase` never aborts `fn`; it runs to
// completion. The caller's own timeout (e.g. the bash tool) governs.
//
// The result of a command always goes to stdout; progress always goes to
// a caller-supplied sink (usually stderr), so --json output stays clean.

/** Phases faster than this are reported as silent. */
export const SLOW_MS = 200;

export type ProgressSink = (msg: string) => void;

/**
 * Run `fn`. If it takes longer than SLOW_MS, call `onSlow("<label>…")`
 * exactly once. Returns fn's result. Never cancels fn.
 */
export async function phase<T>(
  label: string,
  fn: () => Promise<T>,
  onSlow?: ProgressSink,
): Promise<T> {
  if (!onSlow) return fn();
  const t = setTimeout(() => onSlow(`${label}…`), SLOW_MS);
  try {
    return await fn();
  } finally {
    clearTimeout(t);
  }
}
