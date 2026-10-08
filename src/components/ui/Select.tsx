import { Check, ChevronDown } from 'lucide-react'
import { Children, Fragment, isValidElement, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { DROPDOWN_GAP, Menu, type MenuItem } from './Menu'
import './ui.css'

type Choice = { kind: 'option'; value: string; label: string; disabled?: boolean } | { kind: 'group'; label: string }

/** The value a change hands back, shaped like a native select's event so a call site reads `e.target.value` as before. */
export interface SelectChange {
  target: { value: string }
  currentTarget: { value: string }
}

export interface SelectProps {
  value: string | number | undefined
  onChange: (e: SelectChange) => void
  /** `<option>`s, `<optgroup>`s of them, arrays and fragments — the same children a native select takes. */
  children: ReactNode
  className?: string
  title?: string
  style?: CSSProperties
  disabled?: boolean
  /** Open as it appears (a select shown to be chosen from at once). */
  autoFocus?: boolean
  /** The menu was closed without a choice — where a native select would have lost focus unchosen. */
  onBlur?: () => void
  tabIndex?: number
  id?: string
  'aria-label'?: string
  'aria-hidden'?: boolean
}

/**
 * Our dropdown, in place of the browser's `<select>`: a button that shows the current choice and a chevron, opening
 * the choices in the app's `Menu` — the current one ticked and focused, ↑ ↓ and a letter to move, Enter to pick,
 * Escape to leave it as it was. It takes a native select's children and props (`value`, `onChange` with
 * `e.target.value`, `className`, `disabled`, `title`), so swapping one for the other is a change of name. The
 * button is as wide as the widest choice, as a native select is, so the field keeps its width as the value changes.
 */
export function Select({ value, onChange, children, className, title, style, disabled, autoFocus, onBlur, tabIndex, id, ...aria }: SelectProps) {
  const choices = useMemo(() => collect(children), [children])
  const current = String(value ?? '')
  const shown = choices.find((c): c is Extract<Choice, { kind: 'option' }> => c.kind === 'option' && c.value === current)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; width: number; anchor: HTMLButtonElement } | null>(null)
  const picked = useRef(false)
  const opened = useRef(false)

  const open = () => {
    const el = buttonRef.current
    const r = el?.getBoundingClientRect()
    if (!el || !r || disabled) return
    picked.current = false
    opened.current = true
    setMenu({ x: r.left, y: r.bottom + DROPDOWN_GAP, width: r.width, anchor: el })
  }
  // Open at once when asked to, as the element appears.
  const autoOpened = useRef(false)
  const refCallback = (el: HTMLButtonElement | null) => {
    buttonRef.current = el
    if (el && autoFocus && !autoOpened.current) {
      autoOpened.current = true
      requestAnimationFrame(() => open())
    }
  }

  const items: MenuItem[] = choices.map((c) =>
    c.kind === 'group'
      ? { kind: 'label', label: c.label }
      : {
          kind: 'item',
          label: c.label,
          icon: c.value === current ? Check : Blank,
          checked: c.value === current,
          disabled: c.disabled,
          onSelect: () => {
            picked.current = true
            if (c.value !== current) onChange({ target: { value: c.value }, currentTarget: { value: c.value } })
          },
        },
  )
  const focusAt = items.findIndex((it, i) => it.kind === 'item' && (choices[i] as { value?: string }).value === current)
  const ghosts = choices.length <= 60 ? choices.filter((c) => c.kind === 'option') : []

  return (
    <>
      <button
        ref={refCallback}
        type="button"
        id={id}
        className={`select-trigger ${className ?? ''}`}
        style={style}
        title={title}
        disabled={disabled}
        tabIndex={tabIndex}
        data-value={current}
        // A menu of radio items, the chosen one checked: Menu's keys (↑ ↓, a letter, Enter) are a menu's.
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-label={aria['aria-label']}
        aria-hidden={aria['aria-hidden']}
        onClick={() => (menu ? setMenu(null) : open())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            open()
          }
        }}
        onBlur={() => {
          if (!opened.current) onBlur?.()
        }}
      >
        <span className="select-trigger__label">
          {ghosts.map((g, i) => (
            <span key={i} className="select-trigger__ghost" aria-hidden>
              {g.label}
            </span>
          ))}
          <span>{shown?.label ?? current}</span>
        </span>
        <ChevronDown size={12} className="select-trigger__chev" />
      </button>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          minWidth={menu.width}
          dropdown
          anchor={menu.anchor}
          initialFocus={focusAt >= 0 ? focusAt : undefined}
          items={items}
          onClose={() => {
            setMenu(null)
            opened.current = false
            if (!picked.current) onBlur?.()
            buttonRef.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </>
  )
}

/** The room a tick takes, so the choices line up whether or not they are the current one. */
function Blank({ size = 14 }: { size?: number }) {
  return <span style={{ display: 'inline-block', width: size, height: size, flexShrink: 0 }} />
}

function collect(children: ReactNode, out: Choice[] = []): Choice[] {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return
    const el = c as ReactElement<{ children?: ReactNode; value?: string | number; label?: string; disabled?: boolean }>
    if (el.type === Fragment) collect(el.props.children, out)
    else if (el.type === 'optgroup') {
      out.push({ kind: 'group', label: el.props.label ?? '' })
      collect(el.props.children, out)
    } else if (el.type === 'option') {
      const label = textOf(el.props.children)
      out.push({ kind: 'option', value: String(el.props.value ?? label), label, disabled: el.props.disabled })
    }
  })
  return out
}

function textOf(n: ReactNode): string {
  if (n == null || typeof n === 'boolean') return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  if (isValidElement(n)) return textOf((n.props as { children?: ReactNode }).children)
  return ''
}
