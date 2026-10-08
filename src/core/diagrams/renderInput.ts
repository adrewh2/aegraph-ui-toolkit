import { cssFetches } from './sanitizeSvg'

/**
 * What a diagram's source may ask of the renderer, checked before it is rendered.
 *
 * The rendered picture is rebuilt from an allow-list (`sanitizeSvg.ts`) and drawn as an image, but some things
 * happen before there is a picture to clean, or are cheaper to refuse at the source:
 *
 * - **Graphviz** writes `fontname` (and `labelfontname`, and an HTML label's `<FONT FACE>`) into the SVG's
 *   `font-family` without escaping it, and `stylesheet` into an `<?xml-stylesheet?>`, so a font name with a quote
 *   in it closes the attribute and writes markup of its own. No font is called that: a source that tries is
 *   refused.
 * - **Mermaid** fetches an image shape's picture (`A@{ img: "https://…" }`) with `new Image()` while it lays the
 *   diagram out — a request to someone else's server the moment the diagram is looked at — and puts a diagram's
 *   own CSS (`%%{init: {"themeCSS": …}}%%`, `classDef … fill:url(…)`) into a stylesheet that is live in the page
 *   while it renders. Directives are taken off the source, an image shape is refused, and so is a style that
 *   loads something. `MERMAID_SECURE_KEYS` are the settings no diagram may change, whatever is left.
 */

/** Settings a Mermaid diagram may not set for itself (front matter, a directive): Mermaid's own list and everything that is CSS or decides what is HTML. */
export const MERMAID_SECURE_KEYS = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'dompurifyConfig', 'htmlLabels', 'arrowMarkerAbsolute']

/** Where a DOT source names something Graphviz writes unescaped. */
const DOT_FONT_ATTR = /"?\b(fontname|labelfontname|stylesheet)"?\s*=\s*/gi
/** A font name, as nothing but a font name: no quote, angle bracket or reference that could end the attribute it is written into. */
const UNSAFE_FONT = /["<>&]|\\"/

/** Read a DOT value at `i`: a quoted string (with `+` concatenation), an HTML string, or a bare ID. Returns its text as written. */
function dotValue(src: string, i: number): string {
  if (src[i] === '<') {
    let depth = 0
    let j = i
    for (; j < src.length; j++) {
      if (src[j] === '<') depth++
      else if (src[j] === '>' && --depth === 0) break
    }
    return src.slice(i, j + 1)
  }
  if (src[i] === '"') {
    let out = ''
    let j = i
    for (;;) {
      let k = j + 1
      while (k < src.length && src[k] !== '"') k += src[k] === '\\' ? 2 : 1
      out += src.slice(j + 1, k)
      const more = /^\s*\+\s*"/.exec(src.slice(k + 1, k + 200))
      if (!more) return out
      j = k + more[0].length
    }
  }
  return /^[^\s,;\]{}=]*/.exec(src.slice(i))![0]
}

/** Why a DOT source will not be rendered, or null when it may be. */
export function dotSourceIssue(src: string): string | null {
  for (const m of src.matchAll(DOT_FONT_ATTR)) {
    const value = dotValue(src, m.index + m[0].length)
    if (UNSAFE_FONT.test(value)) return `This diagram's ${m[1].toLowerCase()} has a quote or an angle bracket in it, which Graphviz would write into the picture as markup, so it is not being rendered.`
  }
  for (const m of src.matchAll(/\bface\s*=\s*("[^"]*"|'[^']*')/gi)) {
    if (/[<>&]/.test(m[1].slice(1, -1))) return "This diagram's <FONT FACE> has markup or a reference in it, which Graphviz would write into the picture as markup, so it is not being rendered."
  }
  return null
}

/** `%%{init: …}%%`, `%%{initialize: …}%%`, `%%{config: …}%%` — a diagram's own settings. */
const MERMAID_DIRECTIVE = /%%\{\s*(?:init|initialize|config)\b[\s\S]*?\}%%/gi
/** A node's shape data (`A@{ shape: …, img: … }`). */
const SHAPE_DATA = /@\{[^}]*\}/g

/**
 * A Mermaid source made ready for the renderer: its directives taken off (`source`), or the reason it is refused
 * (`refused`). Front matter stays — its `config` passes the same `MERMAID_SECURE_KEYS` — but a style anywhere in
 * the source that would fetch something refuses the diagram.
 */
export function prepareMermaid(src: string): { source: string; refused?: string } {
  const source = src.replace(MERMAID_DIRECTIVE, '')
  for (const m of source.matchAll(SHAPE_DATA)) {
    // Keys only: a quoted value (`label: "img: …"`) is text.
    const keys = m[0].slice(1).replace(/:\s*("[^"]*"|'[^']*')/g, ': ""')
    if (/(?:^|[\s{,])["']?img["']?\s*:/i.test(keys)) return { source, refused: 'This diagram has an image shape (`img:`), which loads a picture from another server as soon as it is drawn, so it is not being rendered.' }
  }
  // Line by line, CSS escapes decoded: a style can sit in a `classDef`, a `style`, a C4 `UpdateElementStyle`, front
  // matter — anywhere a value reaches a stylesheet — so any line that would fetch is enough.
  for (const line of source.split('\n')) {
    if (cssFetches(line)) return { source, refused: 'This diagram has a style that loads something from elsewhere (`url(…)`, `@import`, `image-set`), so it is not being rendered.' }
  }
  return { source }
}
