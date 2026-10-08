/**
 * How much a script may send back. What comes out of a sandbox is the
 * script's to choose — a million log lines, a remembered state the size of
 * the dataset, a result of a gigabyte — and all of it lands on the page's
 * thread, in its memory and (the state, the last run) in this browser's
 * storage. The bounds are generous for any real script and refuse the rest
 * with a sentence rather than a stalled tab.
 */

/** Log lines kept per run; the rest are counted in one closing line. */
export const MAX_LOG_LINES = 2000
/** Characters of log kept per run, all lines together; a single line is cut at a tenth of it. */
export const MAX_LOG_CHARS = 512 * 1024
/** A result's JSON, in characters: past this it is dropped and the run reports an error. */
export const MAX_RESULT_CHARS = 64 * 1024 * 1024
/** A Visual script's remembered state (`aegraph.remember`), as JSON: past this it is not kept. */
export const MAX_STATE_CHARS = 256 * 1024

export const resultTooLarge = (chars: number) => `The result is too large to show (${Math.round(chars / 1048576)} MB of JSON; the limit is ${MAX_RESULT_CHARS / 1048576} MB): return a summary, or fewer rows or points.`

/** Collects a run's log lines within the bounds; `lines()` ends with a note of what was dropped. */
export class LogSink {
  private kept: string[] = []
  private chars = 0
  private dropped = 0
  push(line: unknown): void {
    let s = typeof line === 'string' ? line : String(line)
    if (this.kept.length >= MAX_LOG_LINES || this.chars >= MAX_LOG_CHARS) {
      this.dropped++
      return
    }
    const cap = Math.min(MAX_LOG_CHARS / 10, MAX_LOG_CHARS - this.chars)
    if (s.length > cap) s = `${s.slice(0, cap)}… (${(s.length - cap).toLocaleString('en-US')} more characters)`
    this.kept.push(s)
    this.chars += s.length
  }
  lines(): string[] {
    return this.dropped ? [...this.kept, `… ${this.dropped.toLocaleString('en-US')} more log line${this.dropped === 1 ? '' : 's'} not kept`] : this.kept
  }
}

/** A list of log lines within the bounds. */
export function capLogs(lines: unknown): string[] {
  const sink = new LogSink()
  if (Array.isArray(lines)) for (const l of lines) sink.push(l)
  return sink.lines()
}

/** A state object kept only when its JSON fits; undefined when it does not (or cannot be written as JSON). */
export function boundedState(state: unknown): Record<string, unknown> | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined
  try {
    const text = JSON.stringify(state)
    return text.length <= MAX_STATE_CHARS ? (JSON.parse(text) as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
