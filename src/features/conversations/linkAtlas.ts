import type { EntityStore } from '../../core/entity/store'
import type { AnyEntity } from '../../core/entity/types'
import { linkAtlasConversations } from '../../core/exchange/atlas'
import { formatNumber } from '../../lib/format'

/**
 * Before a batch of entities is written: join it with whatever half of the
 * atlas ↔ conversations pair the store already holds, so segments and
 * conversations end up linked no matter which arrives first.
 */
export function withAtlasLinks(store: EntityStore, batch: AnyEntity[]): { entities: AnyEntity[]; note?: string } {
  const ids = new Set(batch.map((e) => e.id))
  const existing = store.all().filter((e) => !ids.has(e.id) && (e.type === 'segment' || e.type === 'conversation' || (e.kind === 'relationship' && store.get(e.source.id)?.type === 'segment')))
  const link = linkAtlasConversations([...existing, ...batch])
  if (!link.linked) return { entities: batch }
  const updated = new Map(link.conversations.map((c) => [c.id, c]))
  const merged = batch.map((e) => updated.get(e.id) ?? e)
  for (const c of link.conversations) if (!ids.has(c.id)) merged.push(c) // already in the store; now carrying its atlas
  return { entities: [...merged, ...link.relationships], note: `linked ${formatNumber(link.linked)} conversations to their segments (${formatNumber(link.relationships.length)} relationships)` }
}
