import { Box, ChevronLeft, Grid3x3, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TypeCategory } from '../../core/entity/categories'
import { useEntityStore, useStoreDataVersion, useTypeRegistry } from '../../core/entity/hooks'
import { formatNumber } from '../../lib/format'
import { loadPlotly } from '../plots/PlotlyChart'
import { tagMatrix, type MatrixType, type TagKey } from './tagStats'
import { Select } from '../../components/ui/Select'

/**
 * The Ontology page's tag tab: types down the side, tags across, and in each
 * cell how many entities of the type carry the tag — as a heat grid or as
 * 3D bars. Three framings: tags as facets (any `tier:*`), the values a facet
 * takes (`tier:app`, `tier:data`…), and tags against tags (how often two
 * facets travel together). A cell opens those entities in the Entities table.
 */

type Mode = 'keys' | 'values' | 'tags'
type Measure = 'count' | 'row' | 'col'
type View = '2d' | '3d'

interface Column {
  id: string
  label: string
  /** The facet this value belongs to (values mode). */
  group?: string
  count: number
}

export function TagMatrix({ categories }: { categories: TypeCategory[] }) {
  const store = useEntityStore()
  const version = useStoreDataVersion(store) // a whole-store walk: only data changes redo it
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('keys')
  const [view, setView] = useState<View>(() => (localStorage.getItem('aegraph:ontology:tags-view') as View) || '2d')
  const pickView = (v: View) => (setView(v), localStorage.setItem('aegraph:ontology:tags-view', v))
  const [measure, setMeasure] = useState<Measure>('count')
  const [q, setQ] = useState('')
  const [minCount, setMinCount] = useState(1)
  const [withLinks, setWithLinks] = useState(false)
  /** Values mode: the facet whose values are spread out; none = the biggest faceted keys side by side. */
  const [facet, setFacet] = useState<string | null>(null)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const m = useMemo(() => tagMatrix(store, registry, { categories, relationships: withLinks }), [store, registry, version, categories, withLinks])

  const columns = useMemo<Column[]>(() => {
    const needle = q.trim().toLowerCase()
    const hit = (s: string) => !needle || s.toLowerCase().includes(needle)
    if (mode === 'values') {
      const keys = facet ? m.keys.filter((k) => k.key === facet) : m.keys.filter((k) => k.faceted).slice(0, 6)
      return keys.flatMap((k) => k.values.filter((v) => (k.valueCounts.get(v) ?? 0) >= minCount && (hit(v) || hit(k.key))).map((v) => ({ id: `${k.key}:${v}`, label: v, group: k.key, count: k.valueCounts.get(v) ?? 0 })))
    }
    return m.keys.filter((k) => k.count >= minCount && hit(k.key)).map((k) => ({ id: k.key, label: k.key, count: k.count }))
  }, [m, mode, facet, q, minCount])

  /** Rows: the types, or — tags against tags — the same facets as the columns. */
  const rows = useMemo<{ id: string; label: string; color: string; count: number; type?: MatrixType }[]>(() => {
    if (mode === 'tags') return columns.map((c) => ({ id: c.id, label: c.label, color: '#6d6b66', count: c.count }))
    const all = m.types.filter((t) => t.count >= minCount).map((t) => ({ id: t.type, label: t.label, color: t.color, count: t.count, type: t }))
    // Spreading a facet's values: only the types that carry any of them, so the grid is about that facet.
    return mode === 'values' ? all.filter((r) => columns.some((c) => (m.byTag.get(r.id)?.get(c.id) ?? 0) > 0)) : all
  }, [m, mode, columns, minCount])

  const cell = (rowId: string, colId: string): number => {
    if (mode === 'tags') return m.cooccur.get(rowId)?.get(colId) ?? 0
    if (mode === 'values') return m.byTag.get(rowId)?.get(colId) ?? 0
    return m.byKey.get(rowId)?.get(colId) ?? 0
  }
  const value = (rowId: string, colId: string, rowCount: number, colCount: number) => {
    const n = cell(rowId, colId)
    return measure === 'count' ? n : measure === 'row' ? n / Math.max(1, rowCount) : n / Math.max(1, colCount)
  }
  const maxValue = useMemo(() => {
    let max = 0
    for (const r of rows) for (const c of columns) max = Math.max(max, value(r.id, c.id, r.count, c.count))
    return max || 1
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns, measure, m])
  const fmt = (v: number) => (measure === 'count' ? formatNumber(v) : `${Math.round(v * 100)}%`)

  /** A cell opens the entities behind it; a facet column in keys mode opens its values instead. */
  const openCell = (row: (typeof rows)[number], col: Column) => {
    if (mode === 'keys') {
      const k = m.keys.find((x) => x.key === col.id)
      if (k?.faceted) return (setFacet(k.key), setMode('values'))
    }
    if (mode === 'tags') return navigate(`/entities?tag=${encodeURIComponent(col.id)}`)
    const t = row.type
    if (!t) return
    const rel = t.kind === 'relationship'
    navigate(`/entities?${rel ? 'category=relationships&' : ''}type=${encodeURIComponent(rel ? t.type.slice(1, -1) : t.type)}&tag=${encodeURIComponent(col.id)}`)
  }

  const facets = m.keys.filter((k) => k.faceted)
  const groups = useMemo(() => {
    const out: { group: string; span: number }[] = []
    for (const c of columns) {
      const last = out[out.length - 1]
      if (last && last.group === c.group) last.span++
      else out.push({ group: c.group ?? '', span: 1 })
    }
    return out
  }, [columns])

  return (
    <div className="tm">
      <div className="res__toolbar tm__bar">
        <div className="gx-tabs" role="group" aria-label="Framing">
          <button className={`gx-tab ${mode === 'keys' ? 'is-active' : ''}`} aria-pressed={mode === 'keys'} title="Types down, tags across: how many of each type carry each tag (a key:value tag counts under its key)" onClick={() => setMode('keys')}>
            Types × tags
          </button>
          <button className={`gx-tab ${mode === 'values' ? 'is-active' : ''}`} aria-pressed={mode === 'values'} title="The values a key:value tag takes, per type" onClick={() => setMode('values')}>
            Types × values
          </button>
          <button className={`gx-tab ${mode === 'tags' ? 'is-active' : ''}`} aria-pressed={mode === 'tags'} title="Tags against tags: how often two travel on the same entity" onClick={() => setMode('tags')}>
            Tags × tags
          </button>
        </div>
        {mode === 'values' && facets.length > 0 && (
          <div className="tm__facets" role="group" aria-label="Facet">
            {facet && (
              <button className="btn btn--sm btn--ghost" onClick={() => setFacet(null)} title="Back to the biggest facets side by side">
                <ChevronLeft size={12} /> All facets
              </button>
            )}
            {(facet ? facets.filter((k) => k.key === facet) : facets.slice(0, 12)).map((k) => (
              <button key={k.key} className={`tm__facet ${facet === k.key ? 'is-active' : ''}`} onClick={() => setFacet(facet === k.key ? null : k.key)} title={`${k.values.length} values over ${formatNumber(k.count)} entities`}>
                {k.key}
                <span className="count">{k.values.length}</span>
              </button>
            ))}
          </div>
        )}
        <label className="onto__search tm__search">
          <Search size={14} className="faint" />
          <input placeholder={mode === 'values' ? 'Find a value or a key…' : 'Find a tag…'} value={q} onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button className="btn btn--sm btn--icon btn--ghost" onClick={() => setQ('')} aria-label="Clear">
              <X size={12} />
            </button>
          )}
        </label>
        <span className="spacer" />
        <label className="tm__opt">
          Show
          <Select className="input" value={measure} onChange={(e) => setMeasure(e.target.value as Measure)}>
            <option value="count">count</option>
            <option value="row">% of the {mode === 'tags' ? 'row tag' : 'type'}</option>
            <option value="col">% of the tag</option>
          </Select>
        </label>
        <label className="tm__opt" title="Hide tags and types with fewer entities than this">
          At least
          <input className="input tm__min" type="number" min={1} value={minCount} onChange={(e) => setMinCount(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <label className="tm__opt tm__check" title="Relationships have tags too; show them as rows">
          <input type="checkbox" checked={withLinks} onChange={(e) => setWithLinks(e.target.checked)} /> links
        </label>
        <div className="gx-tabs" role="group" aria-label="View">
          <button className={`gx-tab ${view === '2d' ? 'is-active' : ''}`} aria-pressed={view === '2d'} onClick={() => pickView('2d')} title="Heat grid">
            <Grid3x3 size={12} /> 2D
          </button>
          <button className={`gx-tab ${view === '3d' ? 'is-active' : ''}`} aria-pressed={view === '3d'} onClick={() => pickView('3d')} title="Bars in 3D — drag to orbit, scroll to zoom">
            <Box size={12} /> 3D
          </button>
        </div>
        <span className="muted tm__totals" title={`${formatNumber(m.totals.tagged)} of ${formatNumber(m.totals.entities)} entities carry a tag`}>
          {formatNumber(m.totals.tags)} tags · {formatNumber(m.totals.keys)} keys · {Math.round((100 * m.totals.tagged) / Math.max(1, m.totals.entities))}% tagged
        </span>
      </div>

      {!columns.length || !rows.length ? (
        <div className="muted tm__empty">{m.totals.tags ? 'Nothing matches.' : 'No tags yet — tag some entities and they will show up here.'}</div>
      ) : view === '2d' ? (
        <Grid rows={rows} columns={columns} groups={groups} value={value} cell={cell} fmt={fmt} max={maxValue} mode={mode} onCell={openCell} />
      ) : (
        <Bars rows={rows} columns={columns} value={value} cell={cell} fmt={fmt} measure={measure} />
      )}
    </div>
  )
}

type RowT = { id: string; label: string; color: string; count: number; type?: MatrixType }
type CellFn = (rowId: string, colId: string, rowCount: number, colCount: number) => number

/** The heat grid: sticky headers with counts and a bar for the marginal distribution, cells shaded in the row's colour. */
function Grid({ rows, columns, groups, value, cell, fmt, max, mode, onCell }: { rows: RowT[]; columns: Column[]; groups: { group: string; span: number }[]; value: CellFn; cell: (r: string, c: string) => number; fmt: (v: number) => string; max: number; mode: Mode; onCell: (r: RowT, c: Column) => void }) {
  const maxRow = Math.max(1, ...rows.map((r) => r.count))
  const maxCol = Math.max(1, ...columns.map((c) => c.count))
  const grouped = mode === 'values'
  return (
    <div className="tm__scroll">
      <table className="tm__grid">
        <thead>
          {grouped && (
            <tr className="tm__groups">
              <th className="tm__corner" />
              {groups.map((g, i) => (
                <th key={i} colSpan={g.span} className="tm__group">
                  {g.group}
                </th>
              ))}
            </tr>
          )}
          <tr>
            <th className="tm__corner">{mode === 'tags' ? 'tag ↓ · tag →' : 'type ↓ · tag →'}</th>
            {columns.map((c) => (
              <th key={c.id} className="tm__col" title={`${c.id} · ${formatNumber(c.count)} entities`}>
                <span className="tm__col-bar" style={{ height: `${Math.max(2, (100 * c.count) / maxCol)}%` }} />
                <span className="tm__col-label">{c.label}</span>
                <span className="tm__col-count">{formatNumber(c.count)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th className="tm__row" title={`${r.label} · ${formatNumber(r.count)}${r.type?.untagged ? ` · ${formatNumber(r.type.untagged)} untagged` : ''}`}>
                <span className="tm__row-bar" style={{ width: `${Math.max(2, (100 * r.count) / maxRow)}%`, background: r.color }} />
                <span className="res__facet-dot" style={{ background: r.color }} />
                <span className="tm__row-label">{r.label}</span>
                <span className="tm__row-count">{formatNumber(r.count)}</span>
              </th>
              {columns.map((c) => {
                const n = cell(r.id, c.id)
                const v = value(r.id, c.id, r.count, c.count)
                const a = n ? 0.12 + 0.78 * Math.sqrt(v / max) : 0
                return (
                  <td key={c.id} className={`tm__cell ${n ? 'has-value' : ''} ${a > 0.55 ? 'is-strong' : ''}`} style={n ? { background: `color-mix(in srgb, ${r.color} ${Math.round(a * 100)}%, transparent)` } : undefined} title={n ? `${r.label} × ${c.id}: ${formatNumber(n)} · ${Math.round((100 * n) / Math.max(1, r.count))}% of the ${mode === 'tags' ? 'row' : 'type'} · ${Math.round((100 * n) / Math.max(1, c.count))}% of the tag` : undefined} onClick={n ? () => onCell(r, c) : undefined}>
                    {n ? fmt(v) : ''}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The same matrix as bars standing on a floor: rows and columns as the two axes, height the measure, colour the row's. */
function Bars({ rows, columns, value, cell, fmt, measure }: { rows: RowT[]; columns: Column[]; value: CellFn; cell: (r: string, c: string) => number; fmt: (v: number) => string; measure: Measure }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  /** Square-root heights keep the small bars visible next to a few huge ones (counts are usually that skewed). */
  const [sqrt, setSqrt] = useState(() => localStorage.getItem('aegraph:ontology:tags-sqrt') !== '0')
  const pickSqrt = (v: boolean) => (setSqrt(v), localStorage.setItem('aegraph:ontology:tags-sqrt', v ? '1' : '0'))
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let live = true
    loadPlotly()
      .then((P) => {
        if (!live) return
        // One mesh: every bar is a cuboid of 8 vertices and 12 triangles, coloured per face by its row.
        const x: number[] = []
        const y: number[] = []
        const z: number[] = []
        const i: number[] = []
        const j: number[] = []
        const k: number[] = []
        const facecolor: string[] = []
        const text: string[] = []
        const w = 0.38
        rows.forEach((r, ri) => {
          columns.forEach((c, ci) => {
            const n = cell(r.id, c.id)
            if (!n) return
            const raw = value(r.id, c.id, r.count, c.count)
            const h = sqrt ? Math.sqrt(raw) : raw
            const base = x.length
            const corners: [number, number, number][] = [
              [ci - w, ri - w, 0],
              [ci + w, ri - w, 0],
              [ci + w, ri + w, 0],
              [ci - w, ri + w, 0],
              [ci - w, ri - w, h],
              [ci + w, ri - w, h],
              [ci + w, ri + w, h],
              [ci - w, ri + w, h],
            ]
            const label = `${r.label} × ${c.id}<br>${fmt(raw)}${measure === 'count' ? '' : ` (${formatNumber(n)})`}`
            for (const [cx, cy, cz] of corners) {
              x.push(cx)
              y.push(cy)
              z.push(cz)
              text.push(label)
            }
            const faces: [number, number, number][] = [
              [0, 1, 2], [0, 2, 3], // bottom
              [4, 5, 6], [4, 6, 7], // top
              [0, 1, 5], [0, 5, 4],
              [1, 2, 6], [1, 6, 5],
              [2, 3, 7], [2, 7, 6],
              [3, 0, 4], [3, 4, 7],
            ]
            for (const [a, b, d] of faces) {
              i.push(base + a)
              j.push(base + b)
              k.push(base + d)
              facecolor.push(r.color)
            }
          })
        })
        const font = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#1f1e1b'
        // With square-root heights the z ticks still read in real values: nice values, placed at their roots.
        const top = Math.max(...z, measure === 'count' ? 1 : 0.01)
        const realTop = sqrt ? top * top : top
        const nice = (v: number) => {
          const p = Math.pow(10, Math.floor(Math.log10(v)))
          const m = v / p
          return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p
        }
        const stepZ = nice(realTop / 5)
        const zvals: number[] = []
        for (let v = 0; v <= realTop * 1.0001; v += stepZ) zvals.push(v)
        const zTicks = sqrt ? { tickvals: zvals.map(Math.sqrt), ticktext: zvals.map((v) => (measure === 'count' ? formatNumber(v) : `${Math.round(v * 100)}%`)) } : measure === 'count' ? {} : { tickformat: '.0%' }
        const axis = (vals: { label: string }[]) => ({ tickvals: vals.map((_, n) => n), ticktext: vals.map((v) => (v.label.length > 16 ? v.label.slice(0, 15) + '…' : v.label)), tickfont: { size: 10 }, gridcolor: '#e6e4de', zerolinecolor: '#e6e4de', backgroundcolor: 'transparent', showbackground: false })
        return P.react(
          el,
          [{ type: 'mesh3d', x, y, z, i, j, k, facecolor, text, hoverinfo: 'text', flatshading: true, lighting: { ambient: 0.75, diffuse: 0.6, specular: 0.05, roughness: 0.9 }, lightposition: { x: 100, y: 200, z: 300 } } as never],
          {
            autosize: true,
            margin: { l: 0, r: 0, t: 0, b: 0 },
            paper_bgcolor: 'transparent',
            font: { family: 'system-ui, sans-serif', color: font, size: 11 },
            scene: {
              xaxis: { title: { text: 'tag' }, ...axis(columns) },
              yaxis: { title: { text: rows[0]?.type ? 'type' : 'tag' }, ...axis(rows) },
              zaxis: { title: { text: measure === 'count' ? 'entities' : 'share' }, gridcolor: '#e6e4de', backgroundcolor: 'transparent', showbackground: false, ...zTicks },
              aspectmode: 'manual',
              aspectratio: { x: Math.max(1, columns.length / Math.max(rows.length, 1)) * 1.2, y: 1.2, z: 0.9 },
              camera: { eye: { x: 1.7, y: -1.9, z: 1.1 } },
            },
          } as never,
          { responsive: true, displaylogo: false, displayModeBar: false, scrollZoom: true },
        )
      })
      .then(() => live && setError(null))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [rows, columns, value, cell, fmt, measure, sqrt])
  useEffect(() => {
    const el = ref.current
    return () => {
      if (el) loadPlotly().then((P) => P.purge(el)).catch(() => {})
    }
  }, [])
  return (
    <div className="tm__bars">
      <div ref={ref} className="tm__bars-canvas" />
      {error && <div className="tm__empty muted">{error}</div>}
      <div className="tm__hint muted">drag to orbit · scroll to zoom · hover a bar</div>
      <label className="tm__opt tm__check tm__sqrt" title="Heights as square roots, so small bars stay visible beside a few huge ones; the axis still reads in real values">
        <input type="checkbox" checked={sqrt} onChange={(e) => pickSqrt(e.target.checked)} /> √ heights
      </label>
    </div>
  )
}

export type { TagKey }
