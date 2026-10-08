import { requireExternalServices } from '../account/settings'
import { httpUrl } from '../../core/resources/types'
import type { GeoEntity } from './maps'
import type { WikiPreview } from './wikipedia'

/**
 * What the hover card fetches on demand: more pictures of a place from its
 * Wikipedia article (Wikimedia Commons, no key), cached for the session so a
 * second hover is instant. Nothing is stored on the entity.
 */

const galleries = new Map<string, Promise<string[]>>()

/** Files that are chrome rather than pictures of the place: flags, icons, maps, logos, the wiki's own furniture. */
const NOT_A_PHOTO = /flag|icon|logo|symbol|pictogram|wiki|commons|edit|disambig|question|star|map[_ -]|_map|locator|seal|emblem|coat[_ ]of[_ ]arms|arrow|speaker|sound|nuvola|crystal|ambox|padlock|OOjs|\.svg$|\.gif$/i

/** Picture URLs (~640 px wide) from the article's image list, the lead image first when it is among them. */
export function fetchWikiGallery(preview: WikiPreview, limit = 12): Promise<string[]> {
  const key = `${preview.lang}:${preview.title}`
  let p = galleries.get(key)
  if (!p) {
    p = (async () => {
      const params = new URLSearchParams({ format: 'json', origin: '*', action: 'query', generator: 'images', titles: preview.title, gimlimit: '40', prop: 'imageinfo', iiprop: 'url|mime|size', iiurlwidth: '640', redirects: '1' })
      requireExternalServices('The picture gallery')
      const r = await fetch(`https://${preview.lang}.wikipedia.org/w/api.php?${params}`, { headers: { Accept: 'application/json' } })
      if (!r.ok) throw new Error(`Wikipedia ${r.status}`)
      const j = (await r.json()) as { query?: { pages?: Record<string, { title: string; imageinfo?: { thumburl?: string; url?: string; mime?: string; width?: number; height?: number }[] }> } }
      const out: string[] = []
      for (const pg of Object.values(j.query?.pages ?? {})) {
        const info = pg.imageinfo?.[0]
        if (!info || !/^image\/(jpeg|png|webp)$/.test(info.mime ?? '') || NOT_A_PHOTO.test(pg.title)) continue
        // Tiny files are icons whatever their name; very tall ones are charts and scans.
        if ((info.width ?? 0) < 200 || (info.height ?? 0) < 150 || (info.height ?? 0) > (info.width ?? 1) * 2) continue
        const url = info.thumburl ?? info.url
        if (url) out.push(url)
      }
      return out.slice(0, limit)
    })().catch(() => [] as string[])
    galleries.set(key, p)
  }
  return p
}

/** Where to read more: the article, else the place's own link, else a web search for it. */
export function readMoreUrl(e: GeoEntity, preview: WikiPreview | undefined): { href: string; label: string } {
  // A stored preview is data like any other (a bundle can carry one): its link is followed only when it is http(s), and
  // called Wikipedia only when it is on wikipedia.org — otherwise it is the place's plain link, named by what it is.
  const wiki = httpUrl(preview?.url)
  if (wiki && isWikipedia(wiki)) return { href: wiki, label: 'Wikipedia' }
  const own = httpUrl(e.data.url) ?? wiki
  if (own) return { href: own, label: 'Link' }
  const q = [e.label, e.data.address].filter(Boolean).join(' ')
  return { href: `https://www.google.com/search?q=${encodeURIComponent(q || `${e.data.lat}, ${e.data.lng}`)}`, label: 'Search' }
}

const isWikipedia = (url: string) => {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && (u.hostname === 'wikipedia.org' || u.hostname.endsWith('.wikipedia.org'))
  } catch {
    return false
  }
}
