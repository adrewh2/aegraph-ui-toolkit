import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { displayLabel, oneLineLabel, parseTags, quoteLabel } from '../../core/entity/entity'
import { coerceToKind, kindOfValue, parsePropertyValue, propertyKey, type FieldKind } from '../../core/entity/schema'
import { TypeRegistry, withProperty, withoutProperty } from '../../core/entity/typeRegistry'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { clearStashedUiState, switchProject } from '../../core/projects/active'
import { importBundle } from '../../core/projects/bundle'
import { applyTemplate, fetchTemplate, isTemplateDocument, TEMPLATE_CATALOG } from '../../core/projects/template'
import { createProject, deleteProject, isDemoProject, isProjectEntity, listProjects, projectCounts, requireProject, scopeCounts, wouldCycle, type ProjectEntity } from '../../core/projects/project'
import { getProjectHistory } from '../../core/projects/history'
import { diffList, diffProperties, diffText, excalidrawElements, hashEntity, isImageValue, isLongText, isOpaqueText, isRecordList, shortId, trackedEntities, versioningOf, type CommitEntity, type PropertyChange } from '../../core/projects/versioning'
import { fetchDemoCatalog } from '../datasets/demos'
import { demoLink } from '../../app/demoLink'
import { fetchLocalDemos, loadLocalDemos } from '../datasets/localDemos'
import { saveBlob } from '../../core/exchange/export'
import { openBundleBytes, openBundleUrl, saveAsNewProject, saveProjectBundle } from '../projects/projectActions'
import { publishProject } from '../projects/publish'
import { classifyUrl } from '../../core/net/url'
import { decodeBundleBytes, guardBundle } from './bundleGuard'
import { approveHandedUrl } from './toolkit'
import type { AppHost } from './tools'

const json = (v: unknown) => JSON.stringify(v)

/**
 * Projects over MCP: list, create, open, add/remove, delete, update, save
 * as a bundle, publish, open a bundle by URL, apply a template, load
 * datasets into the active project, and the project's versions (changes,
 * commit, history, restore) — plus the bulk entity tools that read the
 * scope (`delete_entities`, `set_properties`, `tag_entities`,
 * `list_properties`). A project is a named scope over the Library; while
 * one is open every other tool (search, create, graph…) sees and writes
 * into it.
 */
export function createProjectTools(host: AppHost) {
  const { store } = host
  const describe = (p: ProjectEntity) => {
    const c = projectCounts(store, p.id)
    const head = history.head(p.id)
    return { id: p.id, label: displayLabel(p), description: p.description, entities: c.entities, relationships: c.relationships, includes: p.data.includes ?? [], home: p.data.home, source: p.data.source, updatedAt: p.meta.updatedAt, active: store.scope === p.id, versioning: versioningOf(p), head: head ? { id: head.id, short: shortId(head.id), message: head.data.message, at: head.data.at } : null }
  }
  const history = getProjectHistory(store)
  const describeCommit = (c: CommitEntity) => ({ id: c.id, short: shortId(c.id), message: c.data.message, at: c.data.at, ago: ago(c.data.at), auto: !!c.data.auto, parent: c.data.parent, size: c.data.size, stats: c.data.stats, ...(c.data.restoredFrom ? { restoredFrom: c.data.restoredFrom } : {}) })
  /**
   * A commit named the way people and tools name them: the full id, the
   * 7-character short id, any unique prefix of the short form (4+ characters),
   * HEAD, HEAD~n (n commits back) or HEAD^. Ambiguity and misses are errors
   * that say what would have matched.
   */
  const findCommit = (commits: CommitEntity[], ref: string, what = 'commit'): CommitEntity => {
    const r = ref.trim()
    if (!r) throw new Error(`Give a ${what} (project_history lists them).`)
    if (!commits.length) throw new Error('This project has no commits yet.')
    const back = /^HEAD(?:~(\d+)|(\^+))?$/i.exec(r)
    if (back) {
      const n = back[1] ? Number(back[1]) : back[2] ? back[2].length : 0
      const c = commits[n]
      if (!c) throw new Error(`HEAD~${n} is past the first commit (the project has ${commits.length}).`)
      return c
    }
    const exact = commits.find((c) => c.id === r || shortId(c.id) === r)
    if (exact) return exact
    const key = r.replace(/-/g, '').toLowerCase()
    if (key.length < 4) throw new Error(`"${ref}" is too short to name a commit: give at least 4 characters of its id.`)
    const hits = commits.filter((c) => c.id.replace(/-/g, '').toLowerCase().startsWith(key))
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} commits: ${hits.slice(0, 5).map((c) => `${shortId(c.id)} (${c.data.message})`).join(', ')}. Give more characters.`)
    throw new Error(`No commit "${ref}" in this project. project_history lists them (ids, short ids, HEAD~n all work).`)
  }
  const ago = (iso: string) => {
    const ms = Date.now() - Date.parse(iso)
    if (!Number.isFinite(ms) || ms < 0) return iso
    const m = Math.round(ms / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m} min ago`
    const h = Math.round(m / 60)
    if (h < 48) return `${h} h ago`
    return `${Math.round(h / 24)} days ago`
  }
  /** A date filter's bound: ISO, a date, or a relative spell like "2h", "3d", "45m", "1w". */
  const parseWhen = (v: string | undefined, name: string): number | undefined => {
    if (!v) return undefined
    const rel = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(v.trim())
    if (rel) {
      const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase() as 'm' | 'h' | 'd' | 'w']
      return Date.now() - Number(rel[1]) * unit
    }
    const t = Date.parse(v)
    if (!Number.isFinite(t)) throw new Error(`${name}: "${v}" is not a date. Use ISO (2026-09-18 or 2026-09-18T20:00Z) or a span back from now (30m, 2h, 3d, 1w).`)
    return t
  }
  /** The entity's content for the reader: everything but the bookkeeping, long texts trimmed unless asked whole. */
  const content = (e: AnyEntity, whole: boolean) => {
    const data: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(e.data)) data[k] = !whole && typeof v === 'string' && v.length > 4000 ? `${v.slice(0, 4000)}… (${v.length} chars; content: "full" for all of it)` : isOpaqueText(v) && !whole ? `(${sizeOf(v)})` : v
    return { ...brief(e), description: e.description, tags: e.tags, data, ...(e.kind === 'relationship' ? { directed: e.directed } : {}), createdAt: e.meta.createdAt }
  }
  /** An entity in a change list: enough to recognise it, never a whole document body. */
  const brief = (e: AnyEntity) => ({ id: e.id, kind: e.kind, type: e.type, label: displayLabel(e), ...(e.kind === 'relationship' ? { source: e.source.id, target: e.target.id } : {}) })
  /** Property changes with long texts summarised as line diffs (changed lines only) and opaque blobs as sizes. */
  const properties = (changes: PropertyChange[], maxLines: number) =>
    changes.map((c) => {
      if (isImageValue(c.path, c.before) || isImageValue(c.path, c.after)) return { path: c.path, before: sizeOf(c.before), after: sizeOf(c.after), image: true }
      const sceneA = excalidrawElements(c.before)
      const sceneB = excalidrawElements(c.after)
      const listA = sceneA ?? (isRecordList(c.before) ? c.before : undefined)
      const listB = sceneB ?? (isRecordList(c.after) ? c.after : undefined)
      if ((listA || listB) && (c.before === undefined || listA) && (c.after === undefined || listB)) {
        // A list of records — messages, annotations, a diagram's elements — item by item.
        const d = diffList(listA, listB)
        const item = (x: Record<string, unknown>) => (typeof x.label === 'string' ? x.label : typeof x.text === 'string' ? x.text.slice(0, 80) : typeof x.type === 'string' ? x.type : undefined)
        return { path: c.path, list: { by: d.by, unchanged: d.unchanged, added: d.added.slice(0, maxLines).map((x) => ({ key: x.key, item: item(x.item) })), removed: d.removed.slice(0, maxLines).map((x) => ({ key: x.key, item: item(x.item) })), changed: d.changed.slice(0, maxLines).map((x) => ({ key: x.key, item: item(x.after), changes: x.changes.map((ch) => ch.path) })) }, ...(sceneA || sceneB ? { excalidraw: true } : {}) }
      }
      if (isOpaqueText(c.before) || isOpaqueText(c.after)) return { path: c.path, before: sizeOf(c.before), after: sizeOf(c.after), opaque: true }
      if ((isLongText(c.before) || isLongText(c.after)) && (c.before === undefined || typeof c.before === 'string') && (c.after === undefined || typeof c.after === 'string')) {
        const lines = diffText((c.before as string) ?? '', (c.after as string) ?? '').filter((l) => l.op !== ' ')
        return { path: c.path, text_diff: lines.slice(0, maxLines).map((l) => `${l.op} ${l.text}`), added_lines: lines.filter((l) => l.op === '+').length, removed_lines: lines.filter((l) => l.op === '-').length, ...(lines.length > maxLines ? { truncated: lines.length - maxLines } : {}) }
      }
      return { path: c.path, before: c.before, after: c.after }
    })
  const sizeOf = (v: unknown) => (typeof v === 'string' ? `${v.length} chars` : v === undefined ? undefined : JSON.stringify(v).length + ' chars')
  const activeOr = (id?: string): ProjectEntity => {
    if (id) return requireProject(store, id)
    if (!store.scope) throw new Error('No project is open. Pass a project id, or project_open one first.')
    return requireProject(store, store.scope)
  }
  type Query = { type?: string; types?: string[]; tag?: string; tags?: string[]; text?: string; kind?: 'entity' | 'relationship' }
  /** Ids named directly plus every entity matching the query (`tags`: any of them). */
  const resolveIds = (ids?: string[], query?: Query, scoped = true): EntityId[] => {
    const out = new Set<EntityId>(ids ?? [])
    if (query) {
      const types = query.types?.length ? query.types : query.type ? [query.type] : undefined
      const anyTags = query.tags?.length ? query.tags : query.tag ? [query.tag] : undefined
      const needle = query.text?.trim().toLowerCase()
      const matches = (e: AnyEntity) => (!types || types.includes(e.type)) && (!anyTags || anyTags.some((t) => e.tags.includes(t))) && (!query.kind || e.kind === query.kind) && (!needle || JSON.stringify(e).toLowerCase().includes(needle))
      const candidates = anyTags ? anyTags.flatMap((t) => (scoped ? store.withTag(t) : store.library.withTag(t))) : scoped ? store.all() : store.library.all()
      for (const e of candidates) if (matches(e)) out.add(e.id)
    }
    return [...out]
  }
  const QUERY_SCHEMA = {
    type: 'object',
    properties: {
      type: { type: 'string' },
      types: { type: 'array', items: { type: 'string' }, description: 'Any of these types' },
      tag: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Entities carrying any of these tags' },
      text: { type: 'string' },
      kind: { type: 'string', enum: ['entity', 'relationship'] },
    },
    additionalProperties: false,
  } as const

  const list = betaTool({
    name: 'project_list',
    description: "Every project in the Library, with counts, and which one is open. A project is a named scope: while it is open, every other tool sees only its entities and everything created or loaded goes into it. Library = no project = everything. `demo: true` marks a demo — opened from one of the app's demos (`load_dataset`) rather than made or brought by the user; the Projects dialog lists the user's own projects and the demos on separate tabs.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
    run: async () => {
      // The demos' ids name the project of a demo opened before the mark was written; no catalogue (headless), no guess.
      const demoIds = new Set(((await fetchDemoCatalog())?.demos ?? []).map((d) => d.id))
      return json({ active: store.scope, projects: listProjects(store).map((p) => ({ ...describe(p), demo: isDemoProject(p, demoIds) })), library: { entities: store.library.entityCount(), relationships: store.library.relationshipCount() } })
    },
  })

  const create = betaTool({
    name: 'project_create',
    description: 'Create a project and (by default) open it, so what you load or create next belongs to it. `includes` names other projects whose scope is part of this one. `from` saves an existing scope as a new project instead: the same entities referenced (not copied), same includes and home, the current screen state carried over — the UI\'s "Save as new project".',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        description: { type: 'string' },
        includes: { type: 'array', items: { type: 'string' }, description: 'Project ids to include' },
        from: { type: 'string', description: "Save as a copy of this project id, or 'library' for everything (projects and type definitions aside), or 'active' for the open project" },
        open: { type: 'boolean', description: 'Make it the active project (default true)' },
        route: { type: 'string', description: 'Where to go after opening (default: stay)' },
      },
      required: ['label'],
      additionalProperties: false,
    } as const,
    run: ({ label, description, includes, from, open, route }) => {
      if (from !== undefined) {
        if (includes?.length) throw new Error('`from` copies the source project\'s includes; do not pass both.')
        const src = from === 'library' ? null : from === 'active' ? activeOr().id : requireProject(store, from).id
        const before = scopeCounts(store, src)
        const r = saveAsNewProject(store, src, { label, description, home: route ? { route } : undefined }, { route, open: open !== false })
        return json({ created: describe(requireProject(store, r.project.id)), from: src ?? 'library', marked: r.marked, review: { entities: before.entities, relationships: before.relationships, byType: before.byType, byRelationshipType: before.byRelationshipType, tags: before.tags.length } })
      }
      for (const inc of includes ?? []) requireProject(store, inc)
      const p = createProject({ label, description, includes })
      store.upsert(p)
      if (open !== false) switchProject(store, p.id, { route })
      return json({ created: describe(requireProject(store, p.id)) })
    },
  })

  const openTool = betaTool({
    name: 'project_open',
    description: 'Open a project (scope every page and tool to it, restore its own explorer, workstation and section tabs) or, with no id, go back to the Library. The app remounts on the switch; call get_app_context afterwards if you need the new page state.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Project id; omit for the Library' }, route: { type: 'string', description: 'Page to open, e.g. /workstation' } }, additionalProperties: false } as const,
    run: ({ id, route }) => {
      if (id) requireProject(store, id)
      const ok = switchProject(store, id ?? null, { route })
      if (!ok) throw new Error(`Could not open ${id}`)
      return json({ active: store.scope, label: id ? displayLabel(store.get(id)!) : 'Library', route: route ?? null })
    },
  })

  const add = betaTool({
    name: 'project_add',
    description: 'Add entities to a project by id and/or by a Library-wide query (types, tags — any of —, text, kind). Relationships between the added entities and the project\'s existing members come along. Entities are never copied: the same entity can be in many projects.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        query: QUERY_SCHEMA,
        project: { type: 'string', description: 'Project id (default: the open project)' },
      },
      additionalProperties: false,
    } as const,
    run: ({ ids, query, project }) => {
      const p = activeOr(project)
      const targets = resolveIds(ids, query, false)
      const marked = store.mark(targets, p.id)
      return json({ project: p.id, requested: targets.length, added: marked, ...projectCounts(store, p.id) })
    },
  })

  const remove = betaTool({
    name: 'project_remove',
    description: 'Take entities out of a project (by id and/or a query over the project). They stay in the Library and in any other project. The user is asked to confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        query: QUERY_SCHEMA,
        project: { type: 'string', description: 'Project id (default: the open project)' },
      },
      additionalProperties: false,
    } as const,
    run: async ({ ids, query, project }) => {
      const p = activeOr(project)
      const targets = resolveIds(ids, query, store.scope === p.id)
      if (targets.length && !(await host.confirm(`Take ${targets.length} entit${targets.length === 1 ? 'y' : 'ies'} out of ${quoteLabel(displayLabel(p))}? They stay in the Library.`, { yes: 'Take out' }))) return json({ project: p.id, removed: 0, cancelled: true, reason: 'The user declined.' })
      const n = store.unmark(targets, p.id)
      return json({ project: p.id, removed: n, ...projectCounts(store, p.id) })
    },
  })

  const del = betaTool({
    name: 'project_delete',
    description: 'Delete a project. By default its entities stay in the Library; `exclusive_entities: true` also deletes the entities that were in no other project. The user is asked to confirm.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, exclusive_entities: { type: 'boolean' } }, required: ['id'], additionalProperties: false } as const,
    run: async ({ id, exclusive_entities }) => {
      const p = requireProject(store, id)
      const exclusive = [...store.markedWith(id)].filter((m) => store.projectsOf(m).length === 1).length
      const ok = await host.confirm(`Delete project ${quoteLabel(displayLabel(p))}${exclusive_entities ? ` and its ${exclusive} exclusive entities` : ' (its entities stay in the Library)'}?`, { yes: 'Delete', danger: true })
      if (!ok) return 'The user declined. Nothing was deleted.'
      const wasActive = store.scope === id
      const r = deleteProject(store, id, { exclusive: !!exclusive_entities })
      clearStashedUiState(id)
      if (wasActive) switchProject(store, null)
      return json({ project: id, ...r })
    },
  })

  const update = betaTool({
    name: 'project_update',
    description: 'Rename or describe a project, set what it includes, its home route (where it opens), or its version-control setting: autosave (commits on its own after a quiet spell) or commit by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project id (default: the open project)' },
        label: { type: 'string' },
        description: { type: 'string' },
        includes: { type: 'array', items: { type: 'string' }, description: 'Replace the included projects' },
        home_route: { type: 'string', description: 'Route to open the project on, e.g. /workstation or /unigraph/2d?scene=…' },
        autosave: { type: 'boolean', description: 'Version control: commit on its own once the project has been quiet (true, the default) or only by hand with project_commit (false)' },
        autosave_seconds: { type: 'number', description: 'Quiet time before an autosave commit (default 30)' },
      },
      additionalProperties: false,
    } as const,
    run: ({ id, label, description, includes, home_route, autosave, autosave_seconds }) => {
      const p = activeOr(id)
      for (const inc of includes ?? []) {
        requireProject(store, inc)
        if (inc === p.id || wouldCycle(store, p.id, inc)) throw new Error(`Including ${inc} would make a cycle.`)
      }
      const data = { ...p.data }
      if (includes) data.includes = includes
      if (home_route !== undefined) data.home = { ...data.home, route: home_route }
      if (autosave !== undefined || autosave_seconds !== undefined) {
        const v = versioningOf(p)
        data.versioning = { autosave: autosave ?? v.autosave, autosaveDelay: autosave_seconds !== undefined ? Math.max(1, Math.min(3600, autosave_seconds)) : v.autosaveDelay }
      }
      const next = store.update<ProjectEntity>(p.id, { ...(label !== undefined ? { label } : {}), ...(description !== undefined ? { description } : {}), data })
      return json({ updated: describe(next) })
    },
  })

  const save = betaTool({
    name: 'project_save',
    description: 'Save a project as a bundle file: its entities, relationships, the layouts/scenes/workstations built on them, type definitions, tag colours, and the screen state (explorer, workstation) so it reopens the same way. Formats: json (<name>.ae.json — an aegraph document with project and state keys, what other tools read; default) or pack (<name>.aeb — aegraph\'s own binary form: about a sixth the size, quicker to save and load; gzipped inside). Written to the projects folder when one is set, else downloaded. Anyone opens it with /open?url=… or Open bundle….',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Project id (default: the open project)' }, route: { type: 'string', description: 'Route to reopen on (default: the current page)' }, format: { type: 'string', enum: ['json', 'pack'], description: 'json (.ae.json, default) or pack (.aeb)' }, gzip: { type: 'boolean', description: 'json: also gzip (.ae.json.gz)' } }, additionalProperties: false } as const,
    run: async ({ id, route, format, gzip }) => {
      const p = activeOr(id)
      const r = await saveProjectBundle(store, p.id, { route: route ?? host.getContext().route, gzip, format })
      return json({ project: p.id, ...r })
    },
  })

  const publish = betaTool({
    name: 'project_publish',
    description: 'Publish a project as one self-contained, read-only HTML page (downloaded as <name>.html): the overview (types, tags), every saved graph scene drawn as SVG and the Graph Explorer\'s current view when it is open on the project, every chart as a picture, the latest findings and the claims and named communities kept from them, the documents rendered, and a searchable table of every entity with its relationships. Nothing on the page needs the app or a server; it is a snapshot. Returns what went on the page and its size.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Project id (default: the open project)' }, max_entities: { type: 'number', description: 'Rows in the entity table (default 20000)' }, skip_charts: { type: 'boolean', description: 'Leave charts out' } }, additionalProperties: false } as const,
    run: async ({ id, max_entities, skip_charts }) => {
      const p = activeOr(id)
      const r = await publishProject(store, host.registry ?? new TypeRegistry(store), p.id, { maxEntities: max_entities, skipCharts: skip_charts })
      saveBlob(new Blob([r.html], { type: 'text/html' }), r.filename)
      return json({ project: p.id, filename: r.filename, ...r.stats })
    },
  })

  const openBundle = betaTool({
    name: 'project_open_bundle',
    description: 'Open a bundle by URL (same-origin like /datasets/x.ae.json or x.aeb, or CORS-enabled; another site\'s URL needs Third-party services on and the user\'s yes, which the app asks for) or from inline JSON text. It merges into the Library by id (newer wins, nothing is wiped), becomes a project, and opens on the screen it was saved from. A bundle (inline, or from another site) that would replace entities already here is put to the user first, naming a few; one that would replace the assistant\'s memory is refused.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, text: { type: 'string', description: 'The bundle JSON, for small files' }, name: { type: 'string', description: 'Project name when the file has none' } }, additionalProperties: false } as const,
    run: async ({ url, text, name }) => {
      if (!url && !text) throw new Error('Give a url or text.')
      if (url) {
        const href = await approveHandedUrl(host, url, 'Opening a bundle')
        // This site's own bundles (the demos, the templates it serves) open as they always have; another site's is read
        // first, and what it would replace here is put to the user (`guardBundle`).
        if (classifyUrl(href).kind === 'own') {
          const r = await openBundleUrl(store, href)
          return json({ opened: describe(r.project), created: r.created, updated: r.updated, upToDate: r.upToDate, skipped: r.skipped, route: r.route })
        }
        const res = await fetch(href, { credentials: 'omit', referrerPolicy: 'no-referrer' })
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${href}`)
        const bytes = new Uint8Array(await res.arrayBuffer())
        await guardBundle(host, store, await decodeBundleBytes(bytes))
        const stem = decodeURIComponent(href.split(/[?#]/)[0].split('/').pop() ?? 'bundle').replace(/\.aeb$|\.ae\.json(\.gz)?$|\.ae(\.gz)?$|\.aegraph\.json(\.gz)?$|\.json(\.gz)?$/i, '')
        const r = await openBundleBytes(store, bytes, stem || 'bundle', href)
        return json({ opened: describe(r.project), created: r.created, updated: r.updated, upToDate: r.upToDate, skipped: r.skipped, route: r.route })
      }
      const doc = JSON.parse(text!)
      await guardBundle(host, store, doc)
      const r = importBundle(store, doc, { name: name ?? 'Imported project', source: 'import:inline' })
      switchProject(store, r.project.id, { route: r.route })
      return json({ opened: describe(r.project), created: r.created, updated: r.updated, upToDate: r.upToDate, skipped: r.skipped, route: r.route })
    },
  })

  const template = betaTool({
    name: 'project_template',
    description:
      'Project templates: the analytics for a kind of dataset — charts, scripts, graph scenes, a guide, the Analytics and Workstation arrangements — with no data, applied to a project that holds that kind of data. `list` names the templates the app ships (conversation-atlas: for a ChatGPT export labelled as a conversation atlas — segments, conversations, topics, regions…). `apply` puts one into a project (the open one by default, or `project`; `new_project` makes a fresh one named after the template): ids are prefixed with the project, so applying again updates rather than duplicates; the report says which required types the project lacks. Inline `text` applies a template document you have instead of a shipped one.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'apply'] },
        template: { type: 'string', description: 'apply: a template id from list (default conversation-atlas)' },
        text: { type: 'string', description: 'apply: a template document as JSON, instead of a shipped one' },
        project: { type: 'string', description: 'apply: the project to apply to (default: the open project)' },
        new_project: { type: 'boolean', description: 'apply: make a new project for it' },
        adopt: { type: 'boolean', description: 'apply: take the Library’s loose entities of the template’s data types (in no project yet) into the project first — default true for a new project, false otherwise' },
        open: { type: 'boolean', description: 'apply: switch to the project and its home afterwards (default true)' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, template: id, text, project, new_project, open, adopt }) => {
      if (action === 'list') return json({ templates: TEMPLATE_CATALOG.map((t) => ({ id: t.id, label: t.label, description: t.description, requires: t.requires, home: t.home })) })
      const doc = text ? JSON.parse(text) : await fetchTemplate(id ?? 'conversation-atlas')
      if (!isTemplateDocument(doc)) throw new Error('Not a template document (needs a `template` block and entities).')
      let pid = project ?? store.scope ?? undefined
      if (new_project || !pid) {
        const p = createProject({ label: doc.template.label, description: doc.template.description, source: `template:${doc.template.id}` })
        store.upsert(p)
        pid = p.id
      }
      const r = applyTemplate(store, doc, pid, { adopt: adopt ?? (new_project || !project && !store.scope) })
      if (open !== false) {
        if (store.scope !== pid) switchProject(store, pid, { route: r.route })
        else if (r.route) host.navigate(r.route)
      }
      const counts = (type: string) => store.library.ofType(type).filter((e) => (e.meta.projects ?? []).includes(pid!)).length
      return json({ template: r.template.id, project: describe(r.project), created: r.created, updated: r.updated, adopted: r.adopted, missing: r.missing, route: r.route, now: { charts: counts('plot'), scripts: counts('script'), scenes: counts('scene'), documents: counts('document') } })
    },
  })

  const loadDataset = betaTool({
    name: 'load_dataset',
    description:
      'Load a dataset: one of the demo projects this deployment ships from the aegraph-ui-demos repository (bundles — each opens as its own project, whatever is open; among them aurora, china-tour, knowledge-infrastructure, academics and dbpedia-programming-languages; call with no source to list them all with their ids, and each one’s shareable `link` — the site’s address with `?demo=<id>`, which opens the demo for whoever follows it; add `&scene=<scene id or its short name>` to land on one of its scenes), or datasets on this machine served by the dev server, which load into the open project (or the Library when none is open; listed the same way; load several at once — an atlas and a ChatGPT export load linked). Merges by id; `replace` wipes the whole Library first and is almost never what you want with projects.',
    inputSchema: {
      type: 'object',
      properties: {
        sources: { type: 'array', items: { type: 'string' }, description: 'Dataset ids: a demo project id or a local demo id — the listing has the ids' },
        mode: { type: 'string', enum: ['merge', 'replace'] },
      },
      additionalProperties: false,
    } as const,
    run: async ({ sources, mode }) => {
      const local = await fetchLocalDemos()
      const catalog = await fetchDemoCatalog()
      const demos = catalog?.demos ?? []
      if (!sources?.length)
        return json({
          demos: demos.map((d) => ({ id: d.id, title: d.title, description: d.description, tags: d.tags, entities: d.counts?.entities, relationships: d.counts?.relationships, mb: d.bytes ? Number((d.bytes / 1048576).toFixed(1)) : undefined, link: globalThis.location?.origin ? demoLink(globalThis.location.origin, d.id) : undefined })),
          local: local.map((d) => ({ id: d.id, label: d.label, kind: d.kind, mb: Math.round(d.bytes / 1048576), files: d.files?.length })),
          active: store.scope,
        })
      if (mode === 'replace') {
        const ok = await host.confirm('Replace wipes every entity in the Library, in every project. Continue?', { yes: 'Replace', danger: true })
        if (!ok) return 'The user declined. Nothing was loaded.'
      }
      const notes: string[] = []
      let count = 0
      const chosen = []
      for (const s of sources) {
        if (demos.some((d) => d.id === s)) {
          // A demo project is a bundle: it opens as a project of its own, on the screen it was saved from.
          const d = demos.find((x) => x.id === s)!
          const r = await openBundleUrl(store, d.bundleUrl)
          count += r.created + r.updated
          notes.push(`${d.title}: ${r.created} new, ${r.updated} updated, ${r.upToDate} already there — open as project ${r.project.id}`)
        } else {
          const d = local.find((x) => x.id === s || x.label === s)
          if (!d) throw new Error(`No dataset “${s}”. Demos: ${demos.map((x) => x.id).join(', ') || 'none'}. Local: ${local.map((x) => x.id).join(', ') || 'none'}.`)
          chosen.push(d)
        }
      }
      if (chosen.length) {
        const r = await loadLocalDemos(store, chosen, { mode: mode ?? 'merge', onJob: (j) => j && host.notify?.(j.label) })
        notes.push(...r.parts.map((p) => p.note))
        if (r.note) notes.push(r.note)
        count += r.count
      }
      const p = store.scope ? requireProject(store, store.scope) : undefined
      return json({ loaded: count, into: p ? describe(p) : 'Library', notes })
    },
  })

  const deleteMany = betaTool({
    name: 'delete_entities',
    description: 'Delete many entities at once (and the relationships attached to them) — by ids and/or a query over the open project (types, tags — any of —, text, kind). Use project_remove instead if they should only leave the project. The user is asked to confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        query: QUERY_SCHEMA,
        dry_run: { type: 'boolean', description: 'Only report what would be deleted' },
      },
      additionalProperties: false,
    } as const,
    run: async ({ ids, query, dry_run }) => {
      const targets = resolveIds(ids, query).filter((id) => store.has(id) && !isProjectEntity(store.get(id)))
      if (dry_run) return json({ wouldDelete: targets.length, sample: targets.slice(0, 20).map((id) => ({ id, label: displayLabel(store.get(id)!), type: store.get(id)!.type })) })
      if (!targets.length) return json({ deleted: 0 })
      const ok = await host.confirm(`Delete ${targets.length} entities and their relationships from the Library (every project)?`, { yes: 'Delete', danger: true })
      if (!ok) return 'The user declined. Nothing was deleted.'
      store.remove(targets)
      return json({ deleted: targets.length })
    },
  })

  const setProperties = betaTool({
    name: 'set_properties',
    description:
      'Set data properties (field name → value) on one or many entities at once: by ids and/or a query over the open project. Values are used as given (numbers, booleans, arrays, objects, strings); a string value that reads as true/false, a number or JSON is kept as text unless parse_values is true. `remove` drops properties. `define_on_type` also adds the properties to the entities\' type definitions, so they show as columns and inspector rows for every entity of those types. For a single entity, update_entity works too.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        query: QUERY_SCHEMA,
        properties: { type: 'object', additionalProperties: true, description: 'Field name → value' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Property names to delete' },
        parse_values: { type: 'boolean', description: 'Read string values the way the UI reads typed text: "true", "42", "[1,2]" become boolean/number/JSON' },
        kinds: {
          type: 'object',
          additionalProperties: { type: 'string', enum: ['text', 'longtext', 'number', 'boolean', 'date', 'datetime', 'url', 'color', 'json'] },
          description: 'Field name → kind. Values are converted to the kind (dates to YYYY-MM-DD, date-times to ISO, numbers parsed) and the kind is recorded on the entities\' types, so the property gets its widget (date picker, number box, …) everywhere. Implies define_on_type for those names.',
        },
        define_on_type: { type: 'boolean' },
      },
      additionalProperties: false,
    } as const,
    run: ({ ids, query, properties, remove, parse_values, kinds, define_on_type }) => {
      const targets = resolveIds(ids, query).filter((id) => store.has(id))
      if (!targets.length) throw new Error('No entities matched. Give ids or a query.')
      const kindOf = new Map(Object.entries(kinds ?? {}).map(([k, v]) => [propertyKey(k), v as FieldKind]))
      const entries = Object.entries(properties ?? {}).map(([k, v]) => {
        const key = propertyKey(k)
        const kind = kindOf.get(key)
        const value = kind ? coerceToKind(v, kind) : parse_values && typeof v === 'string' ? parsePropertyValue(v) : v
        if (kind && v !== null && v !== undefined && value === undefined) throw new Error(`“${String(v)}” is not a ${kind} (property ${key}).`)
        return [key, value] as const
      })
      if (!entries.length && !remove?.length) throw new Error('Give properties to set or names to remove.')
      const typesTouched = new Set<string>()
      store.transaction(() => {
        for (const id of targets) {
          const e = store.get(id)!
          const data = { ...e.data }
          for (const [k, v] of entries) {
            if (v === null || v === undefined) delete data[k]
            else data[k] = v
          }
          for (const k of remove ?? []) delete data[propertyKey(k)]
          store.update(id, { data })
          if (e.kind === 'entity') typesTouched.add(e.type)
        }
        if (define_on_type || kindOf.size) {
          for (const type of typesTouched) {
            for (const [k, v] of entries) {
              const kind = kindOf.get(k)
              if (kind) store.upsert(withProperty(store, type, { key: k, kind }))
              else if (define_on_type && v !== null && v !== undefined) store.upsert(withProperty(store, type, { key: k, kind: kindOfValue(v) }))
            }
            for (const k of remove ?? []) {
              const next = withoutProperty(store, type, propertyKey(k))
              if (next) store.upsert(next)
            }
          }
        }
      })
      return json({ updated: targets.length, set: entries.map(([k]) => k), removed: (remove ?? []).map(propertyKey), definedOn: define_on_type || kindOf.size ? [...typesTouched] : [], kinds: Object.fromEntries(kindOf) })
    },
  })

  const tagEntities = betaTool({
    name: 'tag_entities',
    description: 'Add tags to, or take tags off, one or many entities at once — by ids and/or a query over the open project (types, tags — any of —, text, kind). Tags are plain words or `key:value` facets (tier:core). For a single entity update_entity works too; update_tag renames a tag everywhere.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        query: QUERY_SCHEMA,
        add: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tags to take off' },
      },
      additionalProperties: false,
    } as const,
    run: ({ ids, query, add, remove }) => {
      const targets = resolveIds(ids, query).filter((id) => store.has(id))
      if (!targets.length) throw new Error('No entities matched. Give ids or a query.')
      const plus = parseTags((add ?? []).join(','))
      const minus = new Set(parseTags((remove ?? []).join(',')))
      if (!plus.length && !minus.size) throw new Error('Give tags to add or remove.')
      let changed = 0
      store.transaction(() => {
        for (const id of targets) {
          const e = store.get(id)!
          const tags = [...new Set([...e.tags.filter((t) => !minus.has(t)), ...plus])]
          if (tags.length === e.tags.length && tags.every((t, i) => t === e.tags[i])) continue
          store.update(id, { tags })
          changed++
        }
      })
      return json({ matched: targets.length, changed, added: plus, removed: [...minus] })
    },
  })

  const listProperties = betaTool({
    name: 'list_properties',
    description: 'The data properties in use: for a type (or every type in the open project), each property with how many entities carry it, the value kinds seen, a sample, whether the type definition declares it and as which kind, and its description when one was written (define_entity_type sets it). Use before set_properties to match existing names.',
    inputSchema: { type: 'object', properties: { type: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Properties per type (default 60)' } }, additionalProperties: false } as const,
    run: ({ type, limit }) => {
      const registry = new TypeRegistry(store)
      const types = type ? [type] : registry.all().filter((t) => t.count > 0).map((t) => t.type)
      const out = types.map((t) => {
        const declared = new Set(registry.propertiesOf(t).map((p) => p.key))
        const code = new Set(registry.fieldsFor(t).filter((f) => f.key.startsWith('data.')).map((f) => f.key.slice(5)))
        const stats = new Map<string, { count: number; kinds: Set<FieldKind>; sample?: unknown }>()
        for (const e of store.ofType(t)) {
          if (e.kind !== 'entity') continue
          for (const [k, v] of Object.entries(e.data)) {
            const st = stats.get(k) ?? { count: 0, kinds: new Set<FieldKind>() }
            st.count++
            st.kinds.add(kindOfValue(v))
            if (st.sample === undefined && v !== null && typeof v !== 'object') st.sample = typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v
            stats.set(k, st)
          }
        }
        const properties = [...stats.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, limit ?? 60)
          .map(([key, st]) => {
            const f = registry.fieldsFor(t).find((x) => x.key === `data.${key}`)
            return { key, count: st.count, kinds: [...st.kinds], sample: st.sample, declared: declared.has(key) ? 'schema' : code.has(key) ? 'code' : 'none', kind: f?.kind, ...(f?.description ? { description: f.description } : {}) }
          })
        return { type: t, entities: registry.get(t).count, properties }
      })
      return json({ types: out })
    },
  })

  // ── Version control ──────────────────────────────────────────────────

  const changes = betaTool({
    name: 'project_changes',
    description:
      "A project's unsaved changes: what its working tree holds now against its last commit (HEAD) — entities added, modified and removed. `detail` counts (just the numbers), list (each entity: id, type, label; for the modified, the property paths that changed) or full (every modified entity's properties before/after; long texts as changed-lines diffs, pictures and data URLs as sizes, lists of records — messages, annotations, a diagram's elements — as items added/removed/changed). Everything a project holds is always kept in the Library; 'unsaved' means not yet committed to the project's history. With no commit yet, everything counts as added.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id (default: the open project)' },
        detail: { type: 'string', enum: ['counts', 'list', 'full'], description: 'Default list' },
        limit: { type: 'number', description: 'Entities per group (default 100)' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Only these entities (with full detail)' },
      },
      additionalProperties: false,
    } as const,
    run: async ({ project, detail, limit, ids }) => {
      const p = activeOr(project)
      const c = await history.changes(p.id)
      const counts = { added: c.added.length, modified: c.modified.length, removed: c.removed.length, total: c.added.length + c.modified.length + c.removed.length }
      const head = c.head ? describeCommit(c.head) : null
      const base = { project: p.id, head, size: c.size, counts, autosave: versioningOf(p).autosave, ...(c.missing ? { missing_blobs: c.missing } : {}) }
      if (detail === 'counts') return json(base)
      const n = limit ?? 100
      const only = ids?.length ? new Set(ids) : null
      const pick = <T extends AnyEntity>(list: T[]) => (only ? list.filter((e) => only.has(e.id)) : list.slice(0, n))
      const full = detail === 'full' || !!only
      const modified = [] as unknown[]
      for (const e of pick(c.modified)) {
        const before = c.before.get(e.id) ?? (await history.entityAt(c.head?.id ?? null, e.id))
        const d = diffProperties(before, e)
        modified.push({ ...brief(e), ...(full ? { properties: properties(d, 60) } : { changed: d.map((x) => x.path) }) })
      }
      const truncated = only ? undefined : Object.fromEntries((['added', 'modified', 'removed'] as const).filter((k) => c[k].length > n).map((k) => [k, c[k].length - n]))
      return json({ ...base, added: pick(c.added).map((e) => (full ? { ...brief(e), properties: properties(diffProperties(undefined, e), 30) } : brief(e))), modified, removed: pick(c.removed).map(brief), ...(truncated && Object.keys(truncated).length ? { truncated } : {}) })
    },
  })

  const commit = betaTool({
    name: 'project_commit',
    description: "Commit a project's unsaved changes as a point in its history, with a message — the UI's Commit button. Returns the commit and its counts, or nothing_to_commit. Works whether autosave is on or off.",
    inputSchema: { type: 'object', properties: { message: { type: 'string' }, project: { type: 'string', description: 'Project id (default: the open project)' } }, required: ['message'], additionalProperties: false } as const,
    run: async ({ message, project }) => {
      const p = activeOr(project)
      const c = await history.commit(p.id, message)
      return json(c ? { project: p.id, commit: describeCommit(c) } : { project: p.id, nothing_to_commit: true })
    },
  })

  const log = betaTool({
    name: 'project_history',
    description:
      "A project's version history. No arguments: the commit log, newest first (id, short id, message, when, autosave or by hand, counts), narrowed with `message` (text in the message), `since`/`until` (ISO date, or a span back from now: 30m, 2h, 3d, 1w) and `include_autosave: false`. `commit`: one commit's changes — entities added, modified (properties before/after, long texts as changed-lines diffs) and removed; with `entity`, just that entity, and `content` (\"brief\" or \"full\") adds the entity as it stood after the commit — a document's text at that point in time. `entity` alone: that entity's own history — every commit that added, changed or removed it, with what changed each time. `from`/`to`: everything that changed between two commits (`to` may be \"working\" for the uncommitted state now). Commits are named by id, short id, a unique prefix (4+ chars), HEAD, HEAD~n or HEAD^.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id (default: the open project)' },
        commit: { type: 'string', description: 'A commit to show in full: id, short id, prefix, HEAD, HEAD~n' },
        entity: { type: 'string', description: 'With commit: only this entity. Alone: this entity\'s history' },
        content: { type: 'string', enum: ['brief', 'full'], description: 'With commit and entity: include the entity as it stood after the commit (brief trims texts over 4000 chars)' },
        from: { type: 'string', description: 'Compare: the older commit' },
        to: { type: 'string', description: 'Compare: the newer commit (default HEAD), or "working" for the uncommitted state' },
        message: { type: 'string', description: 'Log: only commits whose message contains this (case-insensitive)' },
        since: { type: 'string', description: 'Log: only commits at or after this (ISO date, or 30m/2h/3d/1w back from now)' },
        until: { type: 'string', description: 'Log: only commits at or before this' },
        include_autosave: { type: 'boolean', description: 'Log: include autosave commits (default true)' },
        limit: { type: 'number', description: 'Commits to list (default 50) or entities per group (default 100)' },
      },
      additionalProperties: false,
    } as const,
    run: async ({ project, commit: commitRef, entity, content: contentMode, from, to, message, since, until, include_autosave, limit }) => {
      const p = activeOr(project)
      const commits = history.commits(p.id)
      const n = limit ?? 100

      if (from || to) {
        if (!from) throw new Error('Compare needs `from` (the older commit); `to` defaults to HEAD.')
        const a = findCommit(commits, from, 'from')
        const working = to?.trim().toLowerCase() === 'working'
        const b = working ? undefined : to ? findCommit(commits, to, 'to') : commits[0]
        if (!working && b && b.id === a.id) throw new Error(`from and to are the same commit (${shortId(a.id)}).`)
        const stateA = await history.stateAt(a.id)
        const stateB: Map<EntityId, AnyEntity> = b ? await history.stateAt(b.id) : new Map(trackedEntities(store, p.id).map((e) => [e.id, e]))
        const added: AnyEntity[] = []
        const modified: { before: AnyEntity; after: AnyEntity }[] = []
        const removed: AnyEntity[] = []
        for (const [id, after] of stateB) {
          const before = stateA.get(id)
          if (!before) added.push(after)
          else if (hashEntity(before) !== hashEntity(after)) modified.push({ before, after })
        }
        for (const [id, before] of stateA) if (!stateB.has(id)) removed.push(before)
        const wanted = (id: string) => !entity || id === entity
        const truncated = entity ? {} : Object.fromEntries(([['added', added.length], ['modified', modified.length], ['removed', removed.length]] as const).filter(([, len]) => len > n).map(([k, len]) => [k, len - n]))
        return json({
          project: p.id,
          from: describeCommit(a),
          to: b ? describeCommit(b) : 'working',
          counts: { added: added.length, modified: modified.length, removed: removed.length },
          added: added.filter((e) => wanted(e.id)).slice(0, n).map((e) => ({ ...brief(e), properties: properties(diffProperties(undefined, e), 30) })),
          modified: modified.filter((m) => wanted(m.after.id)).slice(0, n).map((m) => ({ ...brief(m.after), properties: properties(diffProperties(m.before, m.after), 60) })),
          removed: removed.filter((e) => wanted(e.id)).slice(0, n).map((e) => ({ ...brief(e), properties: properties(diffProperties(e, undefined), 30) })),
          ...(Object.keys(truncated).length ? { truncated } : {}),
        })
      }

      if (entity && !commitRef) {
        const entries = await history.entityLog(p.id, entity, limit ?? 20)
        const now = store.get(entity)
        const head = commits[0]
        const headVersion = head ? await history.entityAt(head.id, entity) : undefined
        const uncommitted = now && headVersion ? hashEntity(now) !== hashEntity(headVersion) : !!now !== !!headVersion
        return json({
          project: p.id,
          entity,
          exists_now: !!now,
          ...(now ? { now: brief(now) } : {}),
          uncommitted_changes: uncommitted,
          history: entries.map((x) => ({ commit: describeCommit(x.commit), change: x.change, ...(x.change === 'modified' && x.before && x.after ? { changed: diffProperties(x.before, x.after).map((c) => c.path) } : {}), ...(x.change === 'unknown' ? { note: 'this commit\'s content is missing on this device' } : {}) })),
          ...(entries.length ? {} : { note: commits.length ? 'No commit in this project has touched that entity.' : 'This project has no commits yet.' }),
        })
      }

      if (!commitRef) {
        const lo = parseWhen(since, 'since')
        const hi = parseWhen(until, 'until')
        const needle = message?.trim().toLowerCase()
        const kept = commits.filter((c) => (include_autosave !== false || !c.data.auto) && (!needle || c.data.message.toLowerCase().includes(needle)) && (lo === undefined || Date.parse(c.data.at) >= lo) && (hi === undefined || Date.parse(c.data.at) <= hi))
        const shown = kept.slice(0, limit ?? 50)
        return json({ project: p.id, head: commits[0]?.id ?? null, autosave: versioningOf(p).autosave, commits: shown.map(describeCommit), matched: kept.length, total: commits.length, ...(kept.length > shown.length ? { truncated: kept.length - shown.length } : {}) })
      }

      const target = findCommit(commits, commitRef)
      const v = await history.view(target.id)
      if (v.missing) return json({ commit: describeCommit(target), missing_blob: true, note: 'This commit\'s content is not on this device (history is per browser), so its changes cannot be shown; the log entry stands.' })
      const keep = <T extends { id: string } | { after: AnyEntity }>(list: T[]) => (entity ? list.filter((x) => ('after' in x ? x.after.id : x.id) === entity) : list.slice(0, n))
      const out: Record<string, unknown> = {
        commit: describeCommit(target),
        added: keep(v.added).map((e) => ({ ...brief(e), properties: properties(diffProperties(undefined, e), 30) })),
        modified: keep(v.modified).map((m) => ({ ...brief(m.after), properties: properties(diffProperties(m.before, m.after), 60), ...(m.before ? {} : { earlier_version_missing: true }) })),
        removed: keep(v.removed).map((e) => ({ ...brief(e), properties: properties(diffProperties(e, undefined), 30) })),
      }
      if (entity) {
        const touched = v.added.some((e) => e.id === entity) || v.modified.some((m) => m.after.id === entity) || v.removed.some((e) => e.id === entity)
        if (!touched) out.note = `Commit ${shortId(target.id)} did not touch ${entity}; project_history {entity} lists the commits that did.`
        if (contentMode) {
          const at = await history.entityAt(target.id, entity)
          out.content_after = at ? content(at, contentMode === 'full') : null
          if (!at) out.content_note = 'The entity was not in the project after this commit.'
        }
      } else {
        const truncated = Object.fromEntries((['added', 'modified', 'removed'] as const).filter((k) => v[k].length > n).map((k) => [k, v[k].length - n]))
        if (Object.keys(truncated).length) out.truncated = truncated
      }
      return json(out)
    },
  })

  /** The unsaved changes as a person would want them read out before deciding: counts and a few names per group. */
  const unsavedSummary = async (p: ProjectEntity) => {
    const c = await history.changes(p.id)
    const names = (list: AnyEntity[]) => list.slice(0, 6).map((e) => `${quoteLabel(displayLabel(e), 60)} (${oneLineLabel(e.type, 40)})`).join(', ') + (list.length > 6 ? `, … ${list.length - 6} more` : '')
    const parts = [c.added.length ? `${c.added.length} added: ${names(c.added)}` : '', c.modified.length ? `${c.modified.length} modified: ${names(c.modified)}` : '', c.removed.length ? `${c.removed.length} removed: ${names(c.removed)}` : ''].filter(Boolean)
    const total = c.added.length + c.modified.length + c.removed.length
    return { total, counts: { added: c.added.length, modified: c.modified.length, removed: c.removed.length, total }, text: parts.join('; '), changes: { added: c.added.slice(0, 20).map(brief), modified: c.modified.slice(0, 20).map(brief), removed: c.removed.slice(0, 20).map(brief) } }
  }
  const SAVE = 'Save them first'
  const DISCARD = 'Discard them'
  const CANCEL = 'Cancel'
  /**
   * What to do with unsaved changes before a restore: the user decides in
   * the app — a question card in the assistant, a dialog over the bridge —
   * unless the tool call already carries their answer. Resolves to the
   * decision, or null when they cancel (or nothing can ask them).
   */
  const decideUnsaved = async (p: ProjectEntity, what: string, given: 'ask' | 'save' | 'discard' | undefined): Promise<{ decision: 'save' | 'discard'; summary: Awaited<ReturnType<typeof unsavedSummary>> } | { cancelled: string; summary: Awaited<ReturnType<typeof unsavedSummary>> } | null> => {
    const summary = await unsavedSummary(p)
    if (!summary.total) return null
    // Saving first loses nothing, so the caller's word is enough. Discarding loses the changes for good: that is
    // always put to the user, however the call was worded — a tool call is not the user's own words.
    if (given === 'save') return { decision: 'save', summary }
    if (given === 'discard') {
      const ok = await host.confirm(`${quoteLabel(displayLabel(p))} has ${summary.total} unsaved change${summary.total === 1 ? '' : 's'} — ${summary.text}. ${what} throws them away for good. Discard them?`, { yes: 'Discard', danger: true })
      return ok ? { decision: 'discard', summary } : { cancelled: 'The user declined to discard.', summary }
    }
    const question = `${quoteLabel(displayLabel(p))} has ${summary.total} unsaved change${summary.total === 1 ? '' : 's'} — ${summary.text}. ${what} would lose them. Save them as a commit first (so this can be undone), or discard them?`
    if (host.choose) {
      const pick = await host.choose(question, [SAVE, DISCARD, CANCEL])
      if (pick === SAVE) return { decision: 'save', summary }
      if (pick === DISCARD) return { decision: 'discard', summary }
      return { cancelled: pick === null ? 'The user closed the question without choosing.' : 'The user cancelled.', summary }
    }
    // A runner that can only ask yes/no: yes saves first, no cancels — nothing is ever discarded without being asked for by name.
    const ok = await host.confirm(`${question} (Yes: save them first and go on. No: stop here.)`, { yes: 'Save and go on' })
    return ok ? { decision: 'save', summary } : { cancelled: 'The user declined.', summary }
  }

  const restore = betaTool({
    name: 'project_restore',
    description:
      "Go back in a project's history. `commit`: make the project what it was after that commit (edits undone, entities added since taken out — deleted when in no other project —, removed ones put back), recorded as a new commit so it can itself be undone. `discard: true`: throw away every unsaved change (back to HEAD; no commit results — they are gone for good). `entity`: revert one entity to its committed version (an added one is taken out, a removed one put back). Whenever unsaved changes would be lost, the user is shown them in the app and asked — save them as a commit first, discard them, or cancel — and the answer is in the result. `unsaved: save` commits them first without asking (nothing is lost); `unsaved: discard` still asks — throwing work away is always the user's yes in the app. Reverting an entity always asks. Commits are named by id, short id, prefix, HEAD~n.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id (default: the open project)' },
        commit: { type: 'string', description: 'Commit id or short form to restore' },
        discard: { type: 'boolean', description: 'Discard all unsaved changes (restore HEAD)' },
        entity: { type: 'string', description: 'Revert just this entity to HEAD' },
        message: { type: 'string', description: 'Message for the restore commit' },
        unsaved: { type: 'string', enum: ['ask', 'save', 'discard'], description: 'What to do with unsaved changes: ask the user (default), save them as a commit first, or discard them (the user is still asked to confirm)' },
      },
      additionalProperties: false,
    } as const,
    run: async ({ project, commit: commitRef, discard, entity, message, unsaved }) => {
      const p = activeOr(project)
      const commits = history.commits(p.id)
      if (entity) {
        const head = commits[0]
        const before = await history.entityAt(head?.id ?? null, entity)
        const now = store.get(entity)
        if (!now && !before) throw new Error(`No entity ${entity} now or at HEAD.`)
        const changed = now && before ? diffProperties(before, now).map((c) => c.path) : []
        const what = !before ? `Take ${quoteLabel(displayLabel(now!))} (${oneLineLabel(now!.type, 40)}) out of the project — it was added since the last commit` : !now ? `Put ${quoteLabel(displayLabel(before))} (${oneLineLabel(before.type, 40)}) back as it was at the last commit` : changed.length ? `Revert ${quoteLabel(displayLabel(now))} (${oneLineLabel(now.type, 40)}) to its committed version, undoing changes to ${changed.slice(0, 8).map((k) => oneLineLabel(k, 40)).join(', ')}` : ''
        if (!what) return json({ project: p.id, entity, result: 'unchanged' })
        const ok = host.choose ? (await host.choose(`${what}?`, ['Revert it', CANCEL])) === 'Revert it' : await host.confirm(`${what}?`, { yes: 'Revert', danger: true })
        if (!ok) return json({ project: p.id, entity, cancelled: true, reason: 'The user declined.', would: what })
        return json({ project: p.id, entity, result: await history.revertEntity(p.id, entity), ...(changed.length ? { reverted: changed } : {}) })
      }
      if (!discard && !commitRef) throw new Error('Give a commit (project_history lists them), discard: true, or an entity.')
      if (discard && commitRef) throw new Error('Either discard: true (back to HEAD) or a commit to restore, not both.')
      if (discard) {
        if (!commits.length) throw new Error('No commit yet: nothing to discard to. project_commit would record the current state instead.')
        const d = await decideUnsaved(p, 'Discarding', unsaved)
        if (!d) return json({ project: p.id, nothing_to_discard: true, head: describeCommit(commits[0]) })
        if ('cancelled' in d) return json({ project: p.id, cancelled: true, reason: d.cancelled, unsaved: d.summary.counts, changes: d.summary.changes })
        if (d.decision === 'save') {
          const c = await history.commit(p.id, message ?? 'Save before discarding')
          return json({ project: p.id, saved_instead: c ? describeCommit(c) : null, note: 'The user chose to keep the changes: they are committed and nothing was discarded.' })
        }
        const r = await history.restore(p.id, commits[0].id, { message: message ?? 'Discard changes' })
        return json({ project: p.id, discarded: d.summary.counts, changes: d.summary.changes, head: describeCommit(commits[0]), upserted: r.upserted, removed: r.removed, unmarked: r.unmarked, skipped: r.skipped })
      }
      const target = findCommit(commits, commitRef!)
      const d = await decideUnsaved(p, `Restoring ${shortId(target.id)} "${target.data.message}"`, unsaved)
      if (d && 'cancelled' in d) return json({ project: p.id, cancelled: true, reason: d.cancelled, would_restore: describeCommit(target), unsaved: d.summary.counts, changes: d.summary.changes })
      if (target.id === commits[0]?.id && !d) return json({ project: p.id, already_there: true, head: describeCommit(target) })
      const saved = d?.decision === 'save' ? await history.commit(p.id, `Before restoring ${shortId(target.id)}`) : undefined
      const r = await history.restore(p.id, target.id, { message })
      const undoTo = saved ?? commits[0]
      return json({
        project: p.id,
        ...(saved ? { saved_first: describeCommit(saved) } : {}),
        ...(d?.decision === 'discard' ? { discarded: d.summary.counts, changes: d.summary.changes } : {}),
        restored: describeCommit(target),
        commit: r.commit ? describeCommit(r.commit) : null,
        upserted: r.upserted,
        removed: r.removed,
        unmarked: r.unmarked,
        skipped: r.skipped,
        ...(undoTo ? { undo: `project_restore {commit: "${shortId(undoTo.id)}"}${d?.decision === 'discard' ? ' — the discarded changes are not in it' : ''}` } : {}),
      })
    },
  })

  return [list, create, openTool, add, remove, update, del, save, publish, openBundle, template, loadDataset, deleteMany, setProperties, tagEntities, listProperties, changes, commit, log, restore]
}
