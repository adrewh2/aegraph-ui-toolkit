import { slugify } from '../../lib/markdown'
import { DOC_GROUPS, DOC_PAGES, docPage, type DocPage } from './pages'

/**
 * The documentation as the assistant reads it: which page a path shows,
 * a page split into its sections, and a search across all of them. Pure
 * text over the Markdown sources — the same pages the Documentation view
 * renders — so what the assistant quotes is what the user is reading.
 */

/** The docs page a route or pane path shows, if it is one (`/docs/about`, `/docs/about#the-model`, `/model`). */
export function docPageAt(path: string): { page: DocPage; section?: string } | undefined {
  const m = /^\/docs\/([^/?#]+)(?:\?[^#]*)?(?:#(.*))?$/.exec(path)
  if (m) {
    const page = docPage(m[1])
    return page ? { page, section: m[2] || undefined } : undefined
  }
  if (/^\/model(?:[?#]|$)/.test(path)) return { page: docPage('model')!, section: undefined }
  return undefined
}

export interface DocSection {
  /** The heading's anchor (`#the-model`); the page's own title for the lead. */
  id: string
  title: string
  level: number
  /** The section's Markdown, heading line excluded. */
  text: string
}

/** A page split at its headings; the text before the first h2 is the lead, titled as the page. */
export function sectionsOf(page: DocPage): DocSection[] {
  const out: DocSection[] = []
  let current: DocSection = { id: '', title: page.title, level: 1, text: '' }
  let fence = false
  for (const line of page.source.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const h = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h && h[1].length === 1 && !current.text.trim() && !out.length) continue // the h1 is the page title
    if (h && h[1].length > 1) {
      out.push(current)
      current = { id: slugify(h[2]), title: h[2], level: h[1].length, text: '' }
      continue
    }
    current.text += line + '\n'
  }
  out.push(current)
  return out.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text || s.id)
}

/** The page list as the assistant sees it: groups in reading order, each page with its id, title and blurb. */
export function docsCatalog() {
  return DOC_GROUPS.map((g) => ({ group: g.title, pages: g.pages.map((p) => ({ id: p.id, title: p.title, blurb: p.blurb ?? '', ...(p.component ? { live: true } : {}), sections: sectionsOf(p).filter((s) => s.id).map((s) => s.id) })) }))
}

/** A page, or one section of it; undefined for an unknown page. */
export function readDoc(id: string, section?: string): { page: DocPage; title: string; text: string; sections: string[]; section?: string; note?: string } | undefined {
  const page = docPage(id)
  if (!page) return undefined
  const sections = sectionsOf(page)
  const ids = sections.filter((s) => s.id).map((s) => s.id)
  if (page.component) return { page, title: page.title, text: '', sections: [], note: 'This page is rendered live from the workspace rather than written: the registered types, their fields and categories. list_entity_types is the same information as data.' }
  const note = page.generated === 'tools' ? 'The page ends with a tool reference generated from the tool manifest — the same tools you have, so it is not repeated here.' : undefined
  if (section) {
    const want = section.replace(/^#/, '').toLowerCase()
    const s = sections.find((x) => x.id === want) ?? sections.find((x) => x.title.toLowerCase() === want) ?? sections.find((x) => x.id.includes(want))
    if (!s) return { page, title: page.title, text: '', sections: ids, note: `No section "${section}" on this page.` }
    return { page, title: `${page.title} › ${s.title}`, text: s.text, sections: ids, section: s.id, note }
  }
  return { page, title: page.title, text: page.source.replace(/^#\s+.*\n+/, '').trim(), sections: ids, note }
}

export interface DocHit {
  id: string
  title: string
  section: string
  sectionTitle: string
  /** A few lines around the first match, terms intact. */
  excerpt: string
  score: number
}

/** Sections containing every term of the query, best first: matches in a title count for more; ties keep reading order. */
export function searchDocs(query: string, limit = 8): DocHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const hits: DocHit[] = []
  DOC_PAGES.forEach((page, pi) => {
    sectionsOf(page).forEach((s, si) => {
      const hay = `${page.title}\n${s.title}\n${s.text}`.toLowerCase()
      if (!terms.every((t) => hay.includes(t))) return
      const titled = terms.filter((t) => `${page.title} ${s.title}`.toLowerCase().includes(t)).length
      const count = terms.reduce((n, t) => n + hay.split(t).length - 1, 0)
      const lines = s.text.split('\n')
      const at = Math.max(0, lines.findIndex((l) => terms.some((t) => l.toLowerCase().includes(t))))
      const excerpt = lines.slice(Math.max(0, at - 1), at + 3).join('\n').slice(0, 600)
      hits.push({ id: page.id, title: page.title, section: s.id, sectionTitle: s.title, excerpt, score: titled * 10 + count - (pi * 20 + si) / 1000 })
    })
  })
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}
