export type SaveState = 'saved' | 'dirty' | 'saving'

/** A passage the user wants to annotate, with context for re-anchoring. */
export interface PendingQuote {
  exact: string
  prefix?: string
  suffix?: string
}
