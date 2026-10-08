import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { MIGRATIONS, migrateStore, storageMigrationLog, type MigrationId, type MigrationLog } from '../migrate'

/** Made by the old app: before the upgrades shipped, by hand. */
const old = { createdAt: '2026-09-10T12:00:00.000Z', updatedAt: '2026-09-10T12:00:00.000Z', source: 'user' }

const memoryLog = (): MigrationLog & { done: Set<MigrationId> } => {
  const done = new Set<MigrationId>()
  return { done, has: (id) => done.has(id), add: (id) => void done.add(id) }
}

describe('migrateStore', () => {
  it('renames the old app’s music entities to audio, once', () => {
    const store = new EntityStore()
    store.upsertMany([createEntity({ id: 'm', type: 'music', data: { provider: 'spotify', spotifyId: 'x', uri: 'spotify:track:x' }, meta: old }), createEntity({ id: 'a', type: 'audio', data: {} })])
    expect(migrateStore(store)).toBe(1)
    expect(store.get('m')?.type).toBe('audio')
    expect(store.ofType('music')).toHaveLength(0)
    expect(migrateStore(store)).toBe(0)
  })

  it('leaves a type of one’s own that shares an old name: music, display, place', () => {
    const store = new EntityStore()
    store.upsertMany([
      // A project's own `music` (a record collection), `display` (monitors) and `place` (a gazetteer): not the old app's shape.
      createEntity({ id: 'album', type: 'music', data: { artist: 'Nina Simone' }, meta: old }),
      createEntity({ id: 'monitor', type: 'display', data: { inches: 27 }, meta: old }),
      createEntity({ id: 'paris', type: 'place', data: { lat: 48.85, lng: 2.35 }, meta: { ...old, source: 'wikidata' } }),
      createEntity({ id: 'link', type: 'note', label: 'about the monitor' }),
      createRelationship({ id: 'r', type: 'about', source: 'link', target: 'monitor' }),
      // The old app's shapes, but made now — a bundle opened today, a type defined today: not the old app's either.
      createEntity({ id: 'new-music', type: 'music', data: { provider: 'spotify', spotifyId: 'y' }, meta: { source: 'user' } }),
      createEntity({ id: 'new-display', type: 'display', data: { content: { kind: 'plot', plot: 'p' } } }),
      createEntity({ id: 'new-place', type: 'place', data: { lat: 1, lng: 2 }, meta: { source: 'user' } }),
    ])
    expect(migrateStore(store)).toBe(0)
    expect(store.get('album')?.type).toBe('music')
    expect(store.get('monitor')?.type).toBe('display')
    expect(store.get('r')).toBeDefined()
    expect(store.get('paris')?.type).toBe('place')
    expect(store.get('new-music')?.type).toBe('music')
    expect(store.get('new-display')).toBeDefined()
    expect(store.get('new-place')?.type).toBe('place')
  })

  it('drops the old app’s display compositions, keeping the scenes they named', () => {
    const store = new EntityStore()
    store.upsertMany([
      createEntity({ id: 'scene', type: 'projection', data: {} }),
      createEntity({ id: 'd', type: 'display', data: { content: { kind: 'geometry', layers: [{ id: 'l', kind: 'projection', ref: 'scene' }] } }, meta: old }),
    ])
    expect(migrateStore(store)).toBe(1)
    expect(store.get('d')).toBeUndefined()
    expect(store.get('scene')).toBeDefined()
  })

  it('runs each upgrade once per database: logged, and never again — a bundle opened later is not rewritten', () => {
    const store = new EntityStore()
    const log = memoryLog()
    store.upsert(createEntity({ id: 'm', type: 'music', data: { provider: 'spotify', spotifyId: 'x' }, meta: old }))
    expect(migrateStore(store, log)).toBe(1)
    expect([...log.done]).toEqual([...MIGRATIONS])
    // Something of the old shape arrives afterwards (a stashed bundle of old data opened now): the log says done.
    store.upsert(createEntity({ id: 'm2', type: 'music', data: { provider: 'spotify', spotifyId: 'y' }, meta: old }))
    expect(migrateStore(store, log)).toBe(0)
    expect(store.get('m2')?.type).toBe('music')
  })

  it('a new database is born upgraded: logged without running', () => {
    const store = new EntityStore()
    const log = memoryLog()
    store.upsert(createEntity({ id: 'm', type: 'music', data: { provider: 'spotify', spotifyId: 'x' }, meta: old }))
    expect(migrateStore(store, log, { fresh: true })).toBe(0)
    expect(store.get('m')?.type).toBe('music')
    expect(log.done.size).toBe(MIGRATIONS.length)
  })

  it('keeps the log in a Storage, and tolerates one that fails', () => {
    const mem = new Map<string, string>()
    const log = storageMigrationLog({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) })
    expect(log.has('2026-09-display')).toBe(false)
    log.add('2026-09-display')
    log.add('2026-09-display')
    expect(JSON.parse(mem.get('aegraph:migrations')!)).toEqual(['2026-09-display'])
    expect(storageMigrationLog({ getItem: () => mem.get('aegraph:migrations') ?? null, setItem: () => {} }).has('2026-09-display')).toBe(true)
    const broken = storageMigrationLog({
      getItem: () => 'not json',
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(broken.has('2026-09-display')).toBe(false)
    expect(() => broken.add('2026-09-display')).not.toThrow()
  })
})
