import type { EntityStore } from '../entity/store'
import type { AnyEntity, Entity, EntityData, EntityId, ISODate } from '../entity/types'
import { PROJECT_TYPE, scopeEntities, type ProjectEntity } from './project'

/**
 * Version control for projects, the model half.
 *
 * A project's scope is its *working tree*: whatever is in the Library and
 * marked with the project, always persisted, always live. A **commit** is a
 * named point in that tree's history: which entities were in it and what
 * each looked like, as a content hash per entity. The commits of a project
 * form one linear chain (parent → child); the newest is HEAD. The
 * difference between HEAD and the working tree is the project's *unsaved
 * changes* — unsaved in the sense of "not yet committed": the Library keeps
 * every edit regardless.
 *
 * The commit entity (`project:commit`, in the Library, never marked with a
 * project) is light: message, parent, counts. The content — the entities
 * added, modified and removed since the parent — is a blob in its own
 * IndexedDB store (`historyBlobs.ts`), so a history of a large project does
 * not double the store in memory. `history.ts` puts the two together.
 *
 * Hashes are over the entity's content, not its bookkeeping: `updatedAt`,
 * `accessedAt` and the project marks are left out, so a touch, a re-import
 * of identical data, or adding the entity to a second project does not
 * read as a change here.
 */
export const COMMIT_TYPE = 'project:commit'

/** Types that never enter a project's tree: projects themselves and their commits. */
export const isVersioningType = (type: string) => type === PROJECT_TYPE || type.startsWith('project:')

export interface CommitData extends EntityData {
  /** The project this commit belongs to. */
  project: EntityId
  /** The previous commit, or null for the first. */
  parent: EntityId | null
  message: string
  /** Made by autosave rather than by hand. */
  auto?: boolean
  /** When the commit was made (also `meta.createdAt`; kept in data so a bundle can carry it). */
  at: ISODate
  /** Entities in the tree after this commit. */
  size: number
  stats: { added: number; modified: number; removed: number }
  /** For a restore commit: the commit whose tree this one reproduces. */
  restoredFrom?: EntityId
}
export type CommitEntity = Entity<CommitData>

export const isCommitEntity = (e: AnyEntity | undefined): e is CommitEntity => !!e && e.kind === 'entity' && e.type === COMMIT_TYPE && typeof e.data.project === 'string'

/** What a commit stores: the entities changed since its parent, with the hash of each one's new state. */
export interface CommitBlob {
  id: EntityId
  project: EntityId
  /** New in this commit (full content). */
  added: AnyEntity[]
  /** Changed in this commit (the new content; the old is in an earlier commit). */
  modified: AnyEntity[]
  /** Gone in this commit (the content they had). */
  removed: AnyEntity[]
  /** id → hash for every entity in `added` and `modified`. */
  hashes: Record<EntityId, string>
}

// ── Settings ─────────────────────────────────────────────────────────────

export interface VersioningSettings {
  /** Commit automatically a little after the last change (default on). */
  autosave: boolean
  /** How long the tree must be quiet before autosave commits, in seconds. */
  autosaveDelay: number
}
export const DEFAULT_VERSIONING: VersioningSettings = { autosave: true, autosaveDelay: 30 }

/** A project's versioning settings, defaults filled in. */
export function versioningOf(project: ProjectEntity | undefined): VersioningSettings {
  const v = (project?.data.versioning ?? {}) as Partial<VersioningSettings>
  return { autosave: typeof v.autosave === 'boolean' ? v.autosave : DEFAULT_VERSIONING.autosave, autosaveDelay: typeof v.autosaveDelay === 'number' && v.autosaveDelay >= 1 ? v.autosaveDelay : DEFAULT_VERSIONING.autosaveDelay }
}

// ── Hashing ──────────────────────────────────────────────────────────────

/** Entities are immutable, so a hash computed once for an object is good for its life. */
const hashCache = new WeakMap<AnyEntity, string>()

/** A content hash of the entity: 53-bit cyrb53 over a canonical (key-sorted) JSON of everything but the bookkeeping. */
/** The hash when this object has been hashed (or seeded) already — the cheap check the kept working diff prefers. */
export const knownHash = (e: AnyEntity): string | undefined => hashCache.get(e)
/** An object made from HEAD's content (a restore, a revert) is given HEAD's hash rather than hashed again. */
export const seedHash = (e: AnyEntity, h: string) => hashCache.set(e, h)

export function hashEntity(e: AnyEntity): string {
  let h = hashCache.get(e)
  if (h === undefined) {
    h = cyrb53(canonicalEntityJson(e)).toString(36)
    hashCache.set(e, h)
  }
  return h
}

/** How long hashing runs before it lets the page breathe (a frame's worth, less what the page needs to draw). */
const HASH_SLICE_MS = 12

/**
 * Hash a list a slice at a time, yielding to the page between slices: the first commit of a million-entity project
 * hashes every entity, and in one go that was a five-second freeze — with the rest of the commit, enough to take
 * the tab down. `each` gets every entity with its hash, in order.
 */
export async function hashInSlices(list: readonly AnyEntity[], each: (e: AnyEntity, hash: string) => void, sliceMs = HASH_SLICE_MS): Promise<void> {
  let until = performance.now() + sliceMs
  for (let i = 0; i < list.length; i++) {
    each(list[i], hashEntity(list[i]))
    if ((i & 255) === 255 && performance.now() > until) {
      await new Promise((r) => setTimeout(r, 0))
      until = performance.now() + sliceMs
    }
  }
}

/** The part of an entity a hash covers, serialised with sorted keys so key order never matters. */
export function canonicalEntityJson(e: AnyEntity): string {
  const meta = e.meta
  const base: Record<string, unknown> = { id: e.id, kind: e.kind, type: e.type, label: e.label, description: e.description, tags: e.tags, data: e.data, meta: { createdAt: meta.createdAt, createdBy: meta.createdBy, source: meta.source, derivedFrom: meta.derivedFrom } }
  if (e.kind === 'relationship') {
    base.source = e.source
    base.target = e.target
    base.directed = e.directed
  }
  return stableStringify(base)
}

/** JSON with object keys sorted, `undefined` values dropped; arrays keep their order. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) {
    // An array of primitives, or of such arrays (a dataset's rows), has no keys to sort: the native serialiser gives
    // the same text an order of magnitude faster, which is what a 700k-row table is hashed with after every commit.
    if (flatArray(v)) return JSON.stringify(v)
    let s = '['
    for (let i = 0; i < v.length; i++) s += (i ? ',' : '') + stableStringify(v[i])
    return s + ']'
  }
  const keys = Object.keys(v as object).sort()
  let s = '{'
  let first = true
  for (const k of keys) {
    const x = (v as Record<string, unknown>)[k]
    if (x === undefined) continue
    s += (first ? '' : ',') + JSON.stringify(k) + ':' + stableStringify(x)
    first = false
  }
  return s + '}'
}

/** Only primitives, or arrays of primitives, inside (`undefined` and NaN serialise as null either way). */
const flatArray = (v: unknown[]): boolean => {
  for (const x of v) {
    if (x === null || typeof x !== 'object') continue
    if (!Array.isArray(x)) return false
    for (const y of x) if (y !== null && typeof y === 'object') return false
  }
  return true
}

/** cyrb53: a fast 53-bit string hash (public domain, bryc). Good dispersion; not cryptographic. */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

// ── Trees and working changes ────────────────────────────────────────────

/** A commit's tree: every entity in the project at that point, by content hash. */
export type Tree = Map<EntityId, string>

/** The entities a project's tree covers right now: its scope, projects and commits aside. */
export function trackedEntities(store: EntityStore, project: EntityId): AnyEntity[] {
  return scopeEntities(store, project).filter((e) => !isVersioningType(e.type))
}

/** The working tree compared with a tree — ids only; `history.ts` fills in the content of what was removed. */
export interface WorkingDiff {
  added: AnyEntity[]
  modified: AnyEntity[]
  removedIds: EntityId[]
  /** Tree size after the change. */
  size: number
}

export function diffWorkingTree(store: EntityStore, project: EntityId, tree: Tree): WorkingDiff {
  const added: AnyEntity[] = []
  const modified: AnyEntity[] = []
  const seen = new Set<EntityId>()
  const live = trackedEntities(store, project)
  for (const e of live) {
    seen.add(e.id)
    const h = tree.get(e.id)
    if (h === undefined) added.push(e)
    else if (h !== hashEntity(e)) modified.push(e)
  }
  const removedIds: EntityId[] = []
  if (seen.size !== tree.size || added.length) for (const id of tree.keys()) if (!seen.has(id)) removedIds.push(id)
  return { added, modified, removedIds, size: live.length }
}

/** Apply a commit's blob to a tree, in place. */
export function applyBlob(tree: Tree, blob: CommitBlob) {
  for (const e of blob.added) tree.set(e.id, blob.hashes[e.id] ?? hashEntity(e))
  for (const e of blob.modified) tree.set(e.id, blob.hashes[e.id] ?? hashEntity(e))
  for (const e of blob.removed) tree.delete(e.id)
}

// ── Property diffs ───────────────────────────────────────────────────────

/** One changed property of an entity: a dotted path and the values either side (`undefined` = absent). */
export interface PropertyChange {
  path: string
  before: unknown
  after: unknown
}

/** Paths a property diff walks; `meta` only for the fields the hash covers. */
const TOP_LEVEL: (keyof AnyEntity)[] = ['type', 'label', 'description', 'tags', 'data']
const META_LEVEL = ['source', 'createdBy', 'derivedFrom'] as const

/**
 * What changed between two versions of an entity, property by property.
 * Objects are walked (so `data.address.city` is one change, not `data.address`);
 * arrays, strings and scalars are one change each. `tags` is reported as a
 * whole. Missing on one side reads as `undefined`.
 */
export function diffProperties(before: AnyEntity | undefined, after: AnyEntity | undefined): PropertyChange[] {
  const out: PropertyChange[] = []
  const a = before as unknown as Record<string, unknown> | undefined
  const b = after as unknown as Record<string, unknown> | undefined
  for (const k of TOP_LEVEL) walk(k, a?.[k], b?.[k], out, k === 'data' ? 0 : 99)
  for (const k of META_LEVEL) walk(`meta.${k}`, before?.meta[k], after?.meta[k], out, 99)
  if (before?.kind === 'relationship' || after?.kind === 'relationship') {
    const ra = before?.kind === 'relationship' ? before : undefined
    const rb = after?.kind === 'relationship' ? after : undefined
    walk('source', ra?.source, rb?.source, out, 99)
    walk('target', ra?.target, rb?.target, out, 99)
    walk('directed', ra?.directed, rb?.directed, out, 99)
  }
  return out
}

const MAX_DEPTH = 4
function walk(path: string, a: unknown, b: unknown, out: PropertyChange[], depth: number) {
  if (a === b) return
  // An object against nothing (an added or removed entity) is walked key by key, so `data` reads as its properties.
  if ((isPlainObject(a) || a === undefined) && (isPlainObject(b) || b === undefined) && depth < MAX_DEPTH) {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
    for (const k of [...keys].sort()) walk(`${path}.${k}`, a?.[k], b?.[k], out, depth + 1)
    return
  }
  if (deepEqual(a, b)) return
  // Nothing against an empty list is not a change worth a row.
  if ((a === undefined && Array.isArray(b) && !b.length) || (b === undefined && Array.isArray(a) && !a.length)) return
  out.push({ path, before: a, after: b })
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    if (a.length !== bb.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false
    return true
  }
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  return true
}

// ── Lists of records ─────────────────────────────────────────────────────

/** A list of objects (messages, diagram elements, annotations, points) compared item by item. */
export interface ListDiff {
  /** The key the items were matched by: 'id', 'key', 'name', or null for position. */
  by: string | null
  added: { key: string; item: Record<string, unknown> }[]
  removed: { key: string; item: Record<string, unknown> }[]
  changed: { key: string; before: Record<string, unknown>; after: Record<string, unknown>; changes: PropertyChange[] }[]
  unchanged: number
}

const LIST_KEYS = ['id', 'key', 'name', 'uid']
export const isRecordList = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.length > 0 && v.every(isPlainObject)

/**
 * Diff two lists of records: matched by a shared identifying field when
 * every item has one (`id`, `key`, `name`, `uid`), by position otherwise.
 * Undefined on either side is an empty list.
 */
export function diffList(before: unknown, after: unknown): ListDiff {
  const a = isRecordList(before) ? before : []
  const b = isRecordList(after) ? after : []
  const by = LIST_KEYS.find((k) => [...a, ...b].every((x) => x[k] !== undefined && x[k] !== null)) ?? null
  const keyOf = (x: Record<string, unknown>, i: number) => (by ? String(x[by]) : String(i))
  const am = new Map(a.map((x, i) => [keyOf(x, i), x]))
  const bm = new Map(b.map((x, i) => [keyOf(x, i), x]))
  const out: ListDiff = { by, added: [], removed: [], changed: [], unchanged: 0 }
  for (const [key, item] of am) {
    const next = bm.get(key)
    if (!next) out.removed.push({ key, item })
    else if (next === item || deepEqual(item, next)) out.unchanged++
    else {
      const changes: PropertyChange[] = []
      const keys = new Set([...Object.keys(item), ...Object.keys(next)])
      for (const k of [...keys].sort()) walk(k, item[k], next[k], changes, 1)
      out.changed.push({ key, before: item, after: next, changes })
    }
  }
  for (const [key, item] of bm) if (!am.has(key)) out.added.push({ key, item })
  return out
}

/** An Excalidraw scene's elements when the string is one (a diagram's `data.source` in that format). */
export function excalidrawElements(v: unknown): Record<string, unknown>[] | undefined {
  if (typeof v !== 'string' || !v.startsWith('{')) return undefined
  try {
    const doc = JSON.parse(v) as { elements?: unknown }
    return isRecordList(doc.elements) ? doc.elements.filter((e) => !e.isDeleted) : undefined
  } catch {
    return undefined
  }
}

/** A picture: a data URL of an image, or an image-ish field (`src`, `poster`, `thumbnail`) holding a URL. */
export const isImageValue = (path: string, v: unknown): v is string => typeof v === 'string' && (v.startsWith('data:image/') || (/(^|\.)(src|poster|thumbnail|thumb|image|cover)$/i.test(path) && /^(https?:|blob:|\/)/.test(v)))

// ── Text diffs ───────────────────────────────────────────────────────────

export type DiffOp = ' ' | '+' | '-'
export interface DiffLine {
  op: DiffOp
  text: string
}

/** Lines beyond which two texts are compared by prefix/suffix only (the middle shows as replaced). */
const TEXT_DIFF_MAX_LINES = 3000

/**
 * A line diff of two texts (LCS), for a document body or any long string:
 * common lines as ' ', removed as '-', added as '+'. The common prefix and
 * suffix are peeled first so the DP only sees the changed middle; very long
 * middles are reported as one removal and one addition rather than aligned.
 */
export function diffText(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const out: DiffLine[] = []
  for (let i = 0; i < start; i++) out.push({ op: ' ', text: a[i] })
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length * midB.length > TEXT_DIFF_MAX_LINES * TEXT_DIFF_MAX_LINES) {
    for (const t of midA) out.push({ op: '-', text: t })
    for (const t of midB) out.push({ op: '+', text: t })
  } else out.push(...lcsDiff(midA, midB))
  for (let i = endA; i < a.length; i++) out.push({ op: ' ', text: a[i] })
  return out
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  if (!n) return b.map((text) => ({ op: '+', text }))
  if (!m) return a.map((text) => ({ op: '-', text }))
  // dp[i][j] = LCS length of a[i:], b[j:]
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push({ op: '-', text: a[i++] })
    else out.push({ op: '+', text: b[j++] })
  }
  while (i < n) out.push({ op: '-', text: a[i++] })
  while (j < m) out.push({ op: '+', text: b[j++] })
  return out
}

/** Collapse runs of unchanged lines to `context` lines either side of a change, with a marker for what was skipped. */
export function hunks(lines: DiffLine[], context = 3): (DiffLine | { skipped: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].op === ' ') continue
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true
  }
  const out: (DiffLine | { skipped: number })[] = []
  let skipped = 0
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (skipped) out.push({ skipped })
      skipped = 0
      out.push(lines[i])
    } else skipped++
  }
  if (skipped) out.push({ skipped })
  return out
}

/** Whether a value is text worth a line diff (rather than a one-line before/after). */
export const isLongText = (v: unknown): v is string => typeof v === 'string' && (v.length > 120 || v.includes('\n'))
/** A data URL or a very long single token: show sizes, not content. */
export const isOpaqueText = (v: unknown): v is string => typeof v === 'string' && (v.startsWith('data:') || (v.length > 2000 && !v.includes('\n') && !v.includes(' ')))

// ── Listing ──────────────────────────────────────────────────────────────

/** A project's commit entities as the store holds them, newest by clock first — the raw material; `listCommits` orders them by their parent links. */
function rawCommits(store: EntityStore, project: EntityId): CommitEntity[] {
  return store.library
    .ofType(COMMIT_TYPE)
    .filter((e): e is CommitEntity => isCommitEntity(e) && e.data.project === project)
    .sort((a, b) => b.data.at.localeCompare(a.data.at) || b.meta.createdAt.localeCompare(a.meta.createdAt))
}

/** HEAD: the commit no other commit has as its parent (the newest by clock when several qualify, as after a broken chain). */
export function headCommit(store: EntityStore, project: EntityId): CommitEntity | undefined {
  const commits = rawCommits(store, project)
  if (!commits.length) return undefined
  const parents = new Set(commits.map((c) => c.data.parent).filter((p): p is EntityId => !!p))
  return commits.find((c) => !parents.has(c.id)) ?? commits[0]
}

/**
 * A project's commits, newest first: HEAD and its ancestors in chain order —
 * the parent links, not the clock, decide, so two commits in the same
 * millisecond (a restore's "before" and "after", a fast autosave) still
 * list in the order they were made — then any commit off the chain (an
 * older line after a broken link), by clock.
 */
export function listCommits(store: EntityStore, project: EntityId): CommitEntity[] {
  const raw = rawCommits(store, project)
  if (raw.length < 2) return raw
  const byId = new Map(raw.map((c) => [c.id, c]))
  const chain: CommitEntity[] = []
  const seen = new Set<EntityId>()
  let cur = headCommit(store, project)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.push(cur)
    cur = cur.data.parent ? byId.get(cur.data.parent) : undefined
  }
  return chain.length === raw.length ? chain : [...chain, ...raw.filter((c) => !seen.has(c.id))]
}

/** HEAD and its ancestors, HEAD first (commits off the chain left out). */
export function commitChain(store: EntityStore, project: EntityId): CommitEntity[] {
  const byId = new Map(rawCommits(store, project).map((c) => [c.id, c]))
  const out: CommitEntity[] = []
  let cur = headCommit(store, project)
  const seen = new Set<EntityId>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.push(cur)
    cur = cur.data.parent ? byId.get(cur.data.parent) : undefined
  }
  return out
}

export const shortId = (id: string) => id.replace(/-/g, '').slice(0, 7)
