import { useMemo, useState } from 'react'
import { Dialog } from '../../components/ui/Dialog'
import { PropertyInput } from '../../components/ui/PropertyInput'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { fieldPatch, getField, type FieldDef } from '../../core/entity/schema'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { TagEditor } from './TagEditor'
import './EditEntityDialog.css'

/**
 * The Entities table is read only: a row is changed from its right-click menu, through one of these, and saved in
 * one write when the dialog is saved — never a write per keystroke into a table of a million rows.
 *
 * - `RenameDialog` — the name alone.
 * - `EditEntityDialog` — the name, the description, the tags and every property the type declares (and any other
 *   plain value the entity carries), each with the input its kind calls for.
 */

/** The properties a dialog offers: the type's editable `data.*` fields, then plain values the entity has beyond them. */
function propertyFields(e: AnyEntity, declared: FieldDef[]): FieldDef[] {
  const own = declared.filter((f) => f.key.startsWith('data.') && f.editable !== false)
  const known = new Set(own.map((f) => f.key))
  const extra: FieldDef[] = []
  for (const [k, v] of Object.entries(e.data ?? {})) {
    const key = `data.${k}`
    if (known.has(key)) continue
    const kind = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : typeof v === 'string' && v.length <= 500 ? 'text' : undefined
    if (kind) extra.push({ key, label: k, kind, editable: true })
  }
  return [...own, ...extra]
}

/** A write of what changed, in one patch; undefined when nothing did. */
function patchOf(e: AnyEntity, values: Record<string, unknown>): Partial<AnyEntity> | undefined {
  let work: AnyEntity = e
  const patch: Partial<AnyEntity> = {}
  for (const [key, v] of Object.entries(values)) {
    if (JSON.stringify(getField(work, key) ?? null) === JSON.stringify(v ?? null)) continue
    const p = fieldPatch(work, key, v)
    Object.assign(patch, p)
    work = { ...work, ...p } as AnyEntity
  }
  return Object.keys(patch).length ? patch : undefined
}

export function RenameDialog({ id, onClose }: { id: EntityId | null; onClose: () => void }) {
  const store = useEntityStore()
  const toast = useToast()
  const e = id ? store.get(id) : undefined
  const [name, setName] = useState(() => e?.label ?? '')
  const save = () => {
    if (!e) return onClose()
    const label = name.trim()
    if (label && label !== e.label) {
      store.update(e.id, { label })
      toast(`Renamed to ${label}`)
    }
    onClose()
  }
  return (
    <Dialog
      open={!!e}
      title={`Rename ${e ? displayLabel(e) : ''}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={save} disabled={!name.trim()}>
            Rename
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="rename-entity">Name</label>
        <input
          id="rename-entity"
          className="input"
          autoFocus
          value={name}
          onChange={(ev) => setName(ev.target.value)}
          onFocus={(ev) => ev.currentTarget.select()}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') save()
          }}
        />
      </div>
    </Dialog>
  )
}

/** Kinds whose input wants the whole width of the properties panel. */
const WIDE = new Set(['longtext', 'json', 'markdown'])
const isWide = (f: FieldDef, v: unknown) => WIDE.has(f.kind) || (typeof v === 'string' && v.length > 80)
/** Past this many properties the panel gets a filter box. */
const FILTER_FROM = 10

export function EditEntityDialog({ id, onClose }: { id: EntityId | null; onClose: () => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const toast = useToast()
  const e = id ? store.get(id) : undefined
  // The fields as the dialog opened: the registry is made again on every write, and the form must not reshape under the cursor.
  const fields = useMemo(() => (e ? propertyFields(e, registry.fieldsFor(e.type)) : []), [e?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (!e) return {}
    const out: Record<string, unknown> = { label: e.label ?? '', description: e.description ?? '', tags: e.tags }
    for (const f of fields) out[f.key] = getField(e, f.key)
    return out
  })
  const [filter, setFilter] = useState('')
  const set = (key: string, v: unknown) => setValues((cur) => ({ ...cur, [key]: v }))
  const save = () => {
    if (!e) return onClose()
    const clean = { ...values, label: String(values.label ?? '').trim() || e.label, description: String(values.description ?? '').trim() || undefined }
    const patch = patchOf(e, clean)
    if (patch) {
      store.update(e.id, patch)
      toast(`Saved ${displayLabel({ ...e, ...patch } as AnyEntity)}`)
    }
    onClose()
  }
  const q = filter.trim().toLowerCase()
  const shown = q ? fields.filter((f) => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q)) : fields
  const typeDef = e ? registry.get(e.type) : undefined
  return (
    <Dialog
      open={!!e}
      wide
      className="edit-dialog"
      title={`Edit ${e ? displayLabel(e) : ''}`}
      onClose={onClose}
      footer={
        <>
          {e && (
            <span className="edit-dialog__who">
              <span className="edit-dialog__type" style={{ ['--type-color' as string]: registry.colorOf(e.type) }}>
                {typeDef?.label ?? e.type}
              </span>
              <button type="button" className="edit-dialog__id" title="Copy the id" onClick={() => void navigator.clipboard?.writeText(e.id)}>
                {e.id}
              </button>
            </span>
          )}
          <span className="faint edit-dialog__keys">⌘↵ saves</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div
        className="edit-entity"
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
            ev.preventDefault()
            save()
          }
        }}
      >
        <section className="edit-entity__main">
          <div className="field">
            <label htmlFor="edit-entity-label">Name</label>
            <input id="edit-entity-label" className="input edit-entity__name" autoFocus value={String(values.label ?? '')} onChange={(ev) => set('label', ev.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="edit-entity-description">Description</label>
            <textarea id="edit-entity-description" className="input" rows={4} placeholder="What it is, in a sentence or two" value={String(values.description ?? '')} onChange={(ev) => set('description', ev.target.value)} />
          </div>
          <div className="field">
            <label>Tags</label>
            <TagEditor value={(values.tags as string[]) ?? []} onChange={(tags) => set('tags', tags)} autoFocus={false} />
          </div>
        </section>
        <section className="edit-entity__props">
          <header className="edit-entity__props-head">
            <h4>
              Properties <span className="faint">{fields.length}</span>
            </h4>
            {fields.length >= FILTER_FROM && <input className="input edit-entity__filter" placeholder="Find a property…" value={filter} onChange={(ev) => setFilter(ev.target.value)} />}
          </header>
          {!fields.length && <p className="muted edit-entity__none">{typeDef?.label ?? 'This type'} declares no properties, and this one carries no other values. Add one with Set property…, or declare it on the type in the Ontology.</p>}
          {fields.length > 0 && !shown.length && <p className="muted edit-entity__none">No property matches.</p>}
          <div className="edit-entity__grid">
            {shown.map((f) => (
              <div className={`field${isWide(f, values[f.key]) ? ' is-wide' : ''}`} key={f.key}>
                <label title={f.description ?? f.key}>{f.label}</label>
                <PropertyInput kind={f.kind} options={f.options} value={values[f.key]} onChange={(v) => set(f.key, v)} rows={3} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </Dialog>
  )
}
