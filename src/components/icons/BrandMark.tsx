import { MessagesSquare } from 'lucide-react'
import { useState, type SVGProps } from 'react'
import { BRANDS, type BrandId } from './brands'

/**
 * The mark alone, in `currentColor` where we ship a path. A file in
 * `public/brands/<id>.svg` stands in for a brand we ship no mark for; if it is
 * not there either, a glyph is drawn, so nothing ever renders empty.
 */
export function BrandMark({ brand, size = 18, ...rest }: { brand: BrandId; size?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>) {
  const [noFile, setNoFile] = useState(false)
  const b = BRANDS[brand]
  // A file is looked for only where we ship no mark: no wasted request for the ones we draw ourselves.
  if (!b.path && !noFile) return <img src={`/brands/${brand}.svg`} width={size} height={size} alt="" aria-hidden="true" style={{ display: 'block' }} onError={() => setNoFile(true)} />
  if (b.path)
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
        <path d={b.path} />
      </svg>
    )
  const Fallback = b.fallback ?? MessagesSquare
  return <Fallback size={size} aria-hidden="true" />
}

/** The mark on its brand-coloured tile — the shape the dataset cards give every other icon. */
export function BrandTile({ brand, size = 18, className = 'ds__icon' }: { brand: BrandId; size?: number; className?: string }) {
  const b = BRANDS[brand]
  return (
    <span className={className} style={{ background: b.hex, color: '#fff' }} title={b.label}>
      <BrandMark brand={brand} size={size} />
    </span>
  )
}
