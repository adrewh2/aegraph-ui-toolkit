/**
 * What a figure from data may ask Plotly to do. A script's figure, a chart's
 * stored layout, a run kept in this browser — all are drawn by Plotly in the
 * app's own page, where the Content-Security-Policy lets an image or a fetch
 * reach any https host. Plotly loads what a figure names: a layout image's
 * `source`, an image trace's `source`, a map's style, its layers' sources,
 * sprites, glyphs and tiles. A URL there is a request from this page, and
 * the URL can carry the data the script just read. And Plotly's text is a
 * little HTML — `<span style="…">` passes its style through untouched, so
 * `filter:url(https://…)` in a label is a request too.
 *
 * So a figure is cleaned before it is drawn: a URL anywhere Plotly could
 * fetch it goes unless it is a `data:` image; a map keeps only a named style
 * that needs no fetch of the figure's choosing, and only GeoJSON layers it
 * carries itself; and every string's markup is rebuilt from a short list of
 * tags, with only plain colours and font settings in a style. Text is
 * checked one string at a time and placeholders (`%{customdata}`) are kept
 * out of tags, so a template cannot assemble a tag from innocent pieces.
 *
 * Unchanged parts keep their identity: a figure with nothing to clean comes
 * back as the same objects, so a chart of a hundred thousand points is not
 * copied to be checked.
 */

/** Keys whose string value Plotly (or the map library under it) may fetch. */
const URL_KEYS = new Set(['source', 'src', 'url', 'urls', 'href', 'tiles', 'sprite', 'glyphs', 'style', 'sourceattribution', 'tileurl', 'topojsonurl'])
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
/** Map subplots: `mapbox`, `mapbox2`, `map`, `map3`, … */
const MAP_KEY = /^(?:mapbox|map)\d*$/
/** Styles a map can be given by name, none of them a fetch the figure chooses. White-bg needs nothing at all. */
const SAFE_MAP_STYLES = new Set(['white-bg', 'open-street-map', 'carto-positron', 'carto-darkmatter', 'carto-voyager', 'carto-positron-nolabels', 'carto-darkmatter-nolabels', 'carto-voyager-nolabels', 'basic', 'streets', 'outdoors', 'light', 'dark', 'satellite', 'satellite-streets'])
const MAX_DEPTH = 64

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A data: image, the one URL a figure may carry where Plotly fetches. */
export const isDataImage = (s: string) => /^\s*data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml)[;,]/i.test(s)

/** Anything that could resolve to a request: a scheme, a protocol-relative or root path, a backslash host. */
const looksFetchable = (s: string) => /^\s*(?:[a-z][a-z0-9+.-]*:|[\\/]{2}|\/|\.\.?\/)/i.test(s) || /\{[xyz]\}/i.test(s)

/** Tags Plotly understands in text, rebuilt without attributes (a and span are handled apart). */
const PLAIN_TAGS = new Set(['b', 'i', 'em', 'strong', 's', 'u', 'sup', 'sub', 'br'])
const SAFE_STYLE_PROPS = new Set(['color', 'font-size', 'font-weight', 'font-style', 'font-family', 'font-variant', 'text-decoration', 'opacity'])
// A value of words, numbers, #hex, %, commas, quotes for a family name, and rgb()/hsl() — nothing else that can call or escape.
const SAFE_STYLE_VALUE = /^(?:[#\w\s.,%'-]|(?:rgba?|hsla?)\([\d\s.,%]*\))*$/i

function safeStyle(css: string): string {
  const kept: string[] = []
  for (const decl of css.split(';')) {
    const at = decl.indexOf(':')
    if (at < 0) continue
    const prop = decl.slice(0, at).trim().toLowerCase()
    const value = decl.slice(at + 1).trim()
    if (!SAFE_STYLE_PROPS.has(prop) || !value || value.includes('%{') || !SAFE_STYLE_VALUE.test(value)) continue
    kept.push(`${prop}:${value}`)
  }
  return kept.join(';')
}

const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  return m ? (m[1] ?? m[2]) : undefined
}

/**
 * Text as Plotly will read it, with only markup that cannot load anything: the plain tags bare, a span with its safe
 * declarations, a link to http(s) only. Any other `<` is written as `&lt;` (Plotly shows it as the character, after
 * it has looked for tags), so no tag can be finished by a later piece of text.
 */
export function sanitizeFigureText(s: string): string {
  if (!s.includes('<')) return s
  let out = ''
  let i = 0
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      out += s.slice(i)
      break
    }
    out += s.slice(i, lt)
    const gt = s.indexOf('>', lt)
    const m = gt < 0 ? null : /^<(\/?)([a-z]+)((?:\s[^<>]*)?)\/?>$/i.exec(s.slice(lt, gt + 1))
    const name = m?.[2].toLowerCase()
    let tag: string | null = null
    if (m && name && !m[3].includes('%{')) {
      const closing = m[1] === '/'
      if (PLAIN_TAGS.has(name)) tag = closing ? `</${name}>` : `<${name}>`
      else if (name === 'span') {
        if (closing) tag = '</span>'
        else {
          const style = safeStyle(attr(m[3], 'style') ?? '')
          tag = style ? `<span style="${style}">` : '<span>'
        }
      } else if (name === 'a') {
        if (closing) tag = '</a>'
        else {
          const href = attr(m[3], 'href')?.trim()
          tag = href && /^https?:\/\/[^\s"'<>\\]+$/i.test(href) ? `<a href="${href}">` : '<a>'
        }
      }
    }
    if (tag && gt >= 0) {
      out += tag
      i = gt + 1
    } else {
      out += '&lt;'
      i = lt + 1
    }
  }
  return out
}

interface Walk {
  dropped: Set<string>
  nodes: number
}

const NODE_CAP = 2_000_000

function clean(v: unknown, key: string, path: string, depth: number, w: Walk, inMap: boolean): unknown {
  if (++w.nodes > NODE_CAP) throw new Error('The figure is too large to draw (over two million values).')
  if (typeof v === 'string') {
    if (URL_KEYS.has(key.toLowerCase()) || inMap) {
      if (inMap && key === 'style') return SAFE_MAP_STYLES.has(v) ? v : (w.dropped.add(path), undefined)
      if (looksFetchable(v) && !isDataImage(v)) return w.dropped.add(path), undefined
    }
    return sanitizeFigureText(v)
  }
  if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' ? undefined : v
  if (depth > MAX_DEPTH) return w.dropped.add(path), undefined
  if (Array.isArray(v)) {
    // Plain number arrays are most of a figure: checked in one pass, never copied.
    let out: unknown[] | null = null
    for (let i = 0; i < v.length; i++) {
      const x = v[i]
      if (typeof x === 'number' || typeof x === 'boolean' || x === null) {
        if (out) out.push(x)
        continue
      }
      const c = clean(x, key, `${path}[${i}]`, depth + 1, w, inMap)
      if (c !== x && !out) out = v.slice(0, i)
      if (out) out.push(c === undefined ? null : c)
    }
    return out ?? v
  }
  const o = v as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const k of Object.keys(o)) {
    const x = o[k]
    const p = path ? `${path}.${k}` : k
    let c: unknown
    if (FORBIDDEN_KEYS.has(k)) c = undefined
    else if (k === 'accesstoken') c = (w.dropped.add(p), undefined)
    // A map's style as an object (a whole style document, with sources, sprite, glyphs) is a fetch list: a name or nothing.
    else if ((inMap || MAP_KEY.test(k)) && k === 'style' && typeof x !== 'string') c = (w.dropped.add(p), undefined)
    else if (k === 'layers' && inMap) c = mapLayers(x, p, depth, w)
    else c = clean(x, k, p, depth + 1, w, inMap || MAP_KEY.test(k))
    if (c !== x && !out) {
      out = {}
      for (const k2 of Object.keys(o)) {
        if (k2 === k) break
        out[k2] = o[k2]
      }
    }
    if (out && c !== undefined) out[k] = c
  }
  return out ?? o
}

/** A map's layers: GeoJSON carried in the figure stays; a layer that names a URL (raster, vector, a GeoJSON link) goes. */
function mapLayers(v: unknown, path: string, depth: number, w: Walk): unknown {
  if (!Array.isArray(v)) return w.dropped.add(path), undefined
  const kept = v.filter((l, i) => {
    const ok = isObj(l) && (l.sourcetype === undefined || l.sourcetype === 'geojson') && isObj(l.source)
    if (!ok) w.dropped.add(`${path}[${i}]`)
    return ok
  })
  return kept.map((l, i) => clean(l, 'layers', `${path}[${i}]`, depth + 1, w, true))
}

/** Traces: an image trace keeps `source` only as a data: image (its `z` still draws). */
function cleanTraces(data: unknown[], w: Walk): Record<string, unknown>[] {
  const out = clean(data, 'data', 'data', 0, w, false) as unknown[]
  return out.filter(isObj)
}

export interface CleanFigure {
  data: Record<string, unknown>[]
  layout: Record<string, unknown>
  /** Paths that were removed (a URL Plotly would have fetched, a map style document, …). */
  dropped: string[]
}

/**
 * A figure safe to hand to Plotly in the app's page. Layout images go unless their source is a data: image; maps keep
 * a named style and their own GeoJSON; markup in text is rebuilt (see `sanitizeFigureText`). Returns the same arrays
 * and objects where nothing changed.
 */
export function sanitizeFigure(data: unknown[], layout: unknown): CleanFigure {
  const w: Walk = { dropped: new Set(), nodes: 0 }
  const traces = cleanTraces(Array.isArray(data) ? data : [], w)
  const lay = isObj(layout) ? ((clean(layout, 'layout', 'layout', 0, w, false) as Record<string, unknown> | undefined) ?? {}) : {}
  return { data: traces, layout: lay, dropped: [...w.dropped] }
}
