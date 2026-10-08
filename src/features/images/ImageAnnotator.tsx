import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ImageStandIn } from '../../components/RemoteImage'
import { useImageGate } from '../../components/imageGate'
import { useViewActiveRef } from '../workstation/paneContext'
import type { EntityId } from '../../core/entity/types'
import { normalizeBox, type Box, type ImageAnnotation, type ImageEntity } from './images'

export type Tool = 'select' | 'draw'

interface Props {
  image: ImageEntity
  annotations: ImageAnnotation[]
  tool: Tool
  /** A number is an explicit scale; 'fit' sizes the image to the viewport. */
  zoom: number | 'fit'
  selectedId: EntityId | null
  onSelect: (id: EntityId | null) => void
  /** Finished drawing a box (natural pixel coordinates). */
  onDraw: (box: Box) => void
  /** Finished moving or resizing an existing box. */
  onChange: (annotationId: EntityId, box: Box) => void
  onDelete: (annotationId: EntityId) => void
  /** Reports the effective scale (for the zoom readout) and the natural size once loaded. */
  onScale?: (scale: number) => void
  onLoaded?: (size: { width: number; height: number }) => void
  colorOf?: (a: ImageAnnotation) => string | undefined
  /** A box that was just drawn and is awaiting its annotation — stays visible so it can be checked. */
  pending?: Box | null
  /** Wheel / pinch zoom asks the parent to change `zoom`; the point under the cursor stays put. */
  onZoom?: (scale: number) => void
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; scrollLeft: number; scrollTop: number }
  | { kind: 'draw'; start: { x: number; y: number }; box: Box }
  | { kind: 'move'; id: EntityId; start: { x: number; y: number }; origin: Box; box: Box }
  | { kind: 'resize'; id: EntityId; corner: Corner; origin: Box; box: Box }

type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']
const HANDLE = 8
const DEFAULT_COLOR = '#f59e0b'

/**
 * The image with an SVG overlay in natural-pixel coordinates. Boxes are
 * drawn, moved, and resized here; the parent owns persistence.
 */
export function ImageAnnotator({ image, annotations, tool, zoom, selectedId, onSelect, onDraw, onChange, onDelete, onScale, onLoaded, colorOf, pending, onZoom }: Props) {
  const viewport = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(image.data.width && image.data.height ? { width: image.data.width, height: image.data.height } : null)
  const [fit, setFit] = useState(1)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [hover, setHover] = useState<EntityId | null>(null)
  const [failed, setFailed] = useState(false)
  // The picture is data: one on another host waits for the reader's click, and for Third-party services.
  const gate = useImageGate(image.data.src, { providers: true })
  const [space, setSpace] = useState(false)
  // Where a wheel-zoom happened, so the scroll can be corrected once the new scale has rendered.
  const anchor = useRef<{ clientX: number; clientY: number; nx: number; ny: number } | null>(null)

  const scale = zoom === 'fit' ? fit : zoom
  useEffect(() => onScale?.(scale), [scale, onScale])

  // After a zoom, keep the image point that was under the cursor under the cursor.
  useLayoutEffect(() => {
    const a = anchor.current
    const el = viewport.current
    if (!a || !el) return
    anchor.current = null
    const r = el.getBoundingClientRect()
    const stage = el.firstElementChild as HTMLElement | null
    const offX = stage ? stage.offsetLeft : 0
    const offY = stage ? stage.offsetTop : 0
    el.scrollLeft = offX + a.nx * scale - (a.clientX - r.left)
    el.scrollTop = offY + a.ny * scale - (a.clientY - r.top)
  }, [scale])

  // The wheel zooms around the cursor while the pointer is over the image (pinch and ⌘/Ctrl+wheel too); drag to pan.
  useEffect(() => {
    const el = viewport.current
    if (!el || !onZoom) return
    const onWheel = (e: WheelEvent) => {
      if (!natural || !svgRef.current || e.deltaY === 0) return
      e.preventDefault()
      const r = svgRef.current.getBoundingClientRect()
      anchor.current = { clientX: e.clientX, clientY: e.clientY, nx: (e.clientX - r.left) / scale, ny: (e.clientY - r.top) / scale }
      // Pinch gestures arrive as ctrl+wheel with small deltas; treat them a little more sensitively.
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : e.ctrlKey ? 0.01 : 0.0025))
      onZoom(Math.max(0.05, Math.min(8, scale * factor)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onZoom, natural, scale])

  const viewActive = useViewActiveRef()
  // Hold Space to pan with any tool.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!viewActive.current) return // a page or tab behind the front one sits shortcuts out
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.code === 'Space' && !e.repeat) {
        setSpace(true)
        e.preventDefault()
      }
    }
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpace(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // Fit = the largest scale where the whole image is visible; small images are upscaled (to 4×) so boxes are drawable.
  const computeFit = useCallback(() => {
    const el = viewport.current
    if (!el || !natural) return
    const pad = 48
    const s = Math.min((el.clientWidth - pad) / natural.width, (el.clientHeight - pad) / natural.height, 4)
    setFit(Math.max(0.05, s))
  }, [natural])
  useLayoutEffect(computeFit, [computeFit])
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const ro = new ResizeObserver(computeFit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [computeFit])

  // Keyboard: Delete removes the selection, Escape clears it or cancels a draw.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (!viewActive.current) return // a page or tab behind the front one sits shortcuts out
      if (e.key === 'Escape') {
        setDrag(null)
        onSelect(null)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault()
        onDelete(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, onSelect, onDelete])

  const toNatural = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }

  const startPan = (e: ReactPointerEvent<Element>) => {
    const el = viewport.current!
    setDrag({ kind: 'pan', startX: e.clientX, startY: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop })
  }

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!natural) return
    const target = e.target as SVGElement
    const boxId = target.closest('[data-box]')?.getAttribute('data-box') ?? null
    const corner = target.getAttribute('data-corner') as Corner | null
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* not a live pointer (synthetic events) — dragging still works while the cursor stays over the overlay */
    }
    // Middle button, Space-drag, or select-tool drag on empty image → pan.
    if (e.button === 1 || (e.button === 0 && (space || (tool === 'select' && !boxId)))) {
      e.preventDefault()
      onSelect(null)
      startPan(e)
      return
    }
    if (e.button !== 0) return
    const p = toNatural(e)

    if (corner && boxId) {
      const a = annotations.find((x) => x.annotation.id === boxId)
      if (!a) return
      onSelect(boxId)
      setDrag({ kind: 'resize', id: boxId, corner, origin: a.region, box: a.region })
      return
    }
    if (tool === 'select' && boxId) {
      const a = annotations.find((x) => x.annotation.id === boxId)
      if (!a) return
      onSelect(boxId)
      setDrag({ kind: 'move', id: boxId, start: p, origin: a.region, box: a.region })
      return
    }
    if (tool === 'draw') {
      onSelect(null)
      setDrag({ kind: 'draw', start: p, box: { x: p.x, y: p.y, width: 0, height: 0 } })
      return
    }
    onSelect(null)
  }

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag || !natural) return
    if (drag.kind === 'pan') {
      const el = viewport.current!
      el.scrollLeft = drag.scrollLeft - (e.clientX - drag.startX)
      el.scrollTop = drag.scrollTop - (e.clientY - drag.startY)
      return
    }
    const p = toNatural(e)
    if (drag.kind === 'draw') {
      setDrag({ ...drag, box: { x: drag.start.x, y: drag.start.y, width: p.x - drag.start.x, height: p.y - drag.start.y } })
    } else if (drag.kind === 'move') {
      const dx = p.x - drag.start.x
      const dy = p.y - drag.start.y
      const x = Math.max(0, Math.min(natural.width - drag.origin.width, drag.origin.x + dx))
      const y = Math.max(0, Math.min(natural.height - drag.origin.height, drag.origin.y + dy))
      setDrag({ ...drag, box: { ...drag.origin, x: Math.round(x), y: Math.round(y) } })
    } else {
      const o = drag.origin
      const left = drag.corner.includes('w') ? p.x : o.x
      const right = drag.corner.includes('e') ? p.x : o.x + o.width
      const top = drag.corner.includes('n') ? p.y : o.y
      const bottom = drag.corner.includes('s') ? p.y : o.y + o.height
      setDrag({ ...drag, box: { x: left, y: top, width: right - left, height: bottom - top } })
    }
  }

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag || !natural) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* see above */
    }
    setDrag(null)
    if (drag.kind === 'pan') return
    const box = normalizeBox(drag.box, natural.width, natural.height)
    if (drag.kind === 'draw') {
      if (box && box.width >= 4 && box.height >= 4) onDraw(box)
    } else if (box && (box.x !== drag.origin.x || box.y !== drag.origin.y || box.width !== drag.origin.width || box.height !== drag.origin.height)) {
      onChange(drag.id, box)
    }
  }

  // Pans started outside the overlay (middle button on the viewport) follow the pointer window-wide.
  useEffect(() => {
    if (drag?.kind !== 'pan') return
    const move = (e: PointerEvent) => {
      const el = viewport.current
      if (!el) return
      el.scrollLeft = drag.scrollLeft - (e.clientX - drag.startX)
      el.scrollTop = drag.scrollTop - (e.clientY - drag.startY)
    }
    const up = () => setDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag])

  const liveBox = (a: ImageAnnotation): Box => (drag && (drag.kind === 'move' || drag.kind === 'resize') && drag.id === a.annotation.id ? drag.box : a.region)

  return (
    <div ref={viewport} className={`ia ia--${tool} ${space || drag?.kind === 'pan' ? 'is-panning' : ''}`} onPointerDown={(e) => e.button === 1 && natural && (e.preventDefault(), startPan(e))}>
      {!gate ? (
        <div className="ia__failed muted">This image's address is not one that can be shown.</div>
      ) : gate.status !== 'show' ? (
        <div className="ia__failed muted">
          <ImageStandIn gate={gate} alt={image.label} />
        </div>
      ) : failed ? (
        <div className="ia__failed muted">The image could not be loaded{image.data.url ? ` from ${image.data.url}` : ''}.</div>
      ) : (
        <div className="ia__stage" style={natural ? { width: natural.width * scale, height: natural.height * scale } : undefined}>
          <img
            className="ia__img"
            src={gate.src}
            alt={image.label ?? ''}
            referrerPolicy="no-referrer"
            draggable={false}
            onLoad={(e) => {
              const size = { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }
              setNatural(size)
              onLoaded?.(size)
            }}
            onError={() => setFailed(true)}
            style={natural ? { width: natural.width * scale, height: natural.height * scale } : { opacity: 0 }}
          />
          {natural && (
            <svg
              ref={svgRef}
              className="ia__overlay"
              viewBox={`0 0 ${natural.width} ${natural.height}`}
              width={natural.width * scale}
              height={natural.height * scale}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
            >
              {annotations.map((a, i) => {
                const b = liveBox(a)
                const id = a.annotation.id
                const color = colorOf?.(a) ?? DEFAULT_COLOR
                const selected = selectedId === id
                const active = selected || hover === id
                return (
                  <g key={id} data-box={id} className={`ia__box ${selected ? 'is-selected' : ''}`} onPointerEnter={() => setHover(id)} onPointerLeave={() => setHover((h) => (h === id ? null : h))}>
                    <rect x={b.x} y={b.y} width={b.width} height={b.height} fill={color} fillOpacity={active ? 0.18 : 0.08} stroke={color} strokeWidth={selected ? 2.5 : 1.5} vectorEffect="non-scaling-stroke" />
                    <g transform={`translate(${b.x} ${b.y}) scale(${1 / scale})`}>
                      <rect x={0} y={-20} width={20} height={20} rx={3} fill={color} />
                      <text x={10} y={-6} textAnchor="middle" fontSize={11} fontWeight={600} fill="#fff" fontFamily="system-ui, sans-serif">
                        {i + 1}
                      </text>
                    </g>
                    {selected &&
                      tool === 'select' &&
                      CORNERS.map((c) => {
                        const cx = c.includes('e') ? b.x + b.width : b.x
                        const cy = c.includes('s') ? b.y + b.height : b.y
                        const h = HANDLE / scale
                        return <rect key={c} data-corner={c} data-box={id} className={`ia__handle ia__handle--${c}`} x={cx - h / 2} y={cy - h / 2} width={h} height={h} fill="#fff" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                      })}
                  </g>
                )
              })}
              {pending && !drag && (
                <g className="ia__pending">
                  <rect x={pending.x} y={pending.y} width={pending.width} height={pending.height} fill={DEFAULT_COLOR} fillOpacity={0.18} stroke={DEFAULT_COLOR} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  <rect x={pending.x} y={pending.y} width={pending.width} height={pending.height} fill="none" stroke="#fff" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                </g>
              )}
              {drag?.kind === 'draw' && drag.box.width !== 0 && drag.box.height !== 0 && (
                <rect
                  className="ia__draft"
                  x={Math.min(drag.box.x, drag.box.x + drag.box.width)}
                  y={Math.min(drag.box.y, drag.box.y + drag.box.height)}
                  width={Math.abs(drag.box.width)}
                  height={Math.abs(drag.box.height)}
                  fill={DEFAULT_COLOR}
                  fillOpacity={0.15}
                  stroke={DEFAULT_COLOR}
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
          )}
        </div>
      )}
    </div>
  )
}
