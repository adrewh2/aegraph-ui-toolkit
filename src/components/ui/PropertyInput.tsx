import { useState } from 'react'
import type { FieldKind } from '../../core/entity/schema'
import { Select } from './Select'

/**
 * The editor for one property value, by kind: a number box, a true/false
 * choice, native date and date-time pickers, a colour swatch, a URL box,
 * a textarea for long text and JSON, a plain input otherwise. Controlled:
 * `value` is the stored value and `onChange` gets the stored form back
 * (numbers as numbers, dates as `YYYY-MM-DD`, date-times as ISO strings,
 * JSON parsed — or the raw text while it doesn't parse yet).
 */
export function PropertyInput({
  kind,
  options,
  value,
  onChange,
  onEnter,
  onEscape,
  onBlur,
  autoFocus,
  className = 'input',
  placeholder,
  rows = 4,
}: {
  kind: FieldKind | undefined
  options?: { value: string; label: string }[]
  value: unknown
  onChange: (v: unknown) => void
  onEnter?: () => void
  onEscape?: () => void
  onBlur?: () => void
  autoFocus?: boolean
  className?: string
  placeholder?: string
  rows?: number
}) {
  const [jsonText, setJsonText] = useState<string | null>(null)
  // Enter commits; in a textarea Enter is a newline and ⌘/Ctrl+Enter commits.
  const keys = (multiline = false) => (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onEscape?.()
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onEnter?.()
    }
  }
  const common = { autoFocus, className, onBlur, onKeyDown: keys() }
  if (options?.length)
    return (
      <Select {...common} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    )
  switch (kind) {
    case 'number':
      return <input {...common} type="number" step="any" value={value == null ? '' : String(value)} placeholder={placeholder ?? '0'} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    case 'boolean':
      return (
        <Select {...common} value={value === true ? 'true' : value === false ? 'false' : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}>
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      )
    case 'date':
      return <input {...common} type="date" value={typeof value === 'string' ? value.slice(0, 10) : ''} onChange={(e) => onChange(e.target.value || undefined)} />
    case 'datetime':
      return <input {...common} type="datetime-local" step="60" value={toLocalInput(value)} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : undefined)} />
    case 'color':
      return (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="color" autoFocus={autoFocus} value={/^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? String(value) : '#cccccc'} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} style={{ width: 36, height: 28, padding: 2 }} />
          <input className={className} value={value == null ? '' : String(value)} placeholder="#rrggbb" onChange={(e) => onChange(e.target.value)} onKeyDown={keys()} onBlur={onBlur} style={{ width: 100 }} />
        </span>
      )
    case 'url':
      return <input {...common} type="url" value={value == null ? '' : String(value)} placeholder={placeholder ?? 'https://…'} onChange={(e) => onChange(e.target.value)} />
    case 'longtext':
      return <textarea {...common} onKeyDown={keys(true)} rows={rows} value={value == null ? '' : String(value)} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    case 'json': {
      const text = jsonText ?? (value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2))
      let bad = false
      if (jsonText !== null && jsonText.trim()) {
        try {
          JSON.parse(jsonText)
        } catch {
          bad = true
        }
      }
      return (
        <textarea
          {...common}
          onKeyDown={keys(true)}
          rows={rows}
          value={text}
          placeholder={placeholder ?? '{ "key": "value" } or [1, 2, 3]'}
          style={bad ? { outline: '1px solid var(--danger)' } : undefined}
          onChange={(e) => {
            setJsonText(e.target.value)
            try {
              onChange(e.target.value.trim() ? JSON.parse(e.target.value) : undefined)
            } catch {
              onChange(e.target.value)
            }
          }}
        />
      )
    }
    default:
      return <input {...common} type="text" value={value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  }
}

/** ISO (or anything Date reads) → the `datetime-local` control's value, in local time. */
function toLocalInput(v: unknown): string {
  if (!v) return ''
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `formatDate` shows relative times; a `datetime` property reads better absolute. */
// `toLocaleString` costs ~80 µs a call and a table asks for every dated cell on every paint: the text is kept by value.
const dateTimes = new Map<string, string>()
export function formatDateTime(v: unknown): string {
  if (!v) return ''
  const key = String(v)
  let t = dateTimes.get(key)
  if (t === undefined) {
    if (dateTimes.size > 100_000) dateTimes.clear()
    const d = new Date(key)
    t = Number.isNaN(d.getTime()) ? key : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    dateTimes.set(key, t)
  }
  return t
}

export function formatDateOnly(v: unknown): string {
  if (!v) return ''
  const s = String(v)
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { dateStyle: 'medium' })
}
