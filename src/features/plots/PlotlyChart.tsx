import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlotlyEventTarget, PlotlyPoint, PlotlyStatic } from 'plotly.js-dist-min'
import type { EntityId } from '../../core/entity/types'
import type { PlotlyTrace } from '../../core/graph/plot'
import { observeSettledSize } from '../../lib/settledResize'
import { sanitizeFigure } from '../../scripting/figure'
import { useViewActive } from '../workstation/paneContext'
import './plots.css'

/** What a click on a point tells the page: the entities behind it and where the pointer is. */
export interface PointPick {
  ids: EntityId[]
  trace?: string
  x?: unknown
  y?: unknown
  clientX: number
  clientY: number
  /** Right button (context menu) or left click. */
  button: 'left' | 'right'
}

/** Entity ids behind a Plotly point: per-point customdata, a histogram's binned points, or a heatmap cell. */
function idsOf(p: PlotlyPoint): EntityId[] {
  const own = p.customdata
  if (Array.isArray(own)) return own.flat().map(String)
  const all = p.data.customdata
  if (Array.isArray(all)) {
    if (p.pointNumbers?.length) return p.pointNumbers.flatMap((i) => (Array.isArray(all[i]) ? (all[i] as unknown[]).map(String) : []))
    const i = p.pointIndex ?? p.pointNumber
    if (typeof i === 'number' && Array.isArray(all[i])) return (all[i] as unknown[]).map(String)
    if (Array.isArray(i)) {
      const [r, c] = i as unknown as [number, number]
      const row = all[r] as unknown[] | undefined
      const cell = row?.[c]
      if (Array.isArray(cell)) return cell.map(String)
    }
  }
  return []
}

let plotlyPromise: Promise<PlotlyStatic> | null = null
/** Plotly is ~1 MB gzipped; it loads the first time a chart is shown and never before. */
export const loadPlotly = () => (plotlyPromise ??= import('plotly.js-dist-min').then((m) => m.default))

interface Props {
  data: PlotlyTrace[]
  layout: Record<string, unknown>
  className?: string
  /** Called with the mounted element once Plotly has drawn, e.g. for image export. */
  onReady?: (el: HTMLDivElement) => void
  /** A point was clicked or right-clicked. */
  onPick?: (pick: PointPick) => void
  /** What dragging does: move the view (default) or draw a zoom box. */
  dragmode?: 'pan' | 'zoom'
}

/** Zoom every axis about its centre by `factor` (> 1 zooms in). Reads Plotly's resolved ranges, so date and log axes work. */
export async function zoomChart(el: HTMLElement, factor: number) {
  const Plotly = await loadPlotly()
  const full = (el as unknown as { _fullLayout?: Record<string, { range?: [unknown, unknown]; type?: string; _categories?: unknown[] }> })._fullLayout
  if (!full) return
  const update: Record<string, unknown> = {}
  for (const axis of ['xaxis', 'yaxis']) {
    const a = full[axis]
    if (!a?.range) continue
    const isDate = a.type === 'date'
    const toN = (v: unknown) => (isDate ? Date.parse(String(v)) : Number(v))
    let lo = toN(a.range[0])
    let hi = toN(a.range[1])
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    const mid = (lo + hi) / 2
    const half = (hi - lo) / 2 / factor
    lo = mid - half
    hi = mid + half
    // A category axis (a heatmap's rows, a bar chart's groups) has nothing beyond its categories: zooming out stops at all of them.
    if (a.type === 'category' && a._categories?.length) {
      const min = -0.5
      const max = a._categories.length - 0.5
      if (hi - lo >= max - min) {
        update[`${axis}.autorange`] = true
        continue
      }
      if (lo < min) (hi += min - lo), (lo = min)
      if (hi > max) (lo -= hi - max), (hi = max)
    }
    const out = (v: number) => (isDate ? new Date(v).toISOString() : v)
    update[`${axis}.range`] = [out(lo), out(hi)]
    update[`${axis}.autorange`] = false
  }
  await Plotly.relayout(el, update)
}

type FullAxis = { range?: [unknown, unknown]; type?: string; _categories?: unknown[] }
type FullLayout = { xaxis?: FullAxis; yaxis?: FullAxis; _size?: { l: number; t: number; w: number; h: number } }

/**
 * Wheel zoom, done here rather than by Plotly: about the pointer, coalesced to one relayout per frame, and with no
 * CSS-transform preview between steps — Plotly's own scroll zoom previews with a transform and then redraws 50 ms
 * later, which on a heatmap (an image that is re-rasterised each time) flashes and jumps as the wheel turns.
 */
export function attachWheelZoom(el: HTMLElement): () => void {
  let pending: { factor: number; fx: number; fy: number } | null = null
  let frame = 0
  const apply = async () => {
    frame = 0
    const z = pending
    pending = null
    if (!z) return
    const Plotly = await loadPlotly()
    const full = (el as unknown as { _fullLayout?: FullLayout })._fullLayout
    if (!full?._size) return
    const update: Record<string, unknown> = {}
    for (const [axis, f] of [['xaxis', z.fx], ['yaxis', 1 - z.fy]] as const) {
      const a = full[axis]
      if (!a?.range) continue
      const isDate = a.type === 'date'
      const toN = (v: unknown) => (isDate ? Date.parse(String(v)) : Number(v))
      let lo = toN(a.range[0])
      let hi = toN(a.range[1])
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
      // The point under the pointer stays put: the range shrinks or grows around it.
      const at = lo + (hi - lo) * f
      lo = at + (lo - at) / z.factor
      hi = at + (hi - at) / z.factor
      if (a.type === 'category' && a._categories?.length) {
        const min = -0.5
        const max = a._categories.length - 0.5
        if (hi - lo >= max - min) {
          update[`${axis}.autorange`] = true
          continue
        }
        if (lo < min) (hi += min - lo), (lo = min)
        if (hi > max) (lo -= hi - max), (hi = max)
      }
      const out = (v: number) => (isDate ? new Date(v).toISOString() : v)
      update[`${axis}.range`] = [out(lo), out(hi)]
      update[`${axis}.autorange`] = false
    }
    await Plotly.relayout(el, update)
  }
  const onWheel = (e: WheelEvent) => {
    const full = (el as unknown as { _fullLayout?: FullLayout })._fullLayout
    const size = full?._size
    if (!size) return
    const r = el.getBoundingClientRect()
    const fx = (e.clientX - r.left - size.l) / size.w
    const fy = (e.clientY - r.top - size.t) / size.h
    if (fx < -0.05 || fx > 1.05 || fy < -0.05 || fy > 1.05) return // over the margins, the legend, the colour bar: leave it
    e.preventDefault()
    // Trackpads send many small deltas, wheels a few large ones: a wheel click is clamped to ~22 % (Plotly's rate).
    const step = Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) / 300)
    pending = { factor: (pending?.factor ?? 1) * step, fx, fy }
    if (!frame) frame = requestAnimationFrame(() => void apply())
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  return () => {
    el.removeEventListener('wheel', onWheel)
    if (frame) cancelAnimationFrame(frame)
  }
}

/** Shift the view by a fraction of its width/height (positive dx moves the view right, i.e. content left). */
export async function panChart(el: HTMLElement, dx: number, dy: number) {
  const Plotly = await loadPlotly()
  const full = (el as unknown as { _fullLayout?: Record<string, { range?: [unknown, unknown]; type?: string }> })._fullLayout
  if (!full) return
  const update: Record<string, unknown> = {}
  for (const [axis, f] of [['xaxis', dx], ['yaxis', dy]] as const) {
    const a = full[axis]
    if (!a?.range || !f) continue
    const isDate = a.type === 'date'
    const toN = (v: unknown) => (isDate ? Date.parse(String(v)) : Number(v))
    const lo = toN(a.range[0])
    const hi = toN(a.range[1])
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    const shift = (hi - lo) * f
    const out = (v: number) => (isDate ? new Date(v).toISOString() : v)
    update[`${axis}.range`] = [out(lo + shift), out(hi + shift)]
    update[`${axis}.autorange`] = false
  }
  await Plotly.relayout(el, update)
}

const cssVar = (name: string, fallback: string) => (typeof window === 'undefined' ? fallback : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback)

/** Draws with Plotly.react (diffs in place), themed from the app's CSS variables, resized with its container. */
export function PlotlyChart({ data: rawData, layout: rawLayout, className, onReady, onPick, dragmode = 'pan' }: Props) {
  // Whatever drew this figure — a script, a chart from a bundle, a run kept in the browser — it is drawn in the app's
  // page: nothing in it may make Plotly fetch a URL or load one from a style (figure.ts). Same objects when clean.
  const { data, layout } = useMemo(() => {
    const clean = sanitizeFigure(rawData, rawLayout)
    return { data: clean.data, layout: clean.layout }
  }, [rawData, rawLayout])
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  // The last hovered point, so a right-click (which Plotly doesn't route) knows what is under the pointer.
  const hovered = useRef<PlotlyPoint | null>(null)
  // A chart on a page or tab left behind is purged after a minute (Plotly holds its WebGL/SVG scene and
  // listeners per figure) and drawn again on return; `uirevision` brings the zoom back with it.
  const viewActive = useViewActive()
  const [dormant, setDormant] = useState(false)
  useEffect(() => {
    if (viewActive) {
      setDormant(false)
      return
    }
    const t = setTimeout(() => setDormant(true), 60_000)
    return () => clearTimeout(t)
  }, [viewActive])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (dormant) {
      loadPlotly().then((P) => P.purge(el)).catch(() => {})
      return
    }
    let live = true
    loadPlotly()
      .then((Plotly) => {
        if (!live) return
        const font = cssVar('--text', '#1f1e1b')
        const grid = cssVar('--border', '#e5e2da')
        // A script may say `title: 'Text'`; this Plotly wants `{ text }` and would otherwise draw no title at all.
        const title = typeof layout.title === 'string' ? { text: layout.title } : (layout.title as { text?: string } | undefined)
        const themed = {
          ...layout,
          title,
          // Keep the user's zoom/pan across re-renders of the same plot; a new spec starts fresh.
          uirevision: layout.uirevision ?? 'plot',
          dragmode,
          autosize: true,
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          // Plotly's own margins (80 px each side, 100 on top) squeeze a script's figure; the plot tool's are the default here.
          margin: { l: 56, r: 24, t: title?.text ? 48 : 24, b: 48, ...((layout.margin as object) ?? {}) },
          font: { family: cssVar('--font-sans', 'system-ui'), color: font, size: 12 },
          xaxis: { gridcolor: grid, zerolinecolor: grid, ...(layout.xaxis as object) },
          yaxis: { gridcolor: grid, zerolinecolor: grid, ...(layout.yaxis as object) },
          legend: { bgcolor: 'transparent', ...((layout.legend as object) ?? {}) },
        }
        // Our own toolbar drives the view; Plotly's hover modebar would be a second, less clear set of the same controls.
        return Plotly.react(el, data, themed, { responsive: true, displaylogo: false, displayModeBar: false, scrollZoom: false, doubleClick: 'reset' }).then(() => {
          setError(null)
          const target = el as unknown as PlotlyEventTarget
          target.removeAllListeners?.('plotly_click')
          target.removeAllListeners?.('plotly_hover')
          target.removeAllListeners?.('plotly_unhover')
          target.on('plotly_hover', (e) => (hovered.current = e.points[0] ?? null))
          target.on('plotly_unhover', () => (hovered.current = null))
          target.on('plotly_click', (e) => {
            const p = e.points[0]
            const ev = e.event
            if (!p || !ev || ev.button !== 0) return
            pickRef.current?.({ ids: idsOf(p), trace: p.data.name, x: p.x, y: p.y, clientX: ev.clientX, clientY: ev.clientY, button: 'left' })
          })
          onReady?.(el)
        })
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [data, layout, onReady, dragmode, dormant])

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const stop = observeSettledSize(el, () => loadPlotly().then((P) => P.Plots.resize(el)).catch(() => {}))
    const stopWheel = attachWheelZoom(el)
    return () => {
      stop()
      stopWheel()
      loadPlotly().then((P) => P.purge(el)).catch(() => {})
    }
  }, [])

  const onContextMenu = (e: React.MouseEvent) => {
    const p = hovered.current
    if (!p || !pickRef.current) return
    e.preventDefault()
    pickRef.current({ ids: idsOf(p), trace: p.data.name, x: p.x, y: p.y, clientX: e.clientX, clientY: e.clientY, button: 'right' })
  }

  return (
    <div className={`plot ${className ?? ''}`} onContextMenu={onContextMenu}>
      <div ref={ref} className="plot__canvas" />
      {error && <div className="plot__error">{error}</div>}
    </div>
  )
}
