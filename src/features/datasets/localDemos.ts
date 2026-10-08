import { EntityStore } from '../../core/entity/store'
import type { AnyEntity, TagInfo } from '../../core/entity/types'
import { isAtlas, parseAtlas } from '../../core/exchange/atlas'
import { chatGptToEntities, parseChatGpt } from '../../core/exchange/chatgpt'
import { normalizeEntity } from '../../core/exchange/formats'
import { formatNumber } from '../../lib/format'
import { withAtlasLinks } from '../conversations/linkAtlas'

/**
 * Datasets on this machine, served by the dev server from the paths in
 * `.env.local` (`AEGRAPH_LOCAL_DEMOS`, see vite.config.ts). Shared by the
 * Projects dialog's card and the `load_dataset` tool.
 */

/** What the dev server lists at /__local/demos. */
export interface LocalDemo {
  id: string
  label: string
  file: string
  kind: 'file' | 'directory'
  bytes: number
  modified: string
  /** Directory entries: the chunk files served under this demo. */
  files?: { name: string; bytes: number }[]
}

export type Job = { label: string; done: number; total: number; detail?: string } | null
export type Loaded = { entities: AnyEntity[]; tags: TagInfo[]; label: string; note: string }

export async function fetchLocalDemos(): Promise<LocalDemo[]> {
  try {
    const r = await fetch('/__local/demos', { headers: { accept: 'application/json' } })
    const list = r.ok ? await r.json() : []
    return Array.isArray(list) ? (list as LocalDemo[]) : []
  } catch {
    return []
  }
}

const fetchJson = async (onJob: (j: Job) => void, url: string, label: string, bytes: number, doneBefore = 0, totalAll = bytes): Promise<unknown> => {
  onJob({ label: `Reading ${label}`, done: doneBefore, total: totalAll })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const text = await res.text()
  onJob({ label: `Parsing ${label}`, done: doneBefore + bytes, total: totalAll })
  await new Promise((r) => setTimeout(r, 0))
  return JSON.parse(text) as unknown
}

/** One file: an atlas, or an aegraph document / array of records. */
export async function loadLocalFile(d: LocalDemo, onJob: (j: Job) => void = () => {}): Promise<Loaded> {
  const json = await fetchJson(onJob, `/__local/demos/${encodeURIComponent(d.id)}`, d.file, d.bytes)
  if (isAtlas(json)) {
    const atlas = parseAtlas(json, { tag: d.id })
    return { entities: atlas.entities, tags: atlas.tags, label: atlas.label, note: `${atlas.label}: ${formatNumber(atlas.nodes)} nodes, ${formatNumber(atlas.edges)} relationships, ${atlas.types.length} types (${atlas.types.join(', ')})` }
  }
  const raw = Array.isArray(json) ? json : ((json as { entities?: unknown[] }).entities ?? [])
  const entities = raw.map((r, i) => normalizeEntity(r, `${d.id}-${i}`)).filter((e): e is AnyEntity => !!e)
  const tags = ((json as { tags?: TagInfo[] }).tags ?? []).filter((t) => t && typeof t.tag === 'string')
  if (!entities.length) throw new Error('No entities found — expected an atlas (data.graph) or an aegraph document.')
  return { entities, tags, label: d.label, note: `${d.label}: ${formatNumber(entities.length)} entities` }
}

/** A ChatGPT export directory: every conversations*.json chunk, parsed the way the file importer parses one. */
export async function loadLocalConversations(d: LocalDemo, onJob: (j: Job) => void = () => {}): Promise<Loaded> {
  const files = d.files ?? []
  const entities: AnyEntity[] = []
  let done = 0
  let conversations = 0
  let messages = 0
  for (const f of files) {
    const json = await fetchJson(onJob, `/__local/demos/${encodeURIComponent(d.id)}/${encodeURIComponent(f.name)}`, `${f.name} (${files.indexOf(f) + 1}/${files.length})`, f.bytes, done, d.bytes)
    const { format, conversations: parsed } = parseChatGpt(json)
    const out = chatGptToEntities(format, parsed, { tag: 'chatgpt' })
    entities.push(...out.entities)
    conversations += parsed.length
    messages += parsed.reduce((n, c) => n + c.messages.length, 0)
    done += f.bytes
  }
  return { entities, tags: [{ tag: 'chatgpt', color: '#10a37f', description: 'Loaded from a ChatGPT export' }], label: d.label, note: `${d.label}: ${formatNumber(conversations)} conversations, ${formatNumber(messages)} messages from ${files.length} files` }
}

export const loadLocalDemo = (d: LocalDemo, onJob?: (j: Job) => void) => (d.kind === 'directory' ? loadLocalConversations(d, onJob) : loadLocalFile(d, onJob))

/** In replace mode the store is about to be cleared, so links are made within the batch alone. */
const emptyStore = new EntityStore()

/**
 * Read the demos, link atlas segments to conversations (across the batch
 * and, when merging, what the store already holds), and commit in one
 * transaction. Returns the loaded parts and the link note.
 */
export async function loadLocalDemos(store: EntityStore, demos: LocalDemo[], opts: { mode?: 'merge' | 'replace'; onJob?: (j: Job) => void } = {}): Promise<{ parts: Loaded[]; note?: string; readMs: number; indexMs: number; count: number }> {
  const onJob = opts.onJob ?? (() => {})
  const mode = opts.mode ?? 'merge'
  const t0 = performance.now()
  const parts: Loaded[] = []
  for (const d of demos) parts.push(await loadLocalDemo(d, onJob))
  const readMs = performance.now() - t0
  onJob({ label: 'Linking', done: 1, total: 1 })
  await new Promise((r) => setTimeout(r, 0))
  const batch = parts.flatMap((p) => p.entities)
  const { entities, note } = withAtlasLinks(mode === 'merge' ? store : emptyStore, batch)
  const tags = parts.flatMap((p) => p.tags)
  onJob({ label: 'Indexing', done: 0, total: 1 })
  await new Promise((r) => setTimeout(r, 0))
  const t1 = performance.now()
  store.transaction(() => {
    if (mode === 'replace') store.clear()
    for (const t of tags) store.setTagInfo(t.tag, t)
    store.upsertMany(entities)
  })
  onJob(null)
  return { parts, note, readMs, indexMs: performance.now() - t1, count: entities.length }
}
