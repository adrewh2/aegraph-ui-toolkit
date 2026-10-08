import { patchEntity, uniqueTags } from './entity'
import { EntityTable } from './table'
import type {
  AegraphDocument,
  AnyEntity,
  EntityId,
  EntityRef,
  Relationship,
  Tag,
  TagInfo,
} from './types'
import { isRelationship } from './types'
import { isCssColor } from '../../lib/cssColor'

/** `schema:type` — spelled here so the store doesn't import the (React-flavoured) categories module. */
const SCHEMA_TYPE = 'schema:type'
const PROJECT_TYPE = 'project'
/** Projects and their bookkeeping (`project:commit`) belong to the Library: never auto-marked with the open project. */
const isLibraryOnly = (type: string) => type === PROJECT_TYPE || type.startsWith('project:')

export type Direction = 'out' | 'in' | 'both'

export interface EntityQuery {
  kind?: AnyEntity['kind']
  type?: string | string[]
  /** Entity must carry every listed tag. */
  tags?: Tag[]
  /** Case-insensitive search over id, label, description, type, tags and the data as JSON (its first SEARCH_DATA_CHARS): every word must occur; "quoted words" must occur together. */
  text?: string
  predicate?: (e: AnyEntity) => boolean
}

/** Whether an event changes what views and snapshots derive from (a volatile upsert, a tag colour or a scope switch does not). */
const material = (e: StoreEvent): boolean => (e.type === 'upsert' ? !e.volatile : e.type === 'remove' || e.type === 'reset' ? true : e.type === 'batch' ? e.events.some(material) : false)

/**
 * The file a bulk write came from, when it is exactly that file's entities: an opened pack (`.aeb`) whose every entity
 * went into the store as it was decoded. Persistence writes these bytes as they are rather than encoding the same
 * entities again (`Persistence`): a million-entity bundle was four and a half seconds of packing and a gigabyte and
 * a half of garbage, to write what the file already was. `expected` is how many entities the write's upserts carry
 * between them; the file's project, written on its own, is in the bytes too.
 */
export interface BulkSource {
  bytes: Uint8Array
  expected: number
}

export type StoreEvent =
  /** `volatile`: a bookkeeping write (last opened, a script's last run) — the data a view or a snapshot derives from is unchanged. `source`: see `BulkSource`. */
  | { type: 'upsert'; entities: AnyEntity[]; volatile?: boolean; source?: BulkSource }
  /** `handles`: the removed entities' handles (`handleOf`), in the same order — gone from the store once the event arrives. */
  | { type: 'remove'; ids: EntityId[]; handles?: number[] }
  /** The guard (the constraint engine) found violations in a write: the rejected ids were dropped, the rest are warnings. */
  | { type: 'rejected'; violations: GuardViolation[]; rejected: EntityId[] }
  | { type: 'tags' }
  | { type: 'reset' }
  /** The active project scope changed; nothing on disk changes. */
  | { type: 'scope' }
  | { type: 'batch'; events: StoreEvent[] }

type Listener = (event: StoreEvent) => void

/** What a guard reports about one entity in a write (the constraint engine's Violation, seen from here). */
export interface GuardViolation {
  constraintId: EntityId
  constraint: string
  severity: 'reject' | 'warn'
  entityId: EntityId
  entity: string
  message: string
}
/**
 * A check every write passes through: given the entities of a write (and a way to see what each replaces), which are
 * accepted and which are dropped, and why. The constraint engine installs one; without a guard anything goes.
 */
export type StoreGuard = (entities: AnyEntity[], previous: (id: EntityId) => AnyEntity | undefined) => { accepted: AnyEntity[]; rejected: AnyEntity[]; violations: GuardViolation[] }
/** Thrown by a single-entity write the guard rejects. */
export class GuardRejection extends Error {
  readonly violations: GuardViolation[]
  constructor(violations: GuardViolation[]) {
    super(`Rejected by ${violations.length === 1 ? 'a constraint' : `${violations.length} constraints`}: ${violations.map((v) => `${v.constraint}: ${v.message}`).join('; ')}`)
    this.name = 'GuardRejection'
    this.violations = violations
  }
}

/**
 * How far a project's `includes` are followed: this many levels down, and this many projects in all. A project's
 * scope is read on every scoped read, and `includes` arrives in bundles and tool calls — a chain of fifty thousand
 * includes once made every read throw (the walk was recursive) and the remembered project crash every load after.
 * Past either bound the rest is not part of the scope; `capped` says the bound was met.
 */
export const MAX_INCLUDE_DEPTH = 32
export const MAX_INCLUDED_PROJECTS = 256

/** The project and every project it includes, transitively, breadth first with a visited set — no recursion, cycles ignored. */
export function walkIncludes(root: EntityId, includesOf: (id: EntityId) => unknown): { ids: Set<EntityId>; capped: boolean } {
  const ids = new Set<EntityId>([root])
  let level: EntityId[] = [root]
  for (let depth = 0; level.length; depth++) {
    if (depth >= MAX_INCLUDE_DEPTH) return { ids, capped: level.some((id) => Array.isArray(includesOf(id)) && (includesOf(id) as unknown[]).some((x) => typeof x === 'string' && !ids.has(x))) }
    const next: EntityId[] = []
    for (const id of level) {
      const inc = includesOf(id)
      if (!Array.isArray(inc)) continue
      for (const x of inc) {
        if (typeof x !== 'string' || ids.has(x)) continue
        if (ids.size >= MAX_INCLUDED_PROJECTS) return { ids, capped: true }
        ids.add(x)
        next.push(x)
      }
    }
    level = next
  }
  return { ids, capped: false }
}

/** See `scopeCache` on the store. */
type ScopeCache = {
  live: boolean
  id: EntityId | null
  set: Set<EntityId> | null
  /** The project and every project it includes, transitively. */
  projects: Set<EntityId>
  /** Members by type, entities and relationships apart (a type name may carry both). */
  entityTypes: Map<string, number>
  relationshipTypes: Map<string, number>
  /** Type definitions by the type they define, for the vocabulary rule. */
  defsByName: Map<string, Set<EntityId>>
  /**
   * How many in scope carry each tag: `tags()` and `tagUsage` off a tally rather than a walk over every entity. Null
   * until first asked (`scopeTagCounts`): counted with the rest of the scope it was a dozen map writes an entity when
   * a big project opened, for counts the first picture never shows; once counted, writes keep it level.
   */
  tagCounts: Map<Tag, number> | null
  entities: number
  relationships: number
}
type ReadCache = { version: number; all?: AnyEntity[]; relationships?: Relationship[]; tags?: Tag[]; counts?: Map<string, number>; countsByKind?: { entities: Map<string, number>; relationships: Map<string, number> } }

/** The read API a `LibraryReads` view offers — a subset of the store's, unscoped. */
export interface LibraryReads {
  all(): AnyEntity[]
  ofType(type: string): AnyEntity[]
  countOfType(type: string): number
  withTag(tag: Tag): AnyEntity[]
  query(q?: EntityQuery): AnyEntity[]
  relationships(): Relationship[]
  relationshipsOf(id: EntityId, dir?: Direction): Relationship[]
  size(): number
  entityCount(): number
  relationshipCount(): number
  countByType(): Map<string, number>
  countByTypeAndKind(): { entities: Map<string, number>; relationships: Map<string, number> }
  tags(): Tag[]
  tagUsage(tag: Tag): number
}

/**
 * In-memory, indexed home for entities. Holds the graph (entities +
 * relationships), tag metadata, and secondary indexes by type/tag/endpoint.
 *
 * Mutations are the only way to change state, and every mutation bumps
 * `version` and notifies subscribers — so React can subscribe with
 * useSyncExternalStore and views stay projections of one model.
 */
export class EntityStore {
  /** By id, each with its handle (`EntityTable`): the Map this was, plus a small integer per entity for bitsets. */
  private entities = new EntityTable()
  private byType = new Map<string, Set<EntityId>>()
  private byTag = new Map<Tag, Set<EntityId>>()
  /**
   * How far the tag index has got, as a handle: entities below it have their tags in `byTag`, the rest are added the
   * next time it is built (`tagIndex`, `warmTagIndex`); `Infinity` once it covers everything. A dozen tags an entity
   * made the tag index most of the cost of loading a big Library — the WildChat atlas's two million records, a set
   * insert per tag, was 60% of 3.6 s of indexing inside one frozen task — and nothing needs it until someone asks
   * for the entities carrying a tag. So a load leaves it behind; the app builds it in idle slices after boot, and
   * whoever asks first finishes it. Writes keep it level for what it already covers, and leave the rest to the build.
   */
  private tagCursor = 0
  /**
   * Each entity's relationships by end — one relationship id, a short array, or a `Set` for a hub (`Ends`). A `Set`
   * for every end was two million of them for the WildChat atlas's million relationships, most of the store's
   * indexing time when the Library loads; most entities have one or two.
   */
  private outgoing = new Map<EntityId, Ends>()
  private incoming = new Map<EntityId, Ends>()
  private relationshipIds = new Set<EntityId>()
  /**
   * How many entities and how many relationships carry each type, kept as the indexes are written rather than
   * counted on demand: the registry asks for this on every version, and walking two million ids to ask each one
   * whether it is a relationship was 400-750 ms — a stall on the first read after any edit.
   */
  private entityTypeCounts = new Map<string, number>()
  private relationshipTypeCounts = new Map<string, number>()
  /**
   * Bumped only when a relationship is written or removed. `relationships()` builds an array of every relationship
   * — a million of them is a quarter of a second — and an edit to anything else cannot have changed it.
   */
  private relStructure = 0
  /** Project id → ids of the entities marked with it (`meta.projects`). */
  private byProject = new Map<EntityId, Set<EntityId>>()
  /**
   * The active project. While set, every list read (all, ofType, query,
   * relationships, counts, tags…) sees only the project's scope — its marked
   * entities plus those of the projects it includes — and every entity
   * created is marked with it. `get`/`has` stay unscoped: references
   * always resolve. Null = the Library, everything.
   */
  private scopeId: EntityId | null = null
  /** Off only inside `unmark`, which is the one write allowed to drop marks. */
  private keepMarks = true
  /**
   * The active scope as a set, kept level with the writes: an entity that
   * enters or leaves the scope (or the store) moves in and out of the set
   * and its type's tally as it is written, so a read after an edit does not
   * walk the project again — on a 700k-entity project that walk, with the
   * vocabulary pass and the counts over it, was most of a second after every
   * change. `live` false means rebuild on the next read: the scope itself
   * changed, or a project or type definition was written (the scope's
   * includes and the vocabulary follow those, and they are rare).
   */
  private scopeCache: ScopeCache = { live: false, id: null, set: null, projects: new Set(), entityTypes: new Map(), relationshipTypes: new Map(), defsByName: new Map(), tagCounts: null, entities: 0, relationships: 0 }
  private tagInfo = new Map<Tag, TagInfo>()
  private listeners = new Set<Listener>()
  private _version = 0
  /** Bumped only by writes that change data — not by bookkeeping (`touch`, a script's last run): what derived caches key on. */
  private _dataVersion = 0
  /** Per-version caches for hot, allocation-heavy reads. */
  private cache: ReadCache = { version: -1 }
  private scopeOfCache: { version: number; sets: Map<EntityId, Set<EntityId>> } = { version: -1, sets: new Map() }
  /** The same caches while a project is active; the Library's stay valid underneath. */
  private scopedReadCache: ReadCache & { id: EntityId | null } = { version: -1, id: null }
  private bulkDepth = 0
  private pending: StoreEvent[] = []

  get dataVersion() {
    return this._dataVersion
  }
  get version() {
    return this._version
  }

  // ── Reads ────────────────────────────────────────────────────────────

  /**
   * An entity's handle: a small integer, its place in the store for as long as the store is not cleared (a load from
   * disk clears it; a `reset` event says so). For whatever keeps a bit per entity rather than a set of ids — the
   * working diff of a project (`ProjectHistory`). Undefined for an id the store does not hold.
   */
  handleOf(id: EntityId): number | undefined {
    return this.entities.handleOf(id)
  }

  /** The entity at a handle; undefined once it is removed. */
  entityAt(handle: number): AnyEntity | undefined {
    return this.entities.at(handle)
  }

  /** The id a handle was given to, still known after the entity is removed (until the store is cleared). */
  idAt(handle: number): EntityId | undefined {
    return this.entities.idAt(handle)
  }

  /** One past the highest handle: the size a bitset over handles needs. */
  get handleCapacity(): number {
    return this.entities.capacity
  }

  get(id: EntityId): AnyEntity | undefined {
    return this.entities.get(id)
  }

  require(id: EntityId): AnyEntity {
    const e = this.entities.get(id)
    if (!e) throw new Error(`Entity not found: ${id}`)
    return e
  }

  has(id: EntityId) {
    return this.entities.has(id)
  }

  resolve(ref: EntityRef): AnyEntity | undefined {
    return this.entities.get(ref.id)
  }

  /** Entities and relationships in the active scope. */
  size() {
    if (!this.scopeId) return this.entities.size
    const c = this.scopedCounts()
    return c.entities + c.relationships
  }

  all(): AnyEntity[] {
    const c = this.cached()
    if (!c.all) {
      const scope = this.scopeSet()
      c.all = scope ? this.collect(scope) : this.entities.valuesArray()
    }
    return c.all
  }

  ofType(type: string): AnyEntity[] {
    return this.collect(this.byType.get(type))
  }

  withTag(tag: Tag): AnyEntity[] {
    return this.collect(this.tagIndex().get(tag))
  }

  types(): string[] {
    // Off the counts, which the scope's tallies answer without an entity read; a set over every member of a
    // 700k-entity project was built here on every call.
    return [...this.countByType().keys()].sort()
  }

  /** Any one entity of the type, without materialising the whole set. */
  firstOfType(type: string): AnyEntity | undefined {
    const ids = this.byType.get(type)
    if (!ids) return undefined
    const scope = this.scopeSet()
    for (const id of ids) if (!scope || scope.has(id)) return this.entities.get(id)
    return undefined
  }

  /**
   * How many of a type there are, without materialising one of them: the id index answers unscoped, and under a
   * project the scope's own tallies do (kept level with every write — `tally`). It walked the smaller of the scope
   * and the type's ids before: 489,700 conversations in the WildChat atlas, for the sidebar's Chats count, after
   * every write — a chat's own record included.
   */
  countOfType(type: string): number {
    const ids = this.byType.get(type)
    if (!ids) return 0
    if (!this.scopeSet()) return ids.size
    const c = this.scopeCache
    return (c.entityTypes.get(type) ?? 0) + (c.relationshipTypes.get(type) ?? 0)
  }

  /** Every type with how many carry it, counted the same way and kept for the version. */
  countByType(): Map<string, number> {
    const c = this.cached()
    if (c.counts) return c.counts
    const m = new Map<string, number>()
    if (this.scopeSet()) {
      // From the scope's tallies: a type may be carried by entities and relationships both.
      const sc = this.scopeCache
      for (const [t, n] of sc.entityTypes) m.set(t, n)
      for (const [t, n] of sc.relationshipTypes) m.set(t, (m.get(t) ?? 0) + n)
    } else for (const [t, ids] of this.byType) m.set(t, ids.size)
    c.counts = m
    return m
  }

  // ── The Library: the same reads, ignoring the active project ────────

  /**
   * Read the whole Library whatever project is open: `store.library.all()`,
   * `store.library.query(…)`, `store.library.relationshipsOf(id)`… — the
   * same methods, unscoped. For the writes that must be Library-wide
   * (cascading deletes, tag renames) the store uses it internally.
   */
  readonly library: LibraryReads = {
    all: () => this.unscoped(() => this.all()),
    ofType: (type) => this.unscoped(() => this.ofType(type)),
    countOfType: (type) => this.byType.get(type)?.size ?? 0,
    withTag: (tag) => this.unscoped(() => this.withTag(tag)),
    query: (q) => this.unscoped(() => this.query(q)),
    relationships: () => this.unscoped(() => this.relationships()),
    relationshipsOf: (id, dir) => this.unscoped(() => this.relationshipsOf(id, dir)),
    size: () => this.entities.size,
    entityCount: () => this.entities.size - this.relationshipIds.size,
    relationshipCount: () => this.relationshipIds.size,
    countByType: () => this.unscoped(() => this.countByType()),
    countByTypeAndKind: () => this.unscoped(() => this.countByTypeAndKind()),
    tags: () => this.unscoped(() => this.tags()),
    tagUsage: (tag) => this.unscoped(() => this.tagUsage(tag)),
  }

  /** Run a read with the scope lifted. Caches are per scope state, so nothing leaks between the two views. */
  private unscoped<T>(fn: () => T): T {
    const scope = this.scopeId
    if (!scope) return fn()
    this.scopeId = null
    try {
      return fn()
    } finally {
      this.scopeId = scope
    }
  }

  // ── Projects ─────────────────────────────────────────────────────────

  /** The active project id, or null for the Library. */
  get scope(): EntityId | null {
    return this.scopeId
  }

  /** Switch the active project. Bumps the version so every view re-reads. */
  setScope(id: EntityId | null) {
    if (id === this.scopeId) return
    this.scopeId = id
    this.emit({ type: 'scope' })
  }

  /** Projects the entity is marked with. */
  projectsOf(id: EntityId): EntityId[] {
    return this.entities.get(id)?.meta.projects ?? []
  }

  /** Ids marked directly with the project (not what it includes). */
  markedWith(project: EntityId): ReadonlySet<EntityId> {
    return this.byProject.get(project) ?? EMPTY
  }

  /**
   * Everything in a project's scope: its marks, plus the scope of every
   * project it includes (`data.includes`), transitively, cycles ignored.
   */
  scopeOf(project: EntityId): Set<EntityId> {
    // Walking a project's marks and includes is the dearest read on a big Library (the switcher asks for every
    // project's); the answer only changes with the data — marks, includes — so it is kept per data version: a
    // bookkeeping write (a map's saved view) does not send a city's worth of marks through again.
    if (this.scopeOfCache.version !== this._dataVersion) this.scopeOfCache = { version: this._dataVersion, sets: new Map() }
    const cached = this.scopeOfCache.sets.get(project)
    if (cached) return cached
    const out = new Set<EntityId>()
    for (const id of walkIncludes(project, (p) => this.entities.get(p)?.data.includes).ids) {
      const marks = this.byProject.get(id)
      if (marks) for (const m of marks) out.add(m)
    }
    this.scopeOfCache.sets.set(project, out)
    return out
  }

  /**
   * Add entities to a project. Relationships between the newly marked
   * entities and anything already in the project come along, so the
   * project's graph stays connected.
   */
  mark(ids: EntityId[], project: EntityId) {
    const inScope = this.scopeOf(project)
    const adding = new Set<EntityId>()
    for (const id of ids) if (this.entities.has(id) && !inScope.has(id)) adding.add(id)
    if (!adding.size) return 0
    const after = new Set([...inScope, ...adding])
    for (const id of [...adding]) {
      const e = this.entities.get(id)!
      if (e.kind === 'relationship') continue
      for (const r of this.library.relationshipsOf(id)) {
        if (!after.has(r.source.id) || !after.has(r.target.id) || after.has(r.id)) continue
        adding.add(r.id)
        after.add(r.id)
      }
    }
    const changed: AnyEntity[] = []
    for (const id of adding) {
      const e = this.entities.get(id)!
      changed.push({ ...e, meta: { ...e.meta, projects: [...(e.meta.projects ?? []), project] } })
    }
    this.upsertMany(changed)
    return changed.length
  }

  /** Remove entities from a project. The entities stay in the Library. */
  unmark(ids: EntityId[], project: EntityId) {
    const changed: AnyEntity[] = []
    for (const id of ids) {
      const e = this.entities.get(id)
      if (!e?.meta.projects?.includes(project)) continue
      const projects = e.meta.projects.filter((p) => p !== project)
      const meta = { ...e.meta }
      if (projects.length) meta.projects = projects
      else delete meta.projects
      changed.push({ ...e, meta })
    }
    this.keepMarks = false
    try {
      this.upsertMany(changed)
    } finally {
      this.keepMarks = true
    }
    return changed.length
  }

  /** The active scope as a set (see `scopeCache`). Null when unscoped. */
  private scopeSet(): Set<EntityId> | null {
    // Unscoped reads (the Library view lifts the scope for a call) leave the project's cache as it is.
    if (!this.scopeId) return null
    const c = this.scopeCache
    if (c.live && c.id === this.scopeId) return c.set
    const set = this.scopeOf(this.scopeId)
    this.addVocabulary(set)
    const next: ScopeCache = { live: true, id: this.scopeId, set, projects: new Set(), entityTypes: new Map(), relationshipTypes: new Map(), defsByName: new Map(), tagCounts: null, entities: 0, relationships: 0 }
    {
      // The project and what it includes, transitively: a mark with any of them is membership.
      next.projects = walkIncludes(this.scopeId!, (p) => this.entities.get(p)?.data.includes).ids
      for (const id of this.byType.get(SCHEMA_TYPE) ?? []) {
        const d = this.entities.get(id)
        if (d) add(next.defsByName, String(d.data.name), id)
      }
      for (const id of set) {
        const e = this.entities.get(id)
        if (!e) continue
        const m = e.kind === 'relationship' ? next.relationshipTypes : next.entityTypes
        m.set(e.type, (m.get(e.type) ?? 0) + 1)
        if (e.kind === 'relationship') next.relationships++
        else next.entities++
      }
    }
    this.scopeCache = next
    return set
  }

  /** The live scope's tag counts, counted over the scope the first time they are asked for. */
  private scopeTagCounts(): Map<Tag, number> {
    const c = this.scopeCache
    if (c.tagCounts) return c.tagCounts
    const counts = new Map<Tag, number>()
    for (const id of c.set ?? []) {
      const e = this.entities.get(id)
      if (!e) continue
      const tags = e.tags
      for (let i = 0; i < tags.length; i++) bump(counts, tags[i], 1)
    }
    c.tagCounts = counts
    return counts
  }

  /** Is the entity in the live scope by its marks? (Type definitions the vocabulary brought in are not; they are kept by `tally`.) */
  private inLiveScope(e: AnyEntity): boolean {
    const projects = e.meta.projects
    if (!projects) return false
    const c = this.scopeCache
    for (let i = 0; i < projects.length; i++) if (c.projects.has(projects[i])) return true
    return false
  }

  /**
   * A write, applied to the live scope: `e` (the entity as written, or as it was for a removal) enters, leaves or
   * stays, and the tallies follow. A type's first member brings its definitions in (the vocabulary rule); its last
   * one leaving takes them out again, unless they are marked here or shared from the Library.
   */
  private tally(e: AnyEntity, delta: 1 | -1) {
    const c = this.scopeCache
    const set = c.set!
    const rel = e.kind === 'relationship'
    const m = rel ? c.relationshipTypes : c.entityTypes
    const n = (m.get(e.type) ?? 0) + delta
    if (n > 0) m.set(e.type, n)
    else m.delete(e.type)
    if (rel) c.relationships += delta
    else c.entities += delta
    const tags = e.tags
    if (c.tagCounts) for (let i = 0; i < tags.length; i++) bump(c.tagCounts, tags[i], delta)
    if (e.type === SCHEMA_TYPE) return
    const defs = c.defsByName.get(e.type)
    if (!defs) return
    const inUse = (c.entityTypes.get(e.type) ?? 0) + (c.relationshipTypes.get(e.type) ?? 0)
    if (delta === 1 && inUse === 1) {
      for (const id of defs) {
        const d = this.entities.get(id)
        if (d && !set.has(id)) {
          set.add(id)
          this.tally(d, 1)
        }
      }
    } else if (delta === -1 && inUse === 0) {
      for (const id of defs) {
        const d = this.entities.get(id)
        if (d && set.has(id) && d.meta.projects?.length && !this.inLiveScope(d)) {
          set.delete(id)
          this.tally(d, -1)
        }
      }
    }
  }

  /** The live scope follows a write; a project or a type definition written makes it rebuild instead. */
  private scopeWrite(prev: AnyEntity | undefined, next: AnyEntity | undefined) {
    const c = this.scopeCache
    if (!c.live || !c.set) return
    for (const e of [prev, next]) {
      if (e && (e.type === SCHEMA_TYPE || e.type === PROJECT_TYPE)) {
        c.live = false
        return
      }
    }
    const id = (prev ?? next)!.id
    const was = c.set.has(id)
    const now = !!next && this.inLiveScope(next)
    if (was && !now) {
      c.set.delete(id)
      this.tally(prev!, -1)
    } else if (!was && now) {
      c.set.add(id)
      this.tally(next!, 1)
    } else if (was && now && (prev!.type !== next!.type || prev!.kind !== next!.kind)) {
      this.tally(prev!, -1)
      this.tally(next!, 1)
    } else if (was && now && prev!.tags !== next!.tags) {
      // Membership and type stand; only the tags moved. The tag tally follows them, or the scope's tag list would
      // still be naming a tag nobody in it carries — and missing the one just added.
      const counts = c.tagCounts
      if (counts) {
        for (const t of prev!.tags) if (!next!.tags.includes(t)) bump(counts, t, -1)
        for (const t of next!.tags) if (!prev!.tags.includes(t)) bump(counts, t, 1)
      }
    }
  }

  /**
   * Type definitions follow their marks like anything else: a project sees the ones made in it (or brought
   * in by its bundle). Two more come along so nothing in view is nameless: the definition of every type in
   * use in the scope, and definitions in no project at all — vocabulary made in the Library is shared.
   * A demo's types, marked with the demo, stay out of a fresh project.
   */
  private addVocabulary(set: Set<EntityId>) {
    const defs = this.byType.get(SCHEMA_TYPE)
    if (!defs?.size) return
    const used = new Set<string>()
    for (const id of set) {
      const e = this.entities.get(id)
      if (e) used.add(e.type)
    }
    for (const id of defs) {
      if (set.has(id)) continue
      const d = this.entities.get(id)
      if (d && (!d.meta.projects?.length || used.has(String(d.data.name)))) set.add(id)
    }
  }

  private scopedCounts(): { entities: number; relationships: number } {
    if (!this.scopeSet()) {
      const relationships = this.relationshipIds.size
      return { entities: this.entities.size - relationships, relationships }
    }
    return { entities: this.scopeCache.entities, relationships: this.scopeCache.relationships }
  }

  /** Type counts split by kind, since a type name can be used by both entities and relationships. */
  countByTypeAndKind(): { entities: Map<string, number>; relationships: Map<string, number> } {
    // Every TypeRegistry (one per consumer) asks for this on each version; the scoped walk is O(scope), so keep it per version.
    const c = this.cached()
    if (c.countsByKind) return c.countsByKind
    if (this.scopeSet()) return (c.countsByKind = { entities: new Map(this.scopeCache.entityTypes), relationships: new Map(this.scopeCache.relationshipTypes) })
    // The tallies the indexes keep: a map per kind, one entry per type, whatever the store holds.
    return (c.countsByKind = { entities: new Map(this.entityTypeCounts), relationships: new Map(this.relationshipTypeCounts) })
  }

  /**
   * Whether one entity is what `query(q)` would return now — the current object for its id, in scope, of the type,
   * kind and tags asked, matching the text. A view that keeps its rows by the store's events asks this of the few
   * entities a write touched instead of querying the whole project again.
   */
  matches(e: AnyEntity, q: EntityQuery = {}): boolean {
    if (this.entities.get(e.id) !== e) return false
    const scope = this.scopeSet()
    if (scope && !scope.has(e.id)) return false
    if (q.type !== undefined && !(Array.isArray(q.type) ? q.type.includes(e.type) : q.type === e.type)) return false
    if (q.kind && e.kind !== q.kind) return false
    if (q.tags?.length && !q.tags.every((t) => e.tags.includes(t))) return false
    const terms = searchTerms(q.text)
    if (terms && !matchesTerms(searchTextOf(e), terms)) return false
    return !q.predicate || q.predicate(e)
  }

  query(q: EntityQuery = {}): AnyEntity[] {
    let candidates: Iterable<AnyEntity>
    if (q.type !== undefined) {
      // By type, the ids are read straight out of the index into the one array this returns: `ofType` per type and
      // then a flatMap made two more arrays of every row before the filter had seen any of them — at a million rows
      // that is three passes and two arrays' worth of garbage for one pass's work. (Written out rather than handed
      // to a generator: a yield per entity costs more than the array it saves.)
      const types = Array.isArray(q.type) ? q.type : [q.type]
      const terms0 = searchTerms(q.text)
      const wantTags0 = q.tags && q.tags.length > 0 ? q.tags : undefined
      const scope0 = this.scopeSet()
      const out0: AnyEntity[] = []
      for (let t = 0; t < types.length; t++) {
        const ids = this.byType.get(types[t])
        if (!ids) continue
        for (const id of ids) {
          if (scope0 && !scope0.has(id)) continue
          const e = this.entities.get(id)
          if (!e) continue
          if (q.kind && e.kind !== q.kind) continue
          if (wantTags0 && !wantTags0.every((tag) => e.tags.includes(tag))) continue
          if (terms0 && !matchesTerms(searchTextOf(e), terms0)) continue
          if (q.predicate && !q.predicate(e)) continue
          out0.push(e)
        }
      }
      return out0
    } else if (q.tags?.length) {
      candidates = this.withTag(q.tags[0])
    } else if (q.kind === 'relationship') {
      candidates = this.relationships()
    } else {
      candidates = this.all()
    }
    const terms = searchTerms(q.text)
    const out: AnyEntity[] = []
    const wantTags = q.tags && q.tags.length > 0 ? q.tags : undefined
    for (const e of candidates) {
      if (q.kind && e.kind !== q.kind) continue
      if (wantTags && !wantTags.every((t) => e.tags.includes(t))) continue
      if (terms && !matchesTerms(searchTextOf(e), terms)) continue
      if (q.predicate && !q.predicate(e)) continue
      out.push(e)
    }
    return out
  }

  // ── Relationships ────────────────────────────────────────────────────

  relationships(): Relationship[] {
    const c = this.cached()
    if (c.relationships) return c.relationships
    // The array only changes when a relationship does — an edit to anything else keeps the one before it. A million
    // of them take a sixth of a second to collect and every consumer asks after every write, which is most of what
    // an edit used to cost. In a project, the scope is part of the key: its own object is replaced when it is
    // rebuilt, and a relationship entering or leaving it is a write to that relationship, which `relStructure` sees.
    const scope = this.scopeSet()
    const kept = this.relCache
    if (kept && kept.structure === this.relStructure && kept.scope === scope) return (c.relationships = kept.list)
    const list = this.collect(this.relationshipIds) as Relationship[]
    this.relCache = { structure: this.relStructure, scope, list }
    return (c.relationships = list)
  }
  private relCache: { structure: number; scope: ReadonlySet<EntityId> | null; list: Relationship[] } | undefined

  relationshipCount() {
    return this.scopeId ? this.scopedCounts().relationships : this.relationshipIds.size
  }

  entityCount() {
    return this.scopeId ? this.scopedCounts().entities : this.entities.size - this.relationshipIds.size
  }

  relationshipsOf(id: EntityId, dir: Direction = 'both'): Relationship[] {
    const ids = new Set<EntityId>()
    if (dir !== 'in') eachEnd(this.outgoing.get(id), (r) => ids.add(r))
    if (dir !== 'out') eachEnd(this.incoming.get(id), (r) => ids.add(r))
    return this.collect(ids).filter(isRelationship)
  }

  /** Entities one hop away, with the relationship that connects them. */
  neighbors(id: EntityId, dir: Direction = 'both'): { entity: AnyEntity; via: Relationship }[] {
    const out: { entity: AnyEntity; via: Relationship }[] = []
    for (const via of this.relationshipsOf(id, dir)) {
      const otherId = via.source.id === id ? via.target.id : via.source.id
      const entity = this.entities.get(otherId)
      if (entity) out.push({ entity, via })
    }
    return out
  }

  /** Relationships whose endpoint no longer exists. */
  danglingRelationships(): Relationship[] {
    return this.relationships().filter((r) => !this.has(r.source.id) || !this.has(r.target.id))
  }

  // ── Tags ─────────────────────────────────────────────────────────────

  tags(): Tag[] {
    const c = this.cached()
    if (!c.tags) {
      // In scope: the tally the scope keeps (walking two million entities and making an array of each one's tags for
      // every render of the rail was a quarter of a second a time). Unscoped: the index's keys.
      const set = this.scopeSet() ? new Set<Tag>(this.scopeTagCounts().keys()) : new Set<Tag>([...this.tagIndex().keys(), ...this.tagInfo.keys()])
      c.tags = [...set].sort(collator.compare)
    }
    return c.tags
  }

  tagUsage(tag: Tag): number {
    if (this.scopeSet()) return this.scopeTagCounts().get(tag) ?? 0
    return this.tagIndex().get(tag)?.size ?? 0
  }

  getTagInfo(tag: Tag): TagInfo {
    return this.tagInfo.get(tag) ?? { tag }
  }

  /** A tag's colour, or undefined — without the object `getTagInfo` makes for a tag that has no info (a pin per tree asks). */
  tagColor(tag: Tag): string | undefined {
    return this.tagInfo.get(tag)?.color
  }

  setTagInfo(tag: Tag, info: Partial<Omit<TagInfo, 'tag'>>) {
    // Every writer — a bundle, an import, a tool, the picker — comes through here, and the colour reaches markup: a colour or nothing.
    if (info.color !== undefined && !isCssColor(info.color)) {
      const { color: _drop, ...rest } = info
      info = rest
    }
    this.tagInfo.set(tag, { ...this.getTagInfo(tag), ...info, tag })
    this.emit({ type: 'tags' })
  }

  /** Tags are Library-wide: renaming touches every entity carrying the tag, in any project. */
  renameTag(from: Tag, to: Tag) {
    to = to.trim()
    if (!to || from === to) return
    const affected = this.library.withTag(from).map((e) =>
      patchEntity(e, { tags: uniqueTags(e.tags.map((t) => (t === from ? to : t))) }),
    )
    const info = this.tagInfo.get(from)
    this.tagInfo.delete(from)
    if (info) this.tagInfo.set(to, { ...info, tag: to })
    this.upsertMany(affected)
    // The colour and description moved with the name: say so, or persistence keeps them under the old name.
    if (info) this.emit({ type: 'tags' })
  }

  deleteTag(tag: Tag) {
    const affected = this.library.withTag(tag).map((e) => patchEntity(e, { tags: e.tags.filter((t) => t !== tag) }))
    this.tagInfo.delete(tag)
    this.upsertMany(affected)
    this.emit({ type: 'tags' })
  }

  // ── Writes ───────────────────────────────────────────────────────────

  upsert(entity: AnyEntity, opts?: { volatile?: boolean; unchecked?: boolean }) {
    this.upsertMany([entity], opts)
  }

  private guard: StoreGuard | null = null
  /** Install (or remove, with null) the check every write passes through. */
  setGuard(guard: StoreGuard | null) {
    this.guard = guard
  }

  /**
   * `unchecked` skips the guard — for restoring what is already in the store (a load from disk, a sync from another
   * tab), never for new data; a `volatile` write (bookkeeping) skips it too. A single entity the guard rejects throws (the caller asked for that one thing); in a
   * bulk write the rejected are dropped and reported through a `rejected` event, and the rest go in.
   */
  upsertMany(entities: AnyEntity[], opts?: { volatile?: boolean; unchecked?: boolean; source?: BulkSource }) {
    if (entities.length === 0) return
    const offered = entities.length
    if (this.guard && !opts?.unchecked && !opts?.volatile) {
      const map = this.entities
      const r = this.guard(entities, (id) => map.get(id))
      if (r.violations.length) {
        this.emit({ type: 'rejected', violations: r.violations, rejected: r.rejected.map((e) => e.id) })
        if (entities.length === 1 && r.rejected.length === 1) throw new GuardRejection(r.violations.filter((v) => v.severity === 'reject'))
      }
      entities = r.accepted
      if (entities.length === 0) return
    }
    const map = this.entities
    const scope = this.scopeId
    let copied = false
    const replace = (i: number, e: AnyEntity) => {
      if (!copied) {
        entities = entities.slice()
        copied = true
      }
      entities[i] = e
    }
    for (let i = 0; i < entities.length; i++) {
      let e = entities[i]
      const prev = map.get(e.id)
      if (prev !== undefined) {
        if (prev === e) continue
        // Marks are only removed by `unmark`: a write that doesn't mention projects keeps them.
        if (this.keepMarks && prev.meta.projects && !e.meta.projects) replace(i, (e = { ...e, meta: { ...e.meta, projects: prev.meta.projects } }))
        this.reindex(prev, e)
        this.scopeWrite(prev, e)
      } else {
        // Created while a project is active → in that project. Projects themselves stay in the Library.
        if (scope && !e.meta.projects && !isLibraryOnly(e.type)) replace(i, (e = { ...e, meta: { ...e.meta, projects: [scope] } }))
        this.index(e)
        this.scopeWrite(undefined, e)
      }
      map.set(e.id, e)
    }
    // The file stands for this write only if the store took every entity as it was handed over: none rejected, none copied.
    const source = opts?.source && !copied && entities.length === offered ? opts.source : undefined
    this.emit(opts?.volatile ? { type: 'upsert', entities, volatile: true } : source ? { type: 'upsert', entities, source } : { type: 'upsert', entities })
  }

  /**
   * Run many mutations with a single notification at the end. Nested calls
   * are flattened. Use for bulk loads so subscribers don't re-render per chunk.
   */
  /**
   * The same, for a load too big to do in one go: the body may `await` between chunks, and subscribers still see
   * one batch at the end. Two million entities inserted in a single call is a six-second freeze; in chunks with a
   * turn of the event loop between them it is forty short tasks the page draws a progress bar through — and,
   * because the events are still held, nothing re-renders against a half-loaded store.
   */
  async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.bulkDepth++
    try {
      return await fn()
    } finally {
      this.bulkDepth--
      this.flushPending()
    }
  }

  transaction<T>(fn: () => T): T {
    this.bulkDepth++
    try {
      return fn()
    } finally {
      this.bulkDepth--
      this.flushPending()
    }
  }

  /** Whether a transaction is open: its writes are in the store, their events held until it ends. */
  get inTransaction(): boolean {
    return this.bulkDepth > 0
  }

  private afterTransactionFns: (() => void)[] = []

  /**
   * Run `fn` once no transaction is open: now, when none is, else right after the outermost one ends and its events
   * have been delivered. For whoever must not write into a transaction someone else opened — persistence applying
   * another tab's change, which inside one would be held with the transaction's own events and written back as local.
   */
  afterTransaction(fn: () => void) {
    if (this.bulkDepth === 0) fn()
    else this.afterTransactionFns.push(fn)
  }

  private flushPending() {
    if (this.bulkDepth !== 0) return
    if (this.pending.length) {
      const events = this.pending
      this.pending = []
      this._version++
      if (events.some(material)) this._dataVersion++
      this.cache = { version: -1 }
      const merged = mergeEvents(events)
      for (const l of this.listeners) l(merged)
    }
    if (this.afterTransactionFns.length) {
      const fns = this.afterTransactionFns
      this.afterTransactionFns = []
      for (const fn of fns) fn()
    }
  }

  update<E extends AnyEntity>(id: EntityId, patch: Partial<Omit<E, 'id' | 'kind' | 'meta'>>, opts?: { volatile?: boolean }): E {
    const next = patchEntity(this.require(id) as E, patch)
    this.upsert(next, opts)
    return next
  }

  touch(id: EntityId) {
    const e = this.entities.get(id)
    if (!e) return
    this.upsert({ ...e, meta: { ...e.meta, accessedAt: new Date().toISOString() } }, { volatile: true })
  }

  /** Removes entities and, by default, every relationship touching them — in any project: a deleted entity leaves no dangling link behind. */
  remove(ids: EntityId | EntityId[], { cascade = true } = {}) {
    const list = Array.isArray(ids) ? ids : [ids]
    const removed = new Map<EntityId, number>()
    for (const id of list) {
      const e = this.entities.get(id)
      if (!e) continue
      if (cascade) for (const r of this.library.relationshipsOf(id)) this.removeOne(r.id, removed)
      this.removeOne(id, removed)
    }
    if (removed.size) this.emit({ type: 'remove', ids: [...removed.keys()], handles: [...removed.values()] })
  }

  /** Empties the store. The scope is dropped too: whatever is loaded next is the Library, not a project's. */
  clear() {
    this.scopeId = null
    this.scopeCache.live = false
    this.entities.clear()
    this.byType.clear()
    this.byTag.clear()
    this.tagCursor = 0
    this.outgoing.clear()
    this.incoming.clear()
    this.relationshipIds.clear()
    this.entityTypeCounts.clear()
    this.relationshipTypeCounts.clear()
    this.relStructure++
    this.relCache = undefined
    this.byProject.clear()
    this.tagInfo.clear()
    this.emit({ type: 'reset' })
  }

  // ── Exchange ─────────────────────────────────────────────────────────

  toDocument(): AegraphDocument {
    return {
      $schema: 'aegraph/v1',
      exportedAt: new Date().toISOString(),
      entities: this.all(),
      tags: [...this.tagInfo.values()],
    }
  }

  loadDocument(doc: AegraphDocument, { replace = false } = {}) {
    this.transaction(() => {
      if (replace) this.clear()
      for (const t of doc.tags ?? []) if (t && typeof t.tag === 'string') this.tagInfo.set(t.tag, t.color === undefined || isCssColor(t.color) ? t : { ...t, color: undefined })
      this.upsertMany(doc.entities)
    })
  }

  tagInfos(): TagInfo[] {
    return [...this.tagInfo.values()]
  }

  /** Rough in-memory footprint estimate, sampled so it's cheap on large stores. */
  estimateBytes(): number {
    const n = this.entities.size
    if (n === 0) return 0
    const sample = Math.min(n, 500)
    let bytes = 0
    let i = 0
    for (const e of this.entities.values()) {
      if (i++ >= sample) break
      bytes += JSON.stringify(e).length * 2 // UTF-16 in memory
    }
    return Math.round((bytes / sample) * n)
  }

  // ── Subscriptions ────────────────────────────────────────────────────

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ── Internals ────────────────────────────────────────────────────────

  private removeOne(id: EntityId, removed: Map<EntityId, number>) {
    const e = this.entities.get(id)
    if (!e) return
    this.unindex(e)
    this.scopeWrite(e, undefined)
    removed.set(id, this.entities.handleOf(id)!)
    this.entities.delete(id)
  }

  /** Whether the tag index already covers this entity (so a write to it must keep the index level). */
  private tagsIndexed(id: EntityId): boolean {
    if (this.tagCursor === Infinity) return true
    const h = this.entities.handleOf(id)
    return h !== undefined && h < this.tagCursor
  }

  /** The tag index, whole: what is left of it is built now. */
  private tagIndex(): Map<Tag, Set<EntityId>> {
    if (this.tagCursor !== Infinity) this.buildTagIndex(Infinity)
    return this.byTag
  }

  /** Walk the handles from the cursor, adding tags, until done or `deadline` (a `performance.now()` time) passes. */
  private buildTagIndex(deadline: number): boolean {
    const table = this.entities
    let h = this.tagCursor
    const end = table.capacity
    for (; h < end; h++) {
      const e = table.at(h)
      if (e) for (let i = 0; i < e.tags.length; i++) add(this.byTag, e.tags[i], e.id)
      if ((h & 4095) === 4095 && performance.now() > deadline) {
        this.tagCursor = h + 1
        return false
      }
    }
    this.tagCursor = Infinity
    return true
  }

  /**
   * Build some of the tag index — for `sliceMs` at most — and say whether it is done. The app calls this in idle time
   * after boot, so the index is there before anyone asks and the load it was left out of stays short.
   */
  warmTagIndex(sliceMs = 8): boolean {
    return this.tagCursor === Infinity || this.buildTagIndex(performance.now() + sliceMs)
  }

  private index(e: AnyEntity) {
    add(this.byType, e.type, e.id)
    bump(e.kind === 'relationship' ? this.relationshipTypeCounts : this.entityTypeCounts, e.type, 1)
    // A new entity's handle is past any cursor short of Infinity: the next build takes its tags.
    if (this.tagCursor === Infinity) {
      const tags = e.tags
      for (let i = 0; i < tags.length; i++) add(this.byTag, tags[i], e.id)
    }
    const projects = e.meta.projects
    if (projects) for (let i = 0; i < projects.length; i++) add(this.byProject, projects[i], e.id)
    if (e.kind === 'relationship') {
      this.relationshipIds.add(e.id)
      this.relStructure++
      addEnd(this.outgoing, e.source.id, e.id)
      addEnd(this.incoming, e.target.id, e.id)
    }
  }

  /**
   * Update indexes for a changed entity. Only keys that actually changed are
   * touched, so an edit (or an `accessedAt` bump) keeps the entity's position
   * in the type/tag sets — lists in insertion order don't jump.
   */
  private reindex(prev: AnyEntity, next: AnyEntity) {
    if (prev.type !== next.type) {
      del(this.byType, prev.type, prev.id)
      add(this.byType, next.type, next.id)
    }
    if (prev.type !== next.type || prev.kind !== next.kind) {
      bump(prev.kind === 'relationship' ? this.relationshipTypeCounts : this.entityTypeCounts, prev.type, -1)
      bump(next.kind === 'relationship' ? this.relationshipTypeCounts : this.entityTypeCounts, next.type, 1)
    }
    if (prev.kind === 'relationship' || next.kind === 'relationship') this.relStructure++
    if (prev.tags !== next.tags && this.tagsIndexed(prev.id)) {
      for (const t of prev.tags) if (!next.tags.includes(t)) del(this.byTag, t, prev.id)
      for (const t of next.tags) if (!prev.tags.includes(t)) add(this.byTag, t, next.id)
    }
    if (prev.meta.projects !== next.meta.projects) {
      const a = prev.meta.projects ?? [],
        b = next.meta.projects ?? []
      for (const p of a) if (!b.includes(p)) del(this.byProject, p, prev.id)
      for (const p of b) if (!a.includes(p)) add(this.byProject, p, next.id)
    }
    if (prev.kind === 'relationship') {
      if (next.kind !== 'relationship') {
        this.relationshipIds.delete(prev.id)
        delEnd(this.outgoing, prev.source.id, prev.id)
        delEnd(this.incoming, prev.target.id, prev.id)
      } else {
        if (prev.source.id !== next.source.id) {
          delEnd(this.outgoing, prev.source.id, prev.id)
          addEnd(this.outgoing, next.source.id, next.id)
        }
        if (prev.target.id !== next.target.id) {
          delEnd(this.incoming, prev.target.id, prev.id)
          addEnd(this.incoming, next.target.id, next.id)
        }
      }
    } else if (next.kind === 'relationship') {
      this.relationshipIds.add(next.id)
      addEnd(this.outgoing, next.source.id, next.id)
      addEnd(this.incoming, next.target.id, next.id)
    }
  }

  private unindex(e: AnyEntity) {
    del(this.byType, e.type, e.id)
    bump(e.kind === 'relationship' ? this.relationshipTypeCounts : this.entityTypeCounts, e.type, -1)
    const tags = e.tags
    if (this.tagsIndexed(e.id)) for (let i = 0; i < tags.length; i++) del(this.byTag, tags[i], e.id)
    const projects = e.meta.projects
    if (projects) for (let i = 0; i < projects.length; i++) del(this.byProject, projects[i], e.id)
    if (e.kind === 'relationship') {
      this.relationshipIds.delete(e.id)
      this.relStructure++
      delEnd(this.outgoing, e.source.id, e.id)
      delEnd(this.incoming, e.target.id, e.id)
    }
  }

  private cached(): ReadCache {
    if (this.scopeId) {
      if (this.scopedReadCache.version !== this._version || this.scopedReadCache.id !== this.scopeId) this.scopedReadCache = { version: this._version, id: this.scopeId }
      return this.scopedReadCache
    }
    if (this.cache.version !== this._version) this.cache = { version: this._version }
    return this.cache
  }

  private collect(ids?: ReadonlySet<EntityId>): AnyEntity[] {
    if (!ids) return []
    const out: AnyEntity[] = []
    const scope = this.scopeSet()
    for (const id of ids) {
      if (scope && !scope.has(id)) continue
      const e = this.entities.get(id)
      if (e) out.push(e)
    }
    return out
  }

  private emit(event: StoreEvent) {
    if (this.bulkDepth > 0) {
      this.pending.push(event)
      return
    }
    this._version++
    if (material(event)) this._dataVersion++
    this.cache = { version: -1 } // drop cached arrays so removed entities can be collected
    for (const l of this.listeners) l(event)
  }
}

const EMPTY: ReadonlySet<EntityId> = new Set()

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * The text a plain search runs over, cached per entity: id, label, description, type, tags and the data — the data
 * capped, so an entity carrying a transcript or a document body does not keep a second copy of it alive here
 * (the cache once doubled the memory of a chat archive). The first SEARCH_DATA_CHARS of the data's JSON are
 * enough to find an entity by what it is about; the full text belongs to semantic search and the readers.
 */
const SEARCH_DATA_CHARS = 8_000
/**
 * A search box's text as terms: words, each of which must occur, and
 * "quoted phrases", which must occur as written. Lower-cased; empty for a
 * blank query. The same reading everywhere a query is typed — the table,
 * the palette, the tools — so their counts agree.
 */
export function searchTerms(text: string | undefined): string[] | undefined {
  if (!text) return undefined
  const terms: string[] = []
  for (const m of text.toLowerCase().matchAll(/"([^"]*)"|(\S+)/g)) {
    const t = (m[1] ?? m[2] ?? '').trim()
    if (t) terms.push(t)
  }
  return terms.length ? terms : undefined
}

/** Whether a lower-cased haystack holds every term. */
export function matchesTerms(hay: string, terms: string[]): boolean {
  for (const t of terms) if (!hay.includes(t)) return false
  return true
}

/**
 * The search text is kept on the entity itself, under a symbol the rest of the world cannot see: not enumerable, so
 * `JSON.stringify`, a spread and a structured clone all skip it, and an edit makes a new object that has none. A
 * WeakMap held it before; at two million entities its lookups were 243 ms of a 394 ms scan — most of a text search.
 */
const SEARCH_TEXT = Symbol('searchText')
type Searchable = AnyEntity & { [SEARCH_TEXT]?: string }

/**
 * The text is a cache for a run of searches, not a second copy of the project to keep: every entity given one is
 * noted, and SEARCH_IDLE_MS after the last text was asked for they all let it go (`releaseSearchText`). On 700k street
 * trees the texts were 386 MB, kept for the life of the page after one search; a scan without them takes ~0.7 s, with
 * them ~0.2 s, so a burst of searches keeps them and a project at rest does not. The list holds the entities strongly
 * until then, so an entity replaced mid-burst is released a little late, never kept.
 */
export const SEARCH_IDLE_MS = 30_000
let withText: AnyEntity[] = []
let textAsked = 0
let textCalls = 0
let textRelease: ReturnType<typeof setTimeout> | undefined

/** Drop every search text built so far (the idle release; tests call it directly). */
export function releaseSearchText() {
  for (const e of withText) (e as Searchable)[SEARCH_TEXT] = undefined
  withText = []
  clearTimeout(textRelease)
  textRelease = undefined
}
function releaseWhenIdle() {
  const idle = Date.now() - textAsked
  if (idle < SEARCH_IDLE_MS) {
    textRelease = setTimeout(releaseWhenIdle, SEARCH_IDLE_MS - idle)
    ;(textRelease as { unref?: () => void }).unref?.()
    return
  }
  textRelease = undefined
  releaseSearchText()
}

export function searchTextOf(e: AnyEntity): string {
  // The clock is read once per few thousand calls: a scan asks this for every entity.
  if ((textCalls++ & 4095) === 0) textAsked = Date.now()
  let s = (e as Searchable)[SEARCH_TEXT]
  if (s === undefined) {
    withText.push(e)
    if (!textRelease) {
      textAsked = Date.now()
      textRelease = setTimeout(releaseWhenIdle, SEARCH_IDLE_MS)
      ;(textRelease as { unref?: () => void }).unref?.()
    }
    let data = ''
    try {
      data = JSON.stringify(e.data)
      if (data.length > SEARCH_DATA_CHARS) data = data.slice(0, SEARCH_DATA_CHARS)
    } catch {
      /* circular or exotic data — skip */
    }
    s = `${e.id}\n${e.label ?? ''}\n${e.description ?? ''}\n${e.type}\n${e.tags.join('\n')}\n${data}`.toLowerCase()
    Object.defineProperty(e, SEARCH_TEXT, { value: s, enumerable: false, configurable: true, writable: true })
  }
  return s
}

/**
 * Collapse a run of buffered events. Everything before the last reset is
 * irrelevant; the rest is delivered in order as one batch.
 */
function mergeEvents(events: StoreEvent[]): StoreEvent {
  const lastReset = events.map((e) => e.type).lastIndexOf('reset')
  const relevant = lastReset >= 0 ? events.slice(lastReset) : events
  return relevant.length === 1 ? relevant[0] : { type: 'batch', events: relevant }
}

/** One more of this key. */
function bump(m: Map<string, number>, k: string, by: number) {
  const n = (m.get(k) ?? 0) + by
  if (n > 0) m.set(k, n)
  else m.delete(k)
}

function add<K>(m: Map<K, Set<EntityId>>, k: K, id: EntityId) {
  let s = m.get(k)
  if (!s) m.set(k, (s = new Set()))
  s.add(id)
}

/** An entity's relationships at one end: one id, a few in insertion order, or a set once there are many (a hub). */
type Ends = EntityId | EntityId[] | Set<EntityId>
/** Past this many at one end, a set: removing from an array is a walk of it, and a hub's removals would be quadratic. */
const ENDS_SET_FROM = 64

function addEnd(m: Map<EntityId, Ends>, k: EntityId, id: EntityId) {
  const v = m.get(k)
  if (v === undefined) m.set(k, id)
  else if (typeof v === 'string') {
    if (v !== id) m.set(k, [v, id])
  } else if (Array.isArray(v)) {
    if (v.includes(id)) return
    if (v.length >= ENDS_SET_FROM) m.set(k, new Set([...v, id]))
    else v.push(id)
  } else v.add(id)
}

function delEnd(m: Map<EntityId, Ends>, k: EntityId, id: EntityId) {
  const v = m.get(k)
  if (v === undefined) return
  if (typeof v === 'string') {
    if (v === id) m.delete(k)
  } else if (Array.isArray(v)) {
    const i = v.indexOf(id)
    if (i < 0) return
    if (v.length === 1) m.delete(k)
    else if (v.length === 2) m.set(k, v[1 - i])
    else v.splice(i, 1)
  } else {
    v.delete(id)
    if (v.size === 0) m.delete(k)
  }
}

function eachEnd(v: Ends | undefined, f: (id: EntityId) => void) {
  if (v === undefined) return
  if (typeof v === 'string') f(v)
  else v.forEach((id) => f(id))
}

function del<K>(m: Map<K, Set<EntityId>>, k: K, id: EntityId) {
  const s = m.get(k)
  if (!s) return
  s.delete(id)
  if (s.size === 0) m.delete(k)
}

