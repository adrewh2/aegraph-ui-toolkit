import type { EntityStore } from '../entity/store'
import type { AegraphDocument, AnyEntity, TagInfo } from '../entity/types'

/** A self-contained document for a subset of entities: the rows, the relationships among them, and the tag info they use. */
export function entitiesToDocument(store: EntityStore, rows: AnyEntity[]): AegraphDocument {
  // The same row can be reached twice (a table and its selection, a relationship and both its ends): the file
  // names each entity once, or importing it would read the same id as two rows.
  const picked = [...new Map(rows.map((r) => [r.id, r])).values()]
  const ids = new Set(picked.map((r) => r.id))
  const rels = store.relationships().filter((r) => ids.has(r.source.id) && ids.has(r.target.id) && !ids.has(r.id))
  const tags = new Set(picked.flatMap((r) => r.tags))
  const tagInfos: TagInfo[] = [...tags].map((t) => store.getTagInfo(t)).filter((t) => t.color || t.description)
  return { $schema: 'aegraph/v1', exportedAt: new Date().toISOString(), entities: [...picked, ...rels], ...(tagInfos.length ? { tags: tagInfos } : {}) }
}
