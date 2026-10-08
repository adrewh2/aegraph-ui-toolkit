import { schemaTypeId } from '../entity/categories'
import type { BulkSource, EntityStore } from '../entity/store'
import type { AegraphDocument, AnyEntity, EntityId, TagInfo } from '../entity/types'
import { normalizeEntity, normalizeTagInfo } from '../exchange/formats'
import { stableStringify } from './versioning'
import { createProject, isProjectEntity, isSafeProjectId, projectCounts, requireProject, type ProjectEntity } from './project'
import { readStashedUiState, readUiState, stashUiState } from './active'
import { quarantineImportedConstraints } from '../constraints/quarantine'

/**
 * A bundle is the `aegraph/v1` document with two optional keys: `project`
 * (which entity in the file is the project this file *is*) and `state`
 * (the route and UI state to reopen it on the same screen). Old files are
 * bundles without either; old readers ignore both.
 */

/**
 * The keys under which an entity's `data` names another entity by id — the references a project's presentation
 * entities make: a graph scene's filter, layout, rendering and analysis, a projection's diagram or script, a slide's
 * deck, compose and beat, a block's children and its items' `ref`s, a story's deck, a dataset's script, a project's
 * home workstation. A key that ends in `Id` / `Ids` (camelCase: `filterId`, `diagramId`, `selectedIds`) counts too.
 * Anything else — a dataset's cells, a message's text, a property someone typed — is content, and a string in it that
 * happens to equal an id is not followed: it would pull an unrelated entity, from any project, into the file.
 */
const REF_KEYS = new Set(['ref', 'refs', 'deck', 'compose', 'beat', 'story', 'parent', 'children', 'members', 'items', 'source', 'target'])
const isRefKey = (k: string) => REF_KEYS.has(k) || /[a-z](Id|Ids)$/.test(k)
/** Content: never searched for references, however deep. */
const CONTENT_KEYS = new Set(['rows', 'records', 'cells', 'values', 'columns', 'messages', 'content', 'text', 'transcript', 'segments', 'properties'])

/** A chat with the assistant (`assistant-chat:…`, tagged `assistant:chat`) or the assistant's memory (`assistant:memory`). */
export const isAssistantRecord = (e: AnyEntity) => e.tags.includes('assistant:memory') || e.tags.includes('assistant:chat') || e.id.startsWith('assistant-chat:')

export interface ClosureOptions {
  /** Carry the project's assistant chats and the assistant's memory for it. Default true for a saved bundle; a published page leaves them out. */
  assistant?: boolean
}

/**
 * Everything a project needs to open elsewhere, computed once:
 * its scope, relationships among the scope, whatever the scope's
 * presentation entities reference by id under a reference key (`REF_KEYS`: a graph scene's layout, a projection's
 * diagram, a slide's deck — followed transitively), the type
 * definitions and tag metadata in use, and the project entity itself. `outside` counts the entities it carries
 * that are not in the project — what its references reach elsewhere in the Library.
 */
export function projectClosure(store: EntityStore, projectId: EntityId, opts: ClosureOptions = {}): { entities: AnyEntity[]; tags: TagInfo[]; outside: number } {
  const project = requireProject(store, projectId)
  const scope = new Set<EntityId>(store.scopeOf(projectId))
  const keep = (e: AnyEntity | undefined) => !!e && (opts.assistant !== false || !isAssistantRecord(e))
  const ids = new Set<EntityId>([...scope].filter((id) => keep(store.get(id))))
  const queue = [...ids]
  const follow = (v: string) => {
    if (ids.has(v) || v.length < 4 || !store.has(v)) return
    const e = store.get(v)
    if (isProjectEntity(e) || !keep(e)) return
    ids.add(v)
    queue.push(v)
  }
  /** `ref`: whether `v` sits under a reference key, so a string in it is an id to follow. */
  const visit = (v: unknown, ref: boolean, depth: number) => {
    if (depth > 6 || v == null) return
    if (typeof v === 'string') return ref ? follow(v) : undefined
    if (Array.isArray(v)) {
      // Large numeric/positional arrays have no ids in them; only look at arrays of strings/objects.
      if (v.length > 5000) return
      for (const x of v) visit(x, ref, depth + 1)
      return
    }
    if (typeof v === 'object')
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (CONTENT_KEYS.has(k)) continue
        visit(x, isRefKey(k) || (ref && k === 'id'), depth + 1)
      }
  }
  while (queue.length) {
    const e = store.get(queue.pop()!)
    if (!e) continue
    visit(e.data, false, 0)
    if (e.kind === 'relationship') {
      for (const end of [e.source.id, e.target.id]) {
        if (ids.has(end) || !store.has(end) || !keep(store.get(end))) continue
        ids.add(end)
        queue.push(end)
      }
    }
  }
  // Relationships among the closure.
  for (const id of [...ids]) {
    for (const r of store.library.relationshipsOf(id)) if (!ids.has(r.id) && ids.has(r.source.id) && ids.has(r.target.id) && keep(r)) ids.add(r.id)
  }
  const entities: AnyEntity[] = []
  const types = new Set<string>()
  const tags = new Set<string>()
  let outside = 0
  for (const id of ids) {
    const e = store.get(id)
    if (!e || e.id === projectId) continue
    entities.push(e)
    if (!scope.has(id)) outside++
    types.add(e.type)
    for (const t of e.tags) tags.add(t)
  }
  // Vocabulary travels with the data.
  for (const t of types) {
    const def = store.get(schemaTypeId(t))
    if (def && !ids.has(def.id)) entities.push(def)
  }
  const counts = projectCounts(store, projectId)
  entities.push({ ...project, data: { ...project.data, summary: { entities: counts.entities, relationships: counts.relationships, byType: counts.byType } } })
  return { entities, tags: [...tags].map((t) => store.getTagInfo(t)).filter((i) => i.color || i.description), outside }
}

/** The bundle document for a project, with the screen state to reopen it. */
export function buildBundle(store: EntityStore, projectId: EntityId, opts: { route?: string; withState?: boolean; assistant?: boolean; /** Told how many entities from outside the project the file carries. */ onClosure?: (c: { outside: number }) => void } = {}): AegraphDocument {
  const { entities, tags, outside } = projectClosure(store, projectId, { assistant: opts.assistant })
  opts.onClosure?.({ outside })
  const doc: AegraphDocument = { $schema: 'aegraph/v1', exportedAt: new Date().toISOString(), tags, entities, project: projectId }
  if (opts.withState !== false) {
    const ui = store.scope === projectId ? readUiState() : readStashedUiState(projectId)
    doc.state = { route: opts.route, ui }
  }
  return doc
}

export interface BundleReport {
  /** The project the file was, or the one created for it. */
  project: ProjectEntity
  created: number
  updated: number
  upToDate: number
  skipped: number
  /** What the file would have changed that is not its own, left as the Library has it (see `planImport`). */
  conflicts: BundleConflicts
  route?: string
}

/**
 * What an open leaves alone because it is not the file's to change. `entities`: entities already in the Library that
 * belong to no project or to other projects, of which the file holds a newer version — kept as they are, not written,
 * not added to the file's project. `projects`: project entities in the file other than its own — never written, new
 * or not. `types`: type definitions (`schema:type`, Library-wide) the file holds differently, kept unless the caller
 * agreed to replace them (`replaceTypes`, or a yes to `confirm`). `tags`: tag colours and descriptions the Library
 * already has that the file would change, kept on the same terms.
 */
export interface BundleConflicts {
  entities: number
  projects: number
  types: number
  tags: number
}

/** What opening a bundle would do, worked out without writing anything: what a caller shows before asking. */
export interface BundlePreview {
  project: { id: EntityId; label?: string; /** The Library already has this project: the open updates it in place. */ exists: boolean }
  created: number
  /** The file's own entities already in the Library that the open would replace with the file's newer version. */
  updated: number
  upToDate: number
  skipped: number
  conflicts: BundleConflicts
  /** Up to 50 of the ids `updated` counts. */
  updates: EntityId[]
  /** Up to 50 of the type definitions `conflicts.types` counts — what a yes to `confirm` replaces. */
  types: EntityId[]
}

const sameDefinition = (a: AnyEntity, b: AnyEntity) => a.type === b.type && a.label === b.label && a.description === b.description && stableStringify(a.data) === stableStringify(b.data)

/**
 * Merge a bundle into the Library and make it a project. Nothing is wiped, and a file changes only what is its own:
 *
 * - **The file's project** (`doc.project`, a `project` entity in the file) is kept, or one is created named after the
 *   file. An id the Library holds as something other than a project is not taken: a new project is made.
 * - **New entities** go in marked with the file's project and nothing else — marks naming other projects are dropped,
 *   so a file cannot put anything into a project of the reader's.
 * - **The project's own entities** (already in the Library and marked with it: a demo or a pipeline's file opened
 *   again) are updated in place when the file's are newer, keeping whatever other projects the reader added them to.
 * - **Anything else already in the Library** — an entity in no project or in other projects only — is left as it is,
 *   not written and not added to the file's project, and counted as a conflict when the file's version is newer.
 *   (Copying it under a new id would leave every reference to it in the file pointing at the reader's entity, so the
 *   file's version is skipped and counted instead.)
 * - **Other projects** in the file are never written. A file's `includes` is never taken: a new project includes
 *   nothing, an existing one keeps its own.
 * - **Type definitions and tag info** are Library-wide: a new one goes in, one the Library holds differently is kept
 *   unless the caller agreed (`replaceTypes`).
 * - Dates later than now are brought back to now, so a file cannot stay "newer" than every edit to come.
 *
 * The file's UI state is stashed for when the project opens. `previewBundle` reports the same decisions without
 * writing, for a caller that asks first.
 *
 * `normalized`: the entities are already the app's own shape — a pack (`.aeb`) is decoded by this code and
 * needs no coercion — so the lenient per-entity normalisation (a copy of every entity, its meta and its tags) is
 * skipped; on a city's worth of entities that copy was half the import. JSON from anywhere goes through it.
 */
/** Everything an open decides before it writes, and the steps that write it. */
function planImport(store: EntityStore, raw: unknown, opts: ImportOptions = {}): { steps: () => Generator<number, void>; finish: () => BundleReport; total: () => number; preview: () => BundlePreview; agree: () => void } {
  const doc = raw as Partial<AegraphDocument> | unknown[]
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.entities) ? doc.entities : undefined
  if (!list) throw new Error('Not an aegraph document ({ entities: [...] })')
  let entities: AnyEntity[]
  let skipped = 0
  // Whether the file can be saved as it is (see `BulkSource`): every entity in it new to the Library. What the open
  // changes on the way in — a mark added, a type definition migrated — is written after the file, so it wins when the
  // browser reads the two back; an entity the Library already had, kept or merged, is what the file must not stand for.
  let asFile = !!opts.file && !!opts.normalized
  /** The entities the open replaced with a changed copy on the way in: written after the file. */
  const changed = new Set<AnyEntity>()
  const now = new Date().toISOString()
  // A date after now (or one that is not a date and sorts after it) is now.
  const clamp = (e: AnyEntity): AnyEntity => {
    const m = e.meta
    if (!(m.createdAt > now) && !(m.updatedAt > now)) return e
    return { ...e, meta: { ...m, createdAt: m.createdAt > now ? now : m.createdAt, updatedAt: m.updatedAt > now ? now : m.updatedAt } } as AnyEntity
  }
  if (opts.normalized) {
    entities = list as AnyEntity[]
    for (let i = 0; i < entities.length; i++) {
      let e = entities[i]
      const was = e
      // The one migration normalisation carries that a pack could hold: a type definition from before `graph` read as `project`.
      if (e.type === 'schema:type' && e.data.category === 'graph') e = { ...e, data: { ...e.data, category: 'project' } }
      e = clamp(e)
      if (e !== was) {
        entities[i] = e
        changed.add(e)
      }
    }
  } else {
    entities = []
    for (let i = 0; i < list.length; i++) {
      const e = normalizeEntity(list[i], `import-${i}`)
      if (e) entities.push(clamp(e))
      else skipped++
    }
  }
  const tags: TagInfo[] = []
  if (!Array.isArray(doc)) for (const t of doc.tags ?? []) {
    const info = normalizeTagInfo(t)
    if (info) tags.push(info)
  }
  const projectIdInFile = !Array.isArray(doc) && isSafeProjectId(doc.project) ? doc.project : undefined
  let project = entities.find((e) => e.id === projectIdInFile && isProjectEntity(e)) as ProjectEntity | undefined
  // The Library holds that id as something else: the file's project gets an id of its own rather than replacing it.
  const taken = project ? store.get(project.id) : undefined
  if (project && taken && !isProjectEntity(taken)) project = createProject({ label: project.label ?? opts.name ?? 'Imported project', description: project.description, source: opts.source ?? 'import' })
  if (!project) {
    project = createProject({ label: opts.name ?? 'Imported project', source: opts.source ?? 'import' })
    asFile = false
  } else if (project.data.includes !== undefined) {
    // A file's `includes` would put the reader's projects inside this one: never taken (an existing project keeps its own, below).
    const { includes: _, ...data } = project.data
    project = { ...project, data }
  }

  const pid = project.id
  let replaceTypes = !!opts.replaceTypes
  type Decided = { members: AnyEntity[]; changed: Set<AnyEntity>; created: number; updated: number; upToDate: number; conflicts: BundleConflicts; updates: EntityId[]; types: EntityId[]; tagWrites: TagInfo[] }
  /** Every decision, against the store as it is now. */
  const decide = (): Decided => {
    const out: Decided = { members: [], changed: new Set(changed), created: 0, updated: 0, upToDate: 0, conflicts: { entities: 0, projects: 0, types: 0, tags: 0 }, updates: [], types: [], tagWrites: [] }
    for (const t of tags) {
      const have = store.getTagInfo(t.tag)
      const had = !!(have.color || have.description)
      if (had && (have.color !== t.color || have.description !== t.description) && !replaceTypes) out.conflicts.tags++
      else out.tagWrites.push(t)
    }
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]
      if (e.id === pid) continue
      // Another project: never the file's to write.
      if (isProjectEntity(e)) {
        out.conflicts.projects++
        continue
      }
      const prev = store.get(e.id)
      if (prev === undefined) {
        out.created++
        // New to the Library and already marked with this project (a bundle written by the app says so on every
        // entity): the entity goes in as it is — no copy, no set. The common case for a fresh open of a big bundle.
        const own = e.meta.projects
        if (own !== undefined && own.length === 1 && own[0] === pid) out.members.push(e)
        else {
          const marked = { ...e, meta: { ...e.meta, projects: [pid] } } as AnyEntity
          out.members.push(marked)
          out.changed.add(marked)
        }
        continue
      }
      if (isProjectEntity(prev)) {
        out.conflicts.projects++
        continue
      }
      const ours = (prev.meta.projects ?? []).includes(pid)
      if (!ours && (prev.type === 'schema:type' || e.type === 'schema:type')) {
        // A Library-wide definition: the same one is nothing to do; a different one is replaced only when agreed.
        if (sameDefinition(prev, e)) out.upToDate++
        else if (replaceTypes) {
          out.updated++
          if (out.updates.length < 50) out.updates.push(e.id)
          out.members.push({ ...e, meta: { ...e.meta, projects: prev.meta.projects } } as AnyEntity)
        } else {
          out.conflicts.types++
          if (out.types.length < 50) out.types.push(e.id)
        }
        continue
      }
      if (prev.meta.updatedAt >= e.meta.updatedAt) {
        out.upToDate++
        continue
      }
      if (!ours) {
        // Someone else's, or the Library's: kept as it is.
        out.conflicts.entities++
        continue
      }
      out.updated++
      if (out.updates.length < 50) out.updates.push(e.id)
      // The project's own, newer in the file: replaced in place, keeping the projects the reader added it to.
      out.members.push({ ...e, meta: { ...e.meta, projects: prev.meta.projects } } as AnyEntity)
    }
    return out
  }

  let created = 0
  let updated = 0
  let upToDate = 0
  let conflicts: BundleConflicts = { entities: 0, projects: 0, types: 0, tags: 0 }
  /**
   * The work, in steps. Run end to end it is what it always was; run a step at a time with the event loop between
   * them (`importBundleAsync`) a bundle of two million entities loads without freezing the page — the store's
   * transaction still holds the events, so nothing downstream sees a half-opened project. The transaction is the
   * driver's to open, since one of them awaits across it.
   */
  function* steps(): Generator<number, void> {
    // The project first, so the marks below point at something.
    const existingProject = store.get(pid) as ProjectEntity | undefined
    // Opened before: the merge below keeps and skips, and the file no longer says what the store holds.
    if (existingProject) asFile = false
    if (!existingProject) {
      store.upsert(project!)
      created++
    } else if (existingProject.meta.updatedAt < project!.meta.updatedAt) {
      const data = { ...project!.data }
      if (existingProject.data.includes !== undefined) data.includes = existingProject.data.includes
      store.upsert({ ...project!, data, meta: { ...project!.meta, projects: undefined } })
    }
    const d = decide()
    created += d.created
    updated = d.updated
    upToDate = d.upToDate
    conflicts = d.conflicts
    // Anything already here — kept, skipped or merged — and the file no longer says what the store holds.
    if (d.created + 1 !== entities.length) asFile = false
    for (const t of d.tagWrites) store.setTagInfo(t.tag, t)
    const members = d.members
    // Every entity of the file new here, beside its project (written above): the file is the write for those that go in
    // as decoded, and the changed ones follow it as ordinary writes.
    // A constraint the file brings new or changed comes in switched off (core/constraints/quarantine.ts): the copy written
    // is not the file's, so it is written after it.
    const changed = d.changed
    const vetted = quarantineImportedConstraints(store, members, (e) => changed.add(e))
    let decodedCount = 0
    let writes = vetted
    if (asFile && opts.file && vetted.length + 1 === entities.length) {
      const decoded = changed.size ? vetted.filter((e) => !changed.has(e)) : vetted
      decodedCount = decoded.length
      if (changed.size) writes = decoded.concat(vetted.filter((e) => changed.has(e)))
    }
    const source: BulkSource | undefined = decodedCount > 0 ? { bytes: opts.file!, expected: decodedCount } : undefined
    for (let i = 0; i < writes.length; i += IMPORT_CHUNK) {
      const chunk = writes.length <= IMPORT_CHUNK ? writes : writes.slice(i, i + IMPORT_CHUNK)
      if (source && i + chunk.length > decodedCount) {
        // The chunk where the file's part ends: as decoded, then the changed ones on their own.
        const cut = Math.max(0, decodedCount - i)
        if (cut) store.upsertMany(chunk.slice(0, cut), { source })
        store.upsertMany(chunk.slice(cut))
      } else store.upsertMany(chunk, source ? { source } : undefined)
      yield Math.min(i + IMPORT_CHUNK, writes.length)
      if (writes.length <= IMPORT_CHUNK) break
    }
  }
  const finish = (): BundleReport => {
    if (!Array.isArray(doc) && doc.state?.ui) stashUiState(pid, doc.state.ui)
    const route = !Array.isArray(doc) ? doc.state?.route : undefined
    return { project: (store.get(pid) as ProjectEntity) ?? project!, created, updated, upToDate, skipped, conflicts, route }
  }
  const preview = (): BundlePreview => {
    const exists = isProjectEntity(store.get(pid))
    const d = decide()
    return { project: { id: pid, label: project!.label, exists }, created: d.created + (exists ? 0 : 1), updated: d.updated, upToDate: d.upToDate, skipped, conflicts: d.conflicts, updates: d.updates, types: d.types }
  }
  return { steps, finish, total: () => entities.length, preview, agree: () => void (replaceTypes = true) }
}

/** How many entities go into the store between turns of the event loop on a big open. */
const IMPORT_CHUNK = 25_000

/**
 * `normalized`: see `planImport`. `file`: the bytes the document was decoded from (an `.aeb`, gzipped or not), so that
 * an open that puts every entity in as decoded can be saved as those bytes (`BulkSource`). `replaceTypes`: the caller
 * agreed that the file's type definitions and tag info replace the Library's where they differ.
 */
export interface ImportOptions {
  name?: string
  source?: string
  normalized?: boolean
  file?: Uint8Array
  replaceTypes?: boolean
}

export function importBundle(store: EntityStore, raw: unknown, opts: ImportOptions = {}): BundleReport {
  const run = planImport(store, raw, opts)
  store.transaction(() => {
    for (const _ of run.steps()) void _
  })
  return run.finish()
}

/** What `importBundle` would do with this document, without writing anything (see `BundlePreview`). */
export function previewBundle(store: EntityStore, raw: unknown, opts: ImportOptions = {}): BundlePreview {
  return planImport(store, raw, opts).preview()
}

/** Thrown when `confirm` says no: nothing was written. */
export class BundleDeclined extends Error {
  constructor() {
    super('The bundle was not opened.')
    this.name = 'BundleDeclined'
  }
}

/**
 * The same open, a chunk at a time with the event loop between chunks: two million entities is a five-second
 * freeze in one go, and the progress it reports cannot even be drawn. Used where a person is waiting — the
 * bundle a project opens from; the headless engine and an inline paste stay with the synchronous one.
 *
 * `confirm`: asked with the preview before anything is written; false throws `BundleDeclined`, true goes ahead and
 * also replaces the type definitions and tag info the preview counts as differing (`replaceTypes`).
 */
export async function importBundleAsync(
  store: EntityStore,
  raw: unknown,
  opts: ImportOptions & { onProgress?: (done: number, total: number) => void; confirm?: (preview: BundlePreview) => Promise<boolean> | boolean } = {},
): Promise<BundleReport> {
  const run = planImport(store, raw, opts)
  if (opts.confirm) {
    if (!(await opts.confirm(run.preview()))) throw new BundleDeclined()
    // The decisions themselves are taken again when the steps run: the store may have moved while the question was open.
    run.agree()
  }
  const total = run.total()
  await store.transactionAsync(async () => {
    for (const done of run.steps()) {
      opts.onProgress?.(done, total)
      await new Promise<void>((r) => setTimeout(r, 0))
    }
  })
  return run.finish()
}
