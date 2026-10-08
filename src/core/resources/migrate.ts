import type { EntityStore } from '../entity/store'
import { isRelationship, type AnyEntity } from '../entity/types'
import { migrateGeo } from '../../features/maps/maps'
import { madeBeforeUpgrades } from './legacy'
import { RESOURCE_TYPES } from './types'

/**
 * One-off upgrades for data written by older builds, applied to a workspace after it loads from IndexedDB.
 *
 * Each runs **once per database**: `migrateStore` is handed a log of the upgrades done (`storageMigrationLog`, kept in
 * localStorage beside the database — stashing and clearing the browser carry and drop the two together), runs only
 * those not in it, and adds them. A new database (nothing loaded) is born upgraded: every step is logged without
 * running. So a bundle opened later — a demo, a colleague's project — is never rewritten at the next start because one
 * of its types happens to share a name the old app used.
 *
 * And each touches only what the old app wrote: the type name *and* that app's shape of the data *and* a creation
 * date before the upgrade shipped. `music`, `place` and `display` are ordinary words; a type of one's own by that name
 * is not the old one, and is left alone even when the log is lost and the upgrades run again.
 */

/** The upgrades, in the order they run. Their ids are what the log keeps: never rename one. */
export const MIGRATIONS = ['2026-09-music-audio', '2026-09-place-geo', '2026-09-display'] as const
export type MigrationId = (typeof MIGRATIONS)[number]

/** Which upgrades this database has had. */
export interface MigrationLog {
  has(id: MigrationId): boolean
  add(id: MigrationId): void
}

/** A `music` entity as the old app made it: a Spotify link (`MusicData`: provider, the Spotify id). */
export const isLegacyMusic = (e: AnyEntity): boolean => !isRelationship(e) && e.type === 'music' && e.data.provider === 'spotify' && typeof e.data.spotifyId === 'string' && madeBeforeUpgrades(e)

/** A `display` entity as the old app made it: a composition (`content`) of projection layers, or one plot. */
export function isLegacyDisplay(e: AnyEntity): boolean {
  if (isRelationship(e) || e.type !== 'display' || !madeBeforeUpgrades(e)) return false
  const c = e.data.content as { kind?: unknown; layers?: unknown; plot?: unknown } | undefined
  return !!c && typeof c === 'object' && ((c.kind === 'geometry' && Array.isArray(c.layers)) || (c.kind === 'plot' && typeof c.plot === 'string'))
}

const STEPS: Record<MigrationId, (store: EntityStore) => number> = {
  // 2026-09: the `music` resource type became `audio`.
  '2026-09-music-audio': (store) => {
    const legacy = store.library.ofType('music').filter(isLegacyMusic)
    if (legacy.length)
      store.transaction(() => {
        for (const e of legacy) store.update(e.id, { type: RESOURCE_TYPES.audio })
      })
    return legacy.length
  },
  // 2026-09: places became locations / paths / areas with a mapId.
  '2026-09-place-geo': (store) => migrateGeo(store),
  // 2026-09: the short-lived `display` wrapper type (layers over scenes) is gone; the scenes it pointed at stay.
  '2026-09-display': (store) => {
    const displays = store.library.ofType('display').filter(isLegacyDisplay)
    if (displays.length) store.remove(displays.map((e) => e.id))
    return displays.length
  },
}

/**
 * Apply the upgrades `log` does not have yet, and log them. `fresh`: the database was empty — nothing old to upgrade,
 * so each is logged without running. With no log, every step runs (each is idempotent). Returns how many entities
 * changed.
 */
export function migrateStore(store: EntityStore, log?: MigrationLog, { fresh = false }: { fresh?: boolean } = {}): number {
  let changed = 0
  for (const id of MIGRATIONS) {
    if (log?.has(id)) continue
    if (!fresh) changed += STEPS[id](store)
    log?.add(id)
  }
  return changed
}

const LOG_KEY = 'aegraph:migrations'

/** The log kept in a Storage (localStorage in the app). A storage that cannot be read or written logs nothing. */
export function storageMigrationLog(storage: Pick<Storage, 'getItem' | 'setItem'>, key = LOG_KEY): MigrationLog {
  const read = (): string[] => {
    try {
      const v = JSON.parse(storage.getItem(key) ?? '[]') as unknown
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  return {
    has: (id) => read().includes(id),
    add: (id) => {
      const done = read()
      if (done.includes(id)) return
      try {
        storage.setItem(key, JSON.stringify([...done, id]))
      } catch {
        /* no storage: the step runs again next time, touching only the old app's entities */
      }
    },
  }
}
