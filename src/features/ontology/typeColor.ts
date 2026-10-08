import { schemaTypeId } from '../../core/entity/categories'
import type { EntityStore } from '../../core/entity/store'
import { schemaTypeEntity, type ResolvedType } from '../../core/entity/typeRegistry'

/**
 * Set — or clear — the colour a type is drawn in, everywhere it is drawn. The colour lives on the type's own
 * definition, so it travels with a bundle and the assistant reads and writes the same value
 * (`define_entity_type`). Clearing goes back to the colour derived from the name, which is what an undeclared
 * type already uses — the key has to be removed rather than set to nothing, since a definition keeps whatever
 * it is not told about. A type the workspace only inferred has no definition yet: setting a colour writes one,
 * carrying the label and category it was already resolving to so nothing else about it changes.
 */
export function setTypeColor(store: EntityStore, type: string, def: ResolvedType, color: string | undefined) {
  const existing = store.get(schemaTypeId(type))
  const patch: Parameters<typeof schemaTypeEntity>[1] = { color }
  if (!existing) {
    patch.label = def.label
    patch.category = def.category
  }
  const next = schemaTypeEntity(type, patch, existing)
  if (color === undefined) delete (next.data as { color?: string }).color
  store.upsert(next)
}
