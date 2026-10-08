import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DataImage } from '../../components/RemoteImage'
import { useImageGate } from '../../components/imageGate'
import { formatDate, hostOf } from '../../lib/format'
import { formatArea, formatDistance, type GeoEntity, type GeoPreview } from './maps'

/**
 * The card behind a pin, path or area. It stays while the pointer is on the
 * pin or on the card itself, so its pictures can be flipped through and its
 * link followed. Pictures: what the place and its neighbours carry, then —
 * fetched when the card opens — more from its Wikipedia article. The title
 * sits on the picture over a dark scrim, so it reads on any photo.
 */
export interface GeoCardProps {
  entity: GeoEntity
  kind: string
  preview?: GeoPreview
  /** Where the card points, in map-container pixels, and the container's size. */
  anchor: { x: number; y: number }
  size: { x: number; y: number }
  /** More pictures, fetched when the card opens (Wikipedia). */
  loadMore?: (e: GeoEntity) => Promise<string[]>
  readMore: { href: string; label: string }
  onEnter: () => void
  onLeave: () => void
}

export function GeoCard({ entity: e, kind, preview, anchor, size, loadMore, readMore, onEnter, onLeave }: GeoCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState<string[]>([])
  const [idx, setIdx] = useState(0)
  const [style, setStyle] = useState<{ left: number; top: number; dir: 'top' | 'bottom' | 'left' | 'right' | 'float'; arrow: number }>({ left: anchor.x, top: anchor.y, dir: 'top', arrow: 0 })

  // The card is keyed by entity, so a fresh mount starts empty; the fetch is cancelled if it closes first.
  useEffect(() => {
    if (!loadMore) return
    let live = true
    loadMore(e)
      .then((urls) => live && setMore(urls))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [e.id, loadMore]) // eslint-disable-line react-hooks/exhaustive-deps

  const images = [...new Set([...(preview?.images ?? []), ...more])]
  const n = images.length
  const at = n ? Math.min(idx, n - 1) : 0
  const step = (d: number) => setIdx((i) => (n ? (i + d + n) % n : 0))

  // Above the anchor when it fits, else below, else beside; sideways shift keeps it inside the map, arrow still on the pin.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const pad = 8
    const gapV = 26
    const gapH = 16
    const fitsAbove = anchor.y - gapV - h >= pad
    const fitsBelow = anchor.y + gapV + h <= size.y - pad
    const fitsRight = anchor.x + gapH + w <= size.x - pad
    const fitsLeft = anchor.x - gapH - w >= pad
    const dir = fitsAbove ? 'top' : fitsBelow ? 'bottom' : fitsRight ? 'right' : fitsLeft ? 'left' : 'float'
    let left: number
    let top: number
    if (dir === 'top' || dir === 'bottom' || dir === 'float') {
      left = anchor.x - w / 2
      top = dir === 'bottom' ? anchor.y + gapV : anchor.y - gapV - h
      if (dir === 'float') top = Math.max(pad, Math.min(size.y - pad - h, anchor.y - h / 2))
    } else {
      left = dir === 'right' ? anchor.x + gapH : anchor.x - gapH - w
      top = Math.max(pad, Math.min(size.y - pad - h, anchor.y - 24))
    }
    const clampedLeft = Math.max(pad, Math.min(size.x - pad - w, left))
    setStyle({ left: clampedLeft, top, dir, arrow: left - clampedLeft })
  }, [anchor.x, anchor.y, size.x, size.y, n, e.id])

  const when = e.data.at ? formatDate(e.data.at) + (e.data.until ? ` – ${formatDate(e.data.until)}` : '') : ''
  const facts = [kind, when, typeof e.data.lengthM === 'number' && formatDistance(e.data.lengthM), typeof e.data.areaM2 === 'number' && formatArea(e.data.areaM2), e.data.url && hostOf(e.data.url), preview?.links ? `${preview.links} link${preview.links === 1 ? '' : 's'}` : ''].filter(Boolean) as string[]
  const text = e.description || preview?.extract || ''
  const title = e.label ?? kind

  return (
    <div ref={ref} className={`geo-card geo-card--${style.dir}`} style={{ left: style.left, top: style.top, ['--geo-arrow-shift' as string]: `${style.arrow}px` }} onMouseEnter={onEnter} onMouseLeave={onLeave} role="dialog" aria-label={title}>
      {n > 0 ? (
        <div className="geo-card__hero">
          {/* Every picture is in the DOM once seen, so flipping back is instant; only the current one shows. */}
          {/* A picture's address is data: a Wikipedia photo loads with Third-party services on, one on any other host waits for a click (`DataImage`). */}
          {images.map((u, i) => (i === at ? <DataImage key={u} src={u} providers compact alt="" loading="eager" decoding="async" className="is-current" /> : i <= at + 1 && i >= at - 1 ? <GalleryNeighbour key={u} src={u} /> : null))}
          <div className="geo-card__scrim" />
          <div className="geo-card__title geo-card__title--over">{title}</div>
          {n > 1 && (
            <>
              <button className="geo-card__arrow geo-card__arrow--prev" onClick={() => step(-1)} title="Previous picture" aria-label="Previous picture">
                <ChevronLeft size={16} />
              </button>
              <button className="geo-card__arrow geo-card__arrow--next" onClick={() => step(1)} title="Next picture" aria-label="Next picture">
                <ChevronRight size={16} />
              </button>
              <span className="geo-card__count">
                {at + 1} / {n}
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="geo-card__title geo-card__title--plain">{title}</div>
      )}
      <div className="geo-card__body">
        <div className="geo-card__facts">{facts.join(' · ')}</div>
        {e.data.address && e.data.address !== e.label && <div className="geo-card__addr">{e.data.address}</div>}
        {text && <div className="geo-card__desc">{text.length > 260 ? text.slice(0, 257) + '…' : text}</div>}
        <a className="geo-card__more" href={readMore.href} target="_blank" rel="noreferrer noopener">
          <ExternalLink size={12} /> Read more on {readMore.label}
        </a>
      </div>
    </div>
  )
}

/** The pictures either side of the current one, preloaded so flipping is instant — only those that would show without asking. */
function GalleryNeighbour({ src }: { src: string }) {
  const gate = useImageGate(src, { providers: true })
  return gate?.status === 'show' ? <img src={gate.src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : null
}
