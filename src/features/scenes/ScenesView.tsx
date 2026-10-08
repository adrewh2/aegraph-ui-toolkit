import { BarChart3, BoxSelect, Check, Download, Eye, EyeOff, Grid3x3, Layers, Maximize2, Plus, ScanSearch, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { edgePath, geometryBounds, straightRoute, type NodeGeom } from '../../core/diagrams/geometry'
import { diagramFromProjection, diagramSourceOf, isProjection, projectionFromPositions, PROJECTION_TYPE, SCRIPT_SCENE_TYPE, scriptSourceOf, type ProjectionData } from '../../core/graph/projection'
import { geometryToSvg, writeDiagram, type DiagramFormat } from '../../core/diagrams'
import { downloadText } from '../../lib/download'
import { createDiagram, isDiagram } from '../diagrams/diagrams'
import { GRAPH_TYPES, type LayoutData } from '../../core/graph/types'
import { pictureBox, renderDiagram } from '../diagrams/render'
import { svgDataUrl } from '../../core/diagrams/sanitizeSvg'
import { SavedPicker } from '../graph/SavedPicker'
import { Inspector } from '../resources/Inspector'
import { useResizableWidth } from '../../lib/useResizableWidth'
import { fitGroups, groupAt, moveGroup, normalizeGroups, setMembership } from './groups'
import { PlotWorkbench } from '../plots/PlotWorkbench'
import { registerDisplayHandle } from './sceneHandle'
import { relsAmong } from './rels'
import { SceneLayer, type LayerView } from './SceneLayer'
import './scenes.css'

/**
 * The Scenes page: one view that shows a scene — a 2D arrangement of
 * entities (positions, sizes, shapes, colours, edge routes, group boxes),
 * drawn with its own SVG renderer, independent of the graph engines — or a
 * plot. Labels and edges come from the entity store; geometry from the
 * scene. Made for checking diagram imports one-to-one against their source
 * (the source render can be shown underneath), for arranging scenes by
 * hand, and for the assistant to put things on screen. Workstation panes
 * host it like any other view.
 *
 * URL: `?id=<scene>` shows a saved scene, `&over=<scene>` compares another
 * one underneath it (faded, not editable); `?plot=<plot>` shows a plot.
 */

type View = { x: number; y: number; k: number }
const LAST_KEY = 'aegraph:display:last'
type Last = { plot?: string; id?: string }
function readLast(): Last {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') as Last
  } catch {
    return {}
  }
}
const MIN_K = 0.05
const MAX_K = 12
const INERT_OPACITY = 0.55
/** What the view shows: a scene by id (a draft id while it is unsaved), nothing, or a plot. */
type Content = { kind: 'scene'; ref?: EntityId } | { kind: 'plot'; plot: EntityId }
const EMPTY: Content = { kind: 'scene' }
/** A scene made here and not saved yet: an id that is not in the store. */
const draftRef = () => `draft-${Math.random().toString(36).slice(2, 8)}`
const isDraftRef = (ref: string) => ref.startsWith('draft-')

export function ScenesView() {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const registry = useTypeRegistry()
  const toast = useToast()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  // What is shown, and what is selected in it.
  const [content, setContent] = useState<Content>(EMPTY)
  /** Another scene drawn underneath, faded, to compare against — not saved, not editable. */
  const [over, setOver] = useState<EntityId | null>(null)
  const [selected, setSelected] = useState<EntityId | null>(null)
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)

  // The scene's working copy: geometry edits happen here until saved.
  const [data, setData] = useState<ProjectionData | null>(null)
  const [dirty, setDirty] = useState(false)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [showSource, setShowSource] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  const [sourceSvg, setSourceSvg] = useState<string | null>(null)
  const [showMenu, setShowMenu] = useState<{ x: number; y: number } | null>(null)
  const [overMenu, setOverMenu] = useState<{ x: number; y: number } | null>(null)
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ kind: 'pan'; sx: number; sy: number; ox: number; oy: number } | { kind: 'node'; id: EntityId; sx: number; sy: number; ox: number; oy: number; nx: number; ny: number } | { kind: 'resize'; id: EntityId; corner: string; sx: number; sy: number; o: NodeGeom } | { kind: 'group'; id: string; lx: number; ly: number } | { kind: 'group-resize'; id: string; corner: string; sx: number; sy: number; pad: { l: number; t: number; r: number; b: number } } | null>(null)
  const side = useResizableWidth({ storageKey: 'aegraph:display:side-width', initial: 360, min: 260, max: 720, edge: 'start' })

  const isScene = content.kind === 'scene'
  const activeRef = content.kind === 'scene' ? content.ref : undefined

  // ── URL ↔ state ──────────────────────────────────────────────────────
  const writeUrl = useCallback(
    (next: Content, overlay: EntityId | null) => {
      const p: Record<string, string> = {}
      if (next.kind === 'plot') p.plot = next.plot
      else if (next.ref && !isDraftRef(next.ref)) p.id = next.ref
      if (next.kind === 'scene' && overlay) p.over = overlay
      setParams(p, { replace: true })
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ plot: p.plot ?? readLast().plot, id: p.id ?? readLast().id }))
      } catch {
        /* ignore */
      }
    },
    [setParams],
  )
  /** Replace what is shown. */
  const show = useCallback(
    (next: Content) => {
      setContent(next)
      setOver(null)
      setSelected(null)
      setSelectedGroup(null)
      writeUrl(next, null)
    },
    [writeUrl],
  )
  const compareWith = (id: EntityId | null) => {
    setOver(id)
    writeUrl(content, id)
  }
  // Follow the URL: a scene, a plot — or, opened bare, whatever was open last.
  useEffect(() => {
    const id = params.get('id')
    const plot = params.get('plot')
    const overParam = params.get('over')
    if (plot) {
      // Plots moved to the Analytics page; a link that still says `/scenes?plot=` lands there.
      navigate(`/analytics/charts?plot=${encodeURIComponent(plot)}`, { replace: true })
      return
    }
    if (id) {
      if (activeRef !== id && isProjection(store.get(id))) {
        setContent({ kind: 'scene', ref: id })
        setSelected(null)
        setSelectedGroup(null)
      }
      const o = overParam && overParam !== id && isProjection(store.get(overParam)) ? overParam : null
      if (o !== over) setOver(o)
      return
    }
    if (content.kind === 'scene' && !content.ref) {
      const last = readLast()
      if (last.id && isProjection(store.get(last.id))) setParams({ id: last.id }, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  // ── The scene shown ──────────────────────────────────────────────────
  useEffect(() => {
    if (!activeRef) {
      setData(null)
      setDirty(false)
      return
    }
    if (isDraftRef(activeRef)) return // its data was set by whoever made the draft
    const e = store.get(activeRef)
    if (isProjection(e)) {
      const loaded = fitGroups(normalizeGroups(structuredClone(e.data)))
      setData(loaded)
      setDirty(false)
      // `layers` in this closure predates the load, so the loaded data is passed in.
      queueMicrotask(() => fitAll(loaded))
    } else {
      // The scene is gone.
      setContent(EMPTY)
      setData(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRef])

  // The source diagram's own render, for overlaying under the scene.
  useEffect(() => {
    setSourceSvg(null)
    const from = diagramSourceOf(data)
    const d = from ? store.get(from.diagramId) : undefined
    if (!showSource || !isDiagram(d)) return
    let live = true
    renderDiagram(d.data.source, d.data.format, from?.engine ?? 'dot')
      .then((svg) => live && setSourceSvg(svg))
      .catch(() => live && setSourceSvg(null))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSource, diagramSourceOf(data)?.diagramId, diagramSourceOf(data)?.engine])

  // Which entities the active layer places changes rarely; positions change on every drop — the relationship walk keys on the former.
  const placedKey = useMemo(() => (data ? Object.keys(data.nodes).sort().join('|') : ''), [data])
  const rels = useMemo(() => (data ? relsAmong(store, data) : []), [placedKey, store, version]) // eslint-disable-line react-hooks/exhaustive-deps
  // What is drawn: the compared scene underneath (from the store, inert), then the scene itself from its working copy.
  const layers = useMemo<LayerView[]>(() => {
    if (!isScene) return []
    const out: LayerView[] = []
    const o = over ? store.get(over) : undefined
    if (isProjection(o)) out.push({ id: `over:${o.id}`, data: o.data, rels: relsAmong(store, o.data), active: false, opacity: INERT_OPACITY })
    if (data) out.push({ id: 'scene', data, rels, active: true, opacity: 1 })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isScene, over, data, rels, store, version])
  const nodeCount = data ? Object.keys(data.nodes).length : 0
  const missing = data ? Object.keys(data.nodes).filter((id) => !store.has(id)).length : 0

  const fitAll = useCallback(
    (extra?: ProjectionData | null) => {
      const svg = svgRef.current
      if (!svg) return
      const all = [...layers.map((l) => l.data), ...(extra ? [extra] : [])]
      if (!all.length) return
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const g of all) {
        const b = geometryBounds({ width: g.width, height: g.height, nodes: g.nodes, edges: g.edges, groups: g.groups })
        x0 = Math.min(x0, b.x)
        y0 = Math.min(y0, b.y)
        x1 = Math.max(x1, b.x + b.width)
        y1 = Math.max(y1, b.y + b.height)
      }
      const w = x1 - x0
      const h = y1 - y0
      const r = svg.getBoundingClientRect()
      const k = Math.max(MIN_K, Math.min(MAX_K, Math.min(r.width / w, r.height / h)))
      setView({ k, x: (r.width - w * k) / 2 - x0 * k, y: (r.height - h * k) / 2 - y0 * k })
    },
    [layers],
  )

  // Wheel zooms around the cursor; drag on empty space pans.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      setView((v) => {
        const k = Math.max(MIN_K, Math.min(MAX_K, v.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025))))
        return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [content.kind])

  // ── Editing the active layer ─────────────────────────────────────────
  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    const target = e.target as SVGElement
    const nodeId = target.closest('[data-node]')?.getAttribute('data-node')
    const corner = target.getAttribute('data-corner')
    const groupId = target.closest('[data-group]')?.getAttribute('data-group')
    const groupCorner = target.getAttribute('data-group-corner')
    e.currentTarget.setPointerCapture(e.pointerId)
    if (groupId && groupCorner && e.button === 0 && data) {
      const g = data.groups[groupId]
      drag.current = { kind: 'group-resize', id: groupId, corner: groupCorner, sx: e.clientX, sy: e.clientY, pad: g.pad ?? { l: 16, t: 28, r: 16, b: 16 } }
      return
    }
    if (groupId && !nodeId && e.button === 0 && data) {
      setSelected(null)
      setSelectedGroup(groupId)
      drag.current = { kind: 'group', id: groupId, lx: e.clientX, ly: e.clientY }
      return
    }
    if (nodeId && corner && e.button === 0 && data) {
      drag.current = { kind: 'resize', id: nodeId, corner, sx: e.clientX, sy: e.clientY, o: data.nodes[nodeId] }
      return
    }
    if (nodeId && e.button === 0 && data) {
      const g = data.nodes[nodeId]
      setSelected(nodeId)
      setSelectedGroup(null)
      drag.current = { kind: 'node', id: nodeId, sx: e.clientX, sy: e.clientY, ox: g.x, oy: g.y, nx: g.x, ny: g.y }
      liftNode(nodeId)
      return
    }
    if (!nodeId && e.button === 0) {
      setSelected(null)
      setSelectedGroup(null)
    }
    drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }
  }
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }))
    else if (d.kind === 'group') {
      const dx = (e.clientX - d.lx) / view.k
      const dy = (e.clientY - d.ly) / view.k
      d.lx = e.clientX
      d.ly = e.clientY
      setData((cur) => (cur ? moveGroup(cur, d.id, dx, dy, rels.map((r) => ({ id: r.id, source: r.source.id, target: r.target.id }))) : cur))
      setDirty(true)
    } else if (d.kind === 'group-resize') {
      // Resizing a group changes the padding it keeps around its members.
      const dx = (e.clientX - d.sx) / view.k
      const dy = (e.clientY - d.sy) / view.k
      const pad = { ...d.pad }
      if (d.corner.includes('w')) pad.l = Math.max(8, d.pad.l - dx)
      if (d.corner.includes('e')) pad.r = Math.max(8, d.pad.r + dx)
      if (d.corner.includes('n')) pad.t = Math.max(8, d.pad.t - dy)
      if (d.corner.includes('s')) pad.b = Math.max(8, d.pad.b + dy)
      setData((cur) => (cur ? fitGroups({ ...cur, groups: { ...cur.groups, [d.id]: { ...cur.groups[d.id], pad } } }) : cur))
      setDirty(true)
    } else if (d.kind === 'resize') {
      const dx = (e.clientX - d.sx) / view.k
      const dy = (e.clientY - d.sy) / view.k
      const o = d.o
      // Corners move one edge each; the opposite edge stays put.
      let left = o.x - o.width / 2
      let right = o.x + o.width / 2
      let top = o.y - o.height / 2
      let bottom = o.y + o.height / 2
      if (d.corner.includes('w')) left = Math.min(right - 16, left + dx)
      if (d.corner.includes('e')) right = Math.max(left + 16, right + dx)
      if (d.corner.includes('n')) top = Math.min(bottom - 16, top + dy)
      if (d.corner.includes('s')) bottom = Math.max(top + 16, bottom + dy)
      setData((cur) => {
        if (!cur) return cur
        const next = { ...cur, nodes: { ...cur.nodes, [d.id]: { ...cur.nodes[d.id], x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top } }, edges: { ...cur.edges } }
        for (const r of rels) if (r.source.id === d.id || r.target.id === d.id) delete next.edges[r.id]
        return fitGroups(next)
      })
      setDirty(true)
    } else {
      // While the pointer is down only the lifted copy moves; the scene (and its thousands of nodes) is repainted once, on drop.
      d.nx = d.ox + (e.clientX - d.sx) / view.k
      d.ny = d.oy + (e.clientY - d.sy) / view.k
      const lifted = liftRef.current?.querySelector<SVGGElement>('[data-lifted]')
      if (lifted) lifted.setAttribute('transform', `translate(${d.nx - d.ox} ${d.ny - d.oy})${lifted.dataset.rot ? ` ${lifted.dataset.rot}` : ''}`)
      // Its arrows follow as straight lines from the other end to where the node is now.
      const geom = data?.nodes[d.id]
      if (geom) {
        const me = { ...geom, x: d.nx, y: d.ny }
        for (const line of liftRef.current?.querySelectorAll<SVGPathElement>('[data-lifted-edge]') ?? []) {
          const otherId = line.dataset.other!
          const other = data!.nodes[otherId]
          if (!other) continue
          const fromMe = line.dataset.fromMe === '1'
          const pts = fromMe ? straightRoute(me, other) : straightRoute(other, me)
          line.setAttribute('d', edgePath({ points: pts, curve: 'line' }))
          const label = line.nextElementSibling as SVGTextElement | null
          if (label?.tagName === 'text') {
            label.setAttribute('x', String((pts[0].x + pts[pts.length - 1].x) / 2))
            label.setAttribute('y', String((pts[0].y + pts[pts.length - 1].y) / 2 - 6))
          }
        }
      }
    }
  }
  /**
   * Dragging one node in a scene of thousands: the main SVG repaints whole on
   * any change, so the node is drawn on a small overlay for the drag and the
   * original hidden; the drop puts it back and writes the scene once.
   */
  const liftRef = useRef<SVGSVGElement>(null)
  const nodeEl = (id: EntityId) => svgRef.current?.querySelector<SVGGElement>(`[data-node="${CSS.escape(id)}"]`)
  const liftNode = (id: EntityId) => {
    const el = nodeEl(id)
    const layer = liftRef.current
    if (!el || !layer) return
    const g = layer.querySelector('g')!
    g.replaceChildren()
    const copy = el.cloneNode(true) as SVGGElement
    copy.setAttribute('data-lifted', '1')
    copy.removeAttribute('data-node')
    // The node's arrows come along, redrawn as straight lines while it moves (a captured route is dropped on the drop anyway).
    for (const r of rels) {
      if (r.source.id !== id && r.target.id !== id) continue
      const edgeEl = svgRef.current?.querySelector<SVGGElement>(`[data-edge="${CSS.escape(r.id)}"]`)
      if (!edgeEl) continue
      const path = edgeEl.querySelector('path')
      if (!path) continue
      const lifted = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      lifted.setAttribute('class', 'pj__edge is-hot')
      const line = path.cloneNode(false) as SVGPathElement
      line.setAttribute('data-lifted-edge', '1')
      line.dataset.other = r.source.id === id ? r.target.id : r.source.id
      line.dataset.fromMe = r.source.id === id ? '1' : '0'
      lifted.appendChild(line)
      const text = edgeEl.querySelector('text')
      if (text) lifted.appendChild(text.cloneNode(true))
      g.appendChild(lifted)
      edgeEl.style.visibility = 'hidden'
    }
    g.appendChild(copy)
    el.style.visibility = 'hidden'
    layer.style.display = 'block'
    // Hit-testing thousands of shapes on every pointer move is most of a drag's cost; the pointer is captured, so nothing needs hitting.
    svgRef.current?.classList.add('is-dragging')
  }
  const dropNode = (id: EntityId) => {
    const el = nodeEl(id)
    if (el) el.style.visibility = ''
    for (const edgeEl of svgRef.current?.querySelectorAll<SVGGElement>('[data-edge]') ?? []) edgeEl.style.visibility = ''
    svgRef.current?.classList.remove('is-dragging')
    const layer = liftRef.current
    if (layer) {
      layer.querySelector('g')?.replaceChildren()
      layer.style.display = 'none'
    }
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (d?.kind === 'node' && data) {
      const moved = d.nx !== d.ox || d.ny !== d.oy
      dropNode(d.id)
      if (!moved) return
      // The drop writes the position once: the node's captured edge routes go (they become straight lines), its group refits,
      // and the deepest box under its centre becomes its group (measured without the node's own group refit).
      const n = { ...data.nodes[d.id], x: d.nx, y: d.ny }
      const current = Object.keys(data.groups).find((g) => data.groups[g].members?.includes(d.id))
      const target = groupAt({ ...data, groups: Object.fromEntries(Object.entries(data.groups).map(([k, g]) => [k, k === current ? { ...g, members: (g.members ?? []).filter((m) => m !== d.id) } : g])) }, n)
      setData((cur) => {
        if (!cur) return cur
        let next = { ...cur, nodes: { ...cur.nodes, [d.id]: n }, edges: { ...cur.edges } }
        for (const r of rels) if (r.source.id === d.id || r.target.id === d.id) delete next.edges[r.id]
        if (target !== current) next = setMembership(next, d.id, target)
        return fitGroups(next)
      })
      setDirty(true)
    }
  }

  const removeGroup = (gid: string) => {
    setData((cur) => {
      if (!cur) return cur
      const groups = { ...cur.groups }
      const parent = groups[gid]?.parent
      const orphaned = groups[gid]?.members ?? []
      delete groups[gid]
      for (const k of Object.keys(groups)) if (groups[k].parent === gid) groups[k] = { ...groups[k], parent }
      if (parent && groups[parent]) groups[parent] = { ...groups[parent], members: [...(groups[parent].members ?? []), ...orphaned] }
      return fitGroups({ ...cur, groups })
    })
    setSelectedGroup(null)
    setDirty(true)
  }
  const addGroup = () => {
    if (!data) return
    // A new group around the selected node, or an empty box in the middle of the view.
    const id = `g-${Math.random().toString(36).slice(2, 8)}`
    const members = selected ? [selected] : []
    const svg = svgRef.current!.getBoundingClientRect()
    const cx = (svg.width / 2 - view.x) / view.k
    const cy = (svg.height / 2 - view.y) / view.k
    const box = members.length ? { x: 0, y: 0, width: 0, height: 0 } : { x: cx - 120, y: cy - 80, width: 240, height: 160 }
    setData((cur) => (cur ? fitGroups({ ...cur, groups: { ...cur.groups, [id]: { ...box, title: 'Group', members, stroke: '#999', pad: { l: 16, t: 28, r: 16, b: 16 } } } }) : cur))
    if (selected) setData((cur) => (cur ? fitGroups(setMembership(cur, selected, id)) : cur))
    setSelectedGroup(id)
    setSelected(null)
    setDirty(true)
  }
  const renameGroup = (gid: string, title: string) => {
    setData((cur) => (cur ? { ...cur, groups: { ...cur.groups, [gid]: { ...cur.groups[gid], title } } } : cur))
    setDirty(true)
  }

  // ── Scenes: save, load, new ──────────────────────────────────────────
  /** Save the working copy to its scene (or a new one). */
  const saveScene = (name: string, existing?: AnyEntity | EntityId): EntityId | undefined => {
    if (!data) return
    const id = typeof existing === 'string' ? existing : existing?.id
    if (id && store.has(id)) {
      store.update(id, { label: name, data })
      setDirty(false)
      toast(`Saved “${name}”`)
      return id
    }
    const e = { ...projectionFromPositions(name, {}), data, label: name }
    store.upsert(e)
    setContent({ kind: 'scene', ref: e.id })
    setDirty(false)
    writeUrl({ kind: 'scene', ref: e.id }, over)
    toast(`Saved “${name}”`)
    return e.id
  }
  /** Start an unsaved scene. */
  const draft = (d: ProjectionData) => {
    const next: Content = { kind: 'scene', ref: draftRef() }
    setContent(next)
    setOver(null)
    setData(d)
    setDirty(true)
    setSelected(null)
    setSelectedGroup(null)
    writeUrl(next, null)
    queueMicrotask(() => fitAll(d))
  }
  const clearScene = () => {
    show(EMPTY)
    setData(null)
    setDirty(false)
  }
  const newFromLayout = (layout: AnyEntity) => {
    const positions = (layout.data as LayoutData).positions ?? {}
    const ids = Object.keys(positions).filter((id) => store.has(id))
    if (!ids.length) return toast('That layout places nothing that exists here.')
    const xs = ids.map((id) => positions[id].x)
    const ys = ids.map((id) => positions[id].y)
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1
    // Layout coordinates are engine units; scale so the scene is roughly 1600px across.
    const scale = 1600 / span
    draft(projectionFromPositions(`${displayLabel(layout)} · scene`, Object.fromEntries(ids.map((id) => [id, { x: (positions[id].x - Math.min(...xs)) * scale + 100, y: (positions[id].y - Math.min(...ys)) * scale + 100 }]))).data)
  }
  const newGrid = () => {
    const ids = store.query({ kind: 'entity' }).filter((x) => !['layout', 'rendering', 'view', 'filter', 'scene', 'projection', 'plot', 'workstation', 'diagram', 'analysis'].includes(x.type) && !x.type.startsWith('schema:')).slice(0, 200)
    const cols = Math.ceil(Math.sqrt(ids.length))
    draft(projectionFromPositions('New scene', Object.fromEntries(ids.map((x, i) => [x.id, { x: 100 + (i % cols) * 200, y: 100 + Math.floor(i / cols) * 90 }]))).data)
  }

  // The assistant drives the view through this.
  const live = useRef({ content, over, selected, dirty, nodeCount, rels })
  live.current = { content, over, selected, dirty, nodeCount, rels }
  const fns = useRef({ show, saveScene, fitAll, compareWith })
  fns.current = { show, saveScene, fitAll, compareWith }
  useEffect(
    () =>
      registerDisplayHandle({
        getState: () => {
          const s = live.current
          const scene = s.content.kind === 'scene' ? s.content.ref : undefined
          return { scene: scene && !isDraftRef(scene) ? scene : undefined, unsaved: !!scene && isDraftRef(scene), plot: s.content.kind === 'plot' ? s.content.plot : undefined, over: s.over ?? undefined, selection: s.selected ? [s.selected] : [], dirty: s.dirty, nodes: s.content.kind === 'scene' ? s.nodeCount : undefined, edges: s.content.kind === 'scene' ? s.rels.length : undefined }
        },
        show: (t) => (t.plot ? navigate(`/analytics/charts?plot=${encodeURIComponent(t.plot)}`) : fns.current.show({ kind: 'scene', ref: t.scene })),
        compareWith: (id) => fns.current.compareWith(id),
        select: (ids) => {
          setSelected(ids[0] ?? null)
          setSelectedGroup(null)
        },
        save: (name, existing) => fns.current.saveScene(name, existing),
        fit: () => fns.current.fitAll(),
      }),
    [],
  )

  // ── Export ───────────────────────────────────────────────────────────
  const exportAs = (what: 'excalidraw' | 'dot' | 'mermaid' | 'svg', save: boolean) => {
    if (!data) return
    const ents = new Map<EntityId, AnyEntity>()
    for (const id of Object.keys(data.nodes)) {
      const e = store.get(id)
      if (e) ents.set(id, e)
    }
    const d = diagramFromProjection(data, ents, rels.map((r) => ({ id: r.id, source: r.source.id, target: r.target.id, type: r.type, label: r.label, directed: r.directed })))
    const name = (activeRef && !isDraftRef(activeRef) ? displayLabel(store.get(activeRef)!) : 'scene').replace(/[^\w.-]+/g, '_')
    if (what === 'svg') {
      const svg = geometryToSvg(d.geometry!, { nodes: Object.fromEntries(d.nodes.map((n) => [n.id, n.label])), edges: Object.fromEntries(d.edges.filter((e) => e.label).map((e) => [e.id, e.label!])), groups: Object.fromEntries(d.groups.map((g) => [g.id, g.label])) })
      downloadText(`${name}.svg`, svg, 'image/svg+xml')
      return
    }
    const format: DiagramFormat = what
    const src = writeDiagram(d, format)
    if (save) {
      const e = createDiagram(store, { label: `${name} (${format})`, source: src, format, tags: ['from-scene'], source_: 'export:scene' })
      toast(`Saved diagram “${displayLabel(e)}”`)
      navigate(`/diagrams/${e.id}`)
    } else downloadText(`${name}.${format === 'dot' ? 'dot' : format === 'mermaid' ? 'mmd' : 'excalidraw'}`, src, format === 'excalidraw' ? 'application/json' : 'text/plain')
  }
  const exportItems: MenuItem[] = [
    { kind: 'label', label: 'Download' },
    { kind: 'item', label: '.excalidraw (with geometry)', onSelect: () => exportAs('excalidraw', false) },
    { kind: 'item', label: '.svg', onSelect: () => exportAs('svg', false) },
    { kind: 'item', label: '.dot (Graphviz)', onSelect: () => exportAs('dot', false) },
    { kind: 'item', label: '.mmd (Mermaid)', onSelect: () => exportAs('mermaid', false) },
    { kind: 'sep' },
    { kind: 'label', label: 'Save as a diagram resource' },
    { kind: 'item', label: 'Excalidraw diagram', onSelect: () => exportAs('excalidraw', true) },
    { kind: 'item', label: 'Graphviz diagram', onSelect: () => exportAs('dot', true) },
  ]

  // ── Menus ────────────────────────────────────────────────────────────
  const scenes = store.ofType(PROJECTION_TYPE)
  const layouts = store.ofType(GRAPH_TYPES.layout)
  const at = (e: React.MouseEvent<HTMLElement>) => ({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })
  const showItems: MenuItem[] = [
    { kind: 'label', label: 'Scenes' },
    ...(scenes.length
      ? scenes.map<MenuItem>((p) => ({ kind: 'item', label: displayLabel(p), icon: activeRef === p.id ? Check : undefined, onSelect: () => show({ kind: 'scene', ref: p.id }) }))
      : [{ kind: 'item' as const, label: 'No scenes yet', disabled: true, onSelect: () => {} }]),
    { kind: 'sep' },
    { kind: 'item', label: 'Charts and scripts are on the Analytics page', icon: BarChart3, onSelect: () => navigate('/analytics') },
    { kind: 'sep' },
    { kind: 'label', label: 'New scene' },
    ...layouts.map<MenuItem>((l) => ({ kind: 'item', label: `From layout “${displayLabel(l)}”`, onSelect: () => newFromLayout(l) })),
    { kind: 'item', label: 'Grid of entities (first 200)', onSelect: newGrid },
    { kind: 'item', label: 'From a diagram: open it and Export to dataset…', onSelect: () => navigate('/diagrams') },
  ]
  const overItems: MenuItem[] = [
    { kind: 'label', label: 'Draw underneath, faded' },
    ...scenes.filter((p) => p.id !== activeRef).map<MenuItem>((p) => ({ kind: 'item', label: displayLabel(p), icon: over === p.id ? Check : undefined, onSelect: () => compareWith(p.id) })),
    ...(over ? [{ kind: 'sep' as const }, { kind: 'item' as const, label: 'Stop comparing', icon: X, onSelect: () => compareWith(null) }] : []),
  ]

  const colorOf = useCallback((e: AnyEntity | undefined, geom: NodeGeom) => geom.fill ?? (e ? registry.colorOf(e.type) : '#e9e7e1'), [registry])
  const entityOf = useCallback((id: EntityId) => store.get(id), [store])
  const selEntity = selected ? store.get(selected) : undefined
  const overEntity = over ? store.get(over) : undefined
  const summary = data ? `${nodeCount} nodes · ${rels.length} edges${diagramSourceOf(data) ? ` · from ${diagramSourceOf(data)!.format}` : scriptSourceOf(data) ? ' · by a script' : ''}` : 'nothing shown'

  return (
    <div className="pj">
      <div className="pj__top">
        <div className="pj__title">
          <ScanSearch size={16} />
          <span>Scenes</span>
          <span className="muted">Saved pictures: scenes over entities, and charts, drawn on their own</span>
        </div>
        <span className="spacer" />
        {isScene && <SavedPicker type={PROJECTION_TYPE} types={[PROJECTION_TYPE, SCRIPT_SCENE_TYPE]} noun="scene" icon={Layers} activeId={activeRef && !isDraftRef(activeRef) ? activeRef : undefined} dirty={dirty} summary={summary} onLoad={(e) => show({ kind: 'scene', ref: e.id })} onSave={saveScene} onClear={clearScene} clearLabel="Clear" />}
        <button className="btn btn--sm" title="What to show: a saved scene, or a new one" onClick={(e) => setShowMenu(at(e))}>
          <Plus size={13} /> Show
        </button>
        {isScene && (
          <button className={`btn btn--sm ${over ? 'is-on' : ''}`} disabled={!data && !over} title="Draw another scene underneath this one, faded, to compare the two" onClick={(e) => setOverMenu(at(e))}>
            <Layers size={13} /> {overEntity ? `vs ${displayLabel(overEntity)}` : 'Compare'}
          </button>
        )}
        {isScene && (
          <button className="btn btn--sm" disabled={!data} title="Write the scene out as a diagram file, or save it as a diagram resource" onClick={(e) => setExportMenu(at(e))}>
            <Download size={13} /> Export
          </button>
        )}
      </div>
      {!isScene ? (
        <PlotWorkbench />
      ) : (
        <>
          <div className="pj__tools">
            <button className="btn btn--sm btn--icon" title="Zoom out" onClick={() => setView((v) => ({ ...v, k: Math.max(MIN_K, v.k / 1.25) }))}>
              <ZoomOut size={13} />
            </button>
            <span className="pj__zoom mono">{Math.round(view.k * 100)}%</span>
            <button className="btn btn--sm btn--icon" title="Zoom in" onClick={() => setView((v) => ({ ...v, k: Math.min(MAX_K, v.k * 1.25) }))}>
              <ZoomIn size={13} />
            </button>
            <button className="btn btn--sm btn--icon" title="Fit" onClick={() => fitAll()}>
              <Maximize2 size={13} />
            </button>
            <button className={`btn btn--sm btn--icon ${showGrid ? 'is-on' : ''}`} title="Grid" onClick={() => setShowGrid((v) => !v)}>
              <Grid3x3 size={13} />
            </button>
            {data?.source && (
              <button className={`btn btn--sm ${showSource ? 'is-on' : ''}`} title="Show the source diagram's own render underneath, to compare one-to-one" onClick={() => setShowSource((v) => !v)}>
                {showSource ? <EyeOff size={13} /> : <Eye size={13} />} Source render
              </button>
            )}
            <span className="tb__sep" />
            <button className="btn btn--sm" disabled={!data} title={selected ? 'Group the selected node' : 'Add an empty group'} onClick={addGroup}>
              <BoxSelect size={13} /> Group
            </button>
            {selectedGroup && data?.groups[selectedGroup] && (
              <>
                <input className="input pj__group-name" value={data.groups[selectedGroup].title ?? ''} placeholder="Group name" onChange={(e) => renameGroup(selectedGroup, e.target.value)} />
                <span className="muted">{(data.groups[selectedGroup].members ?? []).length} members</span>
                <button className="btn btn--sm btn--icon btn--ghost btn--danger" title="Remove the group (its members stay)" onClick={() => removeGroup(selectedGroup)}>
                  <Trash2 size={13} />
                </button>
              </>
            )}
            <span className="spacer" />
            <span className="muted pj__hint">
              {data ? (
                <>
                  {nodeCount} nodes · {rels.length} edges · {Object.keys(data.groups).length} groups · {Object.keys(data.edges).length} routed{missing ? ` · ${missing} placed ids not in the workspace` : ''}
                  {overEntity ? ` · comparing with “${displayLabel(overEntity)}”` : ''} · drag nodes or groups to move, drop a node into a box to regroup
                </>
              ) : (
                'Show a saved scene, or make a new one'
              )}
            </span>
          </div>
          <div className="pj__body">
            <svg ref={svgRef} className={`pj__canvas ${drag.current?.kind === 'pan' ? 'is-panning' : ''}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
              <defs>
                <marker id="pj-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                  <path d="M0 0L10 5L0 10z" fill="context-stroke" />
                </marker>
                <pattern id="pj-grid" width={50 * view.k} height={50 * view.k} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
                  <path d={`M ${50 * view.k} 0 L 0 0 0 ${50 * view.k}`} fill="none" stroke="rgba(31,30,27,0.08)" strokeWidth="1" />
                </pattern>
              </defs>
              {showGrid && <rect width="100%" height="100%" fill="url(#pj-grid)" />}
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {showSource && sourceSvg && <SourceLayer svg={sourceSvg} format={diagramSourceOf(data)?.format} />}
                {layers.map((l) => (
                  <SceneLayer key={l.id} layer={l} k={view.k} selected={selected} selectedGroup={selectedGroup} entityOf={entityOf} colorOf={colorOf} />
                ))}
              </g>
            </svg>
            {!data && !over && (
              <div className="pj__empty">
                <div className="pj__empty-inner">
                  <h2>Nothing shown yet</h2>
                  <p>Show a saved scene here, or make one from a layout; charts live on the Analytics page.</p>
                  <div className="pj__empty-actions">
                    <button className="btn" onClick={() => navigate('/analytics/charts?plot=new')}>
                      <BarChart3 size={14} /> Analytics
                    </button>
                    <button className="btn" onClick={(e) => setShowMenu(at(e))}>
                      <Plus size={14} /> Show…
                    </button>
                  </div>
                </div>
              </div>
            )}
            <svg ref={liftRef} className="pj__lift" aria-hidden>
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`} />
            </svg>
            {selEntity && (
              <>
                <div className="pane-gutter" onPointerDown={side.onPointerDown} onDoubleClick={side.reset} title="Drag to resize · double-click to reset" />
                <aside className="pj__side" style={{ width: side.width }}>
                  <Inspector entityId={selEntity.id} app onClose={() => setSelected(null)} onOpen={(id) => (data?.nodes[id] ? setSelected(id) : navigate(`/entities?sel=${id}`))} onDelete={() => toast('Delete from the entity table')} />
                </aside>
              </>
            )}
          </div>
        </>
      )}
      {showMenu && <Menu x={showMenu.x} y={showMenu.y} items={showItems} onClose={() => setShowMenu(null)} />}
      {overMenu && <Menu x={overMenu.x} y={overMenu.y} items={overItems} onClose={() => setOverMenu(null)} />}
      {exportMenu && <Menu x={exportMenu.x} y={exportMenu.y} items={exportItems} onClose={() => setExportMenu(null)} />}
    </div>
  )
}

/**
 * The source diagram's picture placed in scene coordinates: Graphviz draws in points with a 4pt margin, Mermaid and
 * the Excalidraw preview in pixels, and in every format a picture's own coordinates are scene pixels (Graphviz's
 * include its margin translate; the Mermaid and Excalidraw viewBoxes only pad). So the picture is drawn as an
 * `<image>` over exactly its viewBox. An image, not markup: the picture is data, and as an image it cannot run
 * script, fetch anything, or style the page (`features/diagrams/DiagramPicture.tsx`).
 */
function SourceLayer({ svg }: { svg: string; format?: string }) {
  const href = useMemo(() => svgDataUrl(svg), [svg])
  const box = useMemo(() => pictureBox(svg), [svg])
  if (!href || !box) return null
  return (
    <g className="pj__source" opacity={0.45} pointerEvents="none">
      <image href={href} x={box.x} y={box.y} width={box.width} height={box.height} preserveAspectRatio="none" />
    </g>
  )
}
