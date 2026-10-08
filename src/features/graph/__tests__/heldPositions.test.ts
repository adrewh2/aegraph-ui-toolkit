import { describe, expect, it, vi } from 'vitest'
import { LOCAL_CAP, pack, prefetchHeldPositions, readHeldPositionsSync, saveHeldPositionsPacked, sessionsToRestore, unpack } from '../heldPositions'

describe('held positions', () => {
  it('packs positions to typed arrays and back, keeping z only when some node has one', () => {
    const flat = { a: { x: 1, y: 2 }, b: { x: -3.5, y: 4 } }
    const p = pack('k', flat)
    expect(p.count).toBe(2)
    expect(p.dims).toBe(2)
    expect(Array.from(p.xyz)).toEqual([1, 2, 0, -3.5, 4, 0])
    expect(unpack(p)).toEqual(flat)
    const deep = { a: { x: 1, y: 2, z: 3 }, b: { x: 0, y: 0 } }
    const q = pack('k', deep)
    expect(q.dims).toBe(3)
    expect(unpack(q)).toEqual({ a: { x: 1, y: 2, z: 3 }, b: { x: 0, y: 0, z: 0 } })
  })
  it('reads the synchronous half: positions, a pending marker, or nothing', () => {
    expect(readHeldPositionsSync(null)).toBeNull()
    expect(readHeldPositionsSync('garbage')).toBeNull()
    expect(readHeldPositionsSync(JSON.stringify({ positions: { a: { x: 1, y: 1 } } }))).toEqual({ positions: { a: { x: 1, y: 1 } } })
    expect(readHeldPositionsSync(JSON.stringify({ idb: true, count: 31000 }))).toEqual({ pending: 31000 })
    expect(LOCAL_CAP).toBe(1000)
  })
  it('a small set handed over packed lands in localStorage, as the ordinary save writes it', async () => {
    // The live-simulation path (`saveHeldPositionsPacked`) is the same store for small sets: the view writes
    // from the engine's arrays, and a reload reads what it always read.
    const held = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
      removeItem: (k: string) => void held.delete(k),
    })
    const key = 'test:held:small'
    await saveHeldPositionsPacked(key, { ids: ['a', 'b'], xyz: Float32Array.from([1, 2, 0, 3, 4, 0]), dims: 2, count: 2 })
    expect(readHeldPositionsSync(localStorage.getItem(key))).toEqual({ positions: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } } })
    // Nothing held is nothing kept.
    await saveHeldPositionsPacked(key, { ids: [], xyz: new Float32Array(0), dims: 2, count: 0 })
    expect(localStorage.getItem(key)).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('explorer sessions nothing refers to are let go', () => {
  const memory = (init: Record<string, string>): Storage => {
    const m = new Map(Object.entries(init))
    return {
      get length() {
        return m.size
      },
      key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
    }
  }

  it('removes a closed tab’s keys, keeps an open tab’s, and never touches the unscoped keys', async () => {
    const { sweepExplorerSessions } = await import('../heldPositions')
    const s = memory({
      'aegraph:workstation:v1': JSON.stringify({ tabs: [{ path: '/unigraph/2d', session: 'open1' }] }),
      'aegraph:ui:project:p1': JSON.stringify({ 'aegraph:workstation:v1': '{"session":"stash2"}' }),
      'aegraph:explorer:v1': '{"unscoped":true}',
      'aegraph:explorer:v1:open1': '{}',
      'aegraph:explorer:positions:v1:open1': '{"idb":true,"count":5000}',
      'aegraph:explorer:v1:stash2': '{}',
      'aegraph:explorer:v1:gone3': '{}',
      'aegraph:explorer:positions:v1:gone3': '{"idb":true,"count":9000}',
      'aegraph:explorer:detail-tabs:gone3': '["a"]',
    })
    const removed = sweepExplorerSessions(s, [memory({})])
    expect(removed).toEqual(['aegraph:explorer:positions:v1:gone3'])
    const left = Array.from({ length: s.length }, (_, i) => s.key(i)).sort()
    expect(left).toEqual(['aegraph:explorer:positions:v1:open1', 'aegraph:explorer:v1', 'aegraph:explorer:v1:open1', 'aegraph:explorer:v1:stash2', 'aegraph:ui:project:p1', 'aegraph:workstation:v1'])
  })

  it('keeps a session a pick in sessionStorage still names', async () => {
    const { sweepExplorerSessions } = await import('../heldPositions')
    const s = memory({ 'aegraph:explorer:v1:held9': '{}' })
    expect(sweepExplorerSessions(s, [memory({ 'aegraph:pick:x': '{"session":"held9"}' })])).toEqual([])
    expect(s.getItem('aegraph:explorer:v1:held9')).toBe('{}')
  })
})

describe('what a reload restores early', () => {
  const storage = (entries: Record<string, string>) => ({
    getItem: (k: string) => entries[k] ?? null,
    key: (i: number) => Object.keys(entries)[i] ?? null,
    get length() {
      return Object.keys(entries).length
    },
  })

  it('finds the sessions a reload will show: the address, and the tab in front in each pane — not the ones behind', () => {
    const ws = { ws: { root: { kind: 'split', children: [{ kind: 'pane', tabs: [{ path: '/unigraph/2d?session=front1' }, { path: '/unigraph/3d?session=behind' }], active: 0 }, { kind: 'pane', tabs: [{ path: '/documents/x' }, { path: '/unigraph/2d?session=front2' }], active: 1 }] } } }
    const s = storage({ 'aegraph:workstation:v1': JSON.stringify(ws), 'aegraph:unigraph:v1': JSON.stringify({ tabs: [{ path: '/unigraph/2d?session=host1' }], active: 0 }), 'aegraph:explorer:v1:zzz': JSON.stringify({ tabs: [{ path: '/unigraph/2d?session=nope' }], active: 0 }) })
    expect(sessionsToRestore('http://x/unigraph/2d?session=addr&x=1', s).sort()).toEqual(['addr', 'front1', 'front2', 'host1'])
    expect(sessionsToRestore('http://x/documents', storage({ 'aegraph:workstation:v1': 'not json' }))).toEqual([])
  })

  it('reads nothing ahead for a session whose positions are not in IndexedDB', () => {
    expect(prefetchHeldPositions(['k1', 'k2'], storage({ k1: JSON.stringify({ positions: { a: { x: 1, y: 2 } } }) }))).toEqual([])
  })
})
