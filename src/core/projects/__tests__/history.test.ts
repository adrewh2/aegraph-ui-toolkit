import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { startAutosave } from '../autosave'
import { MemoryBlobs } from '../historyBlobs'
import { getProjectHistory, memoryPruneLedger, ProjectHistory, PRUNE_AFTER_MS, storagePruneLedger } from '../history'
import { createProject, deleteProject, forkProject } from '../project'
import { canonicalEntityJson, COMMIT_TYPE, diffList, diffProperties, diffText, excalidrawElements, hashEntity, hashInSlices, hunks, isCommitEntity, isImageValue, listCommits, versioningOf } from '../versioning'

const make = () => {
  const store = new EntityStore()
  const p = createProject({ id: 'p1', label: 'One' })
  store.upsert(p)
  store.setScope('p1')
  const a = createEntity({ id: 'a', type: 'note', label: 'A', tags: ['x'], data: { body: 'one\ntwo\nthree' } })
  const b = createEntity({ id: 'b', type: 'note', label: 'B', data: { n: 1, nested: { city: 'Paris', zip: '75' } } })
  const ab = createRelationship({ id: 'ab', type: 'references', source: 'a', target: 'b' })
  store.upsertMany([a, b, ab])
  const history = new ProjectHistory(store, new MemoryBlobs())
  return { store, p, history }
}

beforeEach(() => {
  const mem: Record<string, string> = {}
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k], clear: () => Object.keys(mem).forEach((k) => delete mem[k]) })
})

describe('hashing', () => {
  it('ignores bookkeeping and key order', () => {
    const e = createEntity({ id: 'e', type: 'note', label: 'E', data: { a: 1, b: 2 } })
    const touched = { ...e, meta: { ...e.meta, updatedAt: '2030-01-01T00:00:00Z', accessedAt: 'x', projects: ['p1', 'p2'] } }
    const reordered = { ...e, data: { b: 2, a: 1 } }
    expect(hashEntity(touched)).toBe(hashEntity(e))
    expect(hashEntity(reordered)).toBe(hashEntity(e))
    expect(hashEntity({ ...e, data: { a: 1, b: 3 } })).not.toBe(hashEntity(e))
    expect(hashEntity({ ...e, label: 'F' })).not.toBe(hashEntity(e))
    expect(canonicalEntityJson(e)).not.toContain('updatedAt')
  })
})

describe('property diffs', () => {
  it('reports nested data paths, tags as a whole, and relationship ends', () => {
    const before = createEntity({ id: 'e', type: 'note', label: 'E', tags: ['a'], data: { n: 1, nested: { city: 'Paris', zip: '75' }, gone: true } })
    const after = { ...before, label: 'E2', tags: ['a', 'b'], data: { n: 1, nested: { city: 'Lyon', zip: '75' }, added: 'x' } }
    const changes = diffProperties(before, after)
    expect(changes.map((c) => c.path).sort()).toEqual(['data.added', 'data.gone', 'data.nested.city', 'label', 'tags'])
    expect(changes.find((c) => c.path === 'data.nested.city')).toEqual({ path: 'data.nested.city', before: 'Paris', after: 'Lyon' })
    expect(changes.find((c) => c.path === 'data.gone')).toEqual({ path: 'data.gone', before: true, after: undefined })
    const r1 = createRelationship({ id: 'r', type: 'rel', source: 'a', target: 'b' })
    const r2 = { ...r1, target: { id: 'c' } }
    expect(diffProperties(r1, r2)).toEqual([{ path: 'target', before: { id: 'b' }, after: { id: 'c' } }])
  })

  it('diffs lists of records by id, or by position, and reads Excalidraw scenes', () => {
    const before = [
      { id: 'm1', role: 'user', text: 'hi' },
      { id: 'm2', role: 'assistant', text: 'hello' },
    ]
    const after = [
      { id: 'm1', role: 'user', text: 'hi there' },
      { id: 'm3', role: 'user', text: 'bye' },
    ]
    const d = diffList(before, after)
    expect(d.by).toBe('id')
    expect(d.added.map((x) => x.key)).toEqual(['m3'])
    expect(d.removed.map((x) => x.key)).toEqual(['m2'])
    expect(d.changed[0].changes).toEqual([{ path: 'text', before: 'hi', after: 'hi there' }])
    expect(d.unchanged).toBe(0)
    const p = diffList([{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: 3 }, { a: 4 }])
    expect(p.by).toBeNull()
    expect(p.unchanged).toBe(1)
    expect(p.changed.length).toBe(1)
    expect(p.added.length).toBe(1)
    expect(diffList(undefined, before).added.length).toBe(2)
    const scene = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'e1', type: 'rectangle', x: 0 }, { id: 'e2', type: 'text', text: 'gone', isDeleted: true }] })
    expect(excalidrawElements(scene)?.map((e) => e.id)).toEqual(['e1'])
    expect(excalidrawElements('digraph { a -> b }')).toBeUndefined()
    expect(isImageValue('data.src', 'data:image/png;base64,AAAA')).toBe(true)
    expect(isImageValue('data.src', 'https://x/y.png')).toBe(true)
    expect(isImageValue('data.url', 'https://x/y.png')).toBe(false)
  })

  it('diffs text by line and folds context', () => {
    const d = diffText('a\nb\nc\nd\ne\nf\ng\nh\ni\nj', 'a\nb\nc\nd\nE\nf\ng\nh\ni\nj\nk')
    expect(d.filter((l) => l.op !== ' ').map((l) => `${l.op}${l.text}`)).toEqual(['-e', '+E', '+k'])
    const h = hunks(d, 1)
    expect(h.some((x) => 'skipped' in x && x.skipped === 3)).toBe(true)
    expect(diffText('', 'x').map((l) => l.op)).toEqual(['-', '+'])
    expect(diffText('same', 'same')).toEqual([{ op: ' ', text: 'same' }])
  })
})

describe('commits', () => {
  it('starts with everything as unsaved, then tracks adds, edits and removals', async () => {
    const { store, history } = make()
    let c = await history.changes('p1')
    expect(c.head).toBeUndefined()
    expect(c.added.map((e) => e.id).sort()).toEqual(['a', 'ab', 'b'])

    const first = await history.commit('p1', 'Initial')
    expect(first && isCommitEntity(first)).toBe(true)
    expect(first!.data.stats).toEqual({ added: 3, modified: 0, removed: 0 })
    // Commits live in the Library, not in the project.
    expect(store.projectsOf(first!.id)).toEqual([])
    expect(store.all().some((e) => e.id === first!.id)).toBe(false)
    c = await history.changes('p1')
    expect(c.added.length + c.modified.length + c.removed.length).toBe(0)
    expect(await history.commit('p1', 'nothing')).toBeUndefined()

    store.update('a', { data: { body: 'one\nTWO\nthree' } })
    store.remove('b')
    store.upsert(createEntity({ id: 'c', type: 'note', label: 'C' }))
    c = await history.changes('p1')
    expect(c.added.map((e) => e.id)).toEqual(['c'])
    expect(c.modified.map((e) => e.id)).toEqual(['a'])
    // b and its relationship ab (cascade) are gone, with the content they had.
    expect(c.removed.map((e) => e.id).sort()).toEqual(['ab', 'b'])
    expect(c.removed.find((e) => e.id === 'b')?.label).toBe('B')

    const second = await history.commit('p1', 'Edit a, drop b, add c')
    expect(second!.data.parent).toBe(first!.id)
    expect(second!.data.stats).toEqual({ added: 1, modified: 1, removed: 2 })
    expect(listCommits(store, 'p1').map((x) => x.id)).toEqual([second!.id, first!.id])

    const view = await history.view(second!.id)
    expect(view.modified[0].before?.data.body).toBe('one\ntwo\nthree')
    expect(view.modified[0].after.data.body).toBe('one\nTWO\nthree')
    expect(view.removed.map((e) => e.id).sort()).toEqual(['ab', 'b'])
  })

  it('a re-import with the same content is not a change; a touch is not a change', async () => {
    const { store, history } = make()
    await history.commit('p1', 'Initial')
    const a = store.get('a')!
    store.upsert({ ...a, meta: { ...a.meta, updatedAt: new Date(Date.now() + 1000).toISOString() } })
    store.touch('a')
    const c = await history.count('p1')
    expect(c.total).toBe(0)
  })

  it('restores an earlier commit as a new commit and reverts single entities', async () => {
    const { store, history } = make()
    const first = await history.commit('p1', 'Initial')
    store.update('a', { label: 'A changed' })
    store.remove('b')
    store.upsert(createEntity({ id: 'c', type: 'note', label: 'C' }))
    await history.commit('p1', 'Second')

    const r = await history.restore('p1', first!.id)
    expect(r.commit?.data.restoredFrom).toBe(first!.id)
    expect(store.get('a')?.label).toBe('A')
    expect(store.get('b')?.label).toBe('B')
    expect(store.get('ab')).toBeDefined()
    expect(store.has('c')).toBe(false)
    expect(store.projectsOf('b')).toEqual(['p1'])
    expect((await history.count('p1')).total).toBe(0)
    // The tree at the restore commit equals the tree at the first commit.
    const s1 = await history.stateAt(first!.id)
    const s3 = await history.stateAt(r.commit!.id)
    expect([...s3.keys()].sort()).toEqual([...s1.keys()].sort())

    store.update('a', { label: 'A again' })
    expect(await history.revertEntity('p1', 'a')).toBe('restored')
    expect(store.get('a')?.label).toBe('A')
    store.upsert(createEntity({ id: 'd', type: 'note', label: 'D' }))
    expect(await history.revertEntity('p1', 'd')).toBe('removed')
    expect(store.has('d')).toBe(false)
    expect(await history.revertEntity('p1', 'a')).toBe('unchanged')
  })

  it('an entity in another project too is unmarked, not deleted, on restore', async () => {
    const { store, history } = make()
    const first = await history.commit('p1', 'Initial')
    store.upsert(createProject({ id: 'p2', label: 'Two' }))
    store.upsert(createEntity({ id: 'shared', type: 'note', label: 'S', meta: { projects: ['p1', 'p2'] } }))
    await history.restore('p1', first!.id)
    expect(store.has('shared')).toBe(true)
    expect(store.projectsOf('shared')).toEqual(['p2'])
  })

  it('deleting the project deletes its commits; forget and prune drop the blobs', async () => {
    const { store, history } = make()
    await history.commit('p1', 'Initial')
    store.update('a', { label: 'A2' })
    await history.commit('p1', 'Two')
    expect((await history.blobs.keys()).length).toBe(2)
    store.setScope(null)
    deleteProject(store, 'p1')
    expect(listCommits(store, 'p1')).toEqual([])
    // Seen orphaned once: noted, not deleted. A day on, still orphaned: deleted.
    const t0 = Date.now()
    expect(await history.prune({ now: t0 })).toBe(0)
    expect((await history.blobs.keys()).length).toBe(2)
    expect(await history.prune({ now: t0 + PRUNE_AFTER_MS })).toBe(2)
    expect(await history.blobs.keys()).toEqual([])
  })

  it('prune never deletes a blob on one look: another tab’s commit landing during this start keeps its blob', async () => {
    const { store, history } = make()
    // Another tab has written a commit's blob; its commit entity has not reached this store yet.
    const other = { id: 'elsewhere', project: 'p1', added: [], modified: [], removed: [], hashes: {} }
    await history.blobs.put(other)
    const ledger = memoryPruneLedger()
    const t0 = 1_000_000
    expect(await history.prune({ ledger, now: t0 })).toBe(0)
    expect(await history.blobs.keys()).toEqual(['elsewhere'])
    // Not long after, still without its commit: kept (it has not been orphaned for a day).
    expect(await history.prune({ ledger, now: t0 + 60_000 })).toBe(0)
    // Its commit arrives (the other tab's write, broadcast): struck off the ledger, kept for good.
    store.upsert(createEntity({ id: 'elsewhere', type: COMMIT_TYPE, label: 'Theirs', data: { project: 'p1', parent: null, message: 'Theirs', at: new Date(t0).toISOString(), size: 0, stats: { added: 0, modified: 0, removed: 0 } } }))
    expect(await history.prune({ ledger, now: t0 + 2 * PRUNE_AFTER_MS })).toBe(0)
    expect(ledger.read()).toEqual({})
    expect(await history.blobs.keys()).toEqual(['elsewhere'])
  })

  it('prune keeps its ledger in a Storage shared by the tabs, and skips while another tab prunes', async () => {
    const { store, history } = make()
    await history.commit('p1', 'Initial')
    const [id] = await history.blobs.keys()
    store.remove(id, { cascade: false })
    const mem = new Map<string, string>()
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) }
    expect(await history.prune({ ledger: storagePruneLedger(storage), now: 5 })).toBe(0)
    expect(JSON.parse(mem.get('aegraph:history:orphans')!)).toEqual({ [id]: 5 })
    // Another tab holds the lock: this one does nothing.
    vi.stubGlobal('navigator', { locks: { request: (_n: string, _o: unknown, run: (lock: unknown) => Promise<unknown>) => run(null) } })
    try {
      expect(await history.prune({ ledger: storagePruneLedger(storage), now: 5 + PRUNE_AFTER_MS })).toBe(0)
      expect(await history.blobs.keys()).toEqual([id])
    } finally {
      vi.unstubAllGlobals()
    }
    // A fresh page (a new instance) reads the same ledger: the blob has been orphaned a day, and goes.
    const again = new ProjectHistory(store, history.blobs)
    expect(await again.prune({ ledger: storagePruneLedger(storage), now: 5 + PRUNE_AFTER_MS })).toBe(1)
    expect(mem.has('aegraph:history:orphans')).toBe(false)
  })

  it('forking the Library into a project does not carry commits along', async () => {
    const { store, history } = make()
    await history.commit('p1', 'Initial')
    store.setScope(null)
    const { project } = forkProject(store, null, { label: 'All' })
    expect([...store.markedWith(project.id)].some((id) => isCommitEntity(store.get(id)))).toBe(false)
  })

  it('settings default to autosave on, 30 s', () => {
    const { store } = make()
    expect(versioningOf(store.get('p1') as never)).toEqual({ autosave: true, autosaveDelay: 30 })
    store.update('p1', { data: { versioning: { autosave: false } } })
    expect(versioningOf(store.get('p1') as never).autosave).toBe(false)
  })

  it('shares one history per store', () => {
    const { store } = make()
    expect(getProjectHistory(store)).toBe(getProjectHistory(store))
  })

  it('lists commits in chain order even when the clock cannot tell them apart, and puts a stray line after the chain', async () => {
    const { store, history } = make()
    const now = new Date('2026-09-18T20:00:00.000Z')
    vi.useFakeTimers({ now })
    try {
      const c1 = (await history.commit('p1', 'one'))!
      store.update('a', { label: 'A2' })
      const c2 = (await history.commit('p1', 'two'))!
      store.update('a', { label: 'A3' })
      const c3 = (await history.commit('p1', 'three'))!
      expect(c1.data.at).toBe(c2.data.at) // same millisecond: the clock is no help
      expect(listCommits(store, 'p1').map((c) => c.id)).toEqual([c3.id, c2.id, c1.id])
      expect(history.head('p1')?.id).toBe(c3.id)
      // A commit whose parent is gone (deleted by hand) is still listed, after the chain it fell off.
      const stray = createEntity({ id: 'stray', type: 'project:commit', label: 'stray', data: { project: 'p1', parent: 'gone', message: 'stray', at: '2026-09-18T19:00:00.000Z', size: 0, stats: { added: 0, modified: 0, removed: 0 } } })
      store.upsert(stray)
      expect(listCommits(store, 'p1').map((c) => c.id)).toEqual([c3.id, c2.id, c1.id, 'stray'])
      expect(history.head('p1')?.id).toBe(c3.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts without waiting once the tree is built, and starts the build otherwise', async () => {
    const { store, history } = make()
    expect(history.countSync('p1')).toBeUndefined() // nothing built yet — but the build is on its way
    await history.count('p1')
    expect(history.countSync('p1')).toEqual({ added: 3, modified: 0, removed: 0, total: 3 })
    await history.commit('p1', 'one')
    expect(history.countSync('p1')?.total).toBe(0)
    store.update('a', { label: 'A2' })
    store.remove('b')
    expect(history.countSync('p1')).toEqual({ added: 0, modified: 1, removed: 2, total: 3 })
    expect(history.countSync('nope')).toBeUndefined()
  })

  it('tells one entity\'s story: added, changed with the version replaced, removed', async () => {
    const { store, history } = make()
    const c1 = (await history.commit('p1', 'one'))!
    store.update('a', { label: 'A2', data: { body: 'changed' } })
    const c2 = (await history.commit('p1', 'two'))!
    store.remove('a')
    const c3 = (await history.commit('p1', 'three'))!
    const log = await history.entityLog('p1', 'a')
    expect(log.map((x) => [x.commit.id, x.change])).toEqual([
      [c3.id, 'removed'],
      [c2.id, 'modified'],
      [c1.id, 'added'],
    ])
    expect(log[0].before?.label).toBe('A2')
    expect(log[1].before?.label).toBe('A')
    expect(log[1].after?.label).toBe('A2')
    expect(log[2].after?.label).toBe('A')
    expect(await history.entityLog('p1', 'b')).toHaveLength(1)
    expect(await history.entityLog('p1', 'a', 1)).toHaveLength(1)
    expect(await history.entityLog('p1', 'never')).toEqual([])
    await history.blobs.delete([c2.id])
    const h2 = new ProjectHistory(store, history.blobs)
    expect((await h2.entityLog('p1', 'a')).map((x) => x.change)).toEqual(['removed', 'unknown', 'added'])
  })
})

describe('the working diff between reads', () => {
  it('re-places only the entities touched since, and a write that puts one back as HEAD has it is dropped at commit', async () => {
    const { store, history } = make()
    await history.commit('p1', 'first')
    expect((await history.count('p1')).total).toBe(0)
    // A change, then another write of the same entity: still one modified (no second hash), then a new entity, then a removal.
    store.update('a', { data: { body: 'changed' } })
    expect(await history.count('p1')).toMatchObject({ added: 0, modified: 1, removed: 0 })
    store.update('a', { data: { body: 'changed again' } })
    expect(await history.count('p1')).toMatchObject({ added: 0, modified: 1, removed: 0 })
    store.upsert(createEntity({ id: 'c', type: 'note', label: 'C' }))
    store.remove('b')
    expect(await history.count('p1')).toMatchObject({ added: 1, modified: 1, removed: 2 }) // b and the relationship that went with it
    // Out of the project and back in.
    store.unmark(['c'], 'p1')
    expect(await history.count('p1')).toMatchObject({ added: 0, modified: 1, removed: 2 })
    store.mark(['c'], 'p1')
    expect(await history.count('p1')).toMatchObject({ added: 1, modified: 1, removed: 2 })
    // Back exactly as HEAD has it: the kept diff still counts it, the commit does not.
    store.update('a', { data: { body: 'one\ntwo\nthree' } })
    store.remove('c')
    const c = await history.commit('p1', 'second')
    expect(c?.data.stats).toEqual({ added: 0, modified: 0, removed: 2 })
    expect((await history.count('p1')).total).toBe(0)
    store.update('a', { label: 'A2' })
    expect((await history.count('p1')).total).toBe(1)
    // A revert lands exactly on HEAD and the kept diff knows it without a commit.
    expect(await history.revertEntity('p1', 'a')).toBe('restored')
    expect((await history.count('p1')).total).toBe(0)
    store.update('a', { label: 'A2' })
    expect((await history.count('p1')).total).toBe(1)
    expect((await history.commit('p1', 'third'))?.data.stats).toEqual({ added: 0, modified: 1, removed: 0 })
    expect((await history.count('p1')).total).toBe(0)
  })
})

describe('autosave', () => {
  it('commits after the project has been quiet, and not when autosave is off', async () => {
    vi.useFakeTimers()
    try {
      const { store, history } = make()
      store.update('p1', { data: { versioning: { autosave: true, autosaveDelay: 1 } } })
      const stop = startAutosave(store, history)
      store.upsert(createEntity({ id: 'z', type: 'note', label: 'Z' }))
      expect(listCommits(store, 'p1')).toEqual([])
      await vi.advanceTimersByTimeAsync(1500)
      const commits = listCommits(store, 'p1')
      expect(commits.length).toBe(1)
      expect(commits[0].data.auto).toBe(true)
      expect(commits[0].data.stats.added).toBe(4)
      // A commit entity landing is not itself a change to the tree.
      await vi.advanceTimersByTimeAsync(3000)
      expect(listCommits(store, 'p1').length).toBe(1)

      store.update('p1', { data: { versioning: { autosave: false } } })
      store.update('z', { label: 'Z2' })
      await vi.advanceTimersByTimeAsync(5000)
      expect(listCommits(store, 'p1').length).toBe(1)
      expect((await history.count('p1')).modified).toBe(1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an autosave that fails is told to the app, and cleared by the next one that lands', async () => {
    vi.useFakeTimers()
    try {
      const { store, history } = make()
      store.update('p1', { data: { versioning: { autosave: true, autosaveDelay: 1 } } })
      const put = history.blobs.put.bind(history.blobs)
      let refuse = true
      history.blobs.put = (blob) => (refuse ? Promise.reject(new Error('QuotaExceededError')) : put(blob))
      const told: unknown[] = []
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const stop = startAutosave(store, history, { onFailure: (f) => told.push(f) })
      store.upsert(createEntity({ id: 'z', type: 'note', label: 'Z' }))
      await vi.advanceTimersByTimeAsync(1500)
      expect(told).toEqual([{ project: 'p1', message: 'QuotaExceededError' }])
      refuse = false
      store.update('z', { label: 'Z2' })
      await vi.advanceTimersByTimeAsync(1500)
      expect(told).toEqual([{ project: 'p1', message: 'QuotaExceededError' }, null])
      expect(listCommits(store, 'p1').length).toBe(1)
      stop()
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a big commit does not stop the page', () => {
  it('hashes a slice at a time, yielding between slices, and gives every entity its hash in order', async () => {
    const list = Array.from({ length: 3000 }, (_, i) => createEntity({ id: `h${i}`, type: 'thing', label: `h${i}` }))
    const seen: string[] = []
    let yields = 0
    const real = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      yields++
      return real(fn, ms)
    }) as typeof setTimeout)
    try {
      await hashInSlices(list, (e, h) => seen.push(`${e.id}:${h}`), 0)
    } finally {
      spy.mockRestore()
    }
    expect(seen).toHaveLength(3000)
    expect(seen[0]).toBe(`h0:${hashEntity(list[0])}`)
    expect(yields).toBeGreaterThan(5)
  })

  it('runs one commit per project at a time: an autosave landing during a commit waits, then finds nothing left', async () => {
    const store = new EntityStore()
    store.upsert(createProject({ id: 'p', label: 'P' }))
    store.setScope('p')
    store.upsertMany(Array.from({ length: 500 }, (_, i) => createEntity({ id: `c${i}`, type: 'thing', label: `c${i}` })))
    const history = new ProjectHistory(store, new MemoryBlobs())
    const [a, b] = await Promise.all([history.commit('p', 'mine'), history.commit('p', 'Autosave', { auto: true })])
    expect(a?.data.stats.added).toBe(500)
    expect(b).toBeUndefined()
    expect(listCommits(store, 'p')).toHaveLength(1)
  })
})

describe('memory: a big history is not held in the page', () => {
  it('rebuilds HEAD after a reload from ids and hashes, never the commits’ content', async () => {
    const { store, history } = make()
    await history.commit('p1', 'first')
    store.upsert({ ...store.get('a')!, label: 'A2' })
    await history.commit('p1', 'second')
    // A reload: a new history over the same store and blobs, with nothing cached.
    const blobs = history.blobs as MemoryBlobs
    const get = vi.spyOn(blobs, 'get')
    const again = new ProjectHistory(store, blobs)
    expect((await again.count('p1')).total).toBe(0)
    expect(get).not.toHaveBeenCalled()
    // The tree's keys are the store's own id strings, not copies read back from the blobs.
    const tree = await again.tree('p1')
    expect([...tree.keys()].sort()).toEqual(['a', 'ab', 'b'])
    // A store without `hashes` is still read through `get`.
    const plain = { get: (id: string) => blobs.get(id), put: (b: Parameters<MemoryBlobs['put']>[0]) => blobs.put(b), delete: (ids: string[]) => blobs.delete(ids), keys: () => blobs.keys() }
    expect((await new ProjectHistory(store, plain).count('p1')).total).toBe(0)
  })

  it('does not hold a commit bigger than the budget after making it, and keeps one read back only for the burst', async () => {
    vi.useFakeTimers()
    try {
      const store = new EntityStore()
      store.upsert(createProject({ id: 'big', label: 'Big' }))
      store.setScope('big')
      store.upsertMany(Array.from({ length: 50_001 }, (_, i) => createEntity({ id: `t${i}`, type: 'tree', label: `t${i}` })))
      const history = new ProjectHistory(store, new MemoryBlobs())
      const c = await history.commit('big', 'all of it')
      const cache = (history as unknown as { blobCache: Map<string, unknown> }).blobCache
      // The first commit of a big project is the project: it is on disk, not held here as a second copy.
      expect(cache.has(c!.id)).toBe(false)
      // Still readable: it comes back from the blob store when asked, and is held for the burst of reads that follow.
      expect((await history.view(c!.id)).added).toHaveLength(50_001)
      expect(cache.has(c!.id)).toBe(true)
      vi.advanceTimersByTime(16_000)
      expect(cache.has(c!.id)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)
})

describe('the working diff, kept a bit per entity', () => {
  it('counts what changed since HEAD through edits, removals and an entity removed and written again — as a full diff would', async () => {
    const { store, history } = make()
    await history.commit('p1', 'first')
    expect(await history.count('p1')).toMatchObject({ added: 0, modified: 0, removed: 0 })
    store.upsert({ ...store.get('a')!, label: 'A2' }) // modified
    store.upsert(createEntity({ id: 'c', type: 'note', label: 'C' })) // added
    store.remove('b', { cascade: false }) // removed…
    store.upsert(createEntity({ id: 'b', type: 'note', label: 'B again' })) // …and back, changed: modified, not added
    store.upsert(createEntity({ id: 'd', type: 'note', label: 'D' }))
    store.remove('d') // added and removed again: nothing
    const counted = await history.count('p1')
    expect(counted).toMatchObject({ added: 1, modified: 2, removed: 0, total: 3 })
    // A fresh history over the same store and chain diffs it whole: the same answer.
    const fresh = new ProjectHistory(store, (history as unknown as { blobs: MemoryBlobs }).blobs)
    expect(await fresh.count('p1')).toEqual(counted)
    const changes = await history.changes('p1')
    expect([changes.added.map((e) => e.id), changes.modified.map((e) => e.id).sort()]).toEqual([['c'], ['a', 'b']])
    // Committed: nothing left, and no bit of the old `b` stays behind to be counted again.
    await history.commit('p1', 'second')
    expect(await history.count('p1')).toMatchObject({ added: 0, modified: 0, removed: 0, total: 0 })
    store.remove('c')
    expect(await history.count('p1')).toMatchObject({ added: 0, modified: 0, removed: 1 })
  })

  it('takes a write of most of the project as a reason to diff again whole, with the same result', async () => {
    const { store, history } = make()
    await history.commit('p1', 'first')
    await history.count('p1')
    store.upsertMany(Array.from({ length: 60_000 }, (_, i) => createEntity({ id: `n${i}`, type: 'note', label: `N${i}` })))
    store.upsert({ ...store.get('a')!, label: 'A2' })
    expect(await history.count('p1')).toMatchObject({ added: 60_000, modified: 1, removed: 0 })
  }, 30_000)
})
