import { useState } from 'react'
import type { ValueRef, ValueRefInfo } from '../../core/graph/values'
import { Select } from '../../components/ui/Select'

const GROUP_LABEL: Record<ValueRefInfo['group'], string> = { Data: 'Properties', Meta: 'Built in', Structure: 'Structure', Metrics: 'Metrics', Selection: 'Selection', Datasets: 'From datasets' }
const ORDER: ValueRefInfo['group'][] = ['Data', 'Meta', 'Structure', 'Metrics', 'Datasets', 'Selection']
const CUSTOM = '::custom'

/**
 * Pick what an axis, colour, size or grouping reads: a menu of everything
 * the rows carry — properties, dates, structure, computed metrics — with
 * the raw reference one click away for anyone who wants to type it.
 */
export function RefPicker({ value, onChange, refs, only, none = '—' }: { value: ValueRef | undefined; onChange: (v: ValueRef | undefined) => void; refs: ValueRefInfo[]; only?: ValueRefInfo['kind']; none?: string }) {
  const [typing, setTyping] = useState(false)
  const shown = refs.filter((r) => r.available && (!only || r.kind === only || r.kind === 'unknown'))
  const known = value === undefined || shown.some((r) => r.ref === value)
  if (typing || !known)
    return (
      <span className="refpick refpick--typing">
        <input className="input mono" value={value ?? ''} placeholder="data.field · meta.createdAt · degree" autoFocus={typing} onChange={(e) => onChange(e.target.value || undefined)} />
        <button type="button" className="refpick__back" title="Choose from the list" onClick={() => { setTyping(false); if (!known) onChange(undefined) }}>
          ▾
        </button>
      </span>
    )
  return (
    <Select
      className="gx-select refpick"
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value === CUSTOM) return setTyping(true)
        onChange(e.target.value || undefined)
      }}
    >
      <option value="">{none}</option>
      {ORDER.filter((g) => shown.some((r) => r.group === g)).map((g) => (
        <optgroup key={g} label={GROUP_LABEL[g]}>
          {shown
            .filter((r) => r.group === g)
            .map((r) => (
              <option key={r.ref} value={r.ref}>
                {r.label}
              </option>
            ))}
        </optgroup>
      ))}
      <option value={CUSTOM}>Type a reference…</option>
    </Select>
  )
}
