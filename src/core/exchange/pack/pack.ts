import type { AegraphDocument, AnyEntity, EntityMeta, EntityRef, Relationship, TagInfo } from '../../entity/types'
import { ByteReader, ByteWriter, StringTable } from './bytes'
import { MAX_DATA_DEPTH, MAX_PACK_ENTITIES, MAX_PACK_VALUES } from '../limits'

/**
 * The packed form of an aegraph document — the same information as
 * `.ae.json`, as bytes built for speed and size:
 *
 *  - every string once, in a table decoded with one call (ids, types, tags,
 *    labels, data keys and values alike — keys of `data` cost a byte or two
 *    per entity instead of a quoted name each);
 *  - fixed fields as flags and varints: kind, directedness and which
 *    optional fields are present are bits; dates are millisecond deltas;
 *  - `data` and the rare meta fields as a small tagged-value encoding
 *    (null, booleans, integers, floats, strings, arrays, maps) with the
 *    same semantics as JSON (undefined dropped from maps, null in arrays,
 *    NaN → null, toJSON honoured), so a round trip through the pack matches
 *    a round trip through JSON exactly — except that a lone surrogate, which
 *    UTF-8 cannot carry, comes back as U+FFFD.
 *
 * Layout: magic `AEPK`, version, a header value (schema, exportedAt, tags,
 * project, state), the string table, then the entity records. Ready for a
 * deflate stream on top when it goes to disk (`.aeb`), or straight into
 * IndexedDB as one ArrayBuffer per page.
 */

export const PACK_MAGIC = [0x41, 0x45, 0x50, 0x4b] as const // 'AEPK'
export const PACK_VERSION = 1

export interface PackedDocument {
  exportedAt?: string
  entities: AnyEntity[]
  tags: TagInfo[]
  project?: string
  state?: AegraphDocument['state']
}

// Value tags.
const T_NULL = 0
const T_FALSE = 1
const T_TRUE = 2
const T_INT = 3
const T_F64 = 4
const T_STR = 5
const T_ARR = 6
const T_MAP = 7

// Entity flags.
const F_REL = 1
const F_LABEL = 2
const F_DESC = 4
const F_META = 8
const F_DIRECTED = 16
const F_SRC_SEL = 32
const F_TGT_SEL = 64
const F_DATA = 128

const META_FIXED = new Set(['createdAt', 'updatedAt'])

export function isPacked(bytes: Uint8Array): boolean {
  return bytes.length > 5 && bytes[0] === PACK_MAGIC[0] && bytes[1] === PACK_MAGIC[1] && bytes[2] === PACK_MAGIC[2] && bytes[3] === PACK_MAGIC[3]
}

// ── Encoding ─────────────────────────────────────────────────────────────

class Encoder {
  readonly strings = new StringTable()
  readonly body = new ByteWriter(1 << 20)
  private lastCreated = 0

  value(v: unknown): void {
    const w = this.body
    if (v === null || v === undefined) return w.u8(T_NULL)
    switch (typeof v) {
      case 'boolean':
        return w.u8(v ? T_TRUE : T_FALSE)
      case 'number':
        if (!Number.isFinite(v)) return w.u8(T_NULL)
        if (Number.isInteger(v) && Math.abs(v) < 2 ** 52) {
          w.u8(T_INT)
          return w.svar(v + 0) // -0 is 0, as in JSON
        }
        w.u8(T_F64)
        return w.f64(v)
      case 'string':
        w.u8(T_STR)
        return w.uvar(this.strings.id(v))
      case 'object': {
        const j = (v as { toJSON?: unknown }).toJSON
        if (typeof j === 'function') return this.value((j as () => unknown).call(v))
        if (Array.isArray(v)) {
          w.u8(T_ARR)
          w.uvar(v.length)
          for (let i = 0; i < v.length; i++) this.value(v[i])
          return
        }
        w.u8(T_MAP)
        return this.map(v as Record<string, unknown>)
      }
      default:
        // functions, symbols, bigint: JSON drops them (bigint throws; here it is dropped too)
        return w.u8(T_NULL)
    }
  }

  /** A map body: the entries whose value JSON would keep. */
  map(o: Record<string, unknown>) {
    const w = this.body
    const keys = Object.keys(o)
    let n = 0
    for (let i = 0; i < keys.length; i++) if (keep(o[keys[i]])) n++
    w.uvar(n)
    for (let i = 0; i < keys.length; i++) {
      const v = o[keys[i]]
      if (!keep(v)) continue
      w.uvar(this.strings.id(keys[i]))
      this.value(v)
    }
  }

  entity(e: AnyEntity) {
    const w = this.body
    const rel = e.kind === 'relationship'
    const r = e as Relationship
    const label = e.label !== undefined && e.label !== null
    const desc = e.description !== undefined && e.description !== null
    const meta = e.meta ?? ({} as EntityMeta)
    let extras = 0
    for (const k in meta) if (!META_FIXED.has(k) && keep((meta as unknown as Record<string, unknown>)[k])) extras++
    const dataKeys = e.data ? Object.keys(e.data) : []
    let flags = 0
    if (rel) flags |= F_REL
    if (label) flags |= F_LABEL
    if (desc) flags |= F_DESC
    if (extras) flags |= F_META
    if (rel && r.directed) flags |= F_DIRECTED
    if (rel && r.source?.selector) flags |= F_SRC_SEL
    if (rel && r.target?.selector) flags |= F_TGT_SEL
    if (dataKeys.length) flags |= F_DATA
    w.u8(flags)
    w.uvar(this.strings.id(e.id))
    w.uvar(this.strings.id(e.type ?? 'entity'))
    if (label) w.uvar(this.strings.id(String(e.label)))
    if (desc) w.uvar(this.strings.id(String(e.description)))
    const tags = e.tags ?? []
    w.uvar(tags.length)
    for (let i = 0; i < tags.length; i++) w.uvar(this.strings.id(tags[i]))
    // Dates: milliseconds as deltas — created from the previous entity's, updated from created. Unparseable ones go as strings.
    this.date(meta.createdAt, this.lastCreated, (ms) => (this.lastCreated = ms))
    this.date(meta.updatedAt, this.lastCreated, () => {})
    if (extras) {
      w.uvar(extras)
      for (const k in meta) {
        const v = (meta as unknown as Record<string, unknown>)[k]
        if (META_FIXED.has(k) || !keep(v)) continue
        w.uvar(this.strings.id(k))
        this.value(v)
      }
    }
    if (rel) {
      w.uvar(this.strings.id(r.source.id))
      if (r.source.selector) this.value(r.source.selector)
      w.uvar(this.strings.id(r.target.id))
      if (r.target.selector) this.value(r.target.selector)
    }
    if (dataKeys.length) this.map(e.data as Record<string, unknown>)
  }

  private date(v: unknown, base: number, remember: (ms: number) => void) {
    const w = this.body
    const ms = typeof v === 'string' ? isoToMs(v) : NaN
    if (ms === ms) {
      w.u8(1)
      w.svar(ms - base)
      remember(ms)
    } else {
      w.u8(0)
      this.value(v)
    }
  }
}

/**
 * An ISO instant with millisecond precision (`2024-01-02T03:04:05.678Z`) as
 * epoch ms, or NaN for anything else — including a day the calendar lacks
 * (Feb 30), which would come back normalised; those stay strings. Hand-
 * parsed: Date.parse is several times slower and this runs twice per entity.
 */
function isoToMs(s: string): number {
  if (s.length !== 24 || s.charCodeAt(4) !== 45 || s.charCodeAt(7) !== 45 || s.charCodeAt(10) !== 84 || s.charCodeAt(13) !== 58 || s.charCodeAt(16) !== 58 || s.charCodeAt(19) !== 46 || s.charCodeAt(23) !== 90) return NaN
  let n = 0
  const digits = new Array<number>(17)
  for (let i = 0; i < 24; i++) {
    if (i === 4 || i === 7 || i === 10 || i === 13 || i === 16 || i === 19 || i === 23) continue
    const c = s.charCodeAt(i) - 48
    if (c < 0 || c > 9) return NaN
    digits[n++] = c
  }
  const y = digits[0] * 1000 + digits[1] * 100 + digits[2] * 10 + digits[3]
  const mo = digits[4] * 10 + digits[5]
  const d = digits[6] * 10 + digits[7]
  const h = digits[8] * 10 + digits[9]
  const mi = digits[10] * 10 + digits[11]
  const sec = digits[12] * 10 + digits[13]
  const ms = digits[14] * 100 + digits[15] * 10 + digits[16]
  if (mo < 1 || mo > 12 || d < 1 || d > DAYS_IN_MONTH[mo - 1] + (mo === 2 && isLeap(y) ? 1 : 0) || h > 23 || mi > 59 || sec > 59) return NaN
  // Date.UTC reads a year below 100 as 19xx; such an instant stays a string.
  if (y < 100) return NaN
  return Date.UTC(y, mo - 1, d, h, mi, sec, ms)
}
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/** Epoch ms → ISO instant, with the day's prefix cached: most entities in a run share a handful of days. */
const PAD2 = Array.from({ length: 100 }, (_, i) => (i < 10 ? '0' + i : String(i)))
const PAD3 = Array.from({ length: 1000 }, (_, i) => (i < 10 ? '00' + i : i < 100 ? '0' + i : String(i)))
const DAY_MS = 86_400_000
let dayCacheKey = NaN
let dayCache = ''
function msToIso(ms: number): string {
  // The same instant again — a bundle written in one go stamps every entity alike — is the same string.
  if (ms === lastMs) return lastIso
  const day = Math.floor(ms / DAY_MS)
  if (day !== dayCacheKey) {
    dayCacheKey = day
    dayCache = new Date(day * DAY_MS).toISOString().slice(0, 11)
  }
  let t = ms - day * DAY_MS
  const h = (t / 3_600_000) | 0
  t -= h * 3_600_000
  const mi = (t / 60_000) | 0
  t -= mi * 60_000
  const sec = (t / 1000) | 0
  lastMs = ms
  return (lastIso = dayCache + PAD2[h] + ':' + PAD2[mi] + ':' + PAD2[sec] + '.' + PAD3[t - sec * 1000] + 'Z')
}
let lastMs = NaN
let lastIso = ''
const keep = (v: unknown) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol'

/** Pack a document: entities and the bundle keys. */
export function packDocument(doc: Partial<PackedDocument> & { entities: AnyEntity[] }): Uint8Array {
  const enc = new Encoder()
  // The header goes through the same value encoding, so its strings share the table.
  const header: Record<string, unknown> = { exportedAt: doc.exportedAt ?? new Date().toISOString(), tags: doc.tags ?? [] }
  if (doc.project) header.project = doc.project
  if (doc.state) header.state = doc.state
  enc.value(header)
  const headerEnd = enc.body.pos
  enc.body.uvar(doc.entities.length)
  for (let i = 0; i < doc.entities.length; i++) enc.entity(doc.entities[i])
  const bodyBytes = enc.body.result()
  const out = new ByteWriter(bodyBytes.length + 64 + enc.strings.size * 8)
  for (const b of PACK_MAGIC) out.u8(b)
  out.u8(PACK_VERSION)
  out.u8(0)
  enc.strings.write(out)
  out.uvar(headerEnd)
  out.bytes(bodyBytes)
  return out.result()
}

// ── Decoding ─────────────────────────────────────────────────────────────

const EPOCH = '1970-01-01T00:00:00.000Z'
/** Meta keys the app reads as strings. */
const META_STRINGS = new Set(['accessedAt', 'createdBy', 'source'])

export interface UnpackOptions {
  /** How deep a value may nest (`MAX_DATA_DEPTH` for a file; `MAX_STORED_DEPTH` for what this app wrote itself). */
  maxDepth?: number
}

/**
 * Reads what `Encoder` wrote — and refuses what it could not have: a pack is a file, so every count is checked
 * against the bytes left before anything is allocated for it, every string index against the table, every value's
 * nesting against `maxDepth`, and every entity comes out in the app's shape (`importBundle` takes a pack's entities
 * without normalising them): a non-empty id and type (none is `entity`), string tags and dates, `meta.projects` a list of strings, no
 * `__proto__` key anywhere. A corrupt pack throws; it never yields an entity the store cannot hold.
 */
class Decoder {
  private lastCreated = 0
  readonly r: ByteReader
  readonly strings: string[]
  private readonly maxDepth: number
  /** Array items and map entries decoded so far (`MAX_PACK_VALUES`). */
  private values = 0
  constructor(r: ByteReader, strings: string[], maxDepth = MAX_DATA_DEPTH) {
    this.r = r
    this.strings = strings
    this.maxDepth = maxDepth
  }

  private corrupt(what: string): never {
    throw new Error(`Corrupt pack: ${what} at ${this.r.pos}`)
  }

  /** A string by its index in the table. */
  str(): string {
    const i = this.r.uvar()
    const v = this.strings[i]
    if (v === undefined) this.corrupt(`string ${i} of ${this.strings.length}`)
    return v
  }

  /** A count read from the file, refused when even `min` bytes apiece would run past the end. */
  private count(min: number): number {
    const n = this.r.uvar()
    if (n * min > this.r.buf.length - this.r.pos) this.corrupt(`a count of ${n} with ${this.r.buf.length - this.r.pos} bytes left`)
    return n
  }

  private spend(n: number) {
    this.values += n
    if (this.values > MAX_PACK_VALUES) throw new Error(`This pack holds more than ${MAX_PACK_VALUES.toLocaleString('en')} values, so it is not being read: a project is far smaller than that, and a file this size is either not a project or built to exhaust memory.`)
  }

  value(depth = 0): unknown {
    const r = this.r
    const t = r.u8()
    switch (t) {
      case T_NULL:
        return null
      case T_FALSE:
        return false
      case T_TRUE:
        return true
      case T_INT:
        return r.svar()
      case T_F64:
        return r.f64()
      case T_STR:
        return this.str()
      case T_ARR: {
        if (depth >= this.maxDepth) this.corrupt(`values nested deeper than ${this.maxDepth}`)
        const n = this.count(1)
        this.spend(n)
        const out = new Array<unknown>(n)
        for (let i = 0; i < n; i++) out[i] = this.value(depth + 1)
        return out
      }
      case T_MAP:
        if (depth >= this.maxDepth) this.corrupt(`values nested deeper than ${this.maxDepth}`)
        return this.map(depth + 1)
      default:
        throw new Error(`Corrupt pack: value tag ${t} at ${r.pos - 1}`)
    }
  }

  map(depth = 1): Record<string, unknown> {
    const r = this.r
    const s = this.strings
    const n = this.count(2)
    this.spend(n)
    const out: Record<string, unknown> = {}
    for (let i = 0; i < n; i++) {
      const k = this.str()
      // Strings and small integers — most of what data holds — read here; the rest through the switch.
      const t = r.u8()
      let v: unknown
      if (t === T_STR) {
        const j = r.uvar()
        v = s[j]
        if (v === undefined) this.corrupt(`string ${j} of ${s.length}`)
      } else if (t === T_INT) v = r.svar()
      else {
        r.pos--
        v = this.value(depth)
      }
      // Assigned, `__proto__` would set the object's prototype rather than a key: read and left out.
      if (k !== '__proto__') out[k] = v
    }
    return out
  }

  entity(): AnyEntity {
    const r = this.r
    const flags = r.u8()
    const id = this.str()
    // No type is the generic one, as `normalizeEntity` reads it.
    const type = this.str() || 'entity'
    if (!id) this.corrupt('an entity with no id')
    const label = flags & F_LABEL ? this.str() : undefined
    const description = flags & F_DESC ? this.str() : undefined
    const nt = this.count(1)
    const tags = new Array<string>(nt)
    for (let i = 0; i < nt; i++) tags[i] = this.str()
    const createdAt = this.date(this.lastCreated, true)
    const updatedAt = this.date(this.lastCreated, false)
    const meta: EntityMeta = { createdAt, updatedAt } as EntityMeta
    if (flags & F_META) {
      const n = this.count(2)
      for (let i = 0; i < n; i++) {
        const k = this.str()
        const v = this.value(1)
        if (k === '__proto__' || META_FIXED.has(k)) continue
        // What the app reads from meta as a type: anything else is left out rather than handed on.
        if (k === 'projects') {
          if (Array.isArray(v) && v.every((p) => typeof p === 'string')) meta.projects = v as string[]
          continue
        }
        if (META_STRINGS.has(k) && typeof v !== 'string') continue
        ;(meta as unknown as Record<string, unknown>)[k] = v
      }
    }
    let source: EntityRef | undefined
    let target: EntityRef | undefined
    if (flags & F_REL) {
      source = this.end(flags & F_SRC_SEL)
      target = this.end(flags & F_TGT_SEL)
    }
    const data = flags & F_DATA ? this.map() : {}
    // Same key order for every entity, so they share a hidden class — the label and description in the literal
    // when they are there, rather than added after (a transition per entity).
    if (flags & F_REL) {
      const e: Relationship = label !== undefined ? { id, kind: 'relationship', type, label, tags, data, meta, source: source!, target: target!, directed: !!(flags & F_DIRECTED) } : { id, kind: 'relationship', type, tags, data, meta, source: source!, target: target!, directed: !!(flags & F_DIRECTED) }
      if (description !== undefined) e.description = description
      return e
    }
    const e: AnyEntity = label !== undefined ? { id, kind: 'entity', type, label, tags, data, meta } : { id, kind: 'entity', type, tags, data, meta }
    if (description !== undefined) e.description = description
    return e
  }

  /** A relationship's end: an id, and a selector when the flag says so — kept only when it is an object. */
  private end(selector: number): EntityRef {
    const id = this.str()
    if (!id) this.corrupt('a relationship end with no id')
    const ref: EntityRef = { id }
    if (selector) {
      const v = this.value(1)
      if (v && typeof v === 'object' && !Array.isArray(v)) ref.selector = v as EntityRef['selector']
    }
    return ref
  }

  private date(base: number, remember: boolean): string {
    const r = this.r
    if (r.u8() === 1) {
      const ms = base + r.svar()
      if (!(Math.abs(ms) <= 8.64e15)) this.corrupt(`a date of ${ms} ms`)
      if (remember) this.lastCreated = ms
      return msToIso(ms)
    }
    // Written as a value when it was not an ISO instant: a string stays as it was; anything else is no date.
    const v = this.value(1)
    return typeof v === 'string' ? v : EPOCH
  }
}

/** Unpack a document. Throws on anything that is not a pack this code understands, or one past the bounds in `limits.ts`. */
export function unpackDocument(bytes: Uint8Array, opts: UnpackOptions = {}): PackedDocument {
  if (!isPacked(bytes)) throw new Error('Not an aegraph pack (missing AEPK magic).')
  const r = new ByteReader(bytes)
  r.pos = 4
  const version = r.u8()
  if (version !== PACK_VERSION) throw new Error(`aegraph pack version ${version}: this app reads version ${PACK_VERSION}${version > PACK_VERSION ? ' — update the app' : ''}.`)
  r.u8() // flags, unused
  const strings = StringTable.read(r)
  r.uvar() // header length, for skipping ahead by readers that want the body only
  const dec = new Decoder(r, strings, opts.maxDepth)
  const header = asRecord(dec.value())
  const n = r.uvar()
  if (n > MAX_PACK_ENTITIES) throw new Error(`This pack holds ${n.toLocaleString('en')} entities, more than the ${MAX_PACK_ENTITIES.toLocaleString('en')} a project may have, so it is not being read.`)
  // The smallest entity is eight bytes: flags, id, type, a tag count and two dates.
  if (n * 8 > bytes.length - r.pos) throw new Error(`Corrupt pack: ${n} entities in ${bytes.length - r.pos} bytes`)
  const entities = new Array<AnyEntity>(n)
  for (let i = 0; i < n; i++) entities[i] = dec.entity()
  const state = asRecord(header.state)
  return {
    exportedAt: typeof header.exportedAt === 'string' ? header.exportedAt : undefined,
    tags: Array.isArray(header.tags) ? (header.tags as TagInfo[]) : [],
    project: typeof header.project === 'string' ? header.project : undefined,
    state: header.state && typeof header.state === 'object' ? { ...(typeof state.route === 'string' ? { route: state.route } : {}), ...(state.ui && typeof state.ui === 'object' && !Array.isArray(state.ui) ? { ui: state.ui as Record<string, string> } : {}) } : undefined,
    entities,
  }
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Only the header of a pack (bundle keys, tags, count) without decoding the entities. */
export function peekPack(bytes: Uint8Array): { exportedAt?: string; project?: string; entities: number; strings: number } {
  const r = new ByteReader(bytes)
  if (!isPacked(bytes)) throw new Error('Not an aegraph pack.')
  r.pos = 6
  const strings = StringTable.read(r)
  r.uvar()
  const dec = new Decoder(r, strings)
  const header = asRecord(dec.value())
  return { exportedAt: typeof header.exportedAt === 'string' ? header.exportedAt : undefined, project: typeof header.project === 'string' ? header.project : undefined, entities: r.uvar(), strings: strings.length }
}
