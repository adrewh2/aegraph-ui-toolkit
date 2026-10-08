import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PALETTES } from '../../core/graph/palettes'
import { useDismiss } from './useDismiss'
import './ui.css'

/**
 * The colour a type or a tag is drawn in, wherever that colour is shown:
 * the swatch itself is the control. Clicking it offers the app's own
 * categorical palettes, any colour at all, and *Automatic* — which is not
 * "no colour" but the one derived from the name, so a type without a
 * chosen colour still looks the same everywhere.
 */
const SWATCHES = [...new Set([...(PALETTES.find((p) => p.id === 'tableau10')?.stops ?? []), ...(PALETTES.find((p) => p.id === 'set3')?.stops ?? []), ...(PALETTES.find((p) => p.id === 'okabeIto')?.stops ?? [])])]

interface Props {
  /** The colour in force — the chosen one, or the automatic one when nothing is chosen. */
  value: string
  /** Whether that colour was chosen rather than derived; a derived one offers no "reset". */
  chosen: boolean
  /** `undefined` means go back to the automatic colour. */
  onChange: (color: string | undefined) => void
  label: string
  size?: number
  className?: string
}

export function ColorPick({ value, chosen, onChange, label, size = 12, className = '' }: Props) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  // The swatch button counts as inside: its own click closes the picker rather than closing and reopening it.
  useDismiss(() => setAt(null), { active: !!at, inside: () => [ref.current, button.current] })

  useLayoutEffect(() => {
    if (!at) return
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`
      if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`
    }
  }, [at])

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`colorpick ${className}`}
        style={{ background: value, width: size, height: size }}
        title={`${label} — ${chosen ? value : 'automatic'}. Click to change.`}
        aria-label={`Colour for ${label}`}
        onClick={(e) => {
          e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          setAt(at ? null : { x: r.left, y: r.bottom + 6 })
        }}
      />
      {at &&
        createPortal(
          <div ref={ref} className="colorpick__pop" style={{ left: at.x, top: at.y }}>
            <div className="colorpick__head muted">{label}</div>
            <div className="colorpick__grid">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`colorpick__swatch ${chosen && c.toLowerCase() === value.toLowerCase() ? 'is-on' : ''}`}
                  style={{ background: c }}
                  title={c}
                  aria-label={c}
                  onClick={() => {
                    onChange(c)
                    setAt(null)
                  }}
                />
              ))}
            </div>
            <div className="colorpick__row">
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#cccccc'} onChange={(e) => onChange(e.target.value)} aria-label="Any colour" />
              <button type="button" className="btn btn--sm btn--ghost" disabled={!chosen} onClick={() => (onChange(undefined), setAt(null))}>
                Automatic
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
