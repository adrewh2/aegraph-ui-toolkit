import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'
import { EntityStore } from './store'
import { SCHEMA_TYPE } from './categories'
import { listEntityTypes, subscribeEntityTypes } from './schema'
import type { StoreEvent } from './store'
import { TypeRegistry } from './typeRegistry'

export const EntityStoreContext = createContext<EntityStore | null>(null)

export function useEntityStore(): EntityStore {
  const store = useContext(EntityStoreContext)
  if (!store) throw new Error('useEntityStore must be used inside <EntityStoreContext.Provider>')
  return store
}

/** The store's data version: bumps on writes that change data, not on bookkeeping (last opened, a script's last run). For memos over the whole dataset. */
export function useStoreDataVersion(store: EntityStore): number {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.dataVersion,
    () => store.dataVersion,
  )
}

/** Re-renders on any store change; returns the store's version so selectors can memo on it. */
export function useStoreVersion(store: EntityStore): number {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.version,
    () => store.version,
  )
}

let typesSnapshot = listEntityTypes()
subscribeEntityTypes(() => {
  typesSnapshot = listEntityTypes()
})

export function useEntityTypes() {
  return useSyncExternalStore(subscribeEntityTypes, () => typesSnapshot, () => typesSnapshot)
}

// One registry per store and data version, shared by every component that asks: building one counts every entity by
// type, and a table has a cell per row and column asking for it. The data version, not the version: a bookkeeping
// write (a map's saved view, a script's last run) changes no type and no count, and a new registry would send every
// table's fields — and so its rows, sorted — through again for nothing.
const registries = new WeakMap<EntityStore, { version: number; types: unknown; registry: TypeRegistry }>()
export function registryFor(store: EntityStore, version = store.dataVersion, types: unknown = typesSnapshot): TypeRegistry {
  const hit = registries.get(store)
  if (hit && hit.version === version && hit.types === types) return hit.registry
  const registry = new TypeRegistry(store)
  registries.set(store, { version, types, registry })
  return registry
}

/**
 * What the ontology is made of: the code's type list, and the `schema:type` entities in the store. A view that reads
 * the registry only for categories and labels — the graph slice, for one — can memo on this instead of the
 * registry's identity, which is replaced on every data write and would have it rebuild for a saved scene.
 */
const ontologies = new WeakMap<EntityStore, { version: number }>()
export function ontologyVersion(store: EntityStore): number {
  let t = ontologies.get(store)
  if (!t) {
    t = { version: 0 }
    ontologies.set(store, t)
    const tracker = t
    const touches = (ev: StoreEvent): boolean => {
      if (ev.type === 'upsert') return ev.entities.some((e) => e.type === SCHEMA_TYPE)
      if (ev.type === 'remove' || ev.type === 'reset') return true
      if (ev.type === 'batch') return ev.events.some(touches)
      return false
    }
    store.subscribe((ev) => {
      if (touches(ev)) tracker.version++
    })
    subscribeEntityTypes(() => tracker.version++)
  }
  return t.version
}
export function useOntologyVersion(store: EntityStore): number {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => ontologyVersion(store),
    () => ontologyVersion(store),
  )
}

/** The effective ontology (code definitions ⊕ schema entities), rebuilt when either changes — one instance per store version, shared. */
export function useTypeRegistry(): TypeRegistry {
  const store = useEntityStore()
  const version = useStoreDataVersion(store)
  const types = useEntityTypes()
  return useMemo(() => registryFor(store, version, types), [store, version, types])
}
