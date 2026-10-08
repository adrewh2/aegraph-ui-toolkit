/**
 * Reading a fetched web page without a DOM — the same in a tab and in the headless engine, which has no
 * `DOMParser`. What the `web_fetch` tool gives the model: the page as readable text, its title and description,
 * where it links, the scripts it loads, the data files it names, and the JSON it carries inline — enough to find
 * the dataset behind an app page, whose HTML is often an empty shell that its scripts fill from an API.
 *
 * This is text in, text out: nothing here runs, loads or renders anything the page says to.
 */

export interface PageLink {
  href: string
  text: string
}

export interface ReadPage {
  title?: string
  description?: string
  /** The visible text: scripts, styles and markup gone, blocks on their own lines, entities decoded. */
  text: string
  links: PageLink[]
  scripts: string[]
  /** URLs anywhere in the source — attributes, inline scripts, inline JSON — that look like a data file or an API. */
  data: string[]
  /** Inline JSON the page carries for its scripts (`__NEXT_DATA__`, `application/json`, `application/ld+json`). */
  json: { id?: string; type: string; text: string }[]
}

/** A file extension or path that is data rather than a page. */
const DATA_URL = /\.(csv|tsv|json|jsonl|ndjson|geojson|topojson|parquet|arrow|feather|gexf|graphml|gml|cyjs|nt|ttl|nq|trig|rdf|owl|xml|kml|gpx|xlsx?|zip|gz|ae\.json|aeb|sqlite|db)(\?|#|$)|\/api\/|\/graphql\b|\/trpc\//i

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : undefined
}

const absolute = (href: string, base: string): string | undefined => {
  try {
    const u = new URL(href, base)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
  } catch {
    return undefined
  }
}

const squash = (s: string) => s.replace(/[ \t\f\v\r]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()

/** Whether a response is a page to read (HTML), rather than text to hand back as it is. */
export const isHtml = (contentType: string, text: string) => /html|xhtml/i.test(contentType) || (!contentType && /^\s*(<!doctype html|<html)/i.test(text))

/** Whether a content type is text worth reading at all (the rest is described, not read). */
export function isTextual(contentType: string): boolean {
  const t = contentType.toLowerCase().split(';')[0].trim()
  if (!t) return true
  return t.startsWith('text/') || /(json|xml|javascript|ecmascript|csv|turtle|n-triples|n-quads|trig|sparql|x-ndjson|graphml|gexf|geo\+json|x-www-form-urlencoded|yaml|toml|svg)/.test(t)
}

export function readPage(html: string, url: string): ReadPage {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0])
  const meta = (key: string) => metas.find((m) => (attr(m, 'name') ?? attr(m, 'property'))?.toLowerCase() === key)
  const description = attr(meta('description') ?? meta('og:description') ?? '', 'content')

  const json: ReadPage['json'] = []
  const scripts: string[] = []
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const open = `<script ${m[1]}>`
    const src = attr(open, 'src')
    if (src) {
      const a = absolute(src, url)
      if (a && !scripts.includes(a)) scripts.push(a)
      continue
    }
    const type = (attr(open, 'type') ?? '').toLowerCase()
    if (/json/.test(type) && m[2].trim()) json.push({ ...(attr(open, 'id') ? { id: attr(open, 'id') } : {}), type, text: m[2].trim() })
  }

  const links: PageLink[] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${m[1]}>`, 'href')
    const a = href && absolute(href, url)
    if (!a || seen.has(a)) continue
    seen.add(a)
    links.push({ href: a, text: squash(decodeEntities(m[2].replace(/<[^>]+>/g, ' '))).slice(0, 120) })
  }

  // Data: any quoted or attribute URL in the whole source — inline scripts and JSON included — that looks like data.
  const data: string[] = []
  // JSON in a script writes a slash as `\/` or `\u002F`: read those as slashes first, or `https:\/\/…` is missed.
  const unescaped = html.replace(/\\u002F/gi, '/').replace(/\\\//g, '/')
  for (const m of unescaped.matchAll(/["'(=]\s*((?:https?:)?\/\/[^"'()\s<>\\]+|\/[^"'()\s<>\\]+)/g)) {
    const raw = decodeEntities(m[1])
    if (!DATA_URL.test(raw)) continue
    const a = absolute(raw, url)
    if (a && !data.includes(a) && !scripts.includes(a)) data.push(a)
  }

  // The page's own content when it marks it (<main>, else <article>): the navigation, the table of contents and the
  // footer are the same on every page and would fill the first slice the model reads.
  const content = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(html)?.[1] ?? /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(html)?.[1] ?? html
  const body = content
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|h[1-6]|pre|blockquote|figure|figcaption|form|fieldset|details|summary)\b[^>]*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
  return {
    ...(title ? { title: squash(decodeEntities(title)) } : {}),
    ...(description ? { description } : {}),
    text: squash(decodeEntities(body)),
    links,
    scripts,
    data,
    json,
  }
}

export interface Found {
  term: string
  at: number
  snippet: string
}

/**
 * Where each term occurs in a text, case-insensitively, with `context` characters either side — plain substrings, not
 * patterns, so a term the model writes cannot make the search itself run away. At most `limit` matches in all.
 */
export function findIn(text: string, terms: string[], { context = 160, limit = 40 } = {}): Found[] {
  const hay = text.toLowerCase()
  const out: Found[] = []
  for (const term of terms) {
    const needle = term.toLowerCase()
    if (!needle) continue
    for (let at = hay.indexOf(needle); at >= 0 && out.length < limit; at = hay.indexOf(needle, at + needle.length)) {
      out.push({ term, at, snippet: text.slice(Math.max(0, at - context), at + needle.length + context) })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}
