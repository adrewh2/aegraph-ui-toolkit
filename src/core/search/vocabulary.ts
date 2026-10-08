import type { EntityStore } from '../entity/store'
import type { TypeRegistry } from '../entity/typeRegistry'

/**
 * The vocabulary a phrase like "everything about architecture" is matched
 * against: the types and tags in use, each with its label, description and
 * count in the open scope. `lexicalRank` scores them by word overlap — the
 * fallback when no model is available; the semantic ranking lives beside
 * the assistant, which has the API client.
 */
export interface VocabType {
  name: string
  label: string
  description?: string
  category: string
  count: number
  /** A few entity labels of this type, the tags most often on them, the relationship types they take part in — what the type means here. */
  samples: string[]
  tags: string[]
  links: string[]
}
export interface VocabTag {
  tag: string
  description?: string
  count: number
  samples: string[]
  types: string[]
}
export interface Vocabulary {
  types: VocabType[]
  tags: VocabTag[]
}

export interface Ranked {
  key: string
  score: number
  why?: string
}
export interface Ranking {
  /** semantic: a model read the vocabulary; embedding: sentence similarity in the browser; lexical: word overlap. */
  method: 'semantic' | 'embedding' | 'lexical'
  types: Ranked[]
  tags: Ranked[]
  /** Distinctive words worth a text search across labels and descriptions. */
  terms: string[]
}

const SAMPLES = 6
const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k)
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)

export function buildVocabulary(store: EntityStore, registry: TypeRegistry): Vocabulary {
  type Acc = { count: number; samples: string[]; tags: Map<string, number>; links: Map<string, number> }
  const byType = new Map<string, Acc>()
  type TagAcc = { count: number; samples: string[]; types: Map<string, number> }
  const byTag = new Map<string, TagAcc>()
  for (const e of store.all()) {
    if (e.kind !== 'entity' || e.type.startsWith('schema:')) continue
    const label = e.label?.trim()
    const t: Acc = byType.get(e.type) ?? { count: 0, samples: [], tags: new Map(), links: new Map() }
    t.count++
    if (label && t.samples.length < SAMPLES) t.samples.push(label)
    for (const tag of e.tags) {
      bump(t.tags, tag)
      const g: TagAcc = byTag.get(tag) ?? { count: 0, samples: [], types: new Map() }
      g.count++
      if (label && g.samples.length < SAMPLES) g.samples.push(label)
      bump(g.types, e.type)
      byTag.set(tag, g)
    }
    byType.set(e.type, t)
  }
  for (const r of store.relationships()) {
    const a = store.get(r.source.id)
    const b = store.get(r.target.id)
    if (a) bump(byType.get(a.type)?.links ?? new Map(), r.type)
    if (b && b.type !== a?.type) bump(byType.get(b.type)?.links ?? new Map(), r.type)
  }
  const types: VocabType[] = [...byType].map(([name, a]) => {
    const t = registry.get(name)
    return { name, label: t.label, description: t.description, category: t.category, count: a.count, samples: a.samples, tags: top(a.tags, 5), links: top(a.links, 5) }
  })
  const tags: VocabTag[] = [...byTag].map(([tag, a]) => ({ tag, description: store.getTagInfo(tag).description, count: a.count, samples: a.samples, types: top(a.types, 4).map((n) => registry.get(n).label) }))
  types.sort((a, b) => b.count - a.count)
  tags.sort((a, b) => b.count - a.count)
  return { types, tags }
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'about', 'all', 'every', 'everything', 'anything', 'things', 'stuff', 'related', 'show', 'open', 'me', 'my', 'our', 'that', 'this', 'is', 'are', 'what', 'which', 'how', 'they', 'them', 'their', 'its', 'it', 'has', 'have', 'from', 'into', 'by', 'as', 'at', 'be', 'was', 'were', 'do', 'does', 'get', 'find', 'list', 'table', 'entities', 'entity'])

/** Words of a phrase, lowercased, crudely stemmed, without stop words. */
export function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem))]
}

function stem(w: string): string {
  // "-ers" drops only the plural (papers → paper, workers → worker): the agent noun is the word people search for.
  const s = w.replace(/(ings|ing|ers|ies|ied|ed|es|s)$/, (m) => (m === 'ies' || m === 'ied' ? 'y' : m === 'ers' ? 'er' : m === 'es' && !/(ss|sh|ch|x|z)es$/.test(w) ? 'e' : '')).replace(/(ss|sh|ch|x|z)e$/, '$1')
  // A stem of under three letters is no stem: "red", "king" and "thing" keep themselves.
  return s.length >= 3 ? s : w
}

/** 0–1: how much of the query's words the text shares (stem, prefix and containment count). */
function overlap(query: string[], text: string): number {
  if (!query.length) return 0
  const words = terms(text)
  const joined = text.toLowerCase()
  let hit = 0
  for (const q of query) {
    if (words.includes(q)) hit += 1
    else if (words.some((w) => w.startsWith(q) || q.startsWith(w)) || joined.includes(q)) hit += 0.6
  }
  return Math.min(1, hit / query.length)
}

/** Rank the vocabulary by word overlap with the phrase — no model, no network. */
export function lexicalRank(query: string, vocab: Vocabulary): Ranking {
  const q = terms(query)
  const types = vocab.types.map((t) => ({ key: t.name, score: Math.max(overlap(q, `${t.name} ${t.label}`), 0.8 * overlap(q, t.description ?? '')) })).filter((r) => r.score > 0)
  const tags = vocab.tags.map((t) => ({ key: t.tag, score: Math.max(overlap(q, t.tag.replace(/[:_-]/g, ' ')), 0.8 * overlap(q, t.description ?? '')) })).filter((r) => r.score > 0)
  types.sort((a, b) => b.score - a.score)
  tags.sort((a, b) => b.score - a.score)
  return { method: 'lexical', types, tags, terms: q }
}

/** What a type means here, in one sentence: its label, description, examples, usual tags and links. */
export function typeText(t: VocabType): string {
  const parts = [`${t.label}${t.description ? ` — ${t.description}` : ''}`]
  if (t.samples.length) parts.push(`e.g. ${t.samples.join(', ')}`)
  if (t.tags.length) parts.push(`tagged ${t.tags.map((x) => x.replace(/[:_-]+/g, ' ')).join(', ')}`)
  if (t.links.length) parts.push(`linked by ${t.links.map((x) => x.replace(/[:_-]+/g, ' ')).join(', ')}`)
  return parts.join('; ')
}
export function tagText(t: VocabTag): string {
  const parts = [`${t.tag.replace(/[:_-]+/g, ' ')}${t.description ? ` — ${t.description}` : ''}`]
  if (t.types.length) parts.push(`on ${t.types.join(', ')}`)
  if (t.samples.length) parts.push(`e.g. ${t.samples.join(', ')}`)
  return parts.join('; ')
}

/** The vocabulary as compact lines a model can read: `type name — label · category · n · what it means here`. */
export function describeVocabulary(v: Vocabulary, max = 400): string {
  const t = v.types.slice(0, max).map((x) => `type ${x.name} · ${x.category} · ${x.count} · ${typeText(x)}`)
  const g = v.tags.slice(0, max).map((x) => `tag ${x.tag} · ${x.count} · ${tagText(x)}`)
  return [...t, ...g].join('\n')
}

/** Items to embed for a vocabulary: one line of meaning per type and tag, keyed by that line so a cache can reuse them. */
export function vocabularyTexts(v: Vocabulary): { types: { key: string; text: string }[]; tags: { key: string; text: string }[] } {
  return {
    types: v.types.map((t) => {
      const text = typeText(t)
      return { key: `type:${t.name}:${text}`, text }
    }),
    tags: v.tags.map((t) => {
      const text = tagText(t)
      return { key: `tag:${t.tag}:${text}`, text }
    }),
  }
}

export type EmbedItems = (items: { key: string; text: string }[]) => Promise<Float32Array[]>

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Rank the vocabulary by sentence similarity to the phrase (normalised embeddings → cosine, clamped to 0–1). */
export async function embeddingRank(query: string, vocab: Vocabulary, embed: EmbedItems): Promise<Ranking> {
  const texts = vocabularyTexts(vocab)
  const qs = await embed(queryTexts(query))
  const tv = await embed(texts.types)
  const gv = await embed(texts.tags)
  const score = (v: Float32Array) => Math.max(0, Math.min(1, Math.max(...qs.map((q) => dot(q, v)))))
  const types = vocab.types.map((t, i) => ({ key: t.name, score: score(tv[i]) })).sort((a, b) => b.score - a.score)
  const tags = vocab.tags.map((t, i) => ({ key: t.tag, score: score(gv[i]) })).sort((a, b) => b.score - a.score)
  return { method: 'embedding', types, tags, terms: terms(query) }
}

/** Entities themselves by similarity — a document whose description is about the phrase, whatever its type. */
export async function embeddingRankItems(query: string, items: { id: string; key: string; text: string }[], embed: EmbedItems): Promise<{ id: string; score: number }[]> {
  if (!items.length) return []
  const qs = await embed(queryTexts(query))
  const vs = await embed(items.map((i) => ({ key: i.key, text: i.text })))
  return items.map((it, i) => ({ id: it.id, score: Math.max(0, Math.min(1, Math.max(...qs.map((q) => dot(q, vs[i]))))) })).sort((a, b) => b.score - a.score)
}

/** The phrase and, when it differs, just its content words ("everything about architecture" → "architecture"): the framing words pull similarity down. */
function queryTexts(query: string): { key: string; text: string }[] {
  const q = query.trim()
  const bare = terms(q).join(' ')
  const out = [{ key: `q:${q}`, text: q }]
  if (bare && bare !== q.toLowerCase()) out.push({ key: `q:${bare}`, text: bare })
  return out
}
