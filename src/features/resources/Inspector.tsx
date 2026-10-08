import { Check, Columns3, Copy, ExternalLink, Highlighter, Link2, MoreHorizontal, Plus, Trash2, Waypoints, X } from 'lucide-react'
import { relatedHref, relatedLabel } from '../../app/openIn'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { useOpenInTab } from '../workstation/paneContext'
import { useMemo, useState, type ReactNode } from 'react'
import { Menu, Popover, type MenuItem } from '../../components/ui/Menu'
import { TagChip } from '../../components/ui/TagChip'
import { projectMenuItems } from '../projects/projectMenu'
import { isProjectEntity } from '../../core/projects/project'
import { useToast } from '../../components/ui/useToast'
import { createRelationship, displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import { describeSelector, refToUri } from '../../core/entity/ids'
import { PROPERTY_KINDS, coerceToKind, fieldPatch, getEntityType, getField, kindOfValue, parsePropertyValue, propertyKey, validateEntity, type FieldDef, type FieldKind } from '../../core/entity/schema'
import { PropertyInput, formatDateOnly, formatDateTime } from '../../components/ui/PropertyInput'
import { withProperty, withoutProperty } from '../../core/entity/typeRegistry'
import { isRelationship, type AnyEntity, type EntityId, type Relationship } from '../../core/entity/types'
import { externalHref, httpUrl, RELATIONSHIP_TYPES } from '../../core/resources/types'
import { formatDate } from '../../lib/format'
import { AnnotationsTab } from './AnnotationsTab'
import { EntityTable } from './EntityTable'
import { appViewFor } from './AppView'
import { CreateDialog, type CreateKind } from './CreateDialogs'
import { TagEditor } from './TagEditor'
import './Inspector.css'
import { Select } from '../../components/ui/Select'
import { DataImage } from '../../components/RemoteImage'

type Tab = 'app' | 'fields' | 'annotations' | 'relationships' | 'json' | 'issues'

export function Inspector({
  entityId,
  onClose,
  closable = true,
  onOpen,
  onDelete,
  app = false,
  initialTab,
  collapsedFields,
  actions,
}: {
  entityId: EntityId
  onClose: () => void
  /** Without a close button of its own — inside a tabbed pane, where the tab's × and the pane's controls do that. */
  closable?: boolean
  onOpen: (id: EntityId) => void
  onDelete: (ids: EntityId[]) => void
  /** Offer the resource's interactive form (editor, player, …) as the first tab. Off inside the pages that already are that form. */
  app?: boolean
  /** Tab to open on; falls back to the app tab (or Fields). Changing it re-selects the tab. */
  initialTab?: string
  /** Fields shown folded (a size line and a Show toggle) — e.g. a document's content while its editor is open beside the panel. */
  collapsedFields?: string[]
  /** Extra buttons in the header, before the reference copy — a host's own (the artifact view's Open page). */
  actions?: ReactNode
}) {
  const store = useEntityStore()
  useStoreVersion(store)
  const toast = useToast()
  const entity = store.get(entityId)
  const appView = app && entity ? appViewFor(entity, store) : undefined
  const isTab = (t: string | undefined): t is Tab => !!t && ['app', 'fields', 'annotations', 'relationships', 'json', 'issues'].includes(t)
  const defaultTab = (): Tab => (isTab(initialTab) && (initialTab !== 'app' || appView) ? initialTab : appView ? 'app' : 'fields')
  const [tab, setTab] = useState<Tab>(defaultTab)
  const [creating, setCreating] = useState<CreateKind | null>(null)
  // Switching to an entity without an app view (or vice versa), or being asked for a tab, lands on its natural first tab.
  const [seen, setSeen] = useState(`${entityId}|${initialTab ?? ''}`)
  if (seen !== `${entityId}|${initialTab ?? ''}`) {
    setSeen(`${entityId}|${initialTab ?? ''}`)
    setTab(defaultTab())
  }

  if (!entity) return null
  const def = getEntityType(isRelationship(entity) ? '__relationship__' : entity.type)
  const Icon = def?.icon
  const issues = validateEntity(entity)
  const href = externalHref(entity)
  const annotationCount = isRelationship(entity) ? 0 : store.relationshipsOf(entity.id, 'in').filter((r) => r.type === RELATIONSHIP_TYPES.annotates).length

  return (
    <aside className="insp">
      <div className="insp__head">
        <span className="insp__icon" style={{ background: def?.color ? `${def.color}22` : 'var(--surface-2)', color: def?.color }}>
          {Icon ? <Icon size={16} /> : null}
        </span>
        <div className="insp__title">
          <h3 title={displayLabel(entity)}>{displayLabel(entity)}</h3>
          <div className="meta">
            <span className="badge">{entity.type}</span>
            <span>·</span>
            <span title={new Date(entity.meta.updatedAt).toLocaleString()}>updated {formatDate(entity.meta.updatedAt)}</span>
          </div>
        </div>
        {!isRelationship(entity) && (
          <>
            <button className="btn btn--sm btn--icon btn--ghost" title="Annotate this entity" onClick={() => setCreating('annotation')}>
              <Highlighter size={14} />
            </button>
            <button className="btn btn--sm btn--icon btn--ghost" title="Link this entity to another" onClick={() => setCreating('relationship')}>
              <Link2 size={14} />
            </button>
          </>
        )}
        {href && (
          <a className="btn btn--sm btn--icon btn--ghost" href={href} target="_blank" rel="noreferrer" title="Open link">
            <ExternalLink size={14} />
          </a>
        )}
        {actions}
        <button className="btn btn--sm btn--icon btn--ghost" title="Copy reference URI" onClick={() => (navigator.clipboard.writeText(refToUri({ id: entity.id })), toast('Reference copied'))}>
          <Copy size={14} />
        </button>
        {closable && (
          <button className="btn btn--sm btn--icon btn--ghost" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        )}
      </div>
      <div className="insp__tabs">
        {(
          [
            ...(appView ? [['app', appView.label] as [Tab, string]] : []),
            ['fields', 'Fields'],
            ['annotations', isRelationship(entity) ? null : entity.type === 'annotation' ? 'Annotates' : `Annotations${annotationCount ? ` · ${annotationCount}` : ''}`],
            ['relationships', `Relationships${store.relationshipsOf(entity.id).length ? ` · ${store.relationshipsOf(entity.id).length}` : ''}`],
            ['json', 'JSON'],
            ['issues', issues.length ? `Issues · ${issues.length}` : 'Issues'],
          ] as [Tab, string | null][]
        )
          .filter((t): t is [Tab, string] => t[1] !== null)
          .map(([id, label]) => (
          <button key={id} className={`insp__tab ${tab === id ? 'is-active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className={`insp__body ${tab === 'app' ? 'insp__body--app' : ''} ${tab === 'relationships' ? 'insp__body--rels' : ''}`}>
        {tab === 'app' && appView && <appView.Component entity={entity} onOpen={onOpen} />}
        {tab === 'fields' && <Fields entity={entity} onOpen={onOpen} collapsed={collapsedFields} />}
        {tab === 'annotations' && (
          <>
            {!isRelationship(entity) && entity.type !== 'annotation' && (
              <div className="insp__tab-actions">
                <button className="btn btn--sm" onClick={() => setCreating('annotation')}>
                  <Highlighter size={13} /> Annotate…
                </button>
              </div>
            )}
            <AnnotationsTab entity={entity} onOpen={onOpen} />
          </>
        )}
        {/* Linking lives in the header (the link icon), so the tab is just the list. */}
        {tab === 'relationships' && <Relationships entity={entity} onOpen={onOpen} />}
        {tab === 'json' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <button className="btn btn--sm" onClick={() => (navigator.clipboard.writeText(JSON.stringify(entity, null, 2)), toast('JSON copied'))}>
                <Copy size={13} /> Copy
              </button>
            </div>
            <pre>{JSON.stringify(entity, null, 2)}</pre>
          </>
        )}
        {tab === 'issues' &&
          (issues.length === 0 ? (
            <div className="insp__empty">No validation issues.</div>
          ) : (
            issues.map((i, n) => (
              <div key={n} className="insp__issue">
                <span className={`badge ${i.severity === 'error' ? 'badge--danger' : 'badge--warn'}`}>{i.severity}</span>
                <span>
                  {i.field && <span className="mono">{i.field} · </span>}
                  {i.message}
                </span>
              </div>
            ))
          ))}
        {tab !== 'app' && (
          <>
            <div className="insp__section">Danger zone</div>
            <button className="btn btn--sm btn--danger" onClick={() => onDelete([entity.id])}>
              <Trash2 size={13} /> Delete {isRelationship(entity) ? 'relationship' : 'entity'}
            </button>
          </>
        )}
      </div>
      <CreateDialog
        kind={creating}
        targetId={entity.id}
        onClose={() => setCreating(null)}
        onCreated={() => {
          const kind = creating
          setCreating(null)
          toast(kind === 'relationship' ? 'Relationship created' : 'Annotation created')
          setTab(kind === 'relationship' ? 'relationships' : 'annotations')
        }}
      />
    </aside>
  )
}

function Fields({ entity, onOpen, collapsed = [] }: { entity: AnyEntity; onOpen: (id: EntityId) => void; collapsed?: string[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const toast = useToast()
  const [editing, setEditing] = useState<{ key: string; anchor?: DOMRect } | null>(null)
  const [rowMenu, setRowMenu] = useState<{ key: string; x: number; y: number; anchor: Element } | null>(null)
  const defined = useMemo(() => new Set(registry.fieldsFor(isRelationship(entity) ? undefined : entity.type).map((f) => f.key)), [registry, entity])
  const fields = useMemo(() => {
    const base = registry.fieldsFor(isRelationship(entity) ? undefined : entity.type)
    // Surface any data keys the type definition doesn't know about.
    const known = new Set(base.map((f) => f.key))
    const extra: FieldDef[] = Object.keys(entity.data)
      .filter((k) => !known.has(`data.${k}`))
      .map((k) => ({ key: `data.${k}`, label: k, kind: kindOfValue(entity.data[k]), editable: typeof entity.data[k] !== 'object' || entity.data[k] === null }))
    return [...base, ...extra]
  }, [entity, registry])

  const save = (key: string, value: unknown) => {
    store.update(entity.id, fieldPatch(entity, key, value))
    setEditing(null)
  }
  /** Set a `data` property by name. A chosen kind is remembered on the type, so the property gets its widget everywhere. */
  const addProperty = (name: string, value: unknown, kind: FieldKind | undefined) => {
    const key = propertyKey(name)
    if (!key) return
    const stored = kind ? coerceToKind(value, kind) : typeof value === 'string' ? parsePropertyValue(value) : value
    store.transaction(() => {
      save(`data.${key}`, stored)
      if (kind && !isRelationship(entity)) store.upsert(withProperty(store, entity.type, { key, kind }))
    })
    toast(`Set ${key}`)
  }
  const setKind = (key: string, kind: FieldKind) => {
    const name = key.replace(/^data\./, '')
    store.transaction(() => {
      store.upsert(withProperty(store, entity.type, { key: name, kind }))
      const converted = coerceToKind(entity.data[name], kind)
      if (converted !== undefined && converted !== entity.data[name]) save(key, converted)
    })
    toast(`${name} is a ${PROPERTY_KINDS.find((k) => k.kind === kind)?.label.toLowerCase() ?? kind} on every ${registry.get(entity.type).label}`)
  }
  const removeProperty = (key: string) => {
    const data = { ...entity.data }
    delete data[key.replace(/^data\./, '')]
    store.update(entity.id, { data })
  }
  const defineOnType = (key: string) => {
    const name = key.replace(/^data\./, '')
    store.upsert(withProperty(store, entity.type, { key: name, kind: kindOfValue(entity.data[name]) }))
    toast(`“${name}” is now a field of ${registry.get(entity.type).label}`)
  }
  const rowMenuItems = (key: string): MenuItem[] => {
    const name = key.replace(/^data\./, '')
    const onType = defined.has(key) && registry.propertiesOf(entity.type).some((p) => p.key === name)
    const current = fields.find((f) => f.key === key)?.kind
    return [
      ...(!isRelationship(entity) && !defined.has(key) ? [{ kind: 'item', label: `Add to every ${registry.get(entity.type).label}`, icon: Columns3, onSelect: () => defineOnType(key) } as MenuItem] : []),
      ...(onType ? [{ kind: 'item', label: `Drop from ${registry.get(entity.type).label} fields`, onSelect: () => store.upsert(withoutProperty(store, entity.type, name)!) } as MenuItem] : []),
      { kind: 'item', label: 'Clear', onSelect: () => save(key, undefined) },
      { kind: 'item', label: 'Remove property', icon: Trash2, danger: true, onSelect: () => removeProperty(key) },
      ...(!isRelationship(entity)
        ? [{ kind: 'sep' } as MenuItem, { kind: 'label', label: `Kind · ${PROPERTY_KINDS.find((k) => k.kind === current)?.label ?? current ?? 'auto'}` } as MenuItem, ...PROPERTY_KINDS.map<MenuItem>((k) => ({ kind: 'item', label: k.label, icon: k.kind === current ? Check : undefined, onSelect: () => setKind(key, k.kind) }))]
        : []),
    ]
  }

  return (
    <div>
      {isRelationship(entity) && (
        <>
          <Row k="Source">
            <RefLink id={entity.source.id} selector={entity.source.selector} onOpen={onOpen} />
          </Row>
          <Row k="Target">
            <RefLink id={entity.target.id} selector={entity.target.selector} onOpen={onOpen} />
          </Row>
          <Row k="Directed">{entity.directed ? 'yes' : 'no'}</Row>
        </>
      )}
      {fields.map((f) => {
        const value = getField(entity, f.key)
        const isEditing = editing?.key === f.key
        const folded = collapsed.includes(f.key) && !expanded.has(f.key) && !isEditing
        return (
          <Row key={f.key} k={f.label} after={f.kind === 'tags' ? <ProjectsRow entity={entity} /> : undefined}>
            {folded ? (
              <div className="insp__folded">
                <span className="muted">{summarizeValue(value)}</span>
                <button className="btn btn--sm btn--ghost" onClick={() => setExpanded((s) => new Set(s).add(f.key))}>
                  Show
                </button>
              </div>
            ) : f.kind === 'tags' ? (
              <>
                <div
                  className="editable"
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minHeight: 20 }}
                  onClick={(e) => setEditing({ key: f.key, anchor: e.currentTarget.getBoundingClientRect() })}
                >
                  {(value as string[]).length === 0 && <span className="faint">Add tags…</span>}
                  {(value as string[]).map((t) => (
                    <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
                  ))}
                </div>
                {isEditing && editing.anchor && (
                  <Popover anchor={editing.anchor} onClose={() => setEditing(null)}>
                    <TagEditor value={value as string[]} onChange={(tags) => store.update(entity.id, { tags })} onDone={() => setEditing(null)} />
                  </Popover>
                )}
              </>
            ) : isEditing ? (
              <FieldInput field={f} value={value} onSave={(v) => save(f.key, v)} onCancel={() => setEditing(null)} />
            ) : (
              <div className={f.editable ? 'editable' : ''} onClick={() => f.editable && setEditing({ key: f.key })}>
                <FieldValue field={f} value={value} />
              </div>
            )}
            {f.key.startsWith('data.') && !isEditing && (
              <button className="insp__row-menu" title="Property options" onClick={(e) => setRowMenu({ key: f.key, x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget })}>
                <MoreHorizontal size={13} />
              </button>
            )}
          </Row>
        )
      })}
      <AddPropertyRow onAdd={addProperty} known={fields.map((f) => f.key.replace(/^data\./, ''))} />
      {rowMenu && <Menu x={rowMenu.x} y={rowMenu.y} anchor={rowMenu.anchor} onClose={() => setRowMenu(null)} items={rowMenuItems(rowMenu.key)} />}
    </div>
  )
}

/** One line about a folded value: how much there is, not what it says. */
function summarizeValue(value: unknown): string {
  if (value == null || value === '') return 'Empty'
  if (typeof value === 'string') {
    const lines = value.split('\n').length
    return `${value.length.toLocaleString()} chars · ${lines.toLocaleString()} line${lines === 1 ? '' : 's'} — shown in the editor`
  }
  if (Array.isArray(value)) return `${value.length} items`
  if (typeof value === 'object') return `${Object.keys(value as object).length} keys`
  return String(value)
}

/** The last row of the fields list: a name, an optional kind, a value — Enter to set `data.<name>`. */
function AddPropertyRow({ onAdd, known }: { onAdd: (name: string, value: unknown, kind: FieldKind | undefined) => void; known: string[] }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<FieldKind | ''>('')
  const [value, setValue] = useState<unknown>('')
  const key = propertyKey(name)
  const exists = !!key && known.includes(key)
  const submit = () => {
    if (!key) return
    onAdd(name, value, kind || undefined)
    setName('')
    setValue('')
  }
  const close = () => setOpen(false)
  if (!open)
    return (
      <button className="insp__add-prop" onClick={() => setOpen(true)}>
        <Plus size={13} /> Add property
      </button>
    )
  return (
    <div className="insp__row insp__row--add">
      <div className="k">
        <input className="input" autoFocus placeholder="name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === 'Escape' ? close() : e.key === 'Enter' && submit())} />
        <Select
          className="input insp__kind"
          value={kind}
          title="Kind: which widget the property gets, on this type"
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
      <div className="v">
        <PropertyInput kind={kind || undefined} value={value} onChange={setValue} onEnter={submit} onEscape={close} placeholder={kind ? PROPERTY_KINDS.find((k) => k.kind === kind)?.hint : 'value  (true, 42, [1,2], text…)'} rows={3} />
        <div className="insp__add-hint">{exists ? `Sets the existing ${key}` : key ? `data.${key}${kind ? ` · ${PROPERTY_KINDS.find((k) => k.kind === kind)?.label} on every entity of this type` : ''}` : 'Enter to set · Esc to close'}</div>
      </div>
    </div>
  )
}

function Row({ k, children, after }: { k: string; children: React.ReactNode; after?: React.ReactNode }) {
  return (
    <>
      <div className="insp__row">
        <div className="k">{k}</div>
        <div className="v">{children}</div>
      </div>
      {after}
    </>
  )
}

function FieldValue({ field, value }: { field: FieldDef; value: unknown }) {
  if (value == null || value === '') return <span className="faint">{field.editable ? 'Empty' : '—'}</span>
  if (field.format) return <>{field.format(value, undefined as unknown as AnyEntity)}</>
  switch (field.kind) {
    case 'date':
      return field.key.startsWith('data.') ? <span>{formatDateOnly(value)}</span> : <span title={new Date(String(value)).toLocaleString()}>{formatDate(value)}</span>
    case 'datetime':
      return <span title={String(value)}>{formatDateTime(value)}</span>
    case 'url':
      // A URL from data is a link only when it is http(s): anything else is shown as the text it is.
      return httpUrl(value) ? (
        <a href={httpUrl(value)} target="_blank" rel="noreferrer noopener">
          {String(value)}
        </a>
      ) : (
        <span>{String(value)}</span>
      )
    case 'image':
      // A picture on another host waits for a click: loading it tells that host, and whatever its URL carries.
      return <DataImage src={value} style={{ maxWidth: '100%', maxHeight: 160, borderRadius: 6 }} />
    case 'availability':
    case 'boolean':
      return field.kind === 'availability' ? value ? <span className="badge badge--ok">yes</span> : <span className="badge">no</span> : value ? <span className="badge badge--ok">true</span> : <span className="badge">false</span>
    case 'color':
      return (
        <>
          <span className="swatch" style={{ background: String(value) }} /> <span className="mono">{String(value)}</span>
        </>
      )
    case 'json':
      return <pre>{JSON.stringify(value, null, 2)}</pre>
    case 'longtext':
      return <span style={{ whiteSpace: 'pre-wrap' }}>{String(value)}</span>
    default:
      return <>{String(value)}</>
  }
}

function FieldInput({ field, value, onSave, onCancel }: { field: FieldDef; value: unknown; onSave: (v: unknown) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<unknown>(value)
  const finish = () => onSave(field.kind === 'json' && typeof draft === 'string' ? coerceToKind(draft, 'json') ?? value : draft)
  return <PropertyInput kind={field.kind} options={field.options} value={draft} onChange={setDraft} onEnter={finish} onEscape={onCancel} onBlur={finish} autoFocus />
}

function RefLink({ id, selector, onOpen }: { id: EntityId; selector?: Relationship['target']['selector']; onOpen: (id: EntityId) => void }) {
  const store = useEntityStore()
  const target = store.get(id)
  return (
    <span>
      {target ? (
        <a href="#" onClick={(e) => (e.preventDefault(), onOpen(id))}>
          {displayLabel(target)}
        </a>
      ) : (
        <span className="badge badge--danger">missing {id.slice(0, 8)}</span>
      )}
      {selector && <span className="faint"> {describeSelector(selector)}</span>}
    </span>
  )
}

/** The relationship rows of the inspector's table: direction, the type (coloured), the entity at the other end (with its type). */
const REL_ROW_FIELDS: FieldDef[] = [
  { key: 'data.__dir', label: '', kind: 'text', plain: true, width: 34 },
  { key: 'type', label: 'Type', kind: 'text', width: 150 },
  { key: 'data.__other', label: 'With', kind: 'ref', width: 280, withType: true },
  { key: 'label', label: 'Label', kind: 'text', editable: true, width: 160 },
  { key: 'tags', label: 'Tags', kind: 'tags', editable: true, width: 160 },
  { key: 'meta.updatedAt', label: 'Updated', kind: 'datetime', width: 130 },
]
const relCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/**
 * The entity's relationships as the same table the Entities browser uses:
 * sortable, filterable, the type colour-coded, the other end a link. Rows
 * come sorted by relationship type and then by the other entity's label.
 */
function Relationships({ entity, onOpen }: { entity: AnyEntity; onOpen: (id: EntityId) => void }) {
  const store = useEntityStore()
  const toast = useToast()
  const openTab = useOpenInTab()
  const [adding, setAdding] = useState(false)
  // Deleting a relationship from this table asks first, as every table does (the ⌫ key and the row menu alike).
  const [deleting, setDeleting] = useState<EntityId[] | null>(null)
  const [relType, setRelType] = useState<string>(RELATIONSHIP_TYPES.references)
  const [targetQ, setTargetQ] = useState('')
  const [selected, setSelected] = useState<Set<EntityId>>(() => new Set())
  const rels = store.relationshipsOf(entity.id)
  const rows = useMemo(() => {
    const decorated = rels.map((r) => {
      const outgoing = r.source.id === entity.id
      const other = outgoing ? r.target : r.source
      const dir = r.directed ? (outgoing ? '→' : '←') : '↔'
      const otherLabel = store.get(other.id) ? displayLabel(store.get(other.id)!) : ''
      return { row: { ...r, data: { ...r.data, __dir: dir, __other: other } } as AnyEntity, otherLabel }
    })
    decorated.sort((a, b) => relCollator.compare(a.row.type, b.row.type) || relCollator.compare(a.otherLabel, b.otherLabel))
    return decorated.map((d) => d.row)
  }, [rels, entity.id, store])
  const candidates = targetQ.trim()
    ? store.query({ kind: 'entity', text: targetQ }).filter((e) => e.id !== entity.id).slice(0, 8)
    : []

  const add = (targetId: EntityId) => {
    store.upsert(createRelationship({ type: relType, source: entity.id, target: targetId, meta: { source: 'user' } }))
    setAdding(false)
    setTargetQ('')
    toast('Relationship added')
  }

  return (
    <div className="insp__rels">
      <div className="insp__rels-table">
        <EntityTable
          entities={rows}
          fields={REL_ROW_FIELDS}
          selected={selected}
          onSelectedChange={setSelected}
          // Opening a row means the thing at the other end (the conversation behind "annotates", say); the relationship itself is a click away in its fields.
          onOpen={(e) => onOpen(isRelationship(e) && (e.source.id === entity.id || e.target.id === entity.id) ? (e.source.id === entity.id ? e.target.id : e.source.id) : e.id)}
          onDelete={(ids) => setDeleting(ids)}
          storageKey="aegraph:inspector:relationships"
          emptyMessage="No relationships yet."
          // The row's menu is the one every entity has (related, open in Entities, ask, …) — see entityMenu.tsx.
          showOpenIn
          barEnd={
            <>
              {selected.size > 0 && (
                <button className="btn btn--sm" title="Open a table of the selected relationships with their source and target entities" onClick={() => openTab(relatedHref(store, [...selected]), relatedLabel(store, [...selected]))}>
                  <Waypoints size={13} /> Source & target {selected.size}
                </button>
              )}
              <button className="btn btn--sm" onClick={() => setAdding((v) => !v)}>
                <Plus size={13} /> Add
              </button>
            </>
          }
        />
      </div>
      <ConfirmDialog
        open={!!deleting}
        title={deleting?.length === 1 ? 'Delete this relationship?' : `Delete ${deleting?.length} relationships?`}
        message="The link goes; the entities at either end stay. This can't be undone."
        confirmLabel="Delete"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) store.remove(deleting)
          setDeleting(null)
        }}
      />
      {adding && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input" list="rel-types" value={relType} onChange={(e) => setRelType(e.target.value)} style={{ width: 140 }} />
            <datalist id="rel-types">
              {[...new Set([...Object.values(RELATIONSHIP_TYPES), ...store.relationships().map((r) => r.type)])].map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <input className="input" autoFocus placeholder="Find target entity…" value={targetQ} onChange={(e) => setTargetQ(e.target.value)} style={{ flex: 1 }} />
            <button className="btn btn--sm btn--ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
          {candidates.map((c) => (
            <button key={c.id} className="menu__item" onClick={() => add(c.id)}>
              <span className="badge">{c.type}</span> {displayLabel(c)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Which projects the entity is in, with a menu to change that. */
function ProjectsRow({ entity }: { entity: AnyEntity }) {
  const store = useEntityStore()
  const toast = useToast()
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  if (isProjectEntity(entity)) return null
  const projects = store.projectsOf(entity.id).map((id) => store.get(id)).filter((p): p is AnyEntity => !!p)
  return (
    <Row k="Projects">
      <div className="editable insp__projects" title="Add to or remove from a project" onClick={(e) => setMenu(menu ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget })}>
        {projects.length === 0 && <span className="faint">Library only</span>}
        {projects.map((p) => (
          <span key={p.id} className="chip">
            {displayLabel(p)}
          </span>
        ))}
      </div>
      {menu && <Menu x={menu.x} y={menu.y} anchor={menu.anchor} onClose={() => setMenu(null)} items={projectMenuItems(store, [entity.id], toast)} />}
    </Row>
  )
}
