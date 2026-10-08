import { displayLabel } from './entity'
import type { EntityStore } from './store'
import { isRelationship, type AnyEntity, type EntityId, type Tag } from './types'

/**
 * What a passage of text has to do with the graph: select words anywhere you read — a document, a PDF, a chat — and
 * ask what in the project they touch. Three answers, each cheap enough for a right-click:
 *
 * - **Named** — entities whose name (or an alias) appears in the text as whole words. The text is cut into every run
 *   of one to six words and each entity's normalised label is looked up in that set: one pass over the project, a
 *   set lookup per entity. A short selection also finds names that contain it ("Ada" → "Ada Lovelace").
 * - **Tags** — tags whose name (or its last segment, `topic:graphs` → `graphs`) appears the same way, with how many
 *   entities carry each.
 * - **Mentioned in** — for a short selection, entities whose own text contains it as a phrase (`store.query`, the
 *   reading the ⌘K box and `search_entities` use).
 *
 * The page's `text_insights` tool and the right-click card both call `textInsights`, so they answer alike.
 */

export interface NamedMatch {
  entity: AnyEntity
  /** The words of the text that named it (normalised). */
  matched: string
  /** `whole`: the selection is the name; `phrase`: the name is a run of words in it; `partial`: a short selection is part of the name. */
  how: 'whole' | 'phrase' | 'partial'
}

export interface TagMatch {
  tag: Tag
  count: number
  matched: string
}

export interface TextInsights {
  /** The text as read (trimmed, capped at MAX_TEXT). */
  text: string
  named: NamedMatch[]
  namedTotal: number
  tags: TagMatch[]
  mentions: AnyEntity[]
  mentionsTotal: number
}

export interface TextInsightsOptions {
  /** Entities to leave out: the document the text came from. */
  exclude?: Iterable<EntityId>
  /** Entities that are not things a reader means (type definitions, constraints): left out when this says so. */
  skip?: (e: AnyEntity) => boolean
  /** At most this many of each list (default 30). */
  limit?: number
}

export const MAX_TEXT = 4000
const MAX_PHRASE_WORDS = 6
/** A selection this short (in words) is also searched for as a phrase, and matched inside longer names. */
const SHORT_WORDS = 6

/** Words too common to be a name on their own. */
const STOP = new Set(
  'the and for are but not you all any can her was one our out has him his how its may new now old see two who did get let man put say she too use way with from have this that they them then than what when your into over also just like only some such more most other about which their there these those would could should after before where while been were will each very much many being'.split(' '),
)

/** Lower case, accents dropped, separators and punctuation to single spaces: the form names and text are compared in. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[_\-:/.]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every run of one to MAX_PHRASE_WORDS words in the text. */
function phrasesOf(words: string[]): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < words.length; i++) {
    let p = ''
    for (let n = 0; n < MAX_PHRASE_WORDS && i + n < words.length; n++) {
      p = n ? `${p} ${words[i + n]}` : words[i]
      out.add(p)
    }
  }
  return out
}

/** A name worth matching: three characters or more, and not a stop word on its own. */
const nameable = (key: string) => key.length >= 3 && !STOP.has(key)

/**
 * Normalised names per entity object — a right-click over a big project must not normalise every label again. An
 * edit usually replaces the object; one made in place is caught by the label the entry was made from.
 */
const namesCache = new WeakMap<AnyEntity, { label: string; names: string[] }>()
function namesOf(e: AnyEntity): string[] {
  const label = displayLabel(e)
  const hit = namesCache.get(e)
  if (hit && hit.label === label) return hit.names
  const raw = [label]
  const aliases = (e.data as { aliases?: unknown } | undefined)?.aliases
  if (Array.isArray(aliases)) for (const a of aliases) if (typeof a === 'string') raw.push(a)
  const names = [...new Set(raw.map(normalizeText).filter(nameable))]
  namesCache.set(e, { label, names })
  return names
}

const RANK: Record<NamedMatch['how'], number> = { whole: 0, phrase: 1, partial: 2 }

export function textInsights(store: Pick<EntityStore, 'all' | 'tags' | 'tagUsage' | 'query'>, raw: string, opts: TextInsightsOptions = {}): TextInsights {
  const text = raw.trim().slice(0, MAX_TEXT)
  const limit = opts.limit ?? 30
  const empty: TextInsights = { text, named: [], namedTotal: 0, tags: [], mentions: [], mentionsTotal: 0 }
  const norm = normalizeText(text)
  if (norm.length < 2) return empty
  const words = norm.split(' ')
  const phrases = phrasesOf(words)
  const short = words.length <= SHORT_WORDS && nameable(norm)
  const exclude = new Set(opts.exclude ?? [])

  const named: NamedMatch[] = []
  for (const e of store.all()) {
    if (isRelationship(e) || exclude.has(e.id) || opts.skip?.(e)) continue
    let best: NamedMatch | undefined
    for (const key of namesOf(e)) {
      const how: NamedMatch['how'] | undefined = key === norm ? 'whole' : phrases.has(key) ? 'phrase' : short && key.includes(norm) ? 'partial' : undefined
      if (how && (!best || RANK[how] < RANK[best.how])) best = { entity: e, matched: how === 'partial' ? norm : key, how }
    }
    if (best) named.push(best)
  }
  // The selection itself first, then names found in it (longer names first: "New York Times" before "York"), then names it is part of.
  named.sort((a, b) => RANK[a.how] - RANK[b.how] || b.matched.length - a.matched.length || displayLabel(a.entity).localeCompare(displayLabel(b.entity)))

  const tags: TagMatch[] = []
  for (const tag of store.tags()) {
    const key = normalizeText(tag)
    const last = normalizeText(tag.split(':').pop() ?? tag)
    const matched = nameable(key) && phrases.has(key) ? key : nameable(last) && phrases.has(last) ? last : short && key.includes(norm) ? norm : undefined
    if (matched) tags.push({ tag, count: store.tagUsage(tag), matched })
  }
  tags.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))

  let mentions: AnyEntity[] = []
  if (short) {
    const namedIds = new Set(named.map((m) => m.entity.id))
    const phrase = words.length > 1 ? `"${text.replace(/"/g, ' ')}"` : text
    mentions = store.query({ text: phrase }).filter((e) => !isRelationship(e) && !exclude.has(e.id) && !namedIds.has(e.id) && !opts.skip?.(e))
  }

  return { text, named: named.slice(0, limit), namedTotal: named.length, tags: tags.slice(0, limit), mentions: mentions.slice(0, limit), mentionsTotal: mentions.length }
}
