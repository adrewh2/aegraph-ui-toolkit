import { geometryFromGraphvizJson, geometryFromMermaidSvg, geometryToSvg, parseDiagram, type DiagramFormat, type DiagramGeometry, type ParsedDiagram } from '../../core/diagrams'
import { dotSourceIssue, MERMAID_SECURE_KEYS, prepareMermaid } from '../../core/diagrams/renderInput'
import { sanitizeSvg } from '../../core/diagrams/sanitizeSvg'

/**
 * Rendering: Graphviz through @viz-js/viz (wasm) and Mermaid through the
 * mermaid package. Both are heavy and loaded on first use only.
 *
 * A diagram's source is data, and so is what the renderers make of it. The
 * source is checked first (`core/diagrams/renderInput.ts`: a Graphviz font
 * name that would write markup, a Mermaid image shape or style that would
 * fetch, Mermaid's directives), and every picture leaves here rebuilt from an
 * allow-list (`core/diagrams/sanitizeSvg.ts`). The views then draw it as an
 * image (`DiagramPicture`, `svgDataUrl`), never as markup in the page.
 * `renderDiagram` throws when a source is refused or a picture cannot be
 * cleaned, so a caller shows the error it shows for a source that will not
 * parse.
 */

type Viz = { renderString(src: string, opts?: { format?: string; engine?: string }): string }
let vizPromise: Promise<Viz> | null = null
const loadViz = () => (vizPromise ??= import('@viz-js/viz').then((m) => m.instance() as Promise<Viz>))

type Mermaid = { initialize(cfg: object): void; render(id: string, src: string): Promise<{ svg: string }>; parse(src: string): Promise<unknown> }
let mermaidPromise: Promise<Mermaid> | null = null
const loadMermaid = () =>
  (mermaidPromise ??= import('mermaid').then((m) => {
    const mm = m.default as unknown as Mermaid
    // Labels as SVG text, never HTML in a <foreignObject> — the sanitiser removes those, which left every node an
    // empty box. Mermaid 11+ reads the switch at the top level (flowchart.htmlLabels is kept for older versions).
    // A diagram may not change what is CSS or what is HTML (`secure`: front matter and directives cannot set them).
    mm.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict', secure: MERMAID_SECURE_KEYS, fontFamily: 'system-ui, sans-serif', htmlLabels: false, flowchart: { htmlLabels: false } })
    return mm
  }))

let counter = 0

/** The picture, or the reason it is not being shown. Everything `renderDiagram` returns has been through here. */
function safe(svg: string): string {
  const out = sanitizeSvg(svg)
  if (out.refused) {
    console.warn('[diagram] refused:', out.removed.join(', '))
    throw new Error('This diagram renders to a picture that could not be made safe to show (something executable in it, or markup that does not close), so it is not being shown.')
  }
  if (out.removed.length > 0) console.warn('[diagram] removed from the rendered picture:', out.removed.join(', '))
  return out.svg
}

export async function renderDiagram(src: string, format: DiagramFormat, engine = 'dot'): Promise<string> {
  if (!src.trim()) return ''
  if (format === 'excalidraw') {
    // No renderer for Excalidraw: draw the captured geometry as flat vector.
    const d = parseDiagram(src, 'excalidraw')
    return safe(geometryToSvg(d.geometry!, { nodes: Object.fromEntries(d.nodes.map((n) => [n.id, n.label])), edges: Object.fromEntries(d.edges.filter((e) => e.label).map((e) => [e.id, e.label!])), groups: Object.fromEntries(d.groups.map((g) => [g.id, g.label])) }))
  }
  if (format === 'dot') {
    const issue = dotSourceIssue(src)
    if (issue) throw new Error(issue)
    const viz = await loadViz()
    return safe(viz.renderString(src, { format: 'svg', engine }))
  }
  const ready = prepareMermaid(src)
  if (ready.refused) throw new Error(ready.refused)
  const mm = await loadMermaid()
  const id = `mmd-${++counter}-${Date.now()}`
  try {
    const { svg } = await mm.render(id, ready.source)
    return safe(svg)
  } finally {
    // mermaid leaves a scratch element behind on failure.
    document.getElementById('d' + id)?.remove()
  }
}

/**
 * Geometry for a diagram: Excalidraw carries its own; Graphviz comes from
 * the layout engine's JSON output; Mermaid from its rendered SVG.
 */
export async function extractGeometry(src: string, format: DiagramFormat, parsed: ParsedDiagram, engine = 'dot'): Promise<DiagramGeometry> {
  if (format === 'excalidraw') return parsed.geometry ?? parseDiagram(src, 'excalidraw').geometry!
  if (format === 'dot') {
    const issue = dotSourceIssue(src)
    if (issue) throw new Error(issue)
    const viz = await loadViz()
    return geometryFromGraphvizJson(viz.renderString(src, { format: 'json', engine }), parsed)
  }
  const svg = await renderDiagram(src, 'mermaid')
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  return geometryFromMermaidSvg(doc, parsed)
}

export const GRAPHVIZ_ENGINES = ['dot', 'neato', 'fdp', 'sfdp', 'circo', 'twopi', 'osage', 'patchwork'] as const

/** The Graphviz engine a DOT source asks for (`layout=neato`), when it does. */
export const layoutEngine = (source: string) => /\blayout\s*=\s*"?(dot|neato|fdp|sfdp|circo|twopi|osage|patchwork)\b/.exec(source)?.[1] as (typeof GRAPHVIZ_ENGINES)[number] | undefined

/** Turn an SVG string into a PNG data URL (for downloads). */
export function svgToPng(svg: string, scale = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, img.width * scale)
      canvas.height = Math.max(1, img.height * scale)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(scale, scale)
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => (URL.revokeObjectURL(url), reject(new Error('Could not rasterise the SVG')))
    img.src = url
  })
}

/**
 * A rendered picture at its own size. Mermaid draws its SVG responsive — `width="100%"` with a `max-width` in its
 * style — so it takes the width of whatever holds it, and a zoom on the holder is undone by the width (the zoom
 * buttons did nothing once the diagram was as wide as the pane). This gives the root the fixed width and height
 * of its viewBox, as Graphviz's and the Excalidraw geometry's already have. For views that zoom; a thumbnail keeps
 * Mermaid's own sizing to fit its card.
 */
export function atIntrinsicSize(svg: string): string {
  const m = /<svg\b[^>]*>/i.exec(svg)
  if (!m) return svg
  const tag = m[0]
  const vb = /\sviewBox="\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)\s*"/.exec(tag)
  if (!vb || !/\swidth="100%"/.test(tag)) return svg
  const [w, h] = [Number(vb[1]), Number(vb[2])]
  if (!(w > 0 && h > 0)) return svg
  const fixed = tag
    .replace(/\swidth="100%"/, ` width="${w}"`)
    .replace(/\sheight="[^"]*"/, '')
    .replace(/<svg\b/i, `<svg height="${h}"`)
    .replace(/max-width:\s*[\d.]+px;?\s*/, '')
  return svg.slice(0, m.index) + fixed + svg.slice(m.index + tag.length)
}

/**
 * The box a picture's own coordinates span: its `viewBox`, else its width and height from the origin. A picture
 * drawn as an SVG `<image>` over exactly this box keeps its coordinates — what the Scenes page relies on to lay a
 * diagram under a scene.
 */
export function pictureBox(svg: string): { x: number; y: number; width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0]
  if (!tag) return null
  const vb = /\sviewBox="\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)\s*"/.exec(tag)
  if (vb) {
    const [x, y, width, height] = vb.slice(1).map(Number)
    return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : null
  }
  const w = parseFloat(/\swidth="([\d.]+)"/.exec(tag)?.[1] ?? '')
  const h = parseFloat(/\sheight="([\d.]+)"/.exec(tag)?.[1] ?? '')
  return w > 0 && h > 0 ? { x: 0, y: 0, width: w, height: h } : null
}
