import type { ReactNode } from 'react'
import './KeysHint.css'

type Item = { keys: ReactNode[]; label: string }

/**
 * The keys a view answers to, as a quiet line in its bottom-right corner — Unigraph's camera keys, a diagram's
 * pan and zoom. Small and faint, and the keys never take a click: a reminder, not a control. Each item is a few
 * keys and what they do. `lead` is the one exception, a small control at the line's start that changes what the
 * keys do (Unigraph's orbit / fly switch), so the keys and the switch that changes them read as one line. `reserve`
 * lists the other sets of keys the line can show: they are laid out in the same place, unseen, so the line is as
 * wide as the widest of them and the `lead` control does not move when the set changes.
 */
export function KeysHint({ items, className = '', lead, reserve = [] }: { items: Item[]; className?: string; lead?: ReactNode; reserve?: Item[][] }) {
  const row = (list: Item[], hidden: boolean, key: string) => (
    <span key={key} className={`keys-hint__row${hidden ? ' is-reserve' : ''}`} aria-hidden="true">
      {list.map((it) => (
        <span key={it.label}>
          {it.keys.map((k, i) => (
            <kbd key={i}>{k}</kbd>
          ))}{' '}
          {it.label}
        </span>
      ))}
    </span>
  )
  return (
    <div className={`keys-hint ${className}`}>
      {lead && <span className="keys-hint__lead">{lead}</span>}
      <span className="keys-hint__rows">
        {row(items, false, 'shown')}
        {reserve.map((list, i) => row(list, true, `r${i}`))}
      </span>
    </div>
  )
}
