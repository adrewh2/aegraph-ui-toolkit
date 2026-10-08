import { ArrowLeftRight, ArrowRight, ChevronDown, ChevronRight, Pencil, Search, Waypoints, X } from 'lucide-react'
import { PageHeader } from '../../components/Layout/PageHeader'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { graphHref } from '../../app/openIn'
import { entityHref } from '../../app/routes'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { ColorPick } from '../../components/ui/ColorPick'
import { schemaTypeId } from '../../core/entity/categories'
import { schemaTypeEntity, withProperty } from '../../core/entity/typeRegistry'
import { setTypeColor } from './typeColor'
import { hashColor } from '../../lib/format'
import { matchesWords, type PropertyProfile, type RelationProfile, type TypeProfile } from './profile'
import { ConstraintsPanel } from './ConstraintsPanel'
import { typeEditHref } from './TypeEditor'

/**
 * One entity type, laid out to stay readable when the ontology is large:
 * a sticky head with the counts and the actions, then folding sections —
 * properties, relationships, tags, recent entities — each with its own
 * search and a window of rows that opens on request, so a type with two
 * hundred properties and fifty relationship patterns is a page to scan,
 * not a wall. Descriptions — the type's and each property's — are edited
 * in place and saved on the type's definition (a `schema:type` entity),
 * where the assistant and MCP clients read them.
 */

const WINDOW = 40

export function TypeDetail({ profile, onFocusType, onClose, colorOf, labelOf, page = false }: { profile: TypeProfile; onFocusType: (type: string) => void; onClose: () => void; colorOf: (t: string) => string; labelOf: (t: string) => string; /** The whole page rather than a side pane: a title-sized head, wider columns. */ page?: boolean }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const { def, type } = profile
  const origin = def.origin === 'code' ? 'built in' : def.origin === 'inferred' ? 'inferred from the data' : def.origin === 'code+schema' ? 'built in, described here' : 'defined here'
  const openEntities = () => navigate(`/entities?category=${def.category}&type=${encodeURIComponent(type)}`)
  const openGraph = () => {
    const ids = store.ofType(type).filter((e) => e.kind === 'entity').map((e) => e.id)
    navigate(graphHref(ids, def.pluralLabel, '2d', true))
  }
  const editType = () => navigate(typeEditHref(type))
  const saveTypeDescription = (text: string) => {
    const existing = store.get(schemaTypeId(type))
    const patch: Parameters<typeof schemaTypeEntity>[1] = { description: text.trim() || undefined }
    if (!existing) {
      patch.label = def.label
      patch.category = def.category
    }
    store.upsert(schemaTypeEntity(type, patch, existing))
  }
  const savePropertyDescription = (key: string, text: string) => {
    const kind = profile.properties.find((p) => p.key === key)?.declared?.kind
    store.upsert(withProperty(store, type, { key, description: text.trim() || undefined, ...(kind ? { kind } : {}) }))
  }
  const chip = (t: string) => (
    <button key={t} className="onto__tchip" onClick={() => onFocusType(t)} title={t}>
      <span className="res__facet-dot" style={{ background: colorOf(t) }} />
      {labelOf(t)}
    </button>
  )
  const outgoing = profile.relations.filter((r) => r.direction === 'out')
  const incoming = profile.relations.filter((r) => r.direction === 'in')
  const undirected = profile.relations.filter((r) => r.direction === 'both')

  const meta = (
    <>
      <span>{def.category}</span>
      <span>·</span>
      <span>{origin}</span>
      <span>·</span>
      <strong>{profile.instances.toLocaleString()}</strong>
      <span>{profile.instances === 1 ? 'entity' : 'entities'}</span>
      <span>·</span>
      <strong>{profile.relations.reduce((n, r) => n + r.count, 0).toLocaleString()}</strong>
      <span>relationship ends</span>
      {profile.duplicateLabels > 0 && (
        <>
          <span>·</span>
          <span className="onto__warn" title="Labels shared by more than one entity of this type">
            {profile.duplicateLabels} duplicate label{profile.duplicateLabels === 1 ? '' : 's'}
          </span>
        </>
      )}
    </>
  )
  const lineage = (profile.parent || profile.children.length > 0) && (
    <div className="onto__lineage">
      {profile.parent && (
        <>
          <span className="muted">specialises</span> {chip(profile.parent.type)}
        </>
      )}
      {profile.children.length > 0 && (
        <>
          <span className="muted">specialised by</span> {profile.children.map((c) => chip(c.type))}
        </>
      )}
    </div>
  )
  const actions = (
    <>
      <button className="btn" onClick={openEntities} disabled={!profile.instances}>
        Entities <ArrowRight size={13} />
      </button>
      <button className="btn" onClick={openGraph} disabled={!profile.instances} title="A new graph of just these entities">
        <Waypoints size={13} /> Graph
      </button>
      <button className="btn" onClick={editType} title="Its names, place, colour, description and properties">
        <Pencil size={13} /> Edit type
      </button>
    </>
  )
  const description = <Editable value={def.description ?? ''} placeholder="What entities of this type are — a description for people and for the assistant." onSave={saveTypeDescription} multiline className="onto__desc" />

  return (
    <div className={`onto__detail ${page ? 'onto__detail--page' : ''}`}>
      {page ? (
        // The page: the app's standard head — crumbs, a serif title with the type's colour, the counts as the subtitle, the actions on the right.
        <PageHeader
          title={
            <span className="onto__page-title">
                <ColorPick value={colorOf(type)} chosen={!!def.color} label={def.label} size={16} className="onto__page-dot" onChange={(color) => setTypeColor(store, type, def, color)} />
              {def.label}
              <span className="onto__page-id mono">{type}</span>
            </span>
          }
          subtitle={<span className="onto__detail-meta">{meta}</span>}
          actions={actions}
        >
          {description}
          {lineage}
        </PageHeader>
      ) : (
        <div className="onto__detail-head">
          <div className="onto__detail-title">
            <ColorPick value={colorOf(type)} chosen={!!def.color} label={def.label} onChange={(color) => setTypeColor(store, type, def, color)} />
            <span className="chip" style={{ background: colorOf(type), color: '#fff' }}>
              {def.label}
            </span>
            <span className="mono muted">{type}</span>
            <span className="spacer" />
            <button className="btn btn--sm btn--ghost btn--icon" title="Back to the network" aria-label="Close" onClick={onClose}>
              <X size={13} />
            </button>
          </div>
          <div className="onto__detail-meta">{meta}</div>
          {description}
          {lineage}
          <div className="onto__detail-actions">{actions}</div>
        </div>
      )}

      <div className="onto__detail-body">
        <Section id={`${type}:props`} title="Properties" count={profile.properties.length} hint={profile.declaredUnused.length ? `${profile.declaredUnused.length} declared but unused` : undefined}>
          <PropertiesTable rows={profile.properties} unused={profile.declaredUnused} total={profile.instances} onDescribe={savePropertyDescription} />
        </Section>
        <Section id={`${type}:rels`} title="Relationships" count={profile.relations.length}>
          <RelationsTable outgoing={outgoing} incoming={incoming} undirected={undirected} self={type} chip={chip} onOpen={(rel) => navigate(`/entities?category=relationships&type=${encodeURIComponent(rel)}`)} />
        </Section>
        <Section id={`${type}:constraints`} title="Constraints" count={profile.constraints} collapsed={profile.constraints === 0}>
          <ConstraintsPanel type={type} />
        </Section>
        <Section id={`${type}:tags`} title="Tags" count={profile.tags.length} collapsed={profile.tags.length === 0}>
          <Windowed items={profile.tags} search={(t, q) => matchesWords(t.tag, q)} placeholder="Find a tag…" wrap>
            {(t) => (
              <button key={t.tag} className="onto__tag" onClick={() => navigate(`/entities?category=${def.category}&type=${encodeURIComponent(type)}&tag=${encodeURIComponent(t.tag)}`)} title={`${t.count.toLocaleString()} of ${profile.instances.toLocaleString()} carry ${t.tag}`}>
                <span className="res__facet-dot" style={{ background: store.getTagInfo(t.tag).color ?? hashColor(t.tag) }} />
                {t.tag}
                <span className="count">{t.count.toLocaleString()}</span>
              </button>
            )}
          </Windowed>
        </Section>
        <Section id={`${type}:recent`} title="Recently changed" count={profile.recent.length} collapsed={profile.recent.length === 0}>
          <div className="onto__recent">
            {profile.recent.map((e) => (
              <button key={e.id} className="onto__recent-row" onClick={() => navigate(entityHref(e, registry))}>
                <span className="onto__recent-label">{displayLabel(e)}</span>
                <span className="muted">{e.meta.updatedAt?.slice(0, 10)}</span>
              </button>
            ))}
            {profile.created.first && (
              <div className="muted onto__span">
                Created {profile.created.first.slice(0, 10)} → {profile.created.last?.slice(0, 10)} · last change {profile.updated.last?.slice(0, 10)}
              </div>
            )}
          </div>
        </Section>
      </div>
    </div>
  )
}

// ── Sections and windows ─────────────────────────────────────────────────

const FOLD_KEY = 'aegraph:ontology:folds'
const readFolds = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

/** A folding section with its count in the heading; what is folded is remembered per section id (per type). */
function Section({ id, title, count, hint, collapsed = false, children }: { id: string; title: string; count: number; hint?: string; collapsed?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    const f = readFolds()
    return id in f ? !f[id] : !collapsed
  })
  const toggle = () => {
    setOpen((o) => {
      const next = !o
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify({ ...readFolds(), [id]: !next }))
      } catch {
        /* ignore */
      }
      return next
    })
  }
  return (
    <section className={`onto__section ${open ? '' : 'is-folded'}`}>
      <h4>
        <button type="button" className="gx-fold onto__fold" onClick={toggle} aria-expanded={open}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title}
          <span className="onto__count">{count.toLocaleString()}</span>
        </button>
        {hint && <span className="onto__hint">{hint}</span>}
      </h4>
      {open && children}
    </section>
  )
}

/** A searchable list that shows a window of rows and opens fully on request — the one shape every long list here takes. */
function Windowed<T>({ items, search, placeholder, children, wrap, window = WINDOW, head }: { items: T[]; search: (t: T, q: string) => boolean; placeholder: string; children: (t: T, i: number, list: T[]) => ReactNode; wrap?: boolean; window?: number; head?: ReactNode }) {
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  useEffect(() => setAll(false), [items])
  const hits = useMemo(() => (q.trim() ? items.filter((t) => search(t, q)) : items), [items, q, search])
  const shown = all || hits.length <= window + 5 ? hits : hits.slice(0, window)
  return (
    <div className="onto__list">
      {items.length > 8 && (
        <label className="onto__search">
          <Search size={12} className="faint" />
          <input value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button type="button" className="onto__search-x" onClick={() => setQ('')} aria-label="Clear">
              <X size={11} />
            </button>
          )}
        </label>
      )}
      {head}
      <div className={wrap ? 'onto__wrap' : 'onto__rows'}>{shown.map((t, i) => children(t, i, shown))}</div>
      {shown.length < hits.length && (
        <button type="button" className="btn btn--sm btn--ghost onto__more" onClick={() => setAll(true)}>
          Show all {hits.length.toLocaleString()}
        </button>
      )}
      {!hits.length && <div className="muted onto__none">Nothing matches.</div>}
    </div>
  )
}

// ── Properties ───────────────────────────────────────────────────────────

const KIND_ORDER: PropertyProfile['kinds'] extends Partial<Record<infer K, number>> ? K[] : never = ['string', 'number', 'boolean', 'date', 'array', 'object', 'null']

function PropertiesTable({ rows, unused, total, onDescribe }: { rows: PropertyProfile[]; unused: string[]; total: number; onDescribe: (key: string, text: string) => void }) {
  const [sort, setSort] = useState<'coverage' | 'key'>('coverage')
  const sorted = useMemo(() => (sort === 'key' ? [...rows].sort((a, b) => a.key.localeCompare(b.key)) : rows), [rows, sort])
  return (
    <>
      <Windowed
        items={sorted}
        search={(p, q) => matchesWords(`${p.key} ${p.declared?.label ?? ''} ${p.declared?.description ?? ''} ${Object.keys(p.kinds).join(' ')}`, q)}
        placeholder="Find a property…"
        head={
          <div className="onto__cols onto__cols--head">
            <button type="button" className={`onto__col-btn ${sort === 'key' ? 'is-on' : ''}`} onClick={() => setSort('key')}>
              Property
            </button>
            <span>Kind</span>
            <button type="button" className={`onto__col-btn ${sort === 'coverage' ? 'is-on' : ''}`} onClick={() => setSort('coverage')}>
              Coverage
            </button>
            <span>Values</span>
            <span>Description</span>
          </div>
        }
      >
        {(p) => <PropertyRow key={p.key} p={p} total={total} onDescribe={onDescribe} />}
      </Windowed>
      {unused.length > 0 && (
        <div className="onto__unused">
          <span className="muted">Declared, carried by no entity:</span>
          {unused.map((k) => (
            <span key={k} className="mono onto__unused-key">
              {k}
            </span>
          ))}
        </div>
      )}
    </>
  )
}

function PropertyRow({ p, total, onDescribe }: { p: PropertyProfile; total: number; onDescribe: (key: string, text: string) => void }) {
  const pct = Math.round(p.coverage * 100)
  const kinds = KIND_ORDER.filter((k) => p.kinds[k]).map((k) => ({ k, n: p.kinds[k]! }))
  const observed = kinds.length === 1 ? kinds[0].k : kinds.map((x) => `${x.k} ${Math.round((100 * x.n) / p.count)}%`).join(' · ')
  const values = p.min !== undefined && p.kinds.number ? `${fmt(p.min)} – ${fmt(p.max!)}` : p.dateMin ? `${p.dateMin.slice(0, 10)} → ${p.dateMax!.slice(0, 10)}` : undefined
  const lowCardinality = p.top.length > 0 && !p.distinctCapped && p.distinct <= 12
  return (
    <div className="onto__cols onto__prow" title={p.sample ? `e.g. ${p.sample}` : undefined}>
      <div className="onto__pkey">
        <span className="mono">{p.key}</span>
        {p.declared?.required && <span className="onto__req" title="Required when created by hand">required</span>}
      </div>
      <div className="onto__pkind">
        {p.declared ? <span className="onto__kind" title="Declared on the type">{p.declared.kind}</span> : <span className="onto__kind onto__kind--observed" title="Not declared on the type: seen in the data only">{observed}</span>}
        {p.declared && !agrees(kinds.map((x) => x.k), p.declared.kind) && <span className="muted onto__observed" title="What the data holds, which is not what the declaration says">{observed}</span>}
      </div>
      <div className="onto__pcov" title={`${p.count.toLocaleString()} of ${total.toLocaleString()}`}>
        <span className="onto__bar">
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className="mono">{pct}%</span>
      </div>
      <div className="onto__pvals">
        {values && <span className="mono">{values}</span>}
        {!values && lowCardinality && (
          <span className="onto__topvals">
            {p.top.map((v) => (
              <span key={v.value} className="onto__val" title={`${v.count.toLocaleString()}×`}>
                {v.value || '""'}
              </span>
            ))}
          </span>
        )}
        {!values && !lowCardinality && (
          <span className="muted">
            {p.distinctCapped ? `${p.distinct.toLocaleString()}+` : p.distinct.toLocaleString()} distinct{p.meanLength !== undefined ? ` · ~${Math.round(p.meanLength)} chars` : ''}
          </span>
        )}
      </div>
      <div className="onto__pdesc">
        <Editable value={p.declared?.description ?? ''} placeholder="Describe…" onSave={(text) => onDescribe(p.key, text)} />
      </div>
    </div>
  )
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toPrecision(4))

/** Whether the value kinds seen fit the declared kind (a `text` property holding strings is as declared). */
const FITS: Record<string, string[]> = { string: ['text', 'longtext', 'url', 'image', 'color'], number: ['number'], boolean: ['boolean'], date: ['date', 'datetime', 'text'], array: ['json'], object: ['json'], null: [] }
const agrees = (seen: string[], declared: string) => seen.every((k) => k === 'null' || (FITS[k] ?? []).includes(declared))

// ── Relationships ────────────────────────────────────────────────────────

function RelationsTable({ outgoing, incoming, undirected, self, chip, onOpen }: { outgoing: RelationProfile[]; incoming: RelationProfile[]; undirected: RelationProfile[]; self: string; chip: (t: string) => ReactNode; onOpen: (rel: string) => void }) {
  const all = useMemo(() => [...outgoing.map((r) => ({ r, group: 'out' as const })), ...incoming.map((r) => ({ r, group: 'in' as const })), ...undirected.map((r) => ({ r, group: 'both' as const }))], [outgoing, incoming, undirected])
  const groupTitle = { out: 'Outgoing', in: 'Incoming', both: 'Undirected' }
  return (
    <Windowed
      items={all}
      search={(x, q) => matchesWords(`${x.r.rel} ${x.r.other} ${groupTitle[x.group]}`, q)}
      placeholder="Find a relationship or type…"
      head={
        <div className="onto__rrow onto__rrow--head">
          <span className="onto__rshape">Pattern</span>
          <span className="onto__rnums">
            <span title="Relationships">Count</span>
            <span title="Per participating entity: average · max">Per entity</span>
            <span title="Entities of this type that take part">Entities</span>
          </span>
        </div>
      }
    >
      {(x, i, list) => (
        <div key={`${x.group} ${x.r.rel} ${x.r.other}`}>
          {(i === 0 || list[i - 1].group !== x.group) && <div className="onto__group">{groupTitle[x.group]}</div>}
          <div className="onto__rrow" title={`${x.r.count.toLocaleString()} relationships · ${x.r.instances.toLocaleString()} ${self} entities take part · ${x.r.perInstance.toFixed(1)} each on average, at most ${x.r.maxPerInstance}`}>
            <span className="onto__rshape">
              {x.group === 'in' ? chip(x.r.other) : <span className="onto__self">this</span>}
              <button className="onto__rel" onClick={() => onOpen(x.r.rel)} title="Open these relationships in Entities">
                {x.group === 'both' ? <ArrowLeftRight size={12} className="faint" /> : <ArrowRight size={12} className="faint" />}
                {x.r.rel}
              </button>
              {x.group === 'in' ? <span className="onto__self">this</span> : chip(x.r.other)}
            </span>
            <span className="onto__rnums mono">
              <span title="Relationships">{x.r.count.toLocaleString()}</span>
              <span className="muted" title="Per participating entity: average · max">
                {x.r.perInstance >= 10 ? Math.round(x.r.perInstance) : x.r.perInstance.toFixed(1)}
                {x.r.maxPerInstance > 1 ? ` · ≤${x.r.maxPerInstance}` : ''}
              </span>
              <span className="muted" title="Entities of this type that take part">{x.r.instances.toLocaleString()}</span>
            </span>
          </div>
        </div>
      )}
    </Windowed>
  )
}

// ── Editing in place ─────────────────────────────────────────────────────

/** A value edited where it is read: click to edit, Enter (or blur) saves, Escape cancels. */
function Editable({ value, placeholder, onSave, multiline, className = '' }: { value: string; placeholder: string; onSave: (text: string) => void; multiline?: boolean; className?: string }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  if (!editing)
    return (
      <button type="button" className={`onto__editable ${value ? '' : 'is-empty'} ${className}`} onClick={() => setEditing(true)} title="Click to edit">
        {value || placeholder}
      </button>
    )
  const commit = () => {
    setEditing(false)
    if (text.trim() !== value.trim()) onSave(text)
  }
  const cancel = () => {
    setEditing(false)
    setText(value)
  }
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') cancel()
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      commit()
    }
  }
  return multiline ? <textarea className={`input onto__editing ${className}`} autoFocus rows={3} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={keys} /> : <input className={`input onto__editing ${className}`} autoFocus value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={keys} />
}
