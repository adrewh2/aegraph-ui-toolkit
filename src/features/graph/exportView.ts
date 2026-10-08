import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { serialize } from '../../core/exchange/export'
import { GRAPH_FORMATS, isGraphFormatId, type GraphFormatId } from '../../core/exchange/graph/graphFormats'
import type { ExportFile } from '../../core/exchange/graph/model'
import { svgFromView, type SvgOptions } from '../../core/exchange/graph/svg'
import type { GraphSlice } from '../../core/graph/filter'
import type { Positions } from '../../core/graph/layouts'
import type { EdgeStyle, NodeStyle, RenderingSpec } from '../../core/graph/rendering'
import type { EntityId } from '../../core/entity/types'
import { downloadText } from '../../lib/download'

export type ViewExportFormat = GraphFormatId | 'svg' | 'png' | 'json'

export interface ViewExportContext {
  slice: Pick<GraphSlice, 'nodes' | 'edges'>
  positions: Positions
  styles: { nodes: Map<EntityId, NodeStyle>; edges: Map<EntityId, EdgeStyle> }
  registry: TypeRegistry
  rendering: RenderingSpec
  labels: 'auto' | 'all' | 'none'
  snapshot?: (opts?: { width?: number; height?: number; background?: string }) => Promise<Blob | null>
  name?: string
}

export const VIEW_EXPORT_LABELS: Record<ViewExportFormat, string> = {
  png: 'PNG image',
  svg: 'SVG drawing',
  json: 'aegraph JSON',
  ...(Object.fromEntries(GRAPH_FORMATS.map((f) => [f.id, f.label])) as Record<GraphFormatId, string>),
}

/** The current view in any export format: text files, or a PNG blob. */
export async function exportView(format: ViewExportFormat, ctx: ViewExportContext, opts: SvgOptions & { width?: number; height?: number; background?: string } = {}): Promise<ExportFile[] | Blob> {
  const name = ctx.name ?? 'graph-view'
  if (format === 'png') {
    if (!ctx.snapshot) throw new Error('This renderer cannot produce a PNG snapshot.')
    const blob = await ctx.snapshot({ width: opts.width, height: opts.height, background: opts.background })
    if (!blob) throw new Error('The renderer is not ready for a snapshot.')
    return blob
  }
  if (format === 'svg') {
    const text = svgFromView(ctx.slice, ctx.positions, ctx.styles, { ...opts, labels: opts.labels ?? ctx.labels, edgeLabels: opts.edgeLabels ?? ctx.rendering.edgeLabels, curvedEdges: opts.curvedEdges ?? ctx.rendering.curvedEdges })
    return [{ name: `${name}.svg`, text, mime: 'image/svg+xml' }]
  }
  if (format === 'json') {
    let text = ''
    for (const chunk of serialize({ entities: [...ctx.slice.nodes, ...ctx.slice.edges], tags: [] }, 'json')) text += chunk
    return [{ name: `${name}.ae.json`, text, mime: 'application/json' }]
  }
  if (isGraphFormatId(format)) {
    const f = GRAPH_FORMATS.find((x) => x.id === format)!
    return f.write({ nodes: ctx.slice.nodes, edges: ctx.slice.edges, positions: ctx.positions, styles: ctx.styles, registry: ctx.registry, name })
  }
  throw new Error(`Unknown export format ${format}`)
}

export function downloadFiles(files: ExportFile[]) {
  for (const f of files) downloadText(f.name, f.text, f.mime)
}

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
