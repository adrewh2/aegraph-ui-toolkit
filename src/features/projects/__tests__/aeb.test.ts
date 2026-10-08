import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { exportToBlob } from '../../../core/exchange/export'
import { readPack } from '../../../core/exchange/import'
import { buildBundle } from '../../../core/projects/bundle'
import { createProject } from '../../../core/projects/project'
import { openBundleBytes } from '../projectActions'

beforeEach(() => {
  const mem: Record<string, string> = {}
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k], clear: () => Object.keys(mem).forEach((k) => delete mem[k]) })
})

describe('.aeb bundles', () => {
  it('saves a project as a gzipped pack and opens it from the bytes', async () => {
    const store = new EntityStore()
    store.upsertMany([createEntity({ id: 'a', type: 'note', label: 'A' }), createEntity({ id: 'b', type: 'note', label: 'B' }), createRelationship({ id: 'ab', type: 'references', source: 'a', target: 'b' })])
    const p = createProject({ id: 'p1', label: 'One' })
    store.upsert(p)
    store.mark(['a', 'b'], p.id)
    const doc = buildBundle(store, p.id, { route: '/graph' })
    const r = await exportToBlob({ entities: doc.entities, tags: doc.tags, project: doc.project, state: doc.state }, { format: 'pack' }, 'one')
    expect(r.filename).toBe('one.aeb')
    const bytes = new Uint8Array(await r.blob.arrayBuffer())
    expect(bytes[0]).toBe(0x1f) // gzipped
    const back = await readPack(bytes)
    expect(back.project).toBe('p1')
    expect(back.entities.map((e) => e.id).sort()).toEqual(['a', 'ab', 'b', 'p1'])

    const other = new EntityStore()
    const report = await openBundleBytes(other, bytes, 'one')
    expect(report.project.id).toBe('p1')
    expect(report.route).toBe('/graph')
    expect([...other.scopeOf('p1')].sort()).toEqual(['a', 'ab', 'b'])
    // The same bytes as JSON text still open.
    const json = await exportToBlob({ entities: doc.entities, tags: doc.tags, project: doc.project, state: doc.state }, { format: 'json', gzip: true }, 'one')
    const third = new EntityStore()
    expect((await openBundleBytes(third, new Uint8Array(await json.blob.arrayBuffer()), 'one')).project.id).toBe('p1')
  })
})

describe('an opened .aeb, saved in this browser', () => {
  /** A gzipped pack of a project and `n` notes; `marked`: the notes already carry the project, as a bundle the app writes does. */
  async function pack(n: number, marked: boolean) {
    const { packDocument } = await import('../../../core/exchange/pack/pack')
    const { gzipSync } = await import('node:zlib')
    const p = createProject({ id: 'p1', label: 'One' })
    const notes = Array.from({ length: n }, (_, i) => createEntity({ id: `n${i}`, type: 'note', label: `Note ${i}`, data: { i }, meta: marked ? { projects: ['p1'] } : undefined }))
    return new Uint8Array(gzipSync(packDocument({ entities: [p, ...notes], project: 'p1' })))
  }
  async function pages(): Promise<{ file: boolean; packed: boolean }[]> {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('aegraph', 2)
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const all = await new Promise<{ file?: Blob; packed?: ArrayBuffer }[]>((res) => {
      const r = db.transaction('pages', 'readonly').objectStore('pages').getAll()
      r.onsuccess = () => res(r.result)
    })
    db.close()
    return all.map((p) => ({ file: !!p.file, packed: !!p.packed }))
  }
  async function setup() {
    const { IDBFactory } = await import('fake-indexeddb')
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('BroadcastChannel', undefined)
    const { Persistence } = await import('../../../core/entity/persistence')
    const store = new EntityStore()
    const persistence = new Persistence()
    await persistence.load(store)
    persistence.attach(store)
    const reread = async () => {
      const again = new EntityStore()
      await new Persistence().load(again)
      return again
    }
    return { store, persistence, reread, Persistence }
  }

  it('is kept as the file it was — one page, not the entities packed again — and reads back the same', async () => {
    const { store, persistence, reread } = await setup()
    const bytes = await pack(1200, true)
    await openBundleBytes(store, bytes, 'one')
    await persistence.flush()
    expect(await pages()).toEqual([{ file: true, packed: false }])
    const back = await reread()
    expect(back.library.all().length).toBe(1201)
    expect(back.get('n7')).toMatchObject({ label: 'Note 7', data: { i: 7 }, meta: { projects: ['p1'] } })
    expect([...back.scopeOf('p1')].length).toBe(1200)
  })

  it('is kept as the file when a few entities change on the way in — they are written after it, and win', async () => {
    const { store, persistence, reread } = await setup()
    const { packDocument } = await import('../../../core/exchange/pack/pack')
    const { gzipSync } = await import('node:zlib')
    const p = createProject({ id: 'p1', label: 'One' })
    const notes = Array.from({ length: 1200 }, (_, i) => createEntity({ id: `n${i}`, type: 'note', label: `Note ${i}`, meta: { projects: ['p1'] } }))
    // One the file does not mark (the demos' opening workstation was one): the open marks it, a copy.
    const loose = createEntity({ id: 'loose', type: 'workstation', label: 'Opening' })
    await openBundleBytes(store, new Uint8Array(gzipSync(packDocument({ entities: [p, ...notes, loose], project: 'p1' }))), 'one')
    await persistence.flush()
    const kept = await pages()
    expect(kept.filter((x) => x.file)).toHaveLength(1)
    const back = await reread()
    expect(back.library.all().length).toBe(1202)
    expect(back.get('loose')?.meta.projects).toEqual(['p1'])
  })

  it('is written the ordinary way when the store did not take the file as it was: a merge into an open project, notes to be marked', async () => {
    const { store, persistence, reread } = await setup()
    // Not marked: the open copies every note to mark it, so the file no longer says what the store holds.
    await openBundleBytes(store, await pack(1200, false), 'one')
    await persistence.flush()
    expect((await pages()).every((p) => p.packed && !p.file)).toBe(true)
    // Opened again over itself: a merge, written the ordinary way too (nothing new here: nothing written at all).
    const before = (await pages()).length
    await openBundleBytes(store, await pack(1200, true), 'one')
    await persistence.flush()
    expect((await pages()).slice(before).every((p) => !p.file)).toBe(true)
    const back = await reread()
    expect(back.get('n1199')).toMatchObject({ label: 'Note 1199' })
    expect([...back.scopeOf('p1')].length).toBe(1200)
  })
})
