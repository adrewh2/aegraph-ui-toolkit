import { ChevronDown, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { SCHEMA_TYPE } from '../../core/entity/categories'
import { GRAPH_TYPES } from '../../core/graph/types'
import { useDismiss } from './useDismiss'
import './EntityPicker.css'

/**
 * Combobox for choosing one entity. Opens a dropdown on focus — recent
 * entities first, then whatever matches as you type — so nothing has to be
 * remembered. The dropdown is portalled and fixed-positioned, so the field
 * keeps one height and never resizes the dialog it sits in.
 */
export function EntityPicker({ value, onChange, exclude, placeholder = 'Choose an entity…', autoFocus, types }: { value?: EntityId; onChange: (id?: EntityId) => void; exclude?: EntityId; placeholder?: string; autoFocus?: boolean; types?: string[] }) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const registry = useTypeRegistry()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null)
  const chosen = value ? store.get(value) : undefined

  const results = useMemo(() => {
    const hidden = new Set<string>([SCHEMA_TYPE, ...Object.values(GRAPH_TYPES)])
    const ok = (e: AnyEntity) => e.id !== exclude && !hidden.has(e.type) && (!types || types.includes(e.type))
    const text = q.trim()
    if (text) return store.query({ kind: 'entity', text }).filter(ok).slice(0, 12)
    // Nothing typed: the most recently touched entities.
    return store
      .query({ kind: 'entity' })
      .filter(ok)
      .sort((a, b) => (b.meta.accessedAt ?? b.meta.updatedAt).localeCompare(a.meta.accessedAt ?? a.meta.updatedAt))
      .slice(0, 12)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, exclude, types, version])

  // Place the dropdown under (or above) the field, in viewport coordinates.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const b = boxRef.current?.getBoundingClientRect()
      if (!b) return
      const up = window.innerHeight - b.bottom < 260 && b.top > 260
      setRect({ left: b.left, top: up ? b.top : b.bottom + 4, width: b.width, up })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Escape is the input's own (it closes the list and goes no further, so a dialog around the picker stays open).
  useDismiss(() => setOpen(false), { active: open, inside: () => [boxRef.current, listRef.current], escape: false })

  useEffect(() => setActive(0), [q])

  const choose = (id: EntityId) => {
    onChange(id)
    setQ('')
    setOpen(false)
  }
  const clear = () => {
    onChange(undefined)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  if (chosen) {
    return (
      <div className="epick epick--chosen" ref={boxRef}>
        <span className="badge">{registry.get(chosen.type).label}</span>
        <span className="epick__label" title={displayLabel(chosen)}>
          {displayLabel(chosen)}
        </span>
        <button type="button" className="epick__x" onClick={clear} aria-label="Choose a different entity" title="Change">
          <X size={13} />
        </button>
      </div>
    )
  }

  return (
    <>
      <div className={`epick ${open ? 'is-open' : ''}`} ref={boxRef}>
        <input
          ref={inputRef}
          className="epick__input"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={q}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              setActive((i) => Math.min(i + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter' && open && results[active]) {
              e.preventDefault()
              choose(results[active].id)
            } else if (e.key === 'Escape' && open) {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
            }
          }}
        />
        <button type="button" className="epick__x" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => {
            setOpen((o) => !o)
            inputRef.current?.focus()
          }} aria-label="Show choices">
          <ChevronDown size={14} />
        </button>
      </div>
      {open &&
        rect &&
        createPortal(
          <div ref={listRef} className="epick__list" role="listbox" style={{ left: rect.left, width: rect.width, ...(rect.up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.top }) }}>
            {!q.trim() && results.length > 0 && <div className="epick__head">Recent</div>}
            {results.map((r, i) => (
              <button key={r.id} type="button" role="option" aria-selected={i === active} className={`epick__item ${i === active ? 'is-active' : ''}`} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(r.id)}>
                <span className="badge">{registry.get(r.type).label}</span>
                <span className="epick__label">{displayLabel(r)}</span>
                {r.description && <span className="epick__desc">{r.description}</span>}
              </button>
            ))}
            {results.length === 0 && <div className="epick__empty">{q.trim() ? 'No matches' : 'No entities yet'}</div>}
          </div>,
          document.body,
        )}
    </>
  )
}
