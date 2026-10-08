import { displayLabel, quoteLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import type { AnyEntity } from '../../core/entity/types'
import { normalizeEntity } from '../../core/exchange/formats'
import { previewBundle as planBundle } from '../../core/projects/bundle'
import { gunzipText } from '../../core/exchange/gunzip'
import { looksPacked, readPack } from '../../core/exchange/import'
import { contentOf, isDocument } from '../documents/documents'
import { isOwnMemory } from './memory'
import type { AppHost } from './tools'

/**
 * What opening a bundle through `project_open_bundle` would do to what is already here, asked about before it is
 * done. A bundle merges by id and a newer `updatedAt` wins — and the bundle, its ids and its dates are anyone's to
 * write: one handed to the tool (inline, or from another site) can carry the id of a document the user wrote, dated
 * tomorrow, and replace it with no question asked, past the shrink guard `write_document` has and the confirmation a
 * memory rewrite has. So the tool reads the bundle first and:
 *
 * - refuses it outright if it would replace the assistant's own memory (an id in this browser's memory list): that
 *   document is read into every turn as the assistant's own words, and an import never gets to write it;
 * - otherwise, if it would replace anything, asks — with how many, a few of their names as they are now, and in red
 *   when documents would lose most of their text.
 *
 * What counts as "would replace" is the open's own plan (`previewBundle` in core/projects/bundle.ts): a bundle changes
 * only the entities of its own project, older here than in the file; the Library's other entities are never written.
 * The open itself decides, and this only asks first.
 */

export interface BundlePreview {
  /** Entities here the bundle's versions would replace, with whether a document among them would lose most of its text. */
  updates: { id: string; label: string; shrinks: boolean }[]
  /** How many the open would replace: `updates` names at most the first fifty. */
  count: number
  /** Ids in the file that are the assistant's own memory. */
  memory: string[]
}

/** Read what a bundle document (`{ entities: [...] }` or a bare list) would replace in `store`, writing nothing. */
export function previewBundle(store: EntityStore, raw: unknown): BundlePreview {
  const plan = planBundle(store, raw)
  const doc = raw as { entities?: unknown } | unknown[]
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.entities) ? (doc.entities as unknown[]) : []
  const named = new Set(plan.updates)
  const incoming = new Map<string, AnyEntity>()
  const memory: string[] = []
  for (let i = 0; i < list.length; i++) {
    const e = normalizeEntity(list[i], `import-${i}`)
    if (!e) continue
    if (named.has(e.id)) incoming.set(e.id, e)
    // The memory's id anywhere in the file, whatever the plan makes of it: a bundle has no business naming it.
    const prev = store.get(e.id)
    if (prev && isDocument(prev) && isOwnMemory(prev)) memory.push(prev.id)
  }
  const updates: BundlePreview['updates'] = []
  for (const id of plan.updates) {
    const prev = store.get(id)
    const next = incoming.get(id)
    if (prev && next) updates.push({ id: prev.id, label: displayLabel(prev), shrinks: shrinks(prev, next) })
  }
  return { updates, count: plan.updated, memory }
}

/** A document whose text would go from more than 200 characters to less than half of it. */
function shrinks(prev: AnyEntity, next: AnyEntity): boolean {
  if (!isDocument(prev)) return false
  const before = contentOf(prev).length
  const after = typeof next.data?.content === 'string' ? next.data.content.length : 0
  return before > 200 && after < before / 2
}

/** `previewBundle`, then the refusal or the question; returns when the open may go ahead. */
export async function guardBundle(host: Pick<AppHost, 'confirm'>, store: EntityStore, raw: unknown): Promise<void> {
  const { updates, count: n, memory } = previewBundle(store, raw)
  if (memory.length) throw new Error("Not opened: the bundle would replace the assistant's memory for this project, which an import never writes. Remove that entity from the bundle (or give it another id) to open the rest.")
  if (!n) return
  const shrinking = updates.filter((u) => u.shrinks).length
  const named = updates.slice(0, 3).map((u) => quoteLabel(u.label, 60)).join(', ')
  const ask = `Replace ${n} entit${n === 1 ? 'y' : 'ies'} already here with the bundle's version${n === 1 ? '' : 's'}${shrinking ? ` — ${shrinking} document${shrinking === 1 ? '' : 's'} would lose most of ${shrinking === 1 ? 'its' : 'their'} text` : ''}? ${named}${n > 3 ? ` and ${n - 3} more` : ''}. The bundle dates its copies later than these.`
  if (!(await host.confirm(ask, { yes: 'Replace', danger: shrinking > 0 }))) throw new Error(`Not opened: the user kept the ${n} entit${n === 1 ? 'y' : 'ies'} the bundle would have replaced.`)
}

/** A bundle's bytes as the document they hold — a pack (`.aeb`, gzipped or not) or JSON (gzipped or not) — as the open reads them. */
export async function decodeBundleBytes(bytes: Uint8Array): Promise<unknown> {
  if (looksPacked(bytes)) {
    try {
      return await readPack(bytes)
    } catch (err) {
      if (!(err instanceof Error && /Not an aegraph pack/.test(err.message))) throw err
    }
  }
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
  return JSON.parse(gzipped ? await gunzipText(bytes) : new TextDecoder().decode(bytes))
}
