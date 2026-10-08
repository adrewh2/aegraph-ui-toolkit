import { useState } from 'react'
import { Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { PROPERTY_KINDS, coerceToKind, kindOfValue, parsePropertyValue, propertyKey, type FieldKind } from '../../core/entity/schema'
import { PropertyInput } from '../../components/ui/PropertyInput'
import { withProperty } from '../../core/entity/typeRegistry'
import type { EntityId } from '../../core/entity/types'
import { Select } from '../../components/ui/Select'

/**
 * Set one `data` property on many entities at once: a name, a value (read
 * the way typed values are read everywhere — true/false, numbers and JSON
 * become those, the rest is text), and optionally the property added to
 * the type's definition so it shows as a column for every entity of it.
 */
export function SetPropertyDialog({ ids, onClose }: { ids: EntityId[] | null; onClose: () => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const toast = useToast()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<FieldKind | ''>('')
  const [value, setValue] = useState<unknown>('')
  const [defineChoice, setDefineChoice] = useState<boolean | null>(null)
  // A chosen kind is only useful on the type, so it implies defining unless unticked.
  const define = defineChoice ?? !!kind
  const key = propertyKey(name)
  const types = ids ? [...new Set(ids.map((id) => store.get(id)?.type).filter((t): t is string => !!t))] : []
  const oneType = types.length === 1 ? types[0] : undefined
  const submit = () => {
    if (!ids || !key) return
    const v = kind ? coerceToKind(value, kind) : typeof value === 'string' ? parsePropertyValue(value) : value
    store.transaction(() => {
      for (const id of ids) {
        const e = store.get(id)
        if (!e) continue
        const data = { ...e.data }
        if (v === undefined) delete data[key]
        else data[key] = v
        store.update(id, { data })
      }
      if (define && oneType) store.upsert(withProperty(store, oneType, { key, kind: kind || kindOfValue(v) }))
    })
    toast(`Set ${key} on ${ids.length} ${ids.length === 1 ? 'entity' : 'entities'}`)
    setName('')
    setValue('')
    onClose()
  }
  return (
    <Dialog
      open={!!ids}
      title={`Set property on ${ids?.length ?? 0} ${ids?.length === 1 ? 'entity' : 'entities'}`}
      description="A property is a field name and a value in the entity's data. The same value goes on every selected entity."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!key}>
            Set
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1.4fr', gap: 12 }}>
        <div className="field">
          <label>Name</label>
          <input className="input" autoFocus placeholder="e.g. status, priority, year" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </div>
        <div className="field">
          <label>Kind</label>
          <Select
            className="input"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as FieldKind | '')
              setValue('')
            }}
          >
            <option value="">auto</option>
            {PROPERTY_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <label>Value</label>
          <PropertyInput kind={kind || undefined} value={value} onChange={setValue} onEnter={submit} placeholder={kind ? PROPERTY_KINDS.find((k) => k.kind === kind)?.hint : 'true · 42 · [1, 2] · any text'} rows={3} />
        </div>
      </div>
      {oneType && (
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input type="checkbox" checked={define} onChange={(e) => setDefineChoice(e.target.checked)} />
          <span>
            Add <code>{key || 'the property'}</code>{kind ? ` as ${PROPERTY_KINDS.find((k) => k.kind === kind)?.label.toLowerCase()}` : ''} to the {registry.get(oneType).label} definition (a column for every {registry.get(oneType).label.toLowerCase()})
          </span>
        </label>
      )}
      {types.length > 1 && <p className="faint" style={{ marginTop: 10, fontSize: 12 }}>Selection spans {types.length} types; the property is set on each entity but not added to a type.</p>}
    </Dialog>
  )
}
