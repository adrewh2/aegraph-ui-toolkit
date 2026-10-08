import { createEntity, displayLabel } from '../entity/entity'
import { walkIncludes, type EntityStore } from '../entity/store'
import type { AnyEntity, Entity, EntityData, EntityId } from '../entity/types'

/**
 * A project is a named scope over the Library: the entities marked with it
 * (`meta.projects`) plus the scope of the projects it includes, and the
 * presentation state built on them — layouts, scenes, workstations,
 * diagrams, plots — which is created inside the project and so marked with
 * it. Entities are never copied: the same document can be in any number of
 * projects, and a bundle (`bundle.ts`) carries a project out as a file.
 *
 * The graph pipeline's *exported view* is also a `project` entity, with an
 * explicit `members` list (`core/graph/project.ts`). Those are derived
 * sub-projects and stay as they are; this module is about the top-level
 * ones, which have no `members` and live by marks.
 */
export const PROJECT_TYPE = 'project'

export interface ProjectData extends EntityData {
  /** Projects whose scope is part of this one (composition). */
  includes?: EntityId[]
  /** What to show when the project opens. */
  home?: { route?: string; workstationId?: EntityId }
  /** Where the project came from: 'user', 'import:<file>', 'demo:<id>', … */
  source?: string
  archived?: boolean
  /** The project template applied to it, if one was (its charts, scripts and scenes are marked `template:<id>`). */
  template?: string
  /**
   * The demo it was opened from: the bundle's path on this site (`/demos/<id>/bundle.ae.json.gz`,
   * `/datasets/<name>.ae.json`). Written when a demo opens; the Projects dialog lists such a project under
   * Demos rather than Your projects.
   */
  demo?: string
  /** Refreshed at export. */
  summary?: { entities: number; relationships: number; byType?: Record<string, number> }
}

export type ProjectEntity = Entity<ProjectData>

/** A top-level project: `project` type without the pipeline's `members` list. */
export const isProjectEntity = (e: AnyEntity | undefined): e is ProjectEntity => !!e && e.kind === 'entity' && e.type === PROJECT_TYPE && !Array.isArray(e.data.members)

export function createProject(init: { label: string; description?: string; source?: string; includes?: EntityId[]; home?: ProjectData['home']; id?: EntityId }): ProjectEntity {
  // Project entities belong to the Library, never to a project: the store never auto-marks them.
  return createEntity<ProjectData>({
    id: init.id,
    type: PROJECT_TYPE,
    label: init.label.trim() || 'Untitled project',
    description: init.description?.trim() || undefined,
    tags: [],
    data: { ...(init.includes?.length ? { includes: init.includes } : {}), ...(init.home ? { home: init.home } : {}), source: init.source ?? 'user' },
    meta: { source: init.source ?? 'user' },
  })
}

/** Every top-level project in the Library, newest first. */
export function listProjects(store: EntityStore): ProjectEntity[] {
  return store
    .library.ofType(PROJECT_TYPE)
    .filter(isProjectEntity)
    .sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt))
}

/**
 * The path of a demo bundle, when a URL names one: `/demos/…` (the demos repo's projects, put there at build time)
 * or `/datasets/…` (the bundles every build carries), on this site. Anything else — a file, another site, the dev
 * server's bundles from this machine (`/__local/…`, the owner's own data) — is not a demo.
 */
export function demoBundlePath(url: string, origin: string | undefined = globalThis.location?.origin): string | undefined {
  // With no page (headless), only a path is this site's.
  const base = origin ?? 'http://localhost'
  let u: URL
  try {
    u = new URL(url, base)
  } catch {
    return undefined
  }
  if (u.origin !== new URL(base).origin) return undefined
  return /^\/(demos|datasets)\//.test(u.pathname) ? u.pathname : undefined
}

/**
 * Whether a project is a demo rather than one of the person's own: opened from a demo bundle (`data.demo`), or
 * saying so itself (`source: "demo:<id>"`, which the shipped bundles carry). `demoIds` catches a demo opened before
 * `data.demo` was written: the demos name their project `project:<demo id>`.
 */
export function isDemoProject(p: ProjectEntity, demoIds?: ReadonlySet<string>): boolean {
  if (p.data.demo) return true
  if (p.data.source?.startsWith('demo:') || p.meta.source?.startsWith('demo:')) return true
  return !!demoIds && p.id.startsWith('project:') && demoIds.has(p.id.slice('project:'.length))
}

/** A project id a file may give: no quotes, backslashes or control characters (ids are spliced into routes and UI state). */
export const isSafeProjectId = (id: unknown): id is string => {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return false
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i)
    if (c < 0x20 || c === 0x7f || c === 0x22 || c === 0x5c) return false
  }
  return true
}

export function requireProject(store: EntityStore, id: EntityId): ProjectEntity {
  const e = store.get(id)
  if (!isProjectEntity(e)) throw new Error(`No project with id ${id}`)
  return e
}

export interface ProjectCounts {
  entities: number
  relationships: number
  /** Entity types → count. */
  byType: Record<string, number>
  /** Relationship types → count. */
  byRelationshipType: Record<string, number>
}

/** What is in the project's scope, counted. */
export function projectCounts(store: EntityStore, id: EntityId): ProjectCounts {
  return scopeCounts(store, id)
}

export interface ScopeCounts extends ProjectCounts {
  /** Tag → how many entities in the scope carry it, most first. */
  tags: [string, number][]
}

/** The entities a scope holds: a project's (marks plus includes) or, for `null`, the Library's — projects and type definitions aside. */
export function scopeEntities(store: EntityStore, id: EntityId | null): AnyEntity[] {
  if (id) return [...store.scopeOf(id)].map((eid) => store.get(eid)).filter((e): e is AnyEntity => !!e)
  return store.library.all().filter((e) => e.type !== PROJECT_TYPE && !e.type.startsWith('project:') && e.type !== 'schema:type')
}

/** Counts and tags over a scope (`null` = the Library), the review before saving it as a project. */
export function scopeCounts(store: EntityStore, id: EntityId | null): ScopeCounts {
  let entities = 0
  let relationships = 0
  const byType: Record<string, number> = {}
  const byRelationshipType: Record<string, number> = {}
  const tagCounts = new Map<string, number>()
  for (const e of scopeEntities(store, id)) {
    if (e.kind === 'relationship') {
      relationships++
      byRelationshipType[e.type] = (byRelationshipType[e.type] ?? 0) + 1
    } else {
      entities++
      byType[e.type] = (byType[e.type] ?? 0) + 1
      for (const t of e.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
    }
  }
  const tags = [...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return { entities, relationships, byType, byRelationshipType, tags }
}

/** The project and every project it includes, transitively (bounded: `MAX_INCLUDE_DEPTH`, `MAX_INCLUDED_PROJECTS`): an entity marked with any of them is in the scope. */
export function includedProjects(store: EntityStore, project: EntityId): Set<EntityId> {
  return walkIncludes(project, (id) => store.get(id)?.data.includes).ids
}

/**
 * A project that `includes` another must not, transitively, include itself. A chain past the bounds counts as a
 * cycle: what cannot be followed to its end cannot be shown not to come back.
 */
export function wouldCycle(store: EntityStore, project: EntityId, include: EntityId): boolean {
  const { ids, capped } = walkIncludes(include, (id) => store.get(id)?.data.includes)
  return ids.has(project) || capped
}

/**
 * Delete a project. By default the entities stay in the Library (their
 * marks are removed); `exclusive` also deletes the entities that were in
 * no other project. Returns what happened.
 */
export function deleteProject(store: EntityStore, id: EntityId, { exclusive = false } = {}): { unmarked: number; deleted: number } {
  const project = requireProject(store, id)
  const marked = [...store.markedWith(id)]
  let deleted = 0
  let unmarked = 0
  store.transaction(() => {
    if (exclusive) {
      const only = marked.filter((m) => store.projectsOf(m).length === 1)
      const rest = marked.filter((m) => store.projectsOf(m).length > 1)
      store.remove(only)
      deleted = only.length
      unmarked = store.unmark(rest, id)
    } else unmarked = store.unmark(marked, id)
    // Other projects that included this one lose the reference.
    for (const p of listProjects(store)) {
      if (p.data.includes?.includes(id)) store.update<ProjectEntity>(p.id, { data: { ...p.data, includes: p.data.includes.filter((x) => x !== id) } })
    }
    // Its history goes with it (the commit blobs are pruned at a start a day later, see history.ts › prune).
    const commits = store.library.ofType('project:commit').filter((c) => c.data.project === id)
    if (commits.length) store.remove(commits.map((c) => c.id), { cascade: false })
    store.remove(project.id)
  })
  return { unmarked, deleted }
}

/**
 * Save a scope as a new project. The new project marks the same entities
 * (references, not copies: a document in both is one document, and so are
 * scenes, layouts and workstations — edit one there and both see it), keeps
 * the same `includes` and home, and records where it came from. `from`
 * null saves the whole Library, projects and type definitions aside.
 */
export function forkProject(store: EntityStore, from: EntityId | null, init: { label: string; description?: string; home?: ProjectData['home'] }): { project: ProjectEntity; marked: number } {
  const origin = from ? requireProject(store, from) : null
  const project = createProject({
    label: init.label,
    description: init.description ?? origin?.description,
    includes: origin?.data.includes,
    home: init.home ?? origin?.data.home,
    source: origin ? `fork:${origin.id}` : 'fork:library',
  })
  let marked = 0
  store.transaction(() => {
    store.upsert(project)
    const ids = origin ? [...store.markedWith(origin.id)] : scopeEntities(store, null).map((e) => e.id)
    marked = store.mark(ids, project.id)
  })
  return { project: requireProject(store, project.id), marked }
}

export const projectLabel = (store: EntityStore, id: EntityId | null) => (id ? displayLabel(store.get(id) ?? ({ id } as AnyEntity)) : 'Library')
