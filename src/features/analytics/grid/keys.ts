/**
 * The arrow keys inside the cell editor, as a spreadsheet has them: the text keeps an arrow while the caret has
 * somewhere to go in it, and at its edge the arrow leaves the cell — → with the caret after the last character (and
 * nothing selected) moves to the cell on the right, ← with it before the first to the cell on the left. The editor is
 * one line, so ↑ and ↓ always leave for the cell above or below. With ⇧, ⌘, Ctrl or ⌥ held an arrow is the text's
 * (selecting, jumping by word or line), never a move. Pure, so the rule is tested without a page.
 */

export type EditorMove = 'left' | 'right' | 'up' | 'down'

export interface EditorCaret {
  /** `selectionStart` / `selectionEnd` of the input; null when the browser cannot say. */
  start: number | null
  end: number | null
  /** The length of the text in the editor. */
  length: number
}

export interface KeyMods {
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

/** Where an arrow pressed in the editor takes the cursor, or null when it stays in the text. */
export function editorArrow(key: string, caret: EditorCaret, mods: KeyMods = {}): EditorMove | null {
  if (mods.shiftKey || mods.metaKey || mods.ctrlKey || mods.altKey) return null
  if (key === 'ArrowUp') return 'up'
  if (key === 'ArrowDown') return 'down'
  const collapsed = caret.start !== null && caret.start === caret.end
  if (key === 'ArrowRight') return collapsed && caret.end === caret.length ? 'right' : null
  if (key === 'ArrowLeft') return collapsed && caret.start === 0 ? 'left' : null
  return null
}

/** A move as the rows and columns it steps. */
export const MOVE_STEP: Record<EditorMove, { dr: number; dc: number }> = {
  left: { dr: 0, dc: -1 },
  right: { dr: 0, dc: 1 },
  up: { dr: -1, dc: 0 },
  down: { dr: 1, dc: 0 },
}
