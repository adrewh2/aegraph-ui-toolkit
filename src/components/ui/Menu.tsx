import { useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDismiss } from './useDismiss'
import './ui.css'

export type MenuItem =
  | {
      kind: 'item'
      label: string
      icon?: ComponentType<{ size?: number }>
      onSelect: () => void
      danger?: boolean
      disabled?: boolean
      shortcut?: string
      /** One of a set of choices, this one chosen or not (a dropdown's options): announced as a radio item, `aria-checked`. */
      checked?: boolean
    }
  | { kind: 'sep' }
  | { kind: 'label'; label: string }

interface MenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  /** The button that opened the menu. A press on it doesn't count as "outside", so the button's own click can close the menu instead of reopening it. */
  anchor?: Element | null
  children?: ReactNode
  /** At least this wide — a dropdown's menu as wide as the field that opened it. */
  minWidth?: number
  /** Index into `items` of the item to focus when the menu opens (a dropdown's current choice), so the keys start there. */
  initialFocus?: number
  /** A dropdown opened from a button (a Select, a saved-item picker): hairlines between the items, and no minimum width beyond the button's. */
  dropdown?: boolean
}

/**
 * Fixed-position menu that stays inside the viewport and closes on a press outside / Escape (`useDismiss`). The keys move through it:
 * ↑ ↓ (Home, End) between the items, Enter or Space picks, a letter jumps to the next item starting with it.
 */
export function Menu({ x, y, items, onClose, anchor, children, minWidth, initialFocus, dropdown }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    })
  }, [x, y])

  useLayoutEffect(() => {
    if (initialFocus === undefined) return
    const el = ref.current?.querySelector<HTMLButtonElement>(`[data-menu-index="${initialFocus}"]`)
    ;(el && !el.disabled ? el : enabledItems(ref.current)[0])?.focus({ preventScroll: false })
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const list = enabledItems(ref.current)
    if (!list.length) return
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    const go = (i: number) => (e.preventDefault(), list[(i + list.length) % list.length].focus())
    if (e.key === 'ArrowDown') go(at < 0 ? 0 : at + 1)
    else if (e.key === 'ArrowUp') go(at < 0 ? list.length - 1 : at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(list.length - 1)
    else if (e.key === 'Tab') onClose()
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      const k = e.key.toLowerCase()
      for (let n = 1; n <= list.length; n++) {
        const b = list[(Math.max(at, -1) + n) % list.length]
        if ((b.textContent ?? '').trim().toLowerCase().startsWith(k)) return go(list.indexOf(b))
      }
    }
  }

  // A press on the anchor is not "outside": the button's own click closes the menu instead of reopening it.
  useDismiss(onClose, { inside: () => [ref.current, anchor] })

  return createPortal(
    <div ref={ref} className={`menu${dropdown ? ' menu--dropdown' : ''}`} style={{ left: pos.x, top: pos.y, minWidth }} role="menu" onKeyDown={onKeyDown}>
      {children}
      {items.map((item, i) => {
        if (item.kind === 'sep') return <div key={i} className="menu__sep" role="separator" />
        if (item.kind === 'label')
          return (
            <div key={i} className="menu__label" role="presentation">
              {item.label}
            </div>
          )
        const Icon = item.icon
        return (
          <button
            key={i}
            data-menu-index={i}
            className={`menu__item ${item.danger ? 'menu__item--danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect()
              onClose()
            }}
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
          >
            {Icon && <Icon size={14} />}
            <span className="menu__text">{item.label}</span>
            {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}

/** How far below its button a dropdown opens: snug, so the list reads as the button's. */
export const DROPDOWN_GAP = 2

const enabledItems = (root: HTMLElement | null) => [...(root?.querySelectorAll<HTMLButtonElement>('.menu__item') ?? [])].filter((b) => !b.disabled)

/** Anchored popover positioned under an element. */
export function Popover({ anchor, onClose, children, width }: { anchor: DOMRect; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: anchor.left, y: anchor.bottom + 4 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(anchor.left, window.innerWidth - r.width - 8)),
      y: anchor.bottom + 4 + r.height > window.innerHeight ? Math.max(8, anchor.top - r.height - 4) : anchor.bottom + 4,
    })
  }, [anchor])

  // A press on the rectangle it hangs from — the button that opened it — is not "outside", so that button's own click
  // can close it rather than close and reopen it.
  useDismiss(onClose, {
    inside: () => [ref.current],
    ignore: (e) => e.clientX >= anchor.left && e.clientX <= anchor.right && e.clientY >= anchor.top && e.clientY <= anchor.bottom,
  })

  return createPortal(
    <div ref={ref} className="popover" style={{ left: pos.x, top: pos.y, width }}>
      {children}
    </div>,
    document.body,
  )
}
