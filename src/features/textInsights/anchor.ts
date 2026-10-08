import type { Editor } from '@tiptap/core'

/**
 * Where a selection was, in a form that outlives the page: leaving it (a row of the Insights card opens an entity)
 * unmounts the page, and coming back with Back mounts it again — a new editor, new text nodes. So the selection is
 * kept as a region of the app (the page, the assistant dock), the selected text, and where it starts in that region's
 * text; or, in a textarea (a document's plain editor), which textarea and the offsets in its value.
 */
export type TextAnchor =
  | { kind: 'range'; region: string; text: string; offset: number }
  | { kind: 'textarea'; region: string; index: number; start: number; end: number; text: string }

/** The parts of the app a selection can be in, most specific first. */
const REGIONS = ['.ai-dock', '.app-content']

function regionOf(node: Node): { el: Element; selector: string } | null {
  const el = node instanceof Element ? node : node.parentElement
  for (const selector of REGIONS) {
    const found = el?.closest(selector)
    if (found) return { el: found, selector }
  }
  return null
}

export function anchorOfRange(range: Range): TextAnchor | null {
  const region = regionOf(range.commonAncestorContainer)
  if (!region) return null
  const before = document.createRange()
  before.setStart(region.el, 0)
  before.setEnd(range.startContainer, range.startOffset)
  return { kind: 'range', region: region.selector, text: range.toString(), offset: before.toString().length }
}

export function anchorOfTextarea(el: HTMLTextAreaElement, start: number, end: number): TextAnchor | null {
  const region = regionOf(el)
  if (!region) return null
  return { kind: 'textarea', region: region.selector, index: [...region.el.querySelectorAll('textarea')].indexOf(el), start, end, text: el.value.slice(start, end) }
}

/** The text node and offset at a character position of the region's text, as `Range.toString` counts it. */
function pointAt(root: Element, pos: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let seen = 0
  let last: Text | null = null
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length
    if (pos <= seen + len) return { node: n, offset: pos - seen }
    seen += len
    last = n
  }
  return last && pos === seen ? { node: last, offset: last.data.length } : null
}

function rangeAt(root: Element, start: number, length: number): Range | null {
  const a = pointAt(root, start)
  const b = pointAt(root, start + length)
  if (!a || !b) return null
  const r = document.createRange()
  r.setStart(a.node, a.offset)
  r.setEnd(b.node, b.offset)
  return r
}

/**
 * The selection back, if the page has its text again: the same place when the text there is the same, else the
 * occurrence of the text nearest to it (an edit elsewhere moved it). Selected, and returned with where it is on screen.
 */
export function restoreAnchor(a: TextAnchor): DOMRect | null {
  const root = document.querySelector(a.region)
  if (!root) return null
  if (a.kind === 'textarea') {
    const el = root.querySelectorAll('textarea')[a.index] ?? root.querySelector('textarea')
    if (!el || el.value.slice(a.start, a.end) !== a.text) return null
    el.focus({ preventScroll: true })
    el.setSelectionRange(a.start, a.end)
    return el.getBoundingClientRect()
  }
  // The region also holds pages kept hidden (the one just left, kept for a quick return): only text that is drawn
  // counts — the same place when it holds the same text, else the drawn occurrence nearest to it.
  const drawn = (r: Range | null): r is Range => !!r && r.toString() === a.text && [...r.getClientRects()].some((c) => c.width > 0 && c.height > 0)
  let range: Range | null = rangeAt(root, a.offset, a.text.length)
  if (!drawn(range)) {
    range = null
    const all = root.textContent ?? ''
    let best = -1
    for (let i = all.indexOf(a.text); i >= 0; i = all.indexOf(a.text, i + 1)) {
      if (best >= 0 && Math.abs(i - a.offset) >= Math.abs(best - a.offset)) continue
      const r = rangeAt(root, i, a.text.length)
      if (drawn(r)) {
        best = i
        range = r
      }
    }
    if (!range) return null
  }
  const node = range.commonAncestorContainer
  const el = node instanceof Element ? node : node.parentElement
  if (!selectInEditor(el, range)) {
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
  el?.scrollIntoView({ block: 'nearest' })
  return range.getBoundingClientRect()
}

/**
 * In a rich editor the selection is the editor's: ProseMirror writes its own back over the page's whenever it has the
 * focus, so a range set on the page alone is gone a moment later. The editor (Tiptap keeps it on its element) selects
 * the same text itself, focused, so it shows.
 */
function selectInEditor(el: Element | null, range: Range): boolean {
  const editor = (el?.closest('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null)?.editor
  if (!editor?.view || editor.isDestroyed) return false
  try {
    const from = editor.view.posAtDOM(range.startContainer, range.startOffset)
    const to = editor.view.posAtDOM(range.endContainer, range.endOffset)
    editor.chain().focus(undefined, { scrollIntoView: false }).setTextSelection({ from, to }).run()
    return true
  } catch {
    return false
  }
}
