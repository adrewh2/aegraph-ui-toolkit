import type Anthropic from '@anthropic-ai/sdk'
import { createClient } from '../../core/ai/client'
import { hasApiCredentials } from '../../core/ai/settings'
import { describeVocabulary, embeddingRank, embeddingRankItems, lexicalRank, type EmbedItems, type Ranking, type Vocabulary } from '../../core/search/vocabulary'
import { embedCached, embeddingsAllowed, embeddingsReady, MODEL_SIZE_MB, setEmbeddingsAllowed } from '../search/embedder'

const MODEL = 'claude-haiku-4-5-20251001'

export type Engine = 'model' | 'local' | 'lexical'

export interface RankOptions {
  client?: Anthropic
  /** Force an engine; default: the API key's model if there is one, else the local embeddings, else word overlap. */
  engine?: Engine
  /** Asked once before the local model is downloaded (default: no download without prior consent). */
  confirm?: (message: string, options?: { yes?: string; danger?: boolean }) => Promise<boolean>
  /** Test seam for the local embeddings. */
  embed?: EmbedItems
}

/**
 * Which engine a ranking will use, resolving consent for the local model:
 * the download is only ever started by an explicit semantic request, and
 * the first one asks. Returns a note when it had to fall back.
 */
export async function chooseEngine(opts: RankOptions): Promise<{ engine: Engine; note?: string }> {
  if (opts.engine === 'lexical') return { engine: 'lexical' }
  if (opts.engine === 'model' || (!opts.engine && (opts.client || hasApiCredentials()))) return { engine: 'model' }
  if (opts.embed || embeddingsReady() || embeddingsAllowed()) return { engine: 'local' }
  const ok = opts.confirm ? await opts.confirm(`Search by meaning needs a small language model (about ${MODEL_SIZE_MB} MB) downloaded once and kept in this browser. Download it now?`, { yes: 'Download' }) : false
  if (ok) {
    setEmbeddingsAllowed(true)
    return { engine: 'local' }
  }
  return { engine: 'lexical', note: opts.confirm ? 'The model download was declined: ranked by word overlap, not meaning. Call again with engine "local" to download it, or, on a deployed copy, add an Anthropic API key in the assistant settings.' : `No API key in the assistant settings (locally the chat is Claude Code, and a key is not used) and the local model has not been downloaded: ranked by word overlap, not meaning. Pass engine "local" to download it (about ${MODEL_SIZE_MB} MB, once).` }
}

/**
 * Rank the vocabulary against a phrase by meaning — "architecture" reaches
 * services, components, datastores and a `topology` tag, not just words
 * that contain it. With API credentials a small model reads the whole
 * vocabulary (names, descriptions, counts) and scores what the phrase is
 * about; without them the local sentence embeddings rank it (downloaded
 * once, with consent — `chooseEngine`); failing both, the word-overlap
 * ranking stands in and says so.
 */
export async function semanticRank(query: string, vocab: Vocabulary, opts: RankOptions = {}): Promise<Ranking & { note?: string }> {
  const lexical = lexicalRank(query, vocab)
  const { engine, note } = await chooseEngine(opts)
  if (engine === 'lexical') return { ...lexical, note }
  if (engine === 'local') {
    // The WASM runtime under the local model can die with a bare number (an abort code) rather than an Error,
    // typically under memory pressure in a big workspace: word overlap stands in and the reply says so.
    try {
      return await embeddingRank(query, vocab, opts.embed ?? embedCached)
    } catch (err) {
      return { ...lexical, note: `The local model failed (${err instanceof Error ? err.message : `runtime error ${String(err)}`}); ranked by word overlap instead. Reload the page to retry it, or pass engine: "lexical".` }
    }
  }
  const client = opts.client ?? createClient()
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system:
      'You map a request for entities to a vocabulary of entity types and tags. Score each type and tag 0 to 1 by how much it is about what the request asks for: 1 = squarely that, 0.7 = clearly part of it, 0.4 = loosely related, 0 = unrelated. Judge by meaning, not word overlap: "architecture" covers services, components, datastores, queues, regions, deployment topology and architecture documents; it does not cover people or incidents. Prefer specific types over broad ones. Return only JSON: {"types":[{"name":string,"score":number,"why":string}],"tags":[{"tag":string,"score":number,"why":string}],"terms":[string]} — list only items scoring ≥ 0.3, and in "terms" up to 5 distinctive words worth a text search across entity labels and descriptions (synonyms of the request; never generic words).',
    messages: [{ role: 'user', content: `Request: ${query}\n\nVocabulary (one per line; "· n" is how many entities carry it):\n${describeVocabulary(vocab)}` }],
  })
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  const parsed = parseRanking(text)
  if (!parsed) return lexical
  const typeNames = new Set(vocab.types.map((t) => t.name))
  const tagNames = new Set(vocab.tags.map((t) => t.tag))
  const clamp = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)
  const types = parsed.types.filter((t) => typeNames.has(t.name)).map((t) => ({ key: t.name, score: clamp(t.score), why: t.why }))
  const tags = parsed.tags.filter((t) => tagNames.has(t.tag)).map((t) => ({ key: t.tag, score: clamp(t.score), why: t.why }))
  types.sort((a, b) => b.score - a.score)
  tags.sort((a, b) => b.score - a.score)
  const terms = parsed.terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 2).slice(0, 5)
  return { method: 'semantic', types, tags, terms: terms.length ? terms : lexical.terms }
}

type Parsed = { types: { name: string; score: number; why?: string }[]; tags: { tag: string; score: number; why?: string }[]; terms: string[] }

/** The JSON object in a reply, fences and prose around it tolerated. */
export function parseRanking(text: string): Parsed | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as Partial<Parsed>
    const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : [])
    return {
      types: arr<{ name: string; score: number; why?: string }>(v.types).filter((t) => typeof t?.name === 'string'),
      tags: arr<{ tag: string; score: number; why?: string }>(v.tags).filter((t) => typeof t?.tag === 'string'),
      terms: arr<unknown>(v.terms).filter((t): t is string => typeof t === 'string'),
    }
  } catch {
    return null
  }
}

/** Entities by similarity of their label and description to the phrase, with the local model (the engine must already be 'local'). */
export function rankEntityTexts(query: string, items: { id: string; key: string; text: string }[], embed: EmbedItems = embedCached) {
  return embeddingRankItems(query, items, embed)
}
