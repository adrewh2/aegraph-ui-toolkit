import type { AnyEntity, EntityId } from './types'

/**
 * The store's entities by id, each with a **handle**: a small integer that is its place in this table for as long
 * as the table lives. A handle lets whatever tracks entities in bulk — which ones changed since a commit, which are
 * dirty — keep a bitset (a bit each: 2 million entities in 250 KB) instead of a Set or a Map of ids (tens of bytes
 * each, and a second index of the project to keep in step with the first).
 *
 * The same surface as the Map it replaced — `get`, `has`, `set`, `delete`, `size`, `clear` — plus `handleOf` and
 * `at`. Iteration keeps the Map's order (insertion order; writing an existing id keeps its place). A handle is never
 * given to another id: removing an entity leaves its slot empty (eight bytes), so a bitset over handles never reads
 * one entity's bit as another's. `clear` starts a new `generation` — every handle before it is void.
 */
export class EntityTable {
  private slots = new Map<EntityId, number>()
  private entities: (AnyEntity | undefined)[] = []
  private idList: EntityId[] = []
  /** Bumped by `clear`: handles taken before are meaningless after. */
  generation = 0

  get size(): number {
    return this.slots.size
  }

  /** One past the highest handle given out: the size a bitset over handles needs. */
  get capacity(): number {
    return this.entities.length
  }

  get(id: EntityId): AnyEntity | undefined {
    const h = this.slots.get(id)
    return h === undefined ? undefined : this.entities[h]
  }

  has(id: EntityId): boolean {
    return this.slots.has(id)
  }

  set(id: EntityId, e: AnyEntity): this {
    const h = this.slots.get(id)
    if (h === undefined) {
      this.slots.set(id, this.entities.length)
      this.entities.push(e)
      this.idList.push(id)
    } else this.entities[h] = e
    return this
  }

  delete(id: EntityId): boolean {
    const h = this.slots.get(id)
    if (h === undefined) return false
    this.slots.delete(id)
    this.entities[h] = undefined
    return true
  }

  clear() {
    this.slots.clear()
    this.entities = []
    this.idList = []
    this.generation++
  }

  /** The handle of an entity in the table, or undefined. */
  handleOf(id: EntityId): number | undefined {
    return this.slots.get(id)
  }

  /** The entity at a handle, or undefined when it has been removed (or the handle is from before a `clear`). */
  at(h: number): AnyEntity | undefined {
    return this.entities[h]
  }

  /** The id a handle was given to — still known after the entity is removed, until the next `clear`. */
  idAt(h: number): EntityId | undefined {
    return this.idList[h]
  }

  /** Every entity, in the table's order, as an array (the Map's `[...values()]`, without a generator in between). */
  valuesArray(): AnyEntity[] {
    const out = new Array<AnyEntity>(this.slots.size)
    let i = 0
    for (const h of this.slots.values()) out[i++] = this.entities[h]!
    return out
  }

  *values(): IterableIterator<AnyEntity> {
    for (const h of this.slots.values()) yield this.entities[h]!
  }
}
