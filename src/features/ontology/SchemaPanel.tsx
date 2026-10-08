import { ArrowRight, ArrowLeftRight, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Download, Search, Table2, Waypoints } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { graphSetupHref } from '../../app/openIn'
import { typeHref } from '../../app/routes'
import { CATEGORIES, type TypeCategory } from '../../core/entity/categories'
import { useEntityStore, useStoreDataVersion, useTypeRegistry } from '../../core/entity/hooks'
import { ColorPick } from '../../components/ui/ColorPick'
import { setTypeColor } from './typeColor'
import { downloadText } from '../../lib/download'
import { hashColor } from '../../lib/format'
import { schemaReference, schemaReferenceJson, type Cardinality, type PairRef, type RelationshipRef, type TypeRef } from './reference'
import { typePageHref } from './TypePage'
import './schemaPanel.css'

/**
 * The Schema tab: the dataset's whole vocabulary written out as a
 * reference — every entity type the app knows, with instances or not,
 * grouped by category with its properties (declared, inherited, or only
 * observed on entities); then every relationship type with the pairs of
 * types it connects and the cardinality each pair shows. Read it like a
 * data dictionary; download it as JSON to hand to another system.
 */

const ORIGIN: Record<TypeRef['origin'], string> = { code: 'built in', schema: 'defined in the data', 'code+schema': 'built in · described in the data', inferred: 'inferred from the data' }
const CARD: Record<Cardinality, string> = { '1:1': 'one to one', '1:N': 'one to many', 'N:1': 'many to one', 'N:M': 'many to many' }

export function SchemaPanel() {
  const store = useEntityStore()
  const version = useStoreDataVersion(store)
  const registry = useTypeRegistry()
  const [q, setQ] = useState('')
  const [empty, setEmpty] = useState(true)
  // Cards fold to their head row; `open` is the set unfolded by hand, `all` unfolds every card (a hand-folded one then closes on its own).
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [all, setAll] = useState(false)
  /** Entity types, or relationship types. */
  const [part, setPart] = useState<'types' | 'relationships'>(() => (localStorage.getItem('aegraph:ontology:schema-part') === 'relationships' ? 'relationships' : 'types'))
  const pickPart = (p: 'types' | 'relationships') => {
    setPart(p)
    localStorage.setItem('aegraph:ontology:schema-part', p)
    // Each part starts folded.
    setAll(false)
    setOpen(new Set())
  }
  // Categories start open; folding one hides its types until it is opened again.
  const [foldedCats, setFoldedCats] = useState<Set<TypeCategory>>(() => new Set())
  const toggleCat = (c: TypeCategory) =>
    setFoldedCats((cur) => {
      const next = new Set(cur)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  const isOpen = (key: string) => (all ? !open.has(key) : open.has(key))
  const toggle = (key: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const expandAll = () => (setAll(true), setOpen(new Set()))
  const collapseAll = () => (setAll(false), setOpen(new Set()))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ref = useMemo(() => schemaReference(store, registry), [store, registry, version])

  const text = q.trim().toLowerCase()
  const matches = (...s: (string | undefined)[]) => !text || s.some((x) => x?.toLowerCase().includes(text))
  const groups = ref.byCategory.map((g) => ({ ...g, types: g.types.filter((t) => (empty || t.count > 0) && (matches(t.type, t.label, t.description) || t.properties.some((p) => matches(p.key, p.label)))) })).filter((g) => g.types.length)
  const relationships = ref.relationships.filter((r) => matches(r.rel, r.label, r.description) || r.pairs.some((p) => matches(p.source, p.target)))

  return (
    <div className="res__body sch">
      <div className="sch__bar">
        <div className="gx-tabs" role="tablist" aria-label="Part of the schema">
          <button role="tab" aria-selected={part === 'types'} className={`gx-tab ${part === 'types' ? 'is-active' : ''}`} onClick={() => pickPart('types')} title="Every entity type with its properties">
            Entity types <span className="muted">{ref.totals.types}</span>
          </button>
          <button role="tab" aria-selected={part === 'relationships'} className={`gx-tab ${part === 'relationships' ? 'is-active' : ''}`} onClick={() => pickPart('relationships')} title="Every relationship type with the pairs of types it connects and their cardinality">
            Relationship types <span className="muted">{ref.totals.relationshipTypes}</span>
          </button>
        </div>
        <label className="onto__search">
          <Search size={14} className="faint" />
          <input value={q} placeholder={part === 'types' ? 'Find a type or property…' : 'Find a relationship type or an end type…'} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="sch__meta">
          {part === 'types' && (
            <label className="sch__toggle">
              <input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} /> Types with no entities
            </label>
          )}
          <span className="muted sch__totals">{part === 'types' ? `${ref.totals.withInstances} of ${ref.totals.types} types have entities · ${ref.totals.entities.toLocaleString()} entities` : `${ref.totals.pairs} type pairs · ${ref.totals.relationships.toLocaleString()} relationships`}</span>
        </div>
        <div className="sch__actions">
          <button className="btn btn--sm" onClick={all ? collapseAll : expandAll} title={all ? 'Fold every type to its head row' : 'Unfold every type'}>
            {all ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />} {all ? 'Collapse all' : 'Expand all'}
          </button>
          <button className="btn btn--sm" onClick={() => downloadText(`${store.scope ? (store.get(store.scope)?.label ?? 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'library'}-schema.json`, JSON.stringify(schemaReferenceJson(ref), null, 2))} title="The reference as JSON: types with properties, relationship types with pairs and cardinality">
            <Download size={12} /> Download schema
          </button>
        </div>
      </div>

      {part === 'types' &&
        groups.map((g) => {
          const folded = foldedCats.has(g.category)
          return (
            <section key={g.category} className={`sch__section ${folded ? 'is-folded' : ''}`}>
              <h2 onClick={() => toggleCat(g.category)} title={folded ? 'Show these types' : 'Hide these types'}>
                <button type="button" className="sch__fold" aria-expanded={!folded} aria-label={folded ? 'Expand' : 'Collapse'}>
                  {folded ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                </button>
                {CATEGORIES[g.category].pluralLabel} <span className="muted">{g.types.length}</span>
              </h2>
              {!folded && (
                <>
                  <p className="muted sch__cat">{CATEGORIES[g.category].description}</p>
                  {g.types.map((t) => (
                    <TypeBlock key={t.type} t={t} open={isOpen(t.type)} onToggle={() => toggle(t.type)} />
                  ))}
                </>
              )}
            </section>
          )
        })}
      {part === 'types' && !groups.length && <p className="muted">No type matches.</p>}

      {part === 'relationships' && (
        <section className="sch__section">
          <p className="muted sch__cat">What connects to what through each relationship, and how many on each side. Cardinality is what the data shows, not a rule: “one to many” means some source has several targets of that type while no target has more than one source; the per-source and per-target columns give the counts behind it.</p>
          {relationships.map((r) => (
            <RelBlock key={r.rel} r={r} open={isOpen(`rel:${r.rel}`)} onToggle={() => toggle(`rel:${r.rel}`)} />
          ))}
          {!relationships.length && <p className="muted">No relationships.</p>}
        </section>
      )}
    </div>
  )
}

/**
 * A type's name with its colour, linking to its page. A pseudo-type `(rel)` — a relationship used as an end —
 * reads as "Rel (relationship)". The swatch is the place the type's colour is set: it is what the tables, the
 * chips and the graph all read, so changing it here changes it everywhere.
 */
function TypeLink({ type }: { type: string }) {
  const registry = useTypeRegistry()
  const store = useEntityStore()
  const navigate = useNavigate()
  const bare = type.startsWith('(') ? type.slice(1, -1) : type
  const def = registry.get(bare)
  return (
    <span className="sch__type-wrap">
      <ColorPick value={def.color ?? hashColor(bare)} chosen={!!def.color} label={def.label} onChange={(color) => setTypeColor(store, bare, def, color)} />
      <a className="sch__type" href={typePageHref(bare)} onClick={(e) => (e.preventDefault(), navigate(typePageHref(bare)))} title={type}>
        {bare === type ? def.label : `${def.label} (relationship)`}
      </a>
    </span>
  )
}

/** The way from a type to its rows and to its graph: the Entities browser filtered to it, and a new explorer tab on that filter. */
function GoButtons({ count, label, table, filter }: { count: number; label: string; table: string; filter: Record<string, unknown> }) {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" className="btn btn--sm btn--ghost" disabled={!count} onClick={() => navigate(table)} title={count ? `${label} in the Entities table` : 'No entities yet'}>
        <Table2 size={13} /> Table
      </button>
      <button type="button" className="btn btn--sm btn--ghost" disabled={!count} onClick={() => navigate(graphSetupHref({ label, filter }))} title={count ? `A new graph filtered to ${label.toLowerCase()}` : 'No entities yet'}>
        <Waypoints size={13} /> Graph
      </button>
    </>
  )
}

function TypeBlock({ t, open, onToggle }: { t: TypeRef; open: boolean; onToggle: () => void }) {
  const declared = t.properties.filter((p) => p.declaredOn)
  const observed = t.properties.filter((p) => !p.declaredOn)
  return (
    <article className={`sch__type-block ${t.count ? '' : 'is-empty'} ${open ? 'is-open' : ''}`} id={`schema-${t.type}`}>
      <header className="sch__type-head" onClick={(e) => !(e.target as HTMLElement).closest('a, .btn') && onToggle()}>
        <button type="button" className="sch__fold" aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <TypeLink type={t.type} />
        <span className="mono muted">{t.type}</span>
        <span className="badge">{ORIGIN[t.origin]}</span>
        <span className="muted">{t.count ? `${t.count.toLocaleString()} entit${t.count === 1 ? 'y' : 'ies'}` : 'no entities yet'}</span>
        {t.parent && (
          <span className="muted">
            · subtype of <TypeLink type={t.parent} />
          </span>
        )}
        {t.children.length > 0 && (
          <span className="muted">
            · subtypes:{' '}
            {t.children.map((c, i) => (
              <span key={c}>
                {i > 0 && ', '}
                <TypeLink type={c} />
              </span>
            ))}
          </span>
        )}
        <span className="sch__actions">
          {!open && <span className="muted sch__peek">{t.properties.length ? `${t.properties.length} propert${t.properties.length === 1 ? 'y' : 'ies'}` : ''}</span>}
          <GoButtons count={t.count} label={t.pluralLabel} table={typeHref(t.type, t.category)} filter={{ types: [t.type] }} />
        </span>
      </header>
      {open && t.description && <p className="sch__desc">{t.description}</p>}
      {!open ? null : t.properties.length ? (
        <table className="sch__props">
          <thead>
            <tr>
              <th>Property</th>
              <th>Kind</th>
              <th>Description</th>
              <th className="num">On entities</th>
            </tr>
          </thead>
          <tbody>
            {declared.map((p) => (
              <tr key={p.key}>
                <td>
                  <span className="mono">{p.key}</span>
                  {p.label !== p.key && <span className="muted"> · {p.label}</span>}
                  {p.required && <span className="sch__req">required</span>}
                  {p.declaredOn && p.declaredOn !== t.type && <span className="muted sch__inh"> · from {p.declaredOn}</span>}
                </td>
                <td className="muted">
                  {p.kind ?? '—'}
                  {p.options && <span title={p.options.join(', ')}> · {p.options.length} options</span>}
                </td>
                <td className="muted">{p.description ?? ''}</td>
                <td className="num muted">{t.count ? `${p.count.toLocaleString()} (${Math.round((100 * p.count) / t.count)}%)` : '—'}</td>
              </tr>
            ))}
            {observed.map((p) => (
              <tr key={p.key} className="is-observed">
                <td>
                  <span className="mono">{p.key}</span>
                </td>
                <td className="muted">not declared</td>
                <td className="muted">Seen on entities; add it to the type to give it a kind and a label.</td>
                <td className="num muted">{t.count ? `${p.count.toLocaleString()} (${Math.round((100 * p.count) / t.count)}%)` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted sch__none">No properties beyond the common ones (label, description, tags, dates).</p>
      )}
    </article>
  )
}

function RelBlock({ r, open, onToggle }: { r: RelationshipRef; open: boolean; onToggle: () => void }) {
  return (
    <article className={`sch__type-block ${r.count ? '' : 'is-empty'} ${open ? 'is-open' : ''}`} id={`schema-rel-${r.rel}`}>
      <header className="sch__type-head" onClick={(e) => !(e.target as HTMLElement).closest('.btn') && onToggle()}>
        <button type="button" className="sch__fold" aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="sch__type sch__type--rel">
          <i style={{ background: r.color ?? hashColor(r.rel) }} />
          {r.label}
        </span>
        <span className="mono muted">{r.rel}</span>
        <span className="badge">{ORIGIN[r.origin]}</span>
        <span className="muted">{r.count ? `${r.count.toLocaleString()} relationship${r.count === 1 ? '' : 's'} · ${r.pairs.length} type pair${r.pairs.length === 1 ? '' : 's'}` : 'not used yet'}</span>
        <span className="sch__actions">
          <GoButtons count={r.count} label={r.label} table={`/entities?category=relationships&type=${encodeURIComponent(r.rel)}`} filter={{ relationshipTypes: [r.rel], hideIsolated: true }} />
        </span>
      </header>
      {open && r.description && <p className="sch__desc">{r.description}</p>}
      {open && r.pairs.length > 0 && (
        <table className="sch__props sch__pairs">
          <thead>
            <tr>
              <th>Source</th>
              <th></th>
              <th>Target</th>
              <th>Cardinality</th>
              <th>Per source</th>
              <th>Per target</th>
              <th className="num">Count</th>
            </tr>
          </thead>
          <tbody>
            {r.pairs.map((p) => (
              <PairRow key={p.source + p.target} p={p} />
            ))}
          </tbody>
        </table>
      )}
    </article>
  )
}

function PairRow({ p }: { p: PairRef }) {
  return (
    <tr>
      <td>
        <TypeLink type={p.source} />
      </td>
      <td className="muted">{p.directed ? <ArrowRight size={13} /> : <ArrowLeftRight size={13} />}</td>
      <td>
        <TypeLink type={p.target} />
      </td>
      <td>
        <span className={`sch__card sch__card--${p.cardinality.replace(':', '')}`} title={CARD[p.cardinality]}>
          {p.cardinality}
        </span>{' '}
        <span className="muted">{CARD[p.cardinality]}</span>
      </td>
      <td className="muted" title={`${p.sources.toLocaleString()} distinct sources; one has at most ${p.maxOut} targets`}>
        {p.sources.toLocaleString()} · up to {p.maxOut}
      </td>
      <td className="muted" title={`${p.targets.toLocaleString()} distinct targets; one has at most ${p.maxIn} sources`}>
        {p.targets.toLocaleString()} · up to {p.maxIn}
      </td>
      <td className="num">{p.count.toLocaleString()}</td>
    </tr>
  )
}
