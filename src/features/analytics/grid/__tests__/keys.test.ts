import { describe, expect, it } from 'vitest'
import { editorArrow, MOVE_STEP } from '../keys'

/**
 * The arrows in the dataset grid's cell editor: the caret moves through the text, and at its edge the arrow leaves
 * the cell for the next one, as in a spreadsheet; ↑/↓ always leave (the editor is one line); a modifier keeps the key
 * in the text.
 */
const at = (start: number | null, end: number | null, length: number) => ({ start, end, length })

describe('arrow keys in the cell editor', () => {
  it('→ leaves only with the caret after the last character and nothing selected', () => {
    expect(editorArrow('ArrowRight', at(5, 5, 5))).toBe('right')
    expect(editorArrow('ArrowRight', at(0, 0, 0))).toBe('right')
    expect(editorArrow('ArrowRight', at(3, 3, 5))).toBeNull()
    expect(editorArrow('ArrowRight', at(2, 5, 5))).toBeNull()
    expect(editorArrow('ArrowRight', at(null, null, 5))).toBeNull()
  })

  it('← leaves only with the caret before the first character and nothing selected', () => {
    expect(editorArrow('ArrowLeft', at(0, 0, 5))).toBe('left')
    expect(editorArrow('ArrowLeft', at(0, 0, 0))).toBe('left')
    expect(editorArrow('ArrowLeft', at(1, 1, 5))).toBeNull()
    expect(editorArrow('ArrowLeft', at(0, 3, 5))).toBeNull()
  })

  it('↑ and ↓ always leave a one-line editor, wherever the caret is', () => {
    expect(editorArrow('ArrowUp', at(2, 2, 5))).toBe('up')
    expect(editorArrow('ArrowDown', at(0, 5, 5))).toBe('down')
  })

  it('with ⇧, ⌘, Ctrl or ⌥ held the arrow is the text’s — selecting, jumping — never a move', () => {
    for (const mod of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(editorArrow('ArrowRight', at(5, 5, 5), { [mod]: true })).toBeNull()
      expect(editorArrow('ArrowDown', at(5, 5, 5), { [mod]: true })).toBeNull()
    }
    expect(editorArrow('Enter', at(5, 5, 5))).toBeNull()
  })

  it('each move is one step in its direction', () => {
    expect(MOVE_STEP).toEqual({ left: { dr: 0, dc: -1 }, right: { dr: 0, dc: 1 }, up: { dr: -1, dc: 0 }, down: { dr: 1, dc: 0 } })
  })
})
