import { useEffect, useState } from 'react'
import type { DiagramFormat } from '../../core/diagrams'
import { DiagramPicture } from './DiagramPicture'
import { renderDiagram } from './render'

/**
 * Rendered preview for index cards. Results are cached in memory by
 * source hash so revisiting the index doesn't re-run the renderers; every
 * edit is a new source, so the oldest pictures go past a cap.
 */
const cache = new Map<string, Promise<string>>()
const CACHE_MAX = 200

const hash = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h.toString(36)
}

export function preview(source: string, format: DiagramFormat): Promise<string> {
  const key = `${format}:${hash(source)}`
  let p = cache.get(key)
  if (!p) {
    p = renderDiagram(source, format).catch(() => '')
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
    cache.set(key, p)
  }
  return p
}

export function DiagramThumb({ source, format }: { source: string; format: DiagramFormat }) {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    preview(source, format).then((s) => live && setSvg(s))
    return () => {
      live = false
    }
  }, [source, format])
  if (svg === null) return <pre className="dgi__code dgi__code--pending">{source.split('\n').slice(0, 9).join('\n')}</pre>
  if (!svg) return <pre className="dgi__code">{source.split('\n').slice(0, 9).join('\n')}</pre>
  return (
    <div className="dgi__svg">
      <DiagramPicture svg={svg} />
    </div>
  )
}
