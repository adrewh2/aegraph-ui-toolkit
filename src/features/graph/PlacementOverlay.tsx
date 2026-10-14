import { memo, useEffect, useRef } from 'react'
import type { PlaceResult, Rect } from '../../core/graph/placement'

/** What the overlay needs of a renderer: graph → screen px, and a word when the camera moves. */
export interface OverlayCamera {
  toViewport: (x: number, y: number) => { x: number; y: number }
  /** Subscribe to camera moves and resizes; returns the unsubscribe. */
  onChange: (cb: () => void) => () => void
}

interface Props {
  camera: OverlayCamera | null
  overlay: { region: Rect; cells?: PlaceResult['cells']; axes: PlaceResult['axes'] } | undefined
}

const MAX_CELLS = 3600

/**
 * The last placement's region, heatmap cells and axis ticks, drawn in graph
 * coordinates inside one SVG group whose transform follows the camera.
 * Camera moves cost three coordinate conversions and a few attribute
 * writes per frame — React never re-renders on pan/zoom.
 */
export const PlacementOverlay = memo(function PlacementOverlay({ camera, overlay }: Props) {
  const gRef = useRef<SVGGElement>(null)
  const labelsRef = useRef<SVGGElement>(null)

  useEffect(() => {
    if (!camera || !overlay) return
    let raf = 0
    const sync = () => {
      raf = 0
      const g = gRef.current
      if (!g) return
      const o = camera.toViewport(0, 0)
      const ex = camera.toViewport(1, 0)
      const ey = camera.toViewport(0, 1)
      g.setAttribute('transform', `matrix(${ex.x - o.x} ${ex.y - o.y} ${ey.x - o.x} ${ey.y - o.y} ${o.x} ${o.y})`)
      const labels = labelsRef.current
      if (labels) {
        for (const el of labels.children) {
          const t = el as SVGTextElement
          const gx = Number(t.dataset.gx)
          const gy = Number(t.dataset.gy)
          const p = camera.toViewport(gx, gy)
          t.setAttribute('x', String(p.x + Number(t.dataset.dx ?? 0)))
          t.setAttribute('y', String(p.y + Number(t.dataset.dy ?? 0)))
        }
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(sync)
    }
    sync()
    const off = camera.onChange(schedule)
    return () => {
      off()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [camera, overlay])

  if (!overlay) return null
  const { region, cells, axes } = overlay
  const drawCells = cells && cells.length <= MAX_CELLS
  return (
    <svg className="gx-overlay" aria-hidden>
      <g ref={gRef}>
        {/* y is up in graph space and down in SVG; the matrix from the camera already flips, so draw in raw graph coordinates. */}
        {drawCells &&
          cells.map((c) => (
            <rect key={`${c.x},${c.y}`} x={c.rect.minX} y={c.rect.minY} width={c.rect.maxX - c.rect.minX} height={c.rect.maxY - c.rect.minY} fill="none" stroke="color-mix(in srgb, var(--text) 18%, transparent)" vectorEffect="non-scaling-stroke" />
          ))}
        <rect x={region.minX} y={region.minY} width={region.maxX - region.minX} height={region.maxY - region.minY} fill="none" stroke="color-mix(in srgb, var(--text) 45%, transparent)" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
      </g>
      <g ref={labelsRef} className="gx-overlay__labels">
        {axes.x?.ticks.slice(0, 24).map((t, i) => (
          <text key={`x${i}`} data-gx={t.at} data-gy={region.minY} data-dy={14} textAnchor="middle">
            {t.label}
          </text>
        ))}
        {axes.y?.ticks.slice(0, 24).map((t, i) => (
          <text key={`y${i}`} data-gx={region.minX} data-gy={t.at} data-dx={-6} textAnchor="end" dominantBaseline="middle">
            {t.label}
          </text>
        ))}
        {axes.x && (
          <text data-gx={(region.minX + region.maxX) / 2} data-gy={region.minY} data-dy={30} textAnchor="middle" className="gx-overlay__axis">
            {axes.x.ref}
          </text>
        )}
        {axes.y && (
          <text data-gx={region.minX} data-gy={region.maxY} data-dy={-8} textAnchor="start" className="gx-overlay__axis">
            {axes.y.ref} ↑
          </text>
        )}
      </g>
    </svg>
  )
})
