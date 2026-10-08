import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Lock, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '../../components/Layout/PageHeader'
import { ColorPick } from '../../components/ui/ColorPick'
import { Dialog } from '../../components/ui/Dialog'
import { Select } from '../../components/ui/Select'
import { useToast } from '../../components/ui/useToast'
import { CATEGORIES, CATEGORY_ORDER, type TypeCategory } from '../../core/entity/categories'
import { useEntityStore, useStoreDataVersion, useTypeRegistry } from '../../core/entity/hooks'
import { propertyKey, PROPERTY_KINDS, type FieldKind } from '../../core/entity/schema'
import { applyTypeDraft, checkTypeDraft, inheritedProperties, planTypeDraft, typeDraft, typeSlug, type DraftIssue, type PropertyDraft, type TypeChangePlan, type TypeDraft } from '../../core/entity/typeEdit'
import type { AnyEntity } from '../../core/entity/types'
import { typePageHref } from './TypePage'
import './typeEditor.css'

/**
 * The ontology's editor for one entity type: what it is called (name, label, plural), where it sits (category,
 * parent), how it looks (colour), what it is (description) — and its properties, one row each with a name, a label,
 * a kind from a list, whether it is required, and, opened, a description and a fixed set of allowed values. What the
 * type has without defining it — its parent chain's properties, the app's built-in fields — is listed beneath, read
 * only, so the whole shape of an entity of the type is on one screen. The New type dialog and the type's Edit view
 * are this form; `core/entity/typeEdit.ts` checks it, says what saving would do to existing entities, and saves.
 */
export function TypeEditor({ draft, onChange, isNew, issues, plan }: { draft: TypeDraft; onChange: (d: TypeDraft) => void; isNew: boolean; issues: DraftIssue[]; plan?: TypeChangePlan }) {
  const registry = useTypeRegistry()
  const issue = (at: string) => issues.find((i) => i.at === at)?.message
  const set = <K extends keyof TypeDraft>(k: K, v: TypeDraft[K]) => onChange({ ...draft, [k]: v })
  // A new type's name follows its label until someone edits the name itself.
  const [nameTouched, setNameTouched] = useState(!isNew)
  const setLabel = (label: string) => onChange({ ...draft, label, ...(nameTouched ? {} : { name: typeSlug(label) }), ...(draft.pluralLabel && draft.pluralLabel !== pluralOf(draft.label) ? {} : { pluralLabel: pluralOf(label) }) })
  // A parent may be any entity type but this one and those below it (that would be a loop).
  const parents = useMemo(() => {
    const below = draft.name ? new Set(registry.withSubtypes(draft.name)) : new Set<string>()
    return registry
      .all()
      .filter((t) => t.kind !== 'relationship' && t.type !== '__relationship__' && t.category !== 'schema' && !below.has(t.type))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [registry, draft.name])
  const inherited = useMemo(() => inheritedProperties(registry, draft.name || undefined, draft.parent), [registry, draft.name, draft.parent])
  const own = new Set(draft.properties.map((p) => propertyKey(p.key)))

  return (
    <div className="tyed">
      <section className="tyed__section">
        <h3 className="tyed__h">The type</h3>
        <div className="tyed__grid">
          <label className="field">
            <span>Name</span>
            <input className="input" autoFocus={isNew} value={draft.label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Research paper" />
            {issue('label') && <span className="tyed__issue">{issue('label')}</span>}
          </label>
          <label className="field">
            <span>Plural</span>
            <input className="input" value={draft.pluralLabel} onChange={(e) => set('pluralLabel', e.target.value)} placeholder={pluralOf(draft.label) || 'e.g. Research papers'} />
          </label>
          <label className="field">
            <span>Id {isNew ? <span className="muted">— what entities carry as their type</span> : <Lock size={11} className="faint" />}</span>
            {isNew ? (
              <input className="input mono" value={draft.name} onChange={(e) => (setNameTouched(true), set('name', e.target.value.toLowerCase().replace(/\s+/g, '-')))} placeholder="research-paper" />
            ) : (
              <input className="input mono" value={draft.name} readOnly title="The id is fixed once a type exists: every entity of the type carries it" />
            )}
            {issue('name') && <span className="tyed__issue">{issue('name')}</span>}
          </label>
          <div className="field">
            <span>Colour</span>
            <span className="tyed__color">
              <ColorPick value={draft.color ?? registry.colorOf(draft.name || 'new')} chosen={!!draft.color} label={draft.label || 'type'} size={18} onChange={(c) => set('color', c || undefined)} />
              {draft.color ? (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => set('color', undefined)}>
                  Use its own
                </button>
              ) : (
                <span className="muted">its own, from the palette</span>
              )}
            </span>
          </div>
        </div>
        <label className="field">
          <span>Description</span>
          <textarea className="input tyed__desc" value={draft.description ?? ''} onChange={(e) => set('description', e.target.value)} placeholder="What an entity of this type is — for people, and for the assistant, which reads it." />
        </label>
      </section>

      <section className="tyed__section">
        <h3 className="tyed__h">Where it sits</h3>
        <div className="tyed__grid">
          <label className="field">
            <span>Category</span>
            <Select className="input" value={draft.category} onChange={(e) => set('category', e.target.value as TypeCategory)}>
              {CATEGORY_ORDER.filter((c) => c !== 'schema').map((c) => (
                <option key={c} value={c}>
                  {CATEGORIES[c].pluralLabel}
                </option>
              ))}
            </Select>
            <span className="muted tyed__hint">{CATEGORIES[draft.category].test}</span>
          </label>
          <label className="field">
            <span>Specialises</span>
            <Select className="input" value={draft.parent ?? ''} onChange={(e) => set('parent', e.target.value || undefined)}>
              <option value="">Nothing — a type of its own</option>
              {parents.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </Select>
            <span className="muted tyed__hint">A subtype has its parent's properties and is listed, mapped and drawn as its kind.</span>
            {issue('parent') && <span className="tyed__issue">{issue('parent')}</span>}
          </label>
        </div>
      </section>

      <section className="tyed__section">
        <h3 className="tyed__h">
          Properties <span className="muted">{draft.properties.length || ''}</span>
        </h3>
        <p className="muted tyed__hint">The fields an entity of this type carries: each is a column in its tables and a row in its inspector, with the kind's own editor — a date picker, a number box, a list of allowed values.</p>
        {draft.properties.length > 0 && (
          <div className="tyed__props" role="table" aria-label="Properties">
            <div className="tyed__prop tyed__prop--head" role="row">
              <span />
              <span>Name</span>
              <span>Label</span>
              <span>Kind</span>
              <span title="Must be given when an entity of the type is made by hand">Required</span>
              <span />
            </div>
            {draft.properties.map((p, i) => (
              <PropertyRow key={i} prop={p} index={i} count={draft.properties.length} issue={issue(`property:${i}`)} shadowed={inherited.find((h) => h.key === propertyKey(p.key))} onChange={(next) => set('properties', draft.properties.map((x, j) => (j === i ? next : x)))} onRemove={() => set('properties', draft.properties.filter((_, j) => j !== i))} onMove={(d) => set('properties', move(draft.properties, i, i + d))} />
            ))}
          </div>
        )}
        <button type="button" className="btn btn--sm tyed__add" onClick={() => set('properties', [...draft.properties, { key: '' }])}>
          <Plus size={13} /> Add property
        </button>
        {inherited.length > 0 && (
          <div className="tyed__inherited">
            <div className="muted tyed__hint">It also has</div>
            <ul>
              {inherited.map((h) => (
                <li key={h.key} className={own.has(h.key) ? 'is-shadowed' : ''} title={own.has(h.key) ? 'Redefined above for this type' : undefined}>
                  <span className="mono">{h.key}</span>
                  <span className="muted">{kindLabel(h.kind)}</span>
                  <span className="faint">{h.builtIn && h.from === draft.name ? 'built in' : `from ${registry.get(h.from).label}`}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {plan && <PlanNote plan={plan} />}
    </div>
  )
}

function PropertyRow({ prop, index, count, issue, shadowed, onChange, onRemove, onMove }: { prop: PropertyDraft; index: number; count: number; issue?: string; shadowed?: { from: string }; onChange: (p: PropertyDraft) => void; onRemove: () => void; onMove: (d: -1 | 1) => void }) {
  const [open, setOpen] = useState(!!(prop.description || prop.options?.length))
  const ref = useRef<HTMLInputElement>(null)
  // A property just added gets the cursor.
  useEffect(() => {
    if (!prop.key && index === count - 1) ref.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const renamed = prop.was && propertyKey(prop.key) !== prop.was
  return (
    <div className={`tyed__prop-wrap ${issue ? 'has-issue' : ''}`} role="row">
      <div className="tyed__prop">
        <button type="button" className="btn btn--sm btn--ghost btn--icon" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Fewer details' : 'Description and allowed values'} title="Description and allowed values">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <input ref={ref} className="input mono" value={prop.key} placeholder="name" aria-label="Property name" onChange={(e) => onChange({ ...prop, key: e.target.value })} onBlur={() => prop.key && onChange({ ...prop, key: propertyKey(prop.key) })} />
        <input className="input" value={prop.label ?? ''} placeholder={prop.key ? humanize(prop.key) : 'Label'} aria-label="Label" onChange={(e) => onChange({ ...prop, label: e.target.value })} />
        <Select className="input" value={prop.kind ?? ''} aria-label="Kind" onChange={(e) => onChange({ ...prop, kind: (e.target.value || undefined) as FieldKind | undefined })}>
          <option value="">Any — read as written</option>
          {PROPERTY_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label} · {k.hint}
            </option>
          ))}
        </Select>
        <input type="checkbox" checked={!!prop.required} aria-label="Required" onChange={(e) => onChange({ ...prop, required: e.target.checked || undefined })} />
        <span className="tyed__row-actions">
          <button type="button" className="btn btn--sm btn--ghost btn--icon" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">
            <ArrowUp size={13} />
          </button>
          <button type="button" className="btn btn--sm btn--ghost btn--icon" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move down">
            <ArrowDown size={13} />
          </button>
          <button type="button" className="btn btn--sm btn--ghost btn--icon" onClick={onRemove} aria-label="Remove property" title="Remove from the type — entities keep their values">
            <Trash2 size={13} />
          </button>
        </span>
      </div>
      {(issue || renamed || shadowed) && (
        <div className="tyed__prop-note">
          {issue && <span className="tyed__issue">{issue}</span>}
          {renamed && !issue && <span className="muted">Renamed from <span className="mono">{prop.was}</span>: the values move with it.</span>}
          {shadowed && !issue && <span className="muted">Redefines the property it has from its parent.</span>}
        </div>
      )}
      {open && (
        <div className="tyed__prop-more">
          <label className="field">
            <span>Description</span>
            <input className="input" value={prop.description ?? ''} placeholder="What the value means" onChange={(e) => onChange({ ...prop, description: e.target.value || undefined })} />
          </label>
          <label className="field">
            <span>Allowed values <span className="muted">— one per line, or leave empty for any</span></span>
            <textarea className="input tyed__options" value={(prop.options ?? []).join('\n')} placeholder={'draft\nreview\nfinal'} onChange={(e) => onChange({ ...prop, options: e.target.value ? e.target.value.split('\n') : undefined })} />
          </label>
        </div>
      )}
    </div>
  )
}

/** What saving will do to the entities that already have the type, said before it is done. */
function PlanNote({ plan }: { plan: TypeChangePlan }) {
  const lines: string[] = []
  for (const r of plan.renamed) if (r.values) lines.push(`${r.from} becomes ${r.to} on ${n(r.values, 'entity', 'entities')}`)
  for (const c of plan.converted) lines.push(`${n(c.values, 'value')} of ${c.key} become ${kindLabel(c.kind).toLowerCase()}${c.kept ? `; ${n(c.kept, 'value')} cannot and stay as written` : ''}`)
  for (const r of plan.removed) if (r.values) lines.push(`${r.key} leaves the type; ${n(r.values, 'entity', 'entities')} keep their value`)
  if (!lines.length) return null
  return (
    <div className="tyed__plan" role="note">
      <strong>Saving will change existing entities</strong>
      <ul>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  )
}

/** The New type dialog: the whole editor, for a type that does not exist yet. */
export function NewTypeDialog({ onClose, onCreated, category, parent }: { onClose: () => void; onCreated?: (e: AnyEntity) => void; category?: TypeCategory; parent?: string }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const toast = useToast()
  const [draft, setDraft] = useState<TypeDraft>(() => ({ ...typeDraft(store, registry), ...(category ? { category } : {}), ...(parent ? { parent, category: registry.get(parent).category } : {}) }))
  const [tried, setTried] = useState(false)
  const issues = checkTypeDraft(draft, registry, { isNew: true, store })
  const create = () => {
    setTried(true)
    if (issues.length) return
    const { entity } = applyTypeDraft(store, registry, draft)
    toast(`${draft.label} defined`)
    onCreated?.(entity)
    onClose()
  }
  // Issues show once something has been typed where they are, or once Define was tried.
  const shown = tried ? issues : issues.filter((i) => (i.at === 'name' || i.at === 'label' ? !!draft.label : true))
  return (
    <Dialog open wide className="tyed-dialog" title="New type" description="A kind of thing in the ontology, with the properties its entities carry. It exports with the data." onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={create} disabled={tried && issues.length > 0}>
          Define type
        </button>
      </>
    }>
      <TypeEditor draft={draft} onChange={setDraft} isNew issues={shown} />
    </Dialog>
  )
}

/** `/ontology/type/:type/edit` — the editor for a type that exists, with what saving will do to its entities. */
export function TypeEditPage() {
  const { type = '' } = useParams()
  const store = useEntityStore()
  useStoreDataVersion(store)
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const toast = useToast()
  const [initial] = useState(() => typeDraft(store, registry, type))
  const [draft, setDraft] = useState(initial)
  const issues = checkTypeDraft(draft, registry, { isNew: false, store })
  const plan = useMemo(() => planTypeDraft(store, registry, draft), [store, registry, draft])
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const back = () => navigate(typePageHref(type))
  const save = () => {
    if (issues.length) return
    applyTypeDraft(store, registry, draft)
    toast(`${draft.label} saved`)
    back()
  }
  return (
    <div className="res onto onto--page tyed-page">
      <PageHeader
        title={<>Edit {initial.label}</>}
        subtitle={<span className="mono">{type}</span>}
        actions={
          <>
            <button className="btn" onClick={back}>
              {dirty ? 'Discard' : 'Back'}
            </button>
            <button className="btn btn--primary" onClick={save} disabled={!dirty || issues.length > 0}>
              Save
            </button>
          </>
        }
      />
      <div className="tyed-page__body">
        <TypeEditor draft={draft} onChange={setDraft} isNew={false} issues={issues} plan={plan} />
      </div>
    </div>
  )
}

export const typeEditHref = (type: string) => `/ontology/type/${encodeURIComponent(type)}/edit`

const move = <T,>(xs: T[], from: number, to: number): T[] => {
  if (to < 0 || to >= xs.length) return xs
  const out = xs.slice()
  out.splice(to, 0, out.splice(from, 1)[0])
  return out
}
const n = (k: number, one: string, many = `${one}s`) => `${k.toLocaleString()} ${k === 1 ? one : many}`
const kindLabel = (k: FieldKind) => PROPERTY_KINDS.find((x) => x.kind === k)?.label ?? k
const humanize = (key: string) => key.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
/** A plural a person would write, for the placeholder and the default: city → cities, class → classes. */
function pluralOf(label: string): string {
  const s = label.trim()
  if (!s) return ''
  if (/[^aeiou]y$/i.test(s)) return `${s.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/i.test(s)) return `${s}es`
  return `${s}s`
}
