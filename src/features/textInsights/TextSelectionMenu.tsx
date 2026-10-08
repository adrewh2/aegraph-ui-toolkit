import { ClipboardPaste, Copy, MessageSquareText, Scissors, Search, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { askAssistant } from '../assistant/ask'
import { openSearch } from '../search/CommandPalette'
import { anchorOfRange, anchorOfTextarea, restoreAnchor, type TextAnchor } from './anchor'
import { InsightsCard } from './InsightsCard'

/**
 * Right-click on selected text, anywhere you read — a document (rich or plain), a PDF, a chat, a docs page — and the
 * app's menu answers instead of the browser's: **Insights** (a card of what in the project the words name, tag or are
 * found in — `core/entity/textInsights.ts`), **Ask about this**, **Search everything**, and Copy — with Cut and Paste
 * where the text is editable, so taking the menu over costs nothing. Shift + right-click still gives the browser's.
 *
 * A view with a right-click menu of its own (a table row, the graph) keeps it: this listens on the document after
 * them, and stands aside when one has called `preventDefault`. Without a selection, or with the press outside it, the
 * browser's menu shows as before.
 *
 * Following a row of the card leaves the page; **Back** brings the card again, over the same words selected again:
 * the card's text and where the selection was (`anchor.ts`) are kept against the history entry it was left from, and
 * a return to that entry puts the selection back once the page has its text (an editor mounts a moment later) and
 * opens the card under it. A card closed by hand is not brought back.
 */

/** What was open when a card row took the app elsewhere, by the history entry it left. */
const leftFrom = new Map<string, { text: string; anchor: TextAnchor }>()
/** How long a returning page may take to show its text again. */
const RESTORE_MS = 5000

/** Where the selection is, so Cut and Paste can put focus and the selection back after the menu took them. */
type Source = { kind: 'textarea'; el: HTMLTextAreaElement; start: number; end: number } | { kind: 'range'; range: Range; editable: HTMLElement | null }

interface Open {
  x: number
  y: number
  text: string
  rect: DOMRect
  source: Source
  anchor: TextAnchor | null
}

interface Card {
  text: string
  rect: DOMRect
  anchor: TextAnchor | null
}

/** Short fields keep the browser's menu; a textarea is a document's plain editor. */
const isField = (el: Element | null) => !!el && el instanceof HTMLInputElement

function selectionAt(e: MouseEvent): Omit<Open, 'x' | 'y'> | null {
  const target = e.target instanceof Element ? e.target : null
  if (!target || isField(target) || target.closest('.menu, .tins')) return null
  if (target instanceof HTMLTextAreaElement) {
    const { selectionStart: start, selectionEnd: end, value } = target
    const text = value.slice(start, end)
    if (!text.trim()) return null
    return { text, rect: target.getBoundingClientRect(), source: { kind: 'textarea', el: target, start, end }, anchor: anchorOfTextarea(target, start, end) }
  }
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const text = sel.toString()
  if (!text.trim()) return null
  const range = sel.getRangeAt(0)
  // Only a press on the selected text: right-clicking elsewhere with something selected somewhere is not about it.
  const pad = 4
  const onIt = [...range.getClientRects()].some((r) => e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad)
  if (!onIt) return null
  const node = range.commonAncestorContainer
  const el = node instanceof Element ? node : node.parentElement
  const editable = el?.closest<HTMLElement>('[contenteditable="true"], [contenteditable=""]') ?? null
  return { text, rect: range.getBoundingClientRect(), source: { kind: 'range', range: range.cloneRange(), editable }, anchor: anchorOfRange(range) }
}

/** Focus the editable place again and select what was selected, so an edit command lands where the menu was opened. */
function restore(source: Source): boolean {
  if (source.kind === 'textarea') {
    source.el.focus()
    source.el.setSelectionRange(source.start, source.end)
    return true
  }
  if (!source.editable) return false
  source.editable.focus()
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(source.range)
  return true
}

const editable = (s: Source) => s.kind === 'textarea' || !!s.editable

export function TextSelectionMenu() {
  const [open, setOpen] = useState<Open | null>(null)
  const [card, setCard] = useState<Card | null>(null)
  const location = useLocation()
  const navigationType = useNavigationType()

  // Back (or Forward) onto an entry a card row left from: the selection again, then the card under it.
  useEffect(() => {
    const left = leftFrom.get(location.key)
    if (!left || navigationType !== 'POP') return
    leftFrom.delete(location.key)
    let raf = 0
    const timers: ReturnType<typeof setTimeout>[] = []
    const until = performance.now() + RESTORE_MS
    const shown = () => (left.anchor.kind === 'textarea' ? document.activeElement instanceof HTMLTextAreaElement && document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd) === left.text : window.getSelection()?.toString() === left.text)
    const attempt = () => {
      const rect = restoreAnchor(left.anchor)
      if (!rect) {
        if (performance.now() < until) raf = requestAnimationFrame(attempt)
        return
      }
      setCard({ text: left.text, rect, anchor: left.anchor })
      // A page that is still arriving (an editor setting its content, a document loading its body) can reset the
      // selection just after it was put back: look again for a moment, and select again if it went.
      for (const ms of [150, 400, 800, 1500, 2500])
        timers.push(
          setTimeout(() => {
            if (shown()) return
            const again = restoreAnchor(left.anchor)
            if (again) setCard((c) => (c && c.text === left.text ? { ...c, rect: again } : c))
          }, ms),
        )
    }
    raf = requestAnimationFrame(attempt)
    return () => {
      cancelAnimationFrame(raf)
      timers.forEach(clearTimeout)
    }
  }, [location.key, navigationType])

  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      if (e.defaultPrevented || e.shiftKey) return
      const at = selectionAt(e)
      if (!at) return
      e.preventDefault()
      setOpen({ ...at, x: e.clientX, y: e.clientY })
    }
    document.addEventListener('contextmenu', onMenu)
    return () => document.removeEventListener('contextmenu', onMenu)
  }, [])

  const items = (o: Open): MenuItem[] => {
    const quote = o.text.trim().replace(/\s+/g, ' ')
    const canEdit = editable(o.source)
    return [
      {
        kind: 'item',
        label: 'Insights',
        icon: Sparkles,
        // The words stay selected under the card: the menu took the focus, and an editor shows no selection without it.
        onSelect: () => {
          const rect = (o.anchor && restoreAnchor(o.anchor)) || o.rect
          setCard({ text: o.text, rect, anchor: o.anchor })
        },
      },
      { kind: 'item', label: 'Ask about this', icon: MessageSquareText, onSelect: () => askAssistant(`What in the project relates to this passage, and how?\n\n> ${quote.slice(0, 2000)}`) },
      { kind: 'item', label: 'Search everything', icon: Search, onSelect: () => openSearch(quote.slice(0, 200)) },
      { kind: 'sep' },
      ...(canEdit
        ? [
            {
              kind: 'item',
              label: 'Cut',
              icon: Scissors,
              onSelect: () => {
                if (restore(o.source)) document.execCommand('cut')
              },
            } as MenuItem,
          ]
        : []),
      { kind: 'item', label: 'Copy', icon: Copy, onSelect: () => void navigator.clipboard?.writeText(o.text) },
      ...(canEdit
        ? [
            {
              kind: 'item',
              label: 'Paste',
              icon: ClipboardPaste,
              onSelect: () =>
                void navigator.clipboard
                  ?.readText()
                  .then((t) => {
                    if (t && restore(o.source)) document.execCommand('insertText', false, t)
                  })
                  .catch(() => {}),
            } as MenuItem,
          ]
        : []),
    ]
  }

  return (
    <>
      {open && <Menu x={open.x} y={open.y} items={items(open)} onClose={() => setOpen(null)} />}
      {card && (
        <InsightsCard
          key={`${card.text}\u0001${card.rect.top}`}
          text={card.text}
          rect={card.rect}
          onClose={() => setCard(null)}
          onLeave={() => {
            if (card.anchor) leftFrom.set(location.key, { text: card.text, anchor: card.anchor })
            if (leftFrom.size > 20) leftFrom.delete(leftFrom.keys().next().value!)
          }}
        />
      )}
    </>
  )
}
