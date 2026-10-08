import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../entity/entity'
import type { AnyEntity } from '../../../entity/types'
import { ByteReader, ByteWriter, StringTable } from '../bytes'
import { isPacked, packDocument, peekPack, unpackDocument } from '../pack'
import { MAX_DATA_DEPTH, MAX_STORED_DEPTH } from '../../limits'

/**
 * The pack at its edges: integers at the varint's limits and beyond,
 * every float kind, deep and empty containers, strings the table must
 * slice right (emoji, empty, repeated), dates the delta path takes and
 * the ones it leaves as text (no millis, an offset, a year below 100),
 * an entity with nothing optional and one with everything, a null label,
 * a relationship without a direction, the bundle keys present or absent,
 * an empty document, junk, gzip, a truncated pack and a stranger version.
 */
const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const roundTrip = (entities: AnyEntity[]) => unpackDocument(packDocument({ entities })).entities
const one = (data: Record<string, unknown>) => roundTrip([createEntity({ id: 'e', data })])[0].data
const PARTY = String.fromCodePoint(0x1f389)
const SMILE = String.fromCodePoint(0x1f600)
const ACUTE = 'a' + String.fromCharCode(0x301)

describe('pack edges', () => {
  it('carries integers to the varint limit and past it as floats, every float kind, and containers deep and empty', () => {
    const d = one({ a: 2 ** 52 - 1, b: 2 ** 52, c: -(2 ** 52), d: 2 ** 53 + 2, e: 1e21, f: -(2 ** 60), g: 5e-324, h: 1.7976931348623157e308, i: 0.1 + 0.2, j: -0, k: [], l: {}, m: [[[[]]]], n: { o: { p: { q: [null, [{}]] } } } })
    expect(d).toEqual({ a: 2 ** 52 - 1, b: 2 ** 52, c: -(2 ** 52), d: 2 ** 53 + 2, e: 1e21, f: -(2 ** 60), g: 5e-324, h: 1.7976931348623157e308, i: 0.1 + 0.2, j: 0, k: [], l: {}, m: [[[[]]]], n: { o: { p: { q: [null, [{}]] } } } })
    expect(Object.is(d.j, 0)).toBe(true) // -0 is 0, as in JSON
    // Deep up to `MAX_DATA_DEPTH` (the data object is the first level); past it, a file is refused and what the app stored itself still reads.
    const nest = (levels: number) => {
      const top: unknown[] = []
      let cur = top
      for (let i = 1; i < levels; i++) cur.push((cur = []))
      return top
    }
    expect(one({ deep: nest(MAX_DATA_DEPTH - 1) }).deep).toEqual(nest(MAX_DATA_DEPTH - 1))
    const deep = packDocument({ entities: [createEntity({ id: 'e', data: { deep: nest(500) } })] })
    expect(() => unpackDocument(deep)).toThrow(/nested deeper than 64/)
    expect(unpackDocument(deep, { maxDepth: MAX_STORED_DEPTH }).entities[0].data.deep).toEqual(nest(500))
  })

  it('slices the string table right around emoji, empty and repeated strings, and stores each distinct string once', () => {
    const w = new ByteWriter(16)
    const t = new StringTable()
    const ids = [PARTY, '', `a${PARTY}b`, 'plain', PARTY, ACUTE, SMILE + SMILE, ''].map((s) => t.id(s))
    expect(ids).toEqual([0, 1, 2, 3, 0, 4, 5, 1])
    t.write(w)
    expect(StringTable.read(new ByteReader(w.result()))).toEqual([PARTY, '', `a${PARTY}b`, 'plain', ACUTE, SMILE + SMILE])
    const e = createEntity({ id: 'x', type: 'x', label: 'x', tags: ['x'], data: { x: 'x', y: ['x', 'x'] } })
    expect(peekPack(packDocument({ entities: [e], tags: [{ tag: 'x' }] })).strings).toBeLessThanOrEqual(6) // x once, plus the keys and header words
    expect(roundTrip([e])).toEqual(viaJson([e]))
  })

  it('takes the delta path for ISO instants with millis and leaves the rest as text, unchanged, including a year below 100', () => {
    const times = ['2024-01-02T03:04:05.678Z', '2024-01-02T03:04:05Z', '2024-01-02T03:04:05.678+00:00', '2024-02-29T00:00:00.000Z', '2023-02-29T00:00:00.000Z', '0099-06-15T12:00:00.000Z', '9999-12-31T23:59:59.999Z', '2024-13-01T00:00:00.000Z', '', 'yesterday']
    const entities = times.map((t, i) => createEntity({ id: `e${i}`, meta: { createdAt: t, updatedAt: t } }))
    // Then older than everything before: the deltas go negative and come back.
    entities.push(createEntity({ id: 'old', meta: { createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1969-12-31T23:59:59.000Z' } }))
    const back = roundTrip(entities).map((e) => [e.meta.createdAt, e.meta.updatedAt])
    expect(back).toEqual([...times.map((t) => [t, t]), ['1970-01-01T00:00:00.000Z', '1969-12-31T23:59:59.000Z']])
  })

  it('writes an entity with nothing optional and one with everything, a null label as none, and a relationship with no direction as undirected', () => {
    const bare: AnyEntity = { id: 'b', kind: 'entity', type: 'entity', tags: [], data: {}, meta: { createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' } }
    const full = createEntity({ id: 'f', type: 'note', label: 'L', description: 'D', tags: ['t1', 't2'], data: { k: 1 }, meta: { source: 'x', createdBy: 'me', accessedAt: '2024-01-03T00:00:00.000Z', projects: ['p'], derivedFrom: { id: 'b' } } })
    const rel = createRelationship({ id: 'r', type: 'r', source: 'b', target: 'f', label: 'l', directed: true, data: {} })
    const out = roundTrip([bare, full, rel])
    expect(out).toEqual(viaJson([bare, full, rel]))
    expect(Object.keys(out[0])).toEqual(['id', 'kind', 'type', 'tags', 'data', 'meta'])
    // A label comes in its place in the literal, not added after: the entities with one share a class of their own.
    expect(Object.keys(out[2])).toEqual(['id', 'kind', 'type', 'label', 'tags', 'data', 'meta', 'source', 'target', 'directed'])
    // Departures from JSON, by design: a null label is no label; a relationship without `directed` is undirected; a missing meta reads as the epoch (a date is always a string).
    const odd = roundTrip([{ ...bare, id: 'n', label: null as unknown as string } as AnyEntity, { ...rel, id: 'u', directed: undefined as unknown as boolean }, { ...bare, id: 'm', meta: undefined as never }])
    expect(odd[0]).not.toHaveProperty('label')
    expect(odd[1].kind === 'relationship' && odd[1].directed).toBe(false)
    expect(odd[2].meta).toEqual({ createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z' })
  })

  it('keeps the bundle keys when given and leaves them out when not, an empty document included', () => {
    const empty = unpackDocument(packDocument({ entities: [] }))
    expect(empty.entities).toEqual([])
    expect(empty.tags).toEqual([])
    expect(empty.project).toBeUndefined()
    expect(empty.state).toBeUndefined()
    expect(empty.exportedAt).toMatch(/^\d{4}-/)
    expect(peekPack(packDocument({ entities: [] }))).toMatchObject({ entities: 0, project: undefined })
    const withKeys = unpackDocument(packDocument({ entities: [], exportedAt: 'when', tags: [{ tag: 'a' }, { tag: 'b', color: '#fff', description: 'd' }], project: 'p', state: { route: '/x' } }))
    expect(withKeys).toEqual({ entities: [], exportedAt: 'when', tags: [{ tag: 'a' }, { tag: 'b', color: '#fff', description: 'd' }], project: 'p', state: { route: '/x' } })
  })

  it('recognises only a pack with room for a header, refuses junk, gzip, a truncated pack and a version it does not read — without hanging', () => {
    const enc = new TextEncoder()
    expect(isPacked(enc.encode('AEPK'))).toBe(false)
    expect(isPacked(new Uint8Array([...enc.encode('AEPK'), 1]))).toBe(false)
    expect(isPacked(new Uint8Array([...enc.encode('AEPK'), 1, 0]))).toBe(true)
    expect(isPacked(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]))).toBe(false)
    expect(isPacked(new Uint8Array())).toBe(false)
    const bytes = packDocument({ entities: [createEntity({ id: 'a', data: { k: 'v'.repeat(50) } })] })
    for (const n of [6, 8, 20, bytes.length - 1]) expect(() => unpackDocument(bytes.subarray(0, n)), `${n} bytes`).toThrow(/Corrupt pack/)
    const older = new Uint8Array(bytes)
    older[4] = 0
    expect(() => unpackDocument(older)).toThrow(/version 0.*reads version 1/)
    const newer = new Uint8Array(bytes)
    newer[4] = 2
    expect(() => unpackDocument(newer)).toThrow(/version 2.*reads version 1/)
  })
})

/**
 * A pack from outside: built by hand, byte by byte, to say what the encoder never would. Each is refused or comes
 * out in the app's shape — never an entity without an id, a tag that is not a string, a prototype set from a key,
 * or a count from the file taken at its word.
 */
describe('a pack from outside', () => {
  const NOW = '2024-01-01T00:00:00.000Z'
  /** A pack with the given strings, an empty header and the entity records `body` writes. */
  const craft = (strings: string[], count: number, body: (w: ByteWriter) => void) => {
    const w = new ByteWriter()
    for (const b of [0x41, 0x45, 0x50, 0x4b, 1, 0]) w.u8(b)
    w.uvar(strings.length)
    for (const x of strings) w.uvar(x.length)
    const at = w.reserve(4)
    const start = w.pos
    w.utf8(strings.join(''))
    w.u32At(at, w.pos - start)
    w.uvar(0)
    w.u8(7) // header: an empty map
    w.uvar(0)
    w.uvar(count)
    body(w)
    return w.result().slice()
  }
  const STR = ['id-1', 'note', NOW, '__proto__', 'polluted', 'projects', 'p', 'source']
  const date = (w: ByteWriter) => (w.u8(0), w.u8(5), w.uvar(2)) // a date written as a value: the string NOW

  it('refuses a string table whose lengths run past its bytes, at once (seventeen bytes once span for seconds)', () => {
    const w = new ByteWriter()
    for (const b of [0x41, 0x45, 0x50, 0x4b, 1, 0]) w.u8(b)
    w.uvar(1)
    w.uvar(3e8)
    const at = w.reserve(4)
    w.u32At(at, 1)
    w.u8(0x80)
    const t0 = performance.now()
    expect(() => unpackDocument(w.result().slice())).toThrow(/string table is shorter/)
    expect(performance.now() - t0).toBeLessThan(100)
    // A count of strings the file cannot hold is refused before anything is sized by it.
    const many = new ByteWriter()
    for (const b of [0x41, 0x45, 0x50, 0x4b, 1, 0]) many.u8(b)
    many.uvar(2 ** 40)
    expect(() => unpackDocument(many.result().slice())).toThrow(/string table of/)
  })

  it('refuses a string index outside the table, an entity with no id, and counts the bytes left cannot hold', () => {
    expect(() => unpackDocument(craft(STR, 1, (w) => (w.u8(0), w.uvar(999), w.uvar(1), w.uvar(0), date(w), date(w))))).toThrow(/string 999 of 8/)
    expect(() => unpackDocument(craft(['', 'note', NOW], 1, (w) => (w.u8(0), w.uvar(0), w.uvar(1), w.uvar(0), date(w), date(w))))).toThrow(/no id/)
    expect(() => unpackDocument(craft(STR, 1, (w) => (w.u8(0), w.uvar(0), w.uvar(1), w.uvar(2 ** 40))))).toThrow(/a count of/)
    expect(() => unpackDocument(craft(STR, 2 ** 30, () => {}))).toThrow(/entities/)
    expect(() => unpackDocument(craft(STR, 6_000_000, () => {}))).toThrow(/more than the 5,000,000/)
    // An array claiming more items than there are bytes left.
    expect(() => unpackDocument(craft(STR, 1, (w) => (w.u8(128), w.uvar(0), w.uvar(1), w.uvar(0), date(w), date(w), w.uvar(1), w.uvar(4), w.u8(6), w.uvar(1e9))))).toThrow(/a count of/)
  })

  it('reads a __proto__ key as nothing, drops meta.projects that is not a list of strings and meta strings that are not strings, and makes any other date the epoch', () => {
    const bytes = craft(STR, 1, (w) => {
      w.u8(128 | 8) // data and meta
      w.uvar(0)
      w.uvar(1)
      w.uvar(1) // one tag
      w.uvar(6)
      w.u8(0) // createdAt: a value, an integer
      w.u8(3)
      w.svar(5)
      w.u8(0) // updatedAt: a value, a map
      w.u8(7)
      w.uvar(0)
      w.uvar(3) // meta: projects = 'p' (not a list), source = 7 (not a string), __proto__ = { polluted }
      w.uvar(5)
      w.u8(5)
      w.uvar(6)
      w.uvar(7)
      w.u8(3)
      w.svar(7)
      w.uvar(3)
      w.u8(7)
      w.uvar(1)
      w.uvar(4)
      w.u8(2)
      w.uvar(1) // data: __proto__ = { polluted: true }
      w.uvar(3)
      w.u8(7)
      w.uvar(1)
      w.uvar(4)
      w.u8(2)
    })
    const [e] = unpackDocument(bytes).entities
    expect(e).toMatchObject({ id: 'id-1', type: 'note', tags: ['p'] })
    expect(e.meta).toEqual({ createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z' })
    expect(Object.getPrototypeOf(e.data)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(e.meta)).toBe(Object.prototype)
    expect((e.data as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses values nested past the bound however the file nests them, the header included', () => {
    const w = new ByteWriter()
    for (const b of [0x41, 0x45, 0x50, 0x4b, 1, 0]) w.u8(b)
    w.uvar(0)
    const at = w.reserve(4)
    w.u32At(at, 0)
    w.uvar(0)
    for (let i = 0; i < 100_000; i++) {
      w.u8(6)
      w.uvar(1)
    }
    w.u8(0)
    expect(() => unpackDocument(w.result().slice())).toThrow(/nested deeper than 64/)
  })
})
