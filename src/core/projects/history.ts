import { createEntity } from '../entity/entity'
import { newEntityId } from '../entity/ids'
import type { EntityStore, StoreEvent } from '../entity/store'
import type { AnyEntity, EntityId } from '../entity/types'
import { HandleSet } from '../entity/handleSet'
import { defaultBlobs, type BlobStore } from './historyBlobs'
import { includedProjects, requireProject } from './project'
import { applyBlob, COMMIT_TYPE, commitChain, diffWorkingTree, hashEntity, hashInSlices, headCommit, isCommitEntity, isVersioningType, knownHash, listCommits, seedHash, shortId, trackedEntities, type CommitBlob, type CommitData, type CommitEntity, type Tree, type WorkingDiff } from './versioning'

/**
 * A project's history, read and written: the commit chain in the store plus
 * the commit blobs (`historyBlobs.ts`). One instance per store (see
 * `getProjectHistory`), so the trees it rebuilds are shared by the pages,
 * the tools and autosave.
 *
 * Trees are rebuilt lazily from the chain the first time a project is asked
 * about and kept while HEAD is unchanged; a commit updates the cached tree
 * in place. Blobs are read on demand and a few recent ones are kept.
 */

/** The working tree against HEAD, content included. */
export interface WorkingChanges {
  head: CommitEntity | undefined
  added: AnyEntity[]
  modified: AnyEntity[]
  /** HEAD's version of the modified entities (the first BEFORE_LIMIT; `entityAt` fetches the rest on demand). */
  before: Map<EntityId, AnyEntity>
  /** The content they had at HEAD. */
  removed: AnyEntity[]
  /** Tree size now. */
  size: number
  /** Commits in the chain whose blob is missing on this device (their changes cannot be shown or restored). */
  missing: number
}

/** One commit, content included: what it added, changed (both sides) and removed. */
export interface CommitView {
  commit: CommitEntity
  added: AnyEntity[]
  modified: { before: AnyEntity | undefined; after: AnyEntity }[]
  removed: AnyEntity[]
  /** The blob is gone from this device. */
  missing: boolean
}

type TreeState = { head: EntityId | null; tree: Tree; missing: number }
/**
 * A project's working diff, kept between reads: what the last full diff
 * found, plus the ids the store has touched since (`dirty`). A read
 * re-classifies the dirty ids only — O(changes), where the full diff walks
 * and hashes the whole project (a badge on a 700k-entity project asked for
 * that after every edit). `dirty: 'all'` means start over.
 */
/**
 * `added` and `modified` are sets of store handles (`HandleSet`), a bit per entity, with their sizes kept: a project
 * of two million entities with no commit yet is two million "added", and as Maps of the entities that was 80 MB kept
 * and, on every badge count, an array of two million built and thrown away. `dirty` holds the handles written since
 * the last read; `gone` the ids removed since (a removed entity's handle is no longer the store's to look up).
 * `generation` is the store's table generation the handles belong to.
 */
type WorkingState = { tree: Tree; added: HandleSet; modified: HandleSet; removed: Set<EntityId>; size: number; dirty: HandleSet | 'all'; gone: Set<EntityId> }
type BlobEntry = { blob: CommitBlob; index: Map<EntityId, AnyEntity>; size: number }
/**
 * The blobs kept after use, weighed in entities rather than counted: twelve
 * small commits cost nothing, but one is the whole project when it is the
 * first commit of a big one. A blob past the budget is kept only while it
 * is in use — a burst of reads (a diff, a restore) shares one read — and
 * dropped a little after.
 */
const BLOB_CACHE = 12
const BLOB_CACHE_ENTITIES = 50_000
const HOT_MS = 15_000
/** How many modified entities `changes` resolves the earlier version of up front. */
const BEFORE_LIMIT = 1000
/** Touched past this many (or half the project), the working diff is taken again whole rather than entity by entity. */
const REDIFF_AT = 50_000

export class ProjectHistory {
  private trees = new Map<EntityId, TreeState>()
  private building = new Map<EntityId, Promise<TreeState>>()
  private blobCache = new Map<EntityId, BlobEntry>()
  private working = new Map<EntityId, WorkingState>()
  /** The commit running for each project, which the next one waits for. */
  private committing = new Map<EntityId, Promise<unknown>>()

  readonly store: EntityStore
  readonly blobs: BlobStore

  constructor(store: EntityStore, blobs: BlobStore = defaultBlobs()) {
    this.store = store
    this.blobs = blobs
    store.subscribe((ev) => this.touched(ev))
  }

  /** The store changed: the ids go on every project's dirty list (a reset means everything). */
  private touched(ev: StoreEvent) {
    if (ev.type === 'batch') {
      for (const e of ev.events) this.touched(e)
      return
    }
    if (!this.working.size) return
    if (ev.type === 'reset') {
      for (const w of this.working.values()) w.dirty = 'all'
      return
    }
    if (ev.type === 'upsert') {
      // A write of most of a project is cheaper to diff again whole than entity by entity.
      const handles: number[] = []
      for (const e of ev.entities) {
        const h = this.store.handleOf(e.id)
        if (h !== undefined) handles.push(h)
      }
      for (const w of this.working.values()) {
        if (w.dirty === 'all') continue
        if (w.dirty.size + handles.length > Math.max(REDIFF_AT, w.size / 2)) {
          w.dirty = 'all'
          continue
        }
        for (const h of handles) w.dirty.add(h)
      }
    } else if (ev.type === 'remove') {
      // The removed entities' handles, as the store gave them out: placed again like any written one (the entity is
      // gone, so it is no longer live), which also clears their bits. An id with no handle is placed on its own.
      for (const w of this.working.values()) {
        if (w.dirty === 'all') continue
        if (ev.handles) for (const h of ev.handles) w.dirty.add(h)
        else for (const id of ev.ids) w.gone.add(id)
      }
    }
  }

  /**
   * The working diff, from the kept state when there is one for this tree:
   * each id touched since is placed again — in the project or not, and
   * against HEAD's hash — and the rest stands. An entity already counted as
   * modified and written again is kept as modified without a new hash, so a
   * 50 MB dataset is not hashed after every edit; a write that puts it back
   * exactly as HEAD is a restore or a revert, and those seed the object's
   * hash (`seedHash`), which is checked first. `commit` hashes anyway.
   */
  private workingDiff(project: EntityId, tree: Tree): WorkingDiff {
    const w = this.workingState(project, tree)
    const added: AnyEntity[] = []
    const modified: AnyEntity[] = []
    w.added.forEach((h) => {
      const e = this.store.entityAt(h)
      if (e) added.push(e)
    })
    w.modified.forEach((h) => {
      const e = this.store.entityAt(h)
      if (e) modified.push(e)
    })
    return { added, modified, removedIds: [...w.removed], size: w.size }
  }

  /** The working diff's counts, from the kept sets' sizes: nothing built per entity (a badge, autosave's check). */
  private workingCounts(project: EntityId, tree: Tree): { added: number; modified: number; removed: number; total: number } {
    const w = this.workingState(project, tree)
    return { added: w.added.size, modified: w.modified.size, removed: w.removed.size, total: w.added.size + w.modified.size + w.removed.size }
  }

  /**
   * The working state, brought up to date: from the kept one when there is one for this tree, each handle and id
   * touched since placed again — in the project or not, and against HEAD's hash — and the rest stands. An entity
   * already counted as modified and written again is kept as modified without a new hash, so a 50 MB dataset is not
   * hashed after every edit; a write that puts it back exactly as HEAD is a restore or a revert, and those seed the
   * object's hash (`seedHash`), which is checked first. `commit` hashes anyway.
   */
  private workingState(project: EntityId, tree: Tree): WorkingState {
    let w = this.working.get(project)
    if (!w || w.tree !== tree || w.dirty === 'all') {
      const d = diffWorkingTree(this.store, project, tree)
      const added = new HandleSet()
      const modified = new HandleSet()
      for (const e of d.added) added.add(this.store.handleOf(e.id)!)
      for (const e of d.modified) modified.add(this.store.handleOf(e.id)!)
      w = { tree, added, modified, removed: new Set(d.removedIds), size: d.size, dirty: new HandleSet(), gone: new Set() }
      this.working.set(project, w)
      return w
    }
    if (w.dirty.size || w.gone.size) {
      const scope = includedProjects(this.store, project)
      const place = (id: EntityId, h: number | undefined) => {
        const e = h === undefined ? undefined : this.store.entityAt(h)
        const live = !!e && !isVersioningType(e.type) && !!e.meta.projects?.some((p) => scope.has(p))
        const wasAdded = h !== undefined && w!.added.has(h)
        const wasModified = h !== undefined && w!.modified.has(h)
        const wasLive = wasAdded || wasModified || (tree.has(id) && !w!.removed.has(id))
        if (live !== wasLive) w!.size += live ? 1 : -1
        if (h !== undefined) {
          w!.added.delete(h)
          w!.modified.delete(h)
        }
        w!.removed.delete(id)
        if (!live) {
          if (tree.has(id)) w!.removed.add(id)
          return
        }
        const hash = tree.get(id)
        const known = knownHash(e!)
        if (hash === undefined) w!.added.add(h!)
        else if (known !== undefined ? known !== hash : wasModified || hash !== hashEntity(e!)) w!.modified.add(h!)
      }
      // Lowest handle first, so an id removed and written again is placed at its old handle (gone) and then its new one.
      w.dirty.forEach((h) => place(this.store.idAt(h)!, h))
      // A removal that named no handles: the id alone, at the handle it has now if it came back.
      for (const id of w.gone) place(id, this.store.handleOf(id))
      w.dirty.clear()
      w.gone.clear()
    }
    return w
  }

  // ── Reads ────────────────────────────────────────────────────────────

  commits(project: EntityId): CommitEntity[] {
    return listCommits(this.store, project)
  }

  head(project: EntityId): CommitEntity | undefined {
    return headCommit(this.store, project)
  }

  /** HEAD's tree, rebuilt from the chain when HEAD moved (or on first use). */
  async tree(project: EntityId): Promise<Tree> {
    return (await this.treeState(project)).tree
  }

  private async treeState(project: EntityId): Promise<TreeState> {
    const head = headCommit(this.store, project)?.id ?? null
    const cached = this.trees.get(project)
    if (cached && cached.head === head) return cached
    let building = this.building.get(project)
    if (!building) {
      building = this.rebuild(project, head).finally(() => this.building.delete(project))
      this.building.set(project, building)
    }
    const state = await building
    // HEAD may have moved while rebuilding (an autosave landed): the next call rebuilds again.
    if (state.head === (headCommit(this.store, project)?.id ?? null)) this.trees.set(project, state)
    return state
  }

  /**
   * HEAD's tree from each commit's ids and hashes, never its content: the
   * first commit of a big project is the project, and reading it here kept
   * a second copy of it for as long as the page lived (950 MB against 313 MB
   * for 700k entities after a reload). The keys are the store's own id
   * strings where it has them, so the tree adds a Map and not the ids again.
   */
  private async rebuild(project: EntityId, head: EntityId | null): Promise<TreeState> {
    const tree: Tree = new Map()
    let missing = 0
    const own = (id: EntityId) => this.store.get(id)?.id ?? id
    for (const c of commitChain(this.store, project).reverse()) {
      if (this.blobs.hashes) {
        const h = await this.blobs.hashes(c.id)
        if (!h) {
          missing++
          continue
        }
        for (let i = 0; i < h.ids.length; i++) tree.set(own(h.ids[i]), h.hashes[i])
        for (const id of h.removed) tree.delete(id)
        continue
      }
      const entry = await this.blob(c.id)
      if (entry) applyBlob(tree, entry.blob)
      else missing++
    }
    return { head, tree, missing }
  }

  /** What the working tree changed since HEAD. With no commit yet, everything is "added". */
  async changes(project: EntityId): Promise<WorkingChanges> {
    requireProject(this.store, project)
    const state = await this.treeState(project)
    const head = headCommit(this.store, project)
    const d = this.workingDiff(project, state.tree)
    const removed: AnyEntity[] = []
    for (const id of d.removedIds) {
      const e = await this.entityAt(head?.id ?? null, id)
      if (e) removed.push(e)
    }
    const before = new Map<EntityId, AnyEntity>()
    for (const e of d.modified.slice(0, BEFORE_LIMIT)) {
      const b = await this.entityAt(head?.id ?? null, e.id)
      if (b) before.set(e.id, b)
    }
    return { head, added: d.added, modified: d.modified, before, removed, size: d.size, missing: state.missing }
  }

  /** Just the counts, for badges; the same work as `changes` minus the removed content. */
  async count(project: EntityId): Promise<{ added: number; modified: number; removed: number; total: number }> {
    const state = await this.treeState(project)
    return this.workingCounts(project, state.tree)
  }

  /**
   * The counts without waiting: from the cached tree when HEAD's tree is
   * built (the badge and autosave keep it warm), else undefined — and the
   * build is started so the next call has it. For a synchronous reader
   * such as the assistant's app context.
   */
  /**
   * Whether a count of this project is cheap now: HEAD's tree is built and the working diff is kept, so a count
   * re-places only what changed since. False before the first count, which diffs the whole project.
   */
  hasCount(project: EntityId): boolean {
    const head = headCommit(this.store, project)?.id ?? null
    const cached = this.trees.get(project)
    const w = this.working.get(project)
    return !!cached && cached.head === head && !!w && w.tree === cached.tree && w.dirty !== 'all'
  }

  countSync(project: EntityId): { added: number; modified: number; removed: number; total: number } | undefined {
    const head = headCommit(this.store, project)?.id ?? null
    const cached = this.trees.get(project)
    if (!cached || cached.head !== head) {
      if (this.store.has(project)) void this.treeState(project).catch(() => {})
      return undefined
    }
    return this.workingCounts(project, cached.tree)
  }

  /**
   * One entity's history: the commits that wrote or removed it, newest
   * first, each with the version it left behind (and, for a change, the one
   * it replaced). Stops after `limit` entries; a commit whose blob is gone
   * is reported as such and skipped.
   */
  async entityLog(project: EntityId, id: EntityId, limit = 20): Promise<{ commit: CommitEntity; change: 'added' | 'modified' | 'removed' | 'unknown'; before?: AnyEntity; after?: AnyEntity }[]> {
    const out: { commit: CommitEntity; change: 'added' | 'modified' | 'removed' | 'unknown'; before?: AnyEntity; after?: AnyEntity }[] = []
    for (const c of commitChain(this.store, project)) {
      if (out.length >= limit) break
      const entry = await this.blob(c.id)
      if (!entry) {
        out.push({ commit: c, change: 'unknown' })
        continue
      }
      if (entry.blob.added.some((e) => e.id === id)) out.push({ commit: c, change: 'added', after: entry.index.get(id) })
      else if (entry.blob.modified.some((e) => e.id === id)) out.push({ commit: c, change: 'modified', before: await this.entityAt(c.data.parent, id), after: entry.index.get(id) })
      else {
        const gone = entry.blob.removed.find((e) => e.id === id)
        if (gone) out.push({ commit: c, change: 'removed', before: gone })
      }
    }
    return out
  }

  /** The entity as it was in the tree of `commit` (null = an empty tree): the last commit at or before it that wrote the id. */
  async entityAt(commit: EntityId | null, id: EntityId): Promise<AnyEntity | undefined> {
    let cur = commit ? this.store.get(commit) : undefined
    const seen = new Set<EntityId>()
    while (isCommitEntity(cur) && !seen.has(cur.id)) {
      seen.add(cur.id)
      const entry = await this.blob(cur.id)
      if (entry) {
        const hit = entry.index.get(id)
        if (hit) return hit
        if (entry.blob.removed.some((e) => e.id === id)) return undefined
      }
      cur = cur.data.parent ? this.store.get(cur.data.parent) : undefined
    }
    return undefined
  }

  /** A commit with its content and, for the modified, the version it replaced. */
  async view(commitId: EntityId): Promise<CommitView> {
    const commit = this.store.get(commitId)
    if (!isCommitEntity(commit)) throw new Error(`No commit with id ${commitId}`)
    const entry = await this.blob(commitId)
    if (!entry) return { commit, added: [], modified: [], removed: [], missing: true }
    const modified: CommitView['modified'] = []
    for (const after of entry.blob.modified) modified.push({ before: await this.entityAt(commit.data.parent, after.id), after })
    return { commit, added: entry.blob.added, modified, removed: entry.blob.removed, missing: false }
  }

  /** The whole tree as it stood after a commit: every entity, by id. */
  async stateAt(commitId: EntityId): Promise<Map<EntityId, AnyEntity>> {
    const commit = this.store.get(commitId)
    if (!isCommitEntity(commit)) throw new Error(`No commit with id ${commitId}`)
    const chain: CommitEntity[] = []
    let cur: AnyEntity | undefined = commit
    const seen = new Set<EntityId>()
    while (isCommitEntity(cur) && !seen.has(cur.id)) {
      seen.add(cur.id)
      chain.push(cur)
      cur = cur.data.parent ? this.store.get(cur.data.parent) : undefined
    }
    const state = new Map<EntityId, AnyEntity>()
    for (const c of chain.reverse()) {
      const entry = await this.blob(c.id)
      if (!entry) throw new Error(`Commit ${shortId(c.id)} has no content on this device; the tree cannot be rebuilt past it.`)
      for (const e of entry.blob.added) state.set(e.id, e)
      for (const e of entry.blob.modified) state.set(e.id, e)
      for (const e of entry.blob.removed) state.delete(e.id)
    }
    return state
  }

  // ── Writes ───────────────────────────────────────────────────────────

  /** Commit the working tree. Returns undefined when nothing changed. */
  /**
   * Commit the working changes. One commit per project at a time — a big one hashes a slice at a time and takes a
   * few seconds, and an autosave landing meanwhile must wait for it rather than commit the same changes twice.
   */
  commit(project: EntityId, message: string, opts: { auto?: boolean; restoredFrom?: EntityId } = {}): Promise<CommitEntity | undefined> {
    const before = this.committing.get(project) ?? Promise.resolve(undefined)
    const run = before.catch(() => undefined).then(() => this.commitNow(project, message, opts))
    const tail = run.finally(() => {
      if (this.committing.get(project) === tail) this.committing.delete(project)
    })
    // The caller hears of a failure through `run`; the tail is only for the next commit to wait on.
    tail.catch(() => {})
    this.committing.set(project, tail)
    return run
  }

  private async commitNow(project: EntityId, message: string, opts: { auto?: boolean; restoredFrom?: EntityId }): Promise<CommitEntity | undefined> {
    requireProject(this.store, project)
    const state = await this.treeState(project)
    const parent = headCommit(this.store, project)
    const d = this.workingDiff(project, state.tree)
    // Hashed a slice at a time: the first commit of a big project is every entity in it (see `hashInSlices`).
    const hashes: Record<EntityId, string> = {}
    // The kept diff may carry a "modified" entity that a later write put back as HEAD has it: the hash says, and
    // the kept diff learns it too (a discard that lands exactly on HEAD makes no commit, and the badge must agree).
    const kept = this.working.get(project)
    const modified: AnyEntity[] = []
    await hashInSlices(d.modified, (e, h) => {
      if (h === state.tree.get(e.id)) {
        const h = this.store.handleOf(e.id)
        if (kept?.tree === state.tree && h !== undefined) kept.modified.delete(h)
        return
      }
      hashes[e.id] = h
      modified.push(e)
    })
    d.modified = modified
    if (!d.added.length && !d.modified.length && !d.removedIds.length) return undefined
    const removed: AnyEntity[] = []
    for (const id of d.removedIds) {
      const e = await this.entityAt(parent?.id ?? null, id)
      if (e) removed.push(e)
    }
    const id = newEntityId()
    await hashInSlices(d.added, (e, h) => (hashes[e.id] = h))
    const blob: CommitBlob = { id, project, added: d.added, modified: d.modified, removed, hashes }
    await this.blobs.put(blob)
    const at = new Date().toISOString()
    const text = message.trim() || (opts.auto ? 'Autosave' : 'Update')
    const commit = createEntity<CommitData>({
      id,
      type: COMMIT_TYPE,
      label: text,
      data: { project, parent: parent?.id ?? null, message: text, ...(opts.auto ? { auto: true } : {}), at, size: d.size, stats: { added: d.added.length, modified: d.modified.length, removed: d.removedIds.length }, ...(opts.restoredFrom ? { restoredFrom: opts.restoredFrom } : {}) },
      meta: { source: opts.auto ? 'autosave' : 'user' },
    })
    // The tree follows the commit whatever the store does with the event.
    const tree = state.tree
    for (const id of d.removedIds) tree.delete(id)
    applyBlob(tree, blob)
    this.trees.set(project, { head: id, tree, missing: state.missing })
    // Everything the diff held is in the tree now; what the store touched while the blob was written stays dirty.
    const w = this.working.get(project)
    if (w && w.tree === tree) {
      w.added.clear()
      w.modified.clear()
      w.removed.clear()
    }
    // A commit the cache would keep is kept for the reads that follow (its changes, a diff); a bigger one — the first
    // commit of a big project is the whole project — is on disk, and holding it and an index of it here as well was a
    // second copy of the project at the moment the tab could least afford one.
    const size = blob.added.length + blob.modified.length + blob.removed.length
    if (size <= BLOB_CACHE_ENTITIES) this.remember(id, { blob, index: indexOf(blob), size })
    this.store.upsert(commit)
    return commit
  }

  /**
   * Make the working tree what it was after `commitId`, then commit that as
   * a new point ("Restore …") so the history stays linear and the step can
   * itself be undone. Entities that left the project in between come back
   * with their marks; entities that joined are taken out (deleted when they
   * were in no other project). Entities in scope only through an included
   * project are left alone and counted as skipped.
   */
  async restore(project: EntityId, commitId: EntityId, opts: { message?: string } = {}): Promise<{ commit: CommitEntity | undefined; upserted: number; removed: number; unmarked: number; skipped: number }> {
    requireProject(this.store, project)
    const target = this.store.get(commitId)
    if (!isCommitEntity(target) || target.data.project !== project) throw new Error(`Commit ${commitId} is not in this project's history`)
    const state = await this.stateAt(commitId)
    const store = this.store
    let upserted = 0
    let removed = 0
    let unmarked = 0
    let skipped = 0
    store.transaction(() => {
      const live = trackedEntities(store, project)
      const toUpsert: AnyEntity[] = []
      for (const [id, e] of state) {
        const cur = store.get(id)
        if (cur && hashEntity(cur) === hashEntity(e) && (cur.meta.projects ?? []).includes(project)) continue
        const marks = new Set(cur?.meta.projects ?? [])
        marks.add(project)
        const back = { ...e, meta: { ...e.meta, projects: [...marks] } }
        seedHash(back, hashEntity(e))
        toUpsert.push(back)
      }
      const toRemove: EntityId[] = []
      const toUnmark: EntityId[] = []
      for (const e of live) {
        if (state.has(e.id)) continue
        const marks = store.projectsOf(e.id)
        if (!marks.includes(project)) skipped++
        else if (marks.length > 1) toUnmark.push(e.id)
        else toRemove.push(e.id)
      }
      if (toUpsert.length) store.upsertMany(toUpsert)
      upserted = toUpsert.length
      unmarked = store.unmark(toUnmark, project)
      if (toRemove.length) store.remove(toRemove, { cascade: false })
      removed = toRemove.length
    })
    const commit = await this.commit(project, opts.message ?? `Restore ${shortId(commitId)} — ${target.data.message}`, { restoredFrom: commitId })
    return { commit, upserted, removed, unmarked, skipped }
  }

  /** Put one entity back the way HEAD has it: an edit undone, a removal undone, an addition taken out. */
  async revertEntity(project: EntityId, id: EntityId): Promise<'restored' | 'removed' | 'unmarked' | 'unchanged'> {
    const head = headCommit(this.store, project)
    const before = await this.entityAt(head?.id ?? null, id)
    const cur = this.store.get(id)
    if (before) {
      if (cur && hashEntity(cur) === hashEntity(before) && (cur.meta.projects ?? []).includes(project)) return 'unchanged'
      const marks = new Set(cur?.meta.projects ?? [])
      marks.add(project)
      const back = { ...before, meta: { ...before.meta, projects: [...marks] } }
      seedHash(back, hashEntity(before))
      this.store.upsert(back)
      return 'restored'
    }
    if (!cur) return 'unchanged'
    const marks = this.store.projectsOf(id)
    if (marks.length > 1) {
      this.store.unmark([id], project)
      return 'unmarked'
    }
    this.store.remove(id)
    return 'removed'
  }

  /** Drop a project's history: its commits and their blobs. */
  async forget(project: EntityId): Promise<number> {
    const ids = listCommits(this.store, project).map((c) => c.id)
    await this.blobs.delete(ids)
    for (const id of ids) this.blobCache.delete(id)
    this.trees.delete(project)
    if (ids.length) this.store.remove(ids, { cascade: false })
    return ids.length
  }

  /**
   * Blobs whose commit is no longer in the store (a deleted project, a commit deleted by hand): deleted — but only
   * once they have been seen without their commit for `after` ms (a day). A blob is written before its commit entity,
   * and another tab's commit reaches this store later still (its database write, then the broadcast): a blob found
   * orphaned at one start may be a commit landing elsewhere. So a first sighting is only noted in the `ledger` (when
   * each orphan was first seen; the app's is in localStorage, `storagePruneLedger`), and a blob goes at a later prune
   * when it is still orphaned and was first seen long enough ago; one whose commit turned up is struck off. A blob
   * of unknown age is thus never deleted on one look. Runs under a Web Lock where the browser has them, so two tabs
   * starting together do not prune at once (the second skips). Returns how many were deleted.
   */
  async prune({ ledger = this.pruneLedger, after = PRUNE_AFTER_MS, now = Date.now() }: { ledger?: PruneLedger; after?: number; now?: number } = {}): Promise<number> {
    const run = async (): Promise<number> => {
      const keys = await this.blobs.keys()
      const seen = ledger.read()
      const next: Record<EntityId, number> = {}
      const doomed: EntityId[] = []
      for (const k of keys) {
        if (isCommitEntity(this.store.get(k))) continue
        const first = seen[k]
        if (typeof first === 'number' && now - first >= after) doomed.push(k)
        else next[k] = typeof first === 'number' ? first : now
      }
      await this.blobs.delete(doomed)
      for (const id of doomed) this.blobCache.delete(id)
      ledger.write(next)
      return doomed.length
    }
    return withLock(PRUNE_LOCK, run, 0)
  }

  /** Orphans seen by this instance, when no ledger is handed in: nothing is deleted on one look even then. */
  private pruneLedger: PruneLedger = memoryPruneLedger()

  // ── Blobs ────────────────────────────────────────────────────────────

  private async blob(commitId: EntityId): Promise<BlobEntry | undefined> {
    const cached = this.blobCache.get(commitId)
    if (cached) {
      // Most recently used last.
      this.blobCache.delete(commitId)
      this.blobCache.set(commitId, cached)
      return cached
    }
    const blob = await this.blobs.get(commitId)
    if (!blob) return undefined
    const entry = { blob, index: indexOf(blob), size: blob.added.length + blob.modified.length + blob.removed.length }
    this.remember(commitId, entry)
    return entry
  }

  private hot?: { id: EntityId; timer: ReturnType<typeof setTimeout> }
  private remember(id: EntityId, entry: BlobEntry) {
    this.blobCache.set(id, entry)
    if (entry.size > BLOB_CACHE_ENTITIES) {
      // Too big to keep: held for the burst it was read for, then let go.
      if (this.hot) {
        clearTimeout(this.hot.timer)
        if (this.hot.id !== id) this.blobCache.delete(this.hot.id)
      }
      const timer = setTimeout(() => {
        if (this.hot?.id === id) this.hot = undefined
        this.blobCache.delete(id)
      }, HOT_MS)
      ;(timer as { unref?: () => void }).unref?.()
      this.hot = { id, timer }
    }
    let weight = 0
    for (const [k, e] of this.blobCache) if (k !== this.hot?.id) weight += e.size
    for (const [k, e] of this.blobCache) {
      if (this.blobCache.size <= BLOB_CACHE && weight <= BLOB_CACHE_ENTITIES) break
      if (k === id || k === this.hot?.id) continue
      this.blobCache.delete(k)
      weight -= e.size
    }
  }
}

function indexOf(blob: CommitBlob): Map<EntityId, AnyEntity> {
  const m = new Map<EntityId, AnyEntity>()
  for (const e of blob.added) m.set(e.id, e)
  for (const e of blob.modified) m.set(e.id, e)
  return m
}

// ── Pruning ──────────────────────────────────────────────────────────────

/** How long a blob must have been seen without its commit before `prune` deletes it. */
export const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000
const PRUNE_LOCK = 'aegraph-history-prune'

/** When each orphaned blob was first seen orphaned (ms since the epoch), by commit id. */
export interface PruneLedger {
  read(): Record<EntityId, number>
  write(seen: Record<EntityId, number>): void
}

export function memoryPruneLedger(): PruneLedger {
  let seen: Record<EntityId, number> = {}
  return { read: () => ({ ...seen }), write: (s) => void (seen = { ...s }) }
}

/** The ledger kept in a Storage (localStorage in the app), shared by the tabs. One that cannot be read reads empty. */
export function storagePruneLedger(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, key = 'aegraph:history:orphans'): PruneLedger {
  return {
    read: () => {
      try {
        const v = JSON.parse(storage.getItem(key) ?? '{}') as unknown
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<EntityId, number>) : {}
      } catch {
        return {}
      }
    },
    write: (seen) => {
      try {
        if (Object.keys(seen).length) storage.setItem(key, JSON.stringify(seen))
        else storage.removeItem(key)
      } catch {
        /* no storage: the orphans are seen afresh next time, and kept meanwhile */
      }
    },
  }
}

type Locks = { request<T>(name: string, options: { ifAvailable: boolean }, run: (lock: unknown) => Promise<T>): Promise<T> }

/** `run` under the Web Lock `name` when the browser has them; `busy` when another tab holds it. Without locks, just `run`. */
async function withLock<T>(name: string, run: () => Promise<T>, busy: T): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks
  if (!locks?.request) return run()
  return locks.request(name, { ifAvailable: true }, (lock) => (lock ? run() : Promise.resolve(busy)))
}

// ── One per store ────────────────────────────────────────────────────────

const instances = new WeakMap<EntityStore, ProjectHistory>()

/** The history service for a store — the pages, the tools and autosave share one. */
export function getProjectHistory(store: EntityStore, blobs?: BlobStore): ProjectHistory {
  let h = instances.get(store)
  if (!h) {
    h = new ProjectHistory(store, blobs)
    instances.set(store, h)
  }
  return h
}
