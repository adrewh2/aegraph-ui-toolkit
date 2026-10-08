import { useMemo, type CSSProperties } from 'react'
import { svgDataUrl } from '../../core/diagrams/sanitizeSvg'

/**
 * A rendered diagram, drawn as an image. The picture is data (its source came in a bundle, an import, from the
 * model) and has been rebuilt from an allow-list (`core/diagrams/sanitizeSvg.ts`); drawn through an `<img>` it
 * also cannot run script, fetch anything, or style the page around it, which markup in the document could. The
 * cost is that its links are not links — a diagram here is a picture to look at; its source is where it is edited.
 */
export function DiagramPicture({ svg, className, style, alt = 'Diagram' }: { svg: string; className?: string; style?: CSSProperties; alt?: string }) {
  const src = useMemo(() => svgDataUrl(svg), [svg])
  if (!src) return null
  return <img className={className} style={style} src={src} alt={alt} draggable={false} decoding="async" />
}
