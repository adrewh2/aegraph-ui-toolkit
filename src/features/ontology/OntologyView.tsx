import { ArrowRight, ArrowLeftRight, Bookmark, BookOpen, CircleDot, Grid3x3, Network, Plus, Search, ShieldCheck, Waypoints, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CATEGORIES, CATEGORY_ORDER, type TypeCategory } from '../../core/entity/categories'
import { useEntityStore, useStoreDataVersion, useTypeRegistry } from '../../core/entity/hooks'
import { hashColor } from '../../lib/format'
import { useResizableWidth } from '../../lib/useResizableWidth'
import { layoutSchema, radialSchema, schemaNetwork, searchTriples, type SchemaTriple, type SchemaType } from './schema'
import { ClaimsPanel } from './ClaimsPanel'
import { ConstraintsPanel } from './ConstraintsPanel'
import { SchemaPanel } from './SchemaPanel'
import { TagMatrix } from './TagMatrix'
import { NewTypeDialog } from './TypeEditor'
import { typePageHref } from './TypePage'
import '../resources/ResourcesView.css'
import './ontology.css'

/**
 * `/ontology` — the vocabulary of the workspace, instances set aside, under
 * five tabs. Schema: every type and relationship type written out as a
 * reference (SchemaPanel). Network: the types as nodes and the links between
 * them weighted by count, beside a searchable table of every (type →
 * relationship → type) triple; a type opens its own page (TypePage), and
 * ⇧-click narrows both to it. Tags: how tags spread over the types
 * (TagMatrix). Claims: what the workspace asserts, with its evidence.
 * Constraints: the rules every write must satisfy, and the audit.
 */
type OntologyTab = 'schema' | 'network' | 'tags' | 'claims' | 'constraints'

export function OntologyView() {
  const store = useEntityStore()
  const version = useStoreDataVersion(store) // a whole-store walk: only data changes redo it
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [focus, setFocus] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  /** Which categories count. The data's own types by default; presentation types (layouts, scenes, plots) on request. */
  const [cats, setCats] = useState<TypeCategory[]>(['knowledge', 'resource'])
  /** The tab in front, remembered across visits. */
  const [tab, setTab] = useState<OntologyTab>(() => (localStorage.getItem('aegraph:ontology:tab') as OntologyTab) || 'schema')
  const pickTab = (t: OntologyTab) => {
    setTab(t)
    localStorage.setItem('aegraph:ontology:tab', t)
  }
  /** Radial: the types around a circle by category, links as curves through the middle. Force: a free layout. */
  const [mode, setMode] = useState<'radial' | 'force'>(() => (localStorage.getItem('aegraph:ontology:mode') as 'radial' | 'force') || 'radial')
  const pickMode = (m: 'radial' | 'force') => {
    setMode(m)
    localStorage.setItem('aegraph:ontology:mode', m)
  }
  const side = useResizableWidth({ storageKey: 'aegraph:ontology:side-width', initial: 560, min: 320, max: 1400, edge: 'start' })
  const svgRef = useRef<SVGSVGElement>(null)
  const [box, setBox] = useState({ w: 800, h: 600 })

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const net = useMemo(() => schemaNetwork(store, registry, { categories: cats }), [store, registry, version, cats])
  const positions = useMemo(() => {
    if (mode === 'force') return layoutSchema(net, box.w, box.h)
    // Radial: the circle fills the box, leaving room for the labels outside it.
    const cx = box.w / 2
    const cy = box.h / 2
    const R = Math.max(60, Math.min(box.w, box.h) / 2 - 130)
    const { slots } = radialSchema(net, CATEGORY_ORDER)
    return new Map(slots.map((s) => [s.type, { x: cx + R * Math.cos(s.angle), y: cy + R * Math.sin(s.angle) }]))
  }, [net, box.w, box.h, mode])
  const radial = useMemo(() => (mode === 'radial' ? radialSchema(net, CATEGORY_ORDER) : null), [net, mode])
  const geom = { cx: box.w / 2, cy: box.h / 2, R: Math.max(60, Math.min(box.w, box.h) / 2 - 130) }
  const angleOf = (t: string) => radial?.slots.find((s) => s.type === t)?.angle
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect
      if (r.width > 50 && r.height > 50) setBox((b) => (Math.abs(b.w - r.width) > 2 || Math.abs(b.h - r.height) > 2 ? { w: r.width, h: r.height } : b))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const colorOf = (t: string) => net.types.find((x) => x.type === t)?.color ?? hashColor(t)
  const labelOf = (t: string) => net.types.find((x) => x.type === t)?.label ?? t
  const rows = useMemo(() => {
    const found = searchTriples(net, q)
    return focus ? found.filter((t) => t.source === focus || t.target === focus) : found
  }, [net, q, focus])
  const focused = focus ? net.types.find((t) => t.type === focus) : undefined
  /** Types touched by the rows in view: the graph dims the rest. */
  const lit = useMemo(() => new Set(rows.flatMap((t) => [t.source, t.target])), [rows])
  const litLinks = useMemo(() => new Set(rows.map((t) => [t.source, t.target].sort().join(' :: '))), [rows])
  const maxCount = Math.max(1, ...net.types.map((t) => t.count))
  const maxLink = Math.max(1, ...net.links.map((l) => l.count))
  const radius = (t: SchemaType) => 8 + 22 * Math.sqrt(t.count / maxCount)
  const filtering = !!q.trim() || !!focus

  const [newType, setNewType] = useState(false)
  return (
    <div className="res onto">
      {newType && <NewTypeDialog onClose={() => setNewType(false)} onCreated={(e) => navigate(typePageHref(String(e.data.name)))} />}
      <div className="res__head">
        <div>
          <h1 className="page-title">Ontology</h1>
          <p className="page-subtitle">
            {tab === 'schema' ? (
              <>The full vocabulary of {store.scope ? 'this project' : 'the Library'} as a reference: every entity type the app knows — with entities or without — and its properties, then every relationship type with the pairs of types it connects and their cardinality. Click a type for its page.</>
            ) : tab === 'claims' ? (
              <>What this workspace asserts: claims with the entities that support them, and the communities that were named. Findings kept from Insights land here; so do claims written by hand.</>
            ) : tab === 'constraints' ? (
              <>The rules the store enforces on every write: what an entity of a type must carry, what must be unique, what a relationship may join, or a check in JavaScript. A write that fails a rejecting rule does not get in; Audit checks what is already there.</>
            ) : tab === 'tags' ? (
              <>How tags spread over the types: each cell is how many entities of a type carry a tag, with <span className="mono">key:value</span> tags grouped under their key. Click a cell to open those entities; click a facet column to spread out its values.</>
            ) : (
              <>
            The schema of this workspace, instances set aside: {net.totals.types} types, {net.totals.predicates} relationship types, {net.totals.triples} type-to-type links over {net.totals.entities.toLocaleString()} entities and {net.totals.relationships.toLocaleString()} relationships
            {net.totals.danglingRelationships ? ` (${net.totals.danglingRelationships} relationships point at nothing)` : ''}. Click a type to see what it is made of and what it relates to.
              </>
            )}
          </p>
        </div>
        <div className="res__head-actions">
          <div className="gx-tabs onto__tabs" role="tablist" aria-label="View">
            <button role="tab" aria-selected={tab === 'schema'} className={`gx-tab ${tab === 'schema' ? 'is-active' : ''}`} onClick={() => pickTab('schema')} title="Every type and relationship type, with properties and cardinality — the reference">
              <BookOpen size={12} /> Schema
            </button>
            <button role="tab" aria-selected={tab === 'network'} className={`gx-tab ${tab === 'network' ? 'is-active' : ''}`} onClick={() => pickTab('network')} title="Types as nodes and the relationships between them as links">
              <Network size={12} /> Network
            </button>
            <button role="tab" aria-selected={tab === 'tags'} className={`gx-tab ${tab === 'tags' ? 'is-active' : ''}`} onClick={() => pickTab('tags')} title="How tags and tag values spread over the types — a matrix, in 2D or 3D">
              <Grid3x3 size={12} /> Tags
            </button>
            <button role="tab" aria-selected={tab === 'claims'} className={`gx-tab ${tab === 'claims' ? 'is-active' : ''}`} onClick={() => pickTab('claims')} title="Claims and their evidence, named communities">
              <Bookmark size={12} /> Claims
            </button>
            <button role="tab" aria-selected={tab === 'constraints'} className={`gx-tab ${tab === 'constraints' ? 'is-active' : ''}`} onClick={() => pickTab('constraints')} title="The rules every write must satisfy">
              <ShieldCheck size={12} /> Constraints
            </button>
          </div>
          <button className="btn btn--primary" onClick={() => setNewType(true)} title="Define a new entity type and its properties">
            <Plus size={13} /> New type
          </button>
          <button className="btn" onClick={() => navigate('/entities?category=types')}>
            Types table
          </button>
          <button className="btn" onClick={() => navigate('/docs/model')}>
            Data model
          </button>
        </div>
      </div>

      {tab === 'tags' && (
        <div className="res__toolbar onto__cats-bar">
          <div className="gx-tabs" role="group" aria-label="Categories">
            {CATEGORY_ORDER.filter((c) => c !== 'schema').map((c) => (
              <button key={c} className={`gx-tab ${cats.includes(c) ? 'is-active' : ''}`} aria-pressed={cats.includes(c)} title={CATEGORIES[c].description} onClick={() => setCats((cur) => (cur.includes(c) ? (cur.length > 1 ? cur.filter((x) => x !== c) : cur) : [...cur, c]))}>
                {CATEGORIES[c].label}
              </button>
            ))}
          </div>
        </div>
      )}
      {tab === 'tags' && <TagMatrix categories={cats} />}
      {tab === 'claims' && <ClaimsPanel />}
      {tab === 'constraints' && <ConstraintsPanel />}
      {tab === 'schema' && <SchemaPanel />}

      {tab === 'network' && (
      <div className="res__toolbar">
        <label className="onto__search">
          <Search size={14} className="faint" />
          <input placeholder="Search the schema: a type, a relationship, or “person → paper”" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button className="btn btn--sm btn--icon btn--ghost" onClick={() => setQ('')} aria-label="Clear">
              <X size={12} />
            </button>
          )}
        </label>
        {focused && (
          <span className="onto__focus">
            <span className="chip" style={{ background: colorOf(focused.type), color: '#fff' }}>
              {focused.label}
            </span>
            <button className="btn btn--sm btn--ghost" onClick={() => setFocus(null)}>
              <X size={12} /> All types
            </button>
          </span>
        )}
        <span className="spacer" />
        <div className="gx-tabs" role="group" aria-label="Layout">
          <button className={`gx-tab ${mode === 'radial' ? 'is-active' : ''}`} aria-pressed={mode === 'radial'} title="Types around a circle by category; links as curves through the middle" onClick={() => pickMode('radial')}>
            <CircleDot size={12} /> Radial
          </button>
          <button className={`gx-tab ${mode === 'force' ? 'is-active' : ''}`} aria-pressed={mode === 'force'} title="A free force layout" onClick={() => pickMode('force')}>
            <Waypoints size={12} /> Force
          </button>
        </div>
        <div className="gx-tabs" role="group" aria-label="Categories">
          {CATEGORY_ORDER.filter((c) => c !== 'schema').map((c) => (
            <button key={c} className={`gx-tab ${cats.includes(c) ? 'is-active' : ''}`} aria-pressed={cats.includes(c)} title={CATEGORIES[c].description} onClick={() => setCats((cur) => (cur.includes(c) ? (cur.length > 1 ? cur.filter((x) => x !== c) : cur) : [...cur, c]))}>
              {CATEGORIES[c].label}
            </button>
          ))}
        </div>
        <span className="muted">{filtering ? `${rows.length} of ${net.totals.triples} links` : `${net.predicates.length} relationship types`}</span>
      </div>
      )}

      {tab === 'network' && (
      <div className="res__body">
        <div className="res__table onto__stage">
          <svg ref={svgRef} className="onto__graph" onClick={() => setFocus(null)}>
            <defs>
              <marker id="onto-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="context-stroke" />
              </marker>
            </defs>
            {net.links.map((l) => {
              const a = positions.get(l.a)
              const b = positions.get(l.b)
              if (!a || !b) return null
              const key = [l.a, l.b].sort().join(' :: ')
              const dim = filtering && !litLinks.has(key)
              const w = 1 + 6 * Math.sqrt(l.count / maxLink)
              if (l.a === l.b) {
                // A self link: a loop above the node.
                const r = radius(net.types.find((t) => t.type === l.a)!) + 6
                return <path key={key} className={`onto__link ${dim ? 'is-dim' : ''}`} d={`M ${a.x - 6} ${a.y - r} C ${a.x - 30} ${a.y - r - 40}, ${a.x + 30} ${a.y - r - 40}, ${a.x + 6} ${a.y - r}`} fill="none" strokeWidth={w} />
              }
              const hot = hover === l.a || hover === l.b || focus === l.a || focus === l.b
              if (mode === 'radial') {
                // A curve bent toward the centre — the further apart around the circle, the deeper it dips — so links bundle through the middle.
                const aa = angleOf(l.a) ?? 0
                const ab = angleOf(l.b) ?? 0
                let gapA = Math.abs(aa - ab) % (Math.PI * 2)
                if (gapA > Math.PI) gapA = Math.PI * 2 - gapA
                const pull = 0.15 + 0.7 * (gapA / Math.PI)
                const c1 = { x: geom.cx + (a.x - geom.cx) * (1 - pull), y: geom.cy + (a.y - geom.cy) * (1 - pull) }
                const c2 = { x: geom.cx + (b.x - geom.cx) * (1 - pull), y: geom.cy + (b.y - geom.cy) * (1 - pull) }
                return (
                  <g key={key} className={`onto__link ${dim ? 'is-dim' : ''} ${hot ? 'is-hot' : ''}`}>
                    <path d={`M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`} fill="none" strokeWidth={w} stroke={hot ? colorOf(hover === l.b || focus === l.b ? l.b : l.a) : undefined}>
                      <title>
                        {labelOf(l.a)} — {labelOf(l.b)}: {l.count.toLocaleString()}
                        {l.triples.map((t) => `\n  ${labelOf(t.source)} → ${t.rel} → ${labelOf(t.target)}: ${t.count.toLocaleString()}`).join('')}
                      </title>
                    </path>
                  </g>
                )
              }
              const mx = (a.x + b.x) / 2
              const my = (a.y + b.y) / 2
              return (
                <g key={key} className={`onto__link ${dim ? 'is-dim' : ''} ${hot ? 'is-hot' : ''}`}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={w} />
                  <text x={mx} y={my - 4} className="onto__link-count">
                    {l.count}
                  </text>
                </g>
              )
            })}
            {radial?.arcs.map((arc) => {
              // The category's arc, just inside the ring (the labels live outside it), with its name inside the arc.
              const r = geom.R - 30
              const large = arc.end - arc.start > Math.PI ? 1 : 0
              const x1 = geom.cx + r * Math.cos(arc.start)
              const y1 = geom.cy + r * Math.sin(arc.start)
              const x2 = geom.cx + r * Math.cos(arc.end)
              const y2 = geom.cy + r * Math.sin(arc.end)
              const mid = (arc.start + arc.end) / 2
              const lx = geom.cx + (r - 16) * Math.cos(mid)
              const ly = geom.cy + (r - 16) * Math.sin(mid)
              return (
                <g key={arc.category} className="onto__arc">
                  <path d={`M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`} fill="none" />
                  <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle">
                    {CATEGORIES[arc.category].pluralLabel} · {arc.types}
                  </text>
                </g>
              )
            })}
            {net.types.map((t) => {
              const p = positions.get(t.type)
              if (!p) return null
              const r = mode === 'radial' ? Math.min(radius(t), 16) : radius(t)
              const dim = filtering && !lit.has(t.type)
              const ang = angleOf(t.type)
              const flip = ang !== undefined && Math.cos(ang) < 0
              return (
                <g
                  key={t.type}
                  className={`onto__node ${dim ? 'is-dim' : ''} ${focus === t.type ? 'is-focus' : ''} ${hover === t.type ? 'is-hover' : ''}`}
                  transform={`translate(${p.x} ${p.y})`}
                  onClick={(e) => (e.stopPropagation(), e.shiftKey || e.altKey ? setFocus(focus === t.type ? null : t.type) : navigate(`/ontology/type/${encodeURIComponent(t.type)}`))}
                  onMouseEnter={() => setHover(t.type)}
                  onMouseLeave={() => setHover(null)}
                >
                  <circle r={r} fill={colorOf(t.type)} />
                  {ang !== undefined ? (
                    <text className="onto__label" transform={`rotate(${((ang * 180) / Math.PI + (flip ? 180 : 0)).toFixed(1)}) translate(${flip ? -(r + 6) : r + 6} 0)`} textAnchor={flip ? 'end' : 'start'} dominantBaseline="middle">
                      {t.label} <tspan className="onto__label-n">{t.count.toLocaleString()}</tspan>
                    </text>
                  ) : (
                    <text y={r + 13} textAnchor="middle" className="onto__label">
                      {t.label}
                    </text>
                  )}
                  {mode === 'force' && (
                    <text y={4} textAnchor="middle" className="onto__count" style={{ fontSize: Math.max(9, Math.min(13, r * 0.7)) }}>
                      {t.count >= 1000 ? `${(t.count / 1000).toFixed(t.count >= 10000 ? 0 : 1)}k` : t.count}
                    </text>
                  )}
                  <title>
                    {t.label} · {t.count.toLocaleString()} entities · {t.degree.toLocaleString()} relationship ends · {t.category} · {t.origin} — click for the type's page · shift-click to show only its links
                  </title>
                </g>
              )
            })}
            {!net.types.length && (
              <text x="50%" y="50%" textAnchor="middle" className="onto__empty">
                Nothing to draw yet — load a dataset.
              </text>
            )}
          </svg>
          <div className="onto__legend">
            {net.predicates.slice(0, 12).map((p) => (
              <button key={p.rel} className="onto__pred" onClick={() => setQ(q.trim() === p.rel ? '' : p.rel)} title={`${p.count.toLocaleString()} relationships over ${p.triples} type pairs`}>
                <span className="res__facet-dot" style={{ background: p.color ?? hashColor(p.rel) }} />
                {p.label} <span className="count">{p.count.toLocaleString()}</span>
              </button>
            ))}
            {net.predicates.length > 12 && <span className="muted">+{net.predicates.length - 12} more</span>}
          </div>
        </div>
        <div className="pane-gutter" onPointerDown={side.onPointerDown} onDoubleClick={side.reset} title="Drag to resize · double-click to reset" />
        <div className="res__inspector onto__side" style={{ width: side.width }}>
          <div className="onto__table-wrap">
            <table className="onto__table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>Relationship</th>
                  <th>To</th>
                  <th className="num">Count</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((tr) => (
                  <TripleRow key={`${tr.source} ${tr.rel} ${tr.target}`} tr={tr} focus={focus} colorOf={colorOf} labelOf={labelOf} onType={(t) => navigate(`/ontology/type/${encodeURIComponent(t)}`)} onOpen={() => navigate(`/entities?category=relationships&type=${encodeURIComponent(tr.rel)}`)} />
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={4} className="muted onto__none">
                      {net.totals.triples ? 'No type-to-type link matches.' : 'No relationships yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      )}
    </div>
  )
}

function TripleRow({ tr, focus, colorOf, labelOf, onType, onOpen }: { tr: SchemaTriple; focus: string | null; colorOf: (t: string) => string; labelOf: (t: string) => string; onType: (t: string) => void; onOpen: () => void }) {
  const cell = (t: string) => (
    <button className={`onto__tcell ${focus === t ? 'is-focus' : ''}`} onClick={() => onType(t)} title={t}>
      <span className="res__facet-dot" style={{ background: colorOf(t) }} />
      {labelOf(t)}
    </button>
  )
  return (
    <tr>
      <td>{cell(tr.source)}</td>
      <td>
        <button className="onto__rel" onClick={onOpen} title="Open these relationships in Entities">
          {tr.directed ? <ArrowRight size={12} className="faint" /> : <ArrowLeftRight size={12} className="faint" />}
          {tr.rel}
        </button>
      </td>
      <td>{cell(tr.target)}</td>
      <td className="num mono">{tr.count.toLocaleString()}</td>
    </tr>
  )
}
