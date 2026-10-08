import { contentOf, createDocument, isDocument } from '../documents/documents'
import type { EntityStore } from '../../core/entity/store'
import type { AnyEntity } from '../../core/entity/types'

/**
 * What the assistant remembers about a project: preferences, conventions,
 * what the user is working on — kept as a document in the entity system
 * (one per scope, tagged `assistant:memory`, source `assistant`), so it
 * is visible and editable in the Documents view like any note, travels
 * with the project, and is read into every turn's context.
 *
 * A memory is only the assistant's own when **this browser** wrote it. A
 * bundle, an import or a demo can carry a document tagged `assistant:memory`
 * too — with `source: 'assistant'` and all — and memory is read into every
 * turn as the assistant's own notes, so a planted one would be an
 * instruction that never goes away. The ids of the memories written here
 * are kept in `aegraph:assistant:memory-ids` (per browser, never in a
 * bundle); a tagged document not on that list is *shared notes*: carried
 * into the turn marked as someone else's writing (`readSharedMemory`), and
 * never written to — the first note starts this browser's own.
 */

export const MEMORY_TAG = 'assistant:memory'
export const MEMORY_LABEL = 'Assistant memory'
/** How much of the memory a turn's context carries (the rest is there for the memory tool to read). */
export const MEMORY_CONTEXT_CHARS = 4000

const TRUSTED_KEY = 'aegraph:assistant:memory-ids'
let fallback: Set<string> | undefined

function trustedIds(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(TRUSTED_KEY)
    if (raw !== undefined) return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    // Storage unreadable (a private window, the headless engine): keep the list for this session only.
  }
  return (fallback ??= new Set())
}

function trust(id: string) {
  const ids = trustedIds()
  if (ids.has(id)) return
  ids.add(id)
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(TRUSTED_KEY, JSON.stringify([...ids]))
    else fallback = ids
  } catch {
    fallback = ids
  }
}

/** Whether this browser wrote the memory document: only then is it the assistant's own. */
export const isOwnMemory = (e: AnyEntity) => trustedIds().has(e.id)

/** The scope's memory document — the one this browser wrote — if it has one. */
export function findMemory(store: EntityStore): AnyEntity | undefined {
  return store.withTag(MEMORY_TAG).find((e) => isDocument(e) && isOwnMemory(e))
}

export function readMemory(store: EntityStore): string {
  const m = findMemory(store)
  return m ? contentOf(m).trim() : ''
}

/** Memory documents that arrived from elsewhere (a bundle, an import): notes to read as someone else's, not the assistant's own. */
export function readSharedMemory(store: EntityStore): string {
  return store
    .withTag(MEMORY_TAG)
    .filter((e) => isDocument(e) && !isOwnMemory(e))
    .map((e) => contentOf(e).trim())
    .filter(Boolean)
    .join('\n\n')
}

/** The memory document, created empty when the scope has none. */
export function ensureMemory(store: EntityStore): AnyEntity {
  const own = findMemory(store)
  if (own) return own
  const made = createDocument(store, { label: MEMORY_LABEL, content: '', tags: [MEMORY_TAG], source: 'assistant' })
  trust(made.id)
  return made
}

export function rewriteMemory(store: EntityStore, content: string): AnyEntity {
  const m = ensureMemory(store)
  store.update(m.id, { data: { ...m.data, content: content.trim() } })
  return store.get(m.id) ?? m
}

/** Add one note (a bullet, dated), unless the same note is already there. */
export function noteMemory(store: EntityStore, text: string): { entity: AnyEntity; added: boolean } {
  const line = text.trim().replace(/\s+/g, ' ')
  const current = readMemory(store)
  if (current.split('\n').some((l) => l.replace(/^- (\d{4}-\d{2}-\d{2}: )?/, '').trim() === line)) return { entity: ensureMemory(store), added: false }
  const dated = `- ${new Date().toISOString().slice(0, 10)}: ${line}`
  return { entity: rewriteMemory(store, current ? `${current}\n${dated}` : dated), added: true }
}

/** The lines `forgetMemory(text)` would drop: every one that contains `text` (case-insensitive). */
export function memoryLinesMatching(store: EntityStore, text: string): string[] {
  const needle = text.trim().toLowerCase()
  return needle ? readMemory(store).split('\n').filter((l) => l.toLowerCase().includes(needle)) : []
}

/** Drop every line that contains `text` (case-insensitive); how many went. */
export function forgetMemory(store: EntityStore, text: string): { entity: AnyEntity; removed: number } {
  const needle = text.trim().toLowerCase()
  const lines = readMemory(store).split('\n')
  const kept = needle ? lines.filter((l) => !l.toLowerCase().includes(needle)) : lines
  return { entity: rewriteMemory(store, kept.join('\n')), removed: lines.length - kept.length }
}
