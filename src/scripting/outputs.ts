import { normOverlay } from '../core/graph/rendering'
import { sanitizeFigure } from './figure'
import type { Output } from './types'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Read a script's return value as outputs. An object may carry several
 * (`{ plot, table }`); a bare string is text; anything else is shown as
 * a value. Shapes are checked here so the renderer never sees garbage.
 */
export function outputsOf(value: unknown): Output[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return [{ kind: 'text', text: value }]
  // A collection of entities or relationships (entities.types.person, returned as is) draws as a table.
  if (Array.isArray(value) && value.length && value.length <= 5000 && value.every((v) => isObj(v) && typeof v.id === 'string' && typeof v.type === 'string')) {
    const records = value as Record<string, unknown>[]
    const rel = records.every((r) => typeof r.source === 'string' && typeof r.target === 'string')
    const keys = new Set<string>()
    for (const r of records) for (const k in (isObj(r.data) ? r.data : {}) as object) keys.add(k)
    const columns = [...(rel ? ['id', 'type', 'source', 'target'] : ['id', 'type', 'label']), ...[...keys].map((k) => `data.${k}`)]
    return [{ kind: 'table', columns, rows: records.map((r) => columns.map((c) => (c.startsWith('data.') ? (isObj(r.data) ? r.data[c.slice(5)] : undefined) : r[c]))) }]
  }
  if (!isObj(value)) return [{ kind: 'value', value }]
  const out: Output[] = []
  const plot = value.plot ?? value.figure
  if (isObj(plot)) {
    const data = Array.isArray(plot.data) ? plot.data.filter(isObj) : []
    if (!data.length) throw new Error('plot.data must be a non-empty array of Plotly traces.')
    // Drawn by Plotly in the app's page: whatever it could fetch (an image source, a map style, a layer's URL) and any
    // markup that could load something is taken out here, before the figure is shown, kept or handed on (figure.ts).
    const clean = sanitizeFigure(data, plot.layout)
    out.push({ kind: 'figure', data: clean.data, layout: clean.layout })
  }
  if (isObj(value.table)) {
    const rows = Array.isArray(value.table.rows) ? value.table.rows.map((r) => (Array.isArray(r) ? r : [r])) : []
    const columns = Array.isArray(value.table.columns) ? value.table.columns.map(String) : rows[0]?.map((_, i) => `c${i + 1}`) ?? []
    out.push({ kind: 'table', columns, rows: rows.slice(0, 5000) })
  }
  if (isObj(value.scene)) {
    const positions = isObj(value.scene.positions) ? value.scene.positions : undefined
    if (!positions) throw new Error('scene.positions must map entity ids to { x, y }.')
    const clean: Record<string, { x: number; y: number; width?: number; height?: number }> = {}
    for (const [id, p] of Object.entries(positions)) {
      if (!isObj(p) || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      clean[id] = { x: p.x, y: p.y, ...(typeof p.width === 'number' ? { width: p.width } : {}), ...(typeof p.height === 'number' ? { height: p.height } : {}) }
    }
    const groups: Record<string, { title?: string; members: string[] }> = {}
    if (isObj(value.scene.groups)) for (const [k, g] of Object.entries(value.scene.groups)) if (isObj(g) && Array.isArray(g.members)) groups[k] = { title: typeof g.title === 'string' ? g.title : undefined, members: g.members.map(String) }
    out.push({ kind: 'scene', label: typeof value.scene.label === 'string' ? value.scene.label : undefined, positions: clean, groups: Object.keys(groups).length ? groups : undefined, scale: typeof value.scene.scale === 'number' ? value.scene.scale : undefined })
  }
  if (isObj(value.layout)) {
    const positions = isObj(value.layout.positions) ? value.layout.positions : undefined
    if (!positions) throw new Error('layout(positions) needs positions per entity id: { [id]: { x, y, z? } }.')
    const clean: Record<string, { x: number; y: number; z?: number }> = {}
    for (const [id, p] of Object.entries(positions)) {
      if (!isObj(p) || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      clean[id] = { x: p.x, y: p.y, ...(typeof p.z === 'number' && Number.isFinite(p.z) ? { z: p.z } : {}) }
    }
    if (!Object.keys(clean).length) throw new Error('layout(positions): no position had a finite x and y.')
    out.push({ kind: 'layout', ...(typeof value.layout.label === 'string' ? { label: value.layout.label } : {}), positions: clean, ...(value.layout.dimensions === 3 ? { dimensions: 3 as const } : value.layout.dimensions === 2 ? { dimensions: 2 as const } : {}) })
  }
  if (isObj(value.style)) {
    const st = value.style
    const overlay = normOverlay({ nodes: st.nodes, edges: st.edges, legend: st.legend })
    if (!overlay?.nodes && !overlay?.edges) throw new Error('style(nodes) needs styles per entity id: { [id]: { color, size, opacity, shape, visible, label } } (edges: color, width, opacity, visible, arrow).')
    out.push({ kind: 'style', ...(typeof st.label === 'string' ? { label: st.label } : {}), overlay, ...(isObj(st.spec) ? { spec: st.spec } : {}) })
  }
  if (typeof value.text === 'string') out.push({ kind: 'text', text: value.text })
  // An empty png is no image: a broken picture would be all the renderer could show.
  if (isObj(value.image) && typeof value.image.png === 'string' && value.image.png) out.push({ kind: 'image', png: value.image.png })
  if (!out.length) out.push({ kind: 'value', value })
  return out
}

export function describeOutputs(outs: Output[]): string {
  return outs
    .map((o) => {
      if (o.kind === 'figure') return `figure · ${o.data.length} trace${o.data.length === 1 ? '' : 's'}${figureTitle(o.layout) ? ` · ${figureTitle(o.layout)}` : ''}`
      if (o.kind === 'table') return `table · ${o.rows.length} rows × ${o.columns.length} columns`
      if (o.kind === 'scene') return `scene · ${Object.keys(o.positions).length} placed`
      if (o.kind === 'layout') return `layout · ${Object.keys(o.positions).length} placed${o.dimensions === 3 ? ' · 3D' : ''}`
      if (o.kind === 'style') return `style · ${[o.overlay.nodes ? `${Object.keys(o.overlay.nodes).length} nodes` : '', o.overlay.edges ? `${Object.keys(o.overlay.edges).length} edges` : ''].filter(Boolean).join(', ')}${o.overlay.legend ? ' · legend' : ''}`
      if (o.kind === 'text') return `text · ${o.text.length} chars`
      if (o.kind === 'image') return 'image'
      return 'value'
    })
    .join(' + ')
}

/** Plotly titles are a string or `{ text }`. */
export function figureTitle(layout: Record<string, unknown>): string | undefined {
  const t = layout.title
  if (typeof t === 'string') return t
  if (t && typeof t === 'object' && typeof (t as { text?: unknown }).text === 'string') return (t as { text: string }).text
  return undefined
}
