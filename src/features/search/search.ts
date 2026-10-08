import { displayLabel } from '../../core/entity/entity'
import { matchesTerms, searchTerms, searchTextOf, type EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { isRelationship, type AnyEntity } from '../../core/entity/types'
import { SCHEMA_TYPE } from '../../core/entity/categories'

/**
 * The search behind ⌘K, as data: for a query, the entities that match with
 * *where* each one matched — its name, a tag, its description, or the text
 * it carries — and for a text match, a snippet around the first hit so a
 * document is recognised by the line that answered, not just its title.
 * The same terms as the store's query (every word; "quoted phrases"), so
 * the palette's count is the Entities table's count.
 */

export type Where = 'label' | 'tag' | 'description' | 'content' | 'other'

export interface EntityHit {
  entity: AnyEntity
  where: Where
  /** For a content hit: the data field the text was found in (`content`, `text`, `address.city`). */
  field?: string
  /** For a content hit: the text around the first term, with the match marked. */
  snippet?: Snippet
  /** Lower is better. */
  rank: number
}

/** A run of text with the matched stretches marked, ready to render. */
export type Snippet = { before: string; match: string; after: string }

export interface SearchResult {
  terms: string[]
  /** Name, tag and description matches: entities the user would know by name. */
  entities: EntityHit[]
  /** Matches inside the text an entity carries — a document's body, a transcript, a page's text. */
  content: EntityHit[]
  /** How many matched in all (the Entities table shows every one). */
  total: number
  /** The scan stopped at the time budget: `total` is a lower bound. */
  partial: boolean
}

const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 90

/** Walk the data for string fields, longest first, so a document's body outranks its title field. */
function textFields(data: Record<string, unknown>, prefix = '', out: { field: string; text: string }[] = [], depth = 0): { field: string; text: string }[] {
  if (depth > 3) return out
  for (const [k, v] of Object.entries(data)) {
    const field = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') {
      if (v.length >= 3 && !v.startsWith('data:')) out.push({ field, text: v })
    } else if (Array.isArray(v)) {
      const strings = v.filter((x): x is string => typeof x === 'string')
      if (strings.length) out.push({ field, text: strings.join(' · ') })
      for (const x of v.slice(0, 50)) if (x && typeof x === 'object' && !Array.isArray(x)) textFields(x as Record<string, unknown>, field, out, depth + 1)
    } else if (v && typeof v === 'object') textFields(v as Record<string, unknown>, field, out, depth + 1)
  }
  return out
}

/** The snippet around the first term found in `text`, on the line it sits in. */
export function snippetOf(text: string, terms: string[]): Snippet | undefined {
  const lower = text.toLowerCase()
  let at = -1
  let term = ''
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) (at = i), (term = t)
  }
  if (at < 0) return undefined
  const lineStart = lower.lastIndexOf('\n', at) + 1
  const lineEndRaw = lower.indexOf('\n', at + term.length)
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw
  const start = Math.max(lineStart, at - SNIPPET_BEFORE)
  const end = Math.min(lineEnd, at + term.length + SNIPPET_AFTER)
  const clean = (s: string) => s.replace(/\s+/g, ' ')
  return { before: (start > lineStart ? '…' : '') + clean(text.slice(start, at)), match: text.slice(at, at + term.length), after: clean(text.slice(at + term.length, end)) + (end < lineEnd ? '…' : '') }
}

/** Where an entity matched the terms, and a snippet when it was in the text it carries. */
export function classify(e: AnyEntity, terms: string[]): { where: Where; field?: string; snippet?: Snippet } {
  const label = displayLabel(e).toLowerCase()
  if (terms.every((t) => label.includes(t))) return { where: 'label' }
  const tags = e.tags.join('\n').toLowerCase()
  if (terms.every((t) => tags.includes(t))) return { where: 'tag' }
  const desc = (e.description ?? '').toLowerCase()
  if (terms.every((t) => desc.includes(t))) return { where: 'description' }
  // The text: the field where the most terms occur, the longest first.
  const fields = textFields(e.data).sort((a, b) => b.text.length - a.text.length)
  let best: { field: string; text: string; hits: number } | undefined
  for (const f of fields) {
    const lower = f.text.toLowerCase()
    const hits = terms.filter((t) => lower.includes(t)).length
    if (hits && (!best || hits > best.hits)) best = { ...f, hits }
    if (best?.hits === terms.length) break
  }
  if (best) return { where: 'content', field: best.field, snippet: snippetOf(best.text, terms) }
  return { where: 'other' } // id, type name, or terms split across fields
}

/**
 * Search the store as the palette does. Name-ish hits come back in
 * `entities`, text hits in `content`, both best first; `total` counts every
 * match. The scan stops after `budgetMs` (a very large Library on a slow
 * keystroke) and says so.
 */
export function searchEntities(store: EntityStore, registry: TypeRegistry, query: string, opts: { limit?: number; budgetMs?: number; now?: () => number } = {}): SearchResult {
  const terms = searchTerms(query) ?? []
  if (!terms.length) return { terms, entities: [], content: [], total: 0, partial: false }
  const limit = opts.limit ?? 8
  const budget = opts.budgetMs ?? 40
  const now = opts.now ?? (() => performance.now())
  const t0 = now()
  const entities: EntityHit[] = []
  const content: EntityHit[] = []
  let total = 0
  let partial = false
  let scanned = 0
  const first = terms[0]
  // `all()` is the scope's entities and relationships, cached by the store.
  for (const e of store.all()) {
    if (++scanned % 64 === 0 && now() - t0 > budget) {
      partial = true
      break
    }
    if (e.type === SCHEMA_TYPE) continue
    if (!matchesTerms(searchTextOf(e), terms)) continue
    total++
    const c = classify(e, terms)
    const label = displayLabel(e).toLowerCase()
    const category = registry.categoryOf(e.type)
    // Name hits first, a name that starts with the query before one that contains it; the user's own material before saved views; relationships last.
    const rank = (c.where === 'label' ? (label.startsWith(first) ? 0 : 1) : c.where === 'tag' ? 2 : c.where === 'description' ? 3 : c.where === 'content' ? 4 : 5) + (category === 'project' ? 10 : 0) + (isRelationship(e) ? 20 : 0)
    const hit: EntityHit = { entity: e, rank, ...c }
    const list = c.where === 'content' ? content : entities
    // Keep the best `limit` of each without holding every hit: insert in rank order, drop the tail.
    let i = list.length
    while (i > 0 && list[i - 1].rank > rank) i--
    if (i < limit) {
      list.splice(i, 0, hit)
      if (list.length > limit) list.pop()
    }
  }
  return { terms, entities, content, total, partial }
}
