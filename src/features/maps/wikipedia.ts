import type { EntityStore } from '../../core/entity/store'
import { isRelationship } from '../../core/entity/types'
import { distanceM, type GeoEntity, type LatLng } from './maps'
import { requireExternalServices } from '../account/settings'

/**
 * Rich previews for what is on the map — a photo and a paragraph — from
 * Wikipedia (free, no key, CORS-friendly). Stored on the entity as
 * `data.preview` so it travels with the data and is fetched once.
 */
/** A photo and a paragraph about a location, from Wikipedia (free, no key): the rich card behind a pin. */
export interface WikiPreview {
  title: string
  extract?: string
  /** The article's lead image as Wikimedia serves it (~320 px wide; other widths are not guaranteed to exist). */
  image?: string
  /** The full-size image, for a detail view. */
  imageLarge?: string
  url: string
  source: 'wikipedia'
  lang: string
  fetchedAt: string
}

export const wikiPreviewOf = (e: GeoEntity): WikiPreview | undefined => (e.data.preview && typeof e.data.preview === 'object' ? (e.data.preview as WikiPreview) : undefined)

// Wikimedia asks callers to identify themselves (browsers can set Api-User-Agent) and throttles bursts: one retry after a pause on 429.
// Browsers drop the User-Agent entry (theirs goes instead); node keeps it, and Wikimedia throttles anonymous scripts.
const HEADERS = { Accept: 'application/json', 'Api-User-Agent': 'aegraph-ui/1.0 (map previews)', 'User-Agent': 'aegraph-ui/1.0 (map previews)' }
async function polite(url: string): Promise<Response> {
  requireExternalServices('Wikipedia enrichment')
  // A breath between requests keeps a batch under Wikimedia's rate limit; when it throttles anyway, wait it out rather
  // than skip — a skipped lookup would let a worse article win.
  await new Promise((res) => setTimeout(res, 300))
  let r = await fetch(url, { headers: HEADERS })
  for (const wait of [4000, 10000, 20000, 30000]) {
    if (r.status !== 429) break
    await new Promise((res) => setTimeout(res, wait))
    r = await fetch(url, { headers: HEADERS })
  }
  if (r.status === 429) throw new Error('Wikipedia is throttling requests; try again in a minute.')
  return r
}
const wikiApi = (lang: string, params: Record<string, string>) => polite(`https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Wikipedia ${r.status}`))))

interface WikiPage {
  title: string
  extract?: string
  thumbnail?: { source: string; width: number; height: number }
  original?: { source: string }
  coordinates?: { lat: number; lon: number }[]
  pageprops?: { disambiguation?: string }
  missing?: string
}
/** Lead image, coordinates and disambiguation flag for several titles in one request. (Asked together with extracts the API pages the answer and drops the coordinates.) */
async function wikiPages(titles: string[], lang: string): Promise<WikiPage[]> {
  if (!titles.length) return []
  const j = (await wikiApi(lang, { action: 'query', prop: 'pageimages|coordinates|pageprops', titles: titles.slice(0, 20).join('|'), piprop: 'thumbnail|original', pithumbsize: '320', colimit: '20', coprimary: 'all', ppprop: 'disambiguation', redirects: '1' })) as { query?: { pages?: Record<string, WikiPage> } }
  return Object.values(j.query?.pages ?? {}).filter((p) => !p.missing && !p.pageprops?.disambiguation)
}
/** The lead paragraph of one article. */
async function wikiExtract(title: string, lang: string): Promise<string | undefined> {
  const j = (await wikiApi(lang, { action: 'query', prop: 'extracts', titles: title, exintro: '1', explaintext: '1', redirects: '1' })) as { query?: { pages?: Record<string, WikiPage> } }
  return Object.values(j.query?.pages ?? {})[0]?.extract?.trim() || undefined
}

/** The words of a name (all of them: “Tower”, “Headquarters”, “Bridge” tell articles apart). */
const tokens = (s: string) => s.toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9\u4e00-\u9fff]+/).filter((w) => w.length > 1 && !STOP.has(w))
const STOP = new Set(['the', 'and', 'of', 'in', 'at', 'to', 'de', 'la'])
const same = (w: string, x: string) => x === w || (w.length > 3 && x.startsWith(w)) || (x.length > 3 && w.startsWith(x))
/** How much of the name the title carries, and how much of the title is the name: 1.5 for the same words, less for a broader or narrower title. */
const overlap = (name: string, title: string) => {
  const ta = [...new Set(tokens(name))]
  const tb = [...new Set(tokens(title))]
  if (!ta.length || !tb.length) return 0
  const hit = ta.filter((w) => tb.some((x) => same(w, x))).length
  if (!hit) return 0
  return hit / ta.length + (0.5 * tb.filter((x) => ta.some((w) => same(w, x))).length) / tb.length
}
const shares = (name: string, title: string) => overlap(name, title) >= 0.5
/** The names to try for a label: the whole thing, then each part around “—”, “&”, “,” and “:”, then a parenthetical on its own. */
function candidates(label: string, split: boolean): string[] {
  const out: string[] = []
  const push = (v: string) => {
    const t = v.replace(/\s+/g, ' ').trim()
    if (t.length > 2 && !out.includes(t)) out.push(t)
  }
  push(label.replace(/\s*\(.*?\)\s*/g, ' '))
  for (const m of label.matchAll(/\(([^)]+)\)/g)) push(m[1])
  // A point's label may name several things (“Opera House & Canton Tower”); a route's or a region's is one name — an en dash is part of it.
  if (split) for (const part of label.split(/\s*(?:—|&|,|:|→)\s*/)) push(part.replace(/\s*\(.*?\)\s*/g, ' '))
  return out
}

/**
 * The Wikipedia article for a place: by name first — the article must sit
 * within `maxKm` of the point when it has coordinates, and its title must
 * share a word with the name — then, for a point only, whatever article is
 * nearest and shares a word. Undefined when nothing fits: better no card
 * than the wrong one.
 */
export async function fetchWikiPreview(p: LatLng, label: string | undefined, opts: { lang?: string; maxKm?: number; radiusM?: number; pointOnly?: boolean } = {}): Promise<WikiPreview | undefined> {
  const lang = opts.lang ?? 'en'
  const maxM = (opts.maxKm ?? 12) * 1000
  const done = (pg: WikiPage): WikiPreview => ({ title: pg.title, extract: pg.extract, image: pg.thumbnail?.source, imageLarge: pg.original?.source, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(pg.title.replace(/ /g, '_'))}`, source: 'wikipedia', lang, fetchedAt: new Date().toISOString() })
  const near = (pg: WikiPage) => {
    const c = pg.coordinates?.[0]
    return c ? distanceM(p, { lat: c.lat, lng: c.lon }) <= maxM : undefined
  }
  // Every name the label suggests is searched; the hit that carries most of its name wins (“Guangzhou Opera House” over
  // “Guangzhou”; the shorter title on a tie, so not “… station”), and it must sit near the point. A place has coordinates;
  // an article without them is a person, a company, a thing — a region or a route may lack them when the title is the name.
  const hits = new Map<string, number>()
  for (const name of label ? candidates(label, opts.pointOnly !== false) : []) {
    const found = (await wikiApi(lang, { action: 'query', list: 'search', srsearch: name.replace(/[’‘]/g, "'"), srlimit: '5' })) as { query?: { search?: { title: string }[] } }
    for (const h of found?.query?.search ?? []) {
      const score = overlap(name, h.title)
      if (score >= 0.5) hits.set(h.title, Math.max(hits.get(h.title) ?? -Infinity, score))
    }
  }
  const ranked = [...hits].sort((x, y) => y[1] - x[1] || x[0].length - y[0].length).slice(0, 6)
  const pages = await wikiPages(ranked.map(([t]) => t), lang)
  // An article placed near the point beats any without coordinates, whatever the score: a place is a place. One without
  // coordinates is taken only when the title all but is the name (and the name is not a short word that could be anyone's).
  const placed = (pg: WikiPage | undefined) => (pg ? near(pg) : undefined)
  const found = ranked
    .map(([title, score]) => ({ score, pg: pages.find((x) => x.title === title) ?? pages.find((x) => x.title.toLowerCase() === title.toLowerCase()) }))
    .filter((c): c is { score: number; pg: WikiPage } => !!c.pg && placed(c.pg) !== false)
    .sort((x, y) => Number(placed(y.pg) === true) - Number(placed(x.pg) === true) || y.score - x.score)
  for (const { pg, score } of found) {
    if (placed(pg) === undefined && (score < 1.25 || tokens(pg.title).join('').length < 6)) continue
    return done({ ...pg, extract: await wikiExtract(pg.title, lang) })
  }
  if (opts.pointOnly === false) return undefined
  const geo = (await wikiApi(lang, { action: 'query', list: 'geosearch', gscoord: `${p.lat}|${p.lng}`, gsradius: String(opts.radiusM ?? 300), gslimit: '5' })) as { query?: { geosearch?: { title: string }[] } }
  const nearby = (geo?.query?.geosearch ?? []).filter((h) => !label || shares(label, h.title)).map((h) => h.title)
  for (const pg of await wikiPages(nearby, lang)) return done({ ...pg, extract: await wikiExtract(pg.title, lang) })
  return undefined
}

/** Fetch and store a preview on a location / path / area. Returns it, or undefined when nothing was found. */
export async function enrichGeo(store: EntityStore, e: GeoEntity, opts: { lang?: string; force?: boolean } = {}): Promise<WikiPreview | undefined> {
  const have = wikiPreviewOf(e)
  // Previews fetched before bdab51a asked Wikimedia for a width it does not render (a broken image): fetch those again.
  if (have && !opts.force && !/\/480px-/.test(have.image ?? '')) return have
  // A path or an area is only ever the article named after it; the article nearest its first point would be something else.
  // A path's point is its start and an area's its centroid, so the article may sit far from it: allow the length of the thing.
  const preview = await fetchWikiPreview({ lat: e.data.lat, lng: e.data.lng }, e.label, { lang: opts.lang, pointOnly: e.type === 'location' ? undefined : false, maxKm: e.type === 'path' ? Math.max(20, ((e.data.lengthM as number | undefined) ?? 0) / 1000) : e.type === 'area' ? Math.max(20, Math.sqrt((e.data.areaM2 as number | undefined) ?? 0) / 1000) : 12 })
  const cur = store.get(e.id)
  if (!cur || isRelationship(cur)) return preview
  const data = { ...cur.data }
  if (preview) data.preview = preview
  else delete data.preview
  data.previewCheckedAt = new Date().toISOString()
  // A volatile write: the preview is a cache of what Wikipedia said and the stamp bookkeeping — persisted, and in the
  // next commit, but not a change autosave wakes for, and not one that sends every table and map over a city's
  // worth of entities again (a hover card fetching one preview cost three seconds of that).
  store.update(e.id, { data }, { volatile: true })
  return preview
}
