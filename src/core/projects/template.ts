import { isRelationship, type AegraphDocument, type AnyEntity, type EntityId, type TagInfo } from '../entity/types'
import type { EntityStore } from '../entity/store'
import { isProjectEntity, isSafeProjectId, type ProjectData, type ProjectEntity } from './project'
import { readStashedUiState, stashUiState, getActiveProjectId, readUiState, writeUiState } from './active'

/**
 * A project template: the analytics for a *kind* of dataset — charts,
 * scripts, graph scenes, a guide, the pages' arrangement — with none of the
 * data. Applied to a project that holds such data (a ChatGPT export run
 * through the atlas pipeline, say), it gives that project the same
 * ready-made pictures another person's got: the template names the types
 * it needs; its charts and scripts select rows by type and tag, never by
 * id, so they work over anyone's export.
 *
 * On disk a template is an aegraph document with a `template` block. Its
 * entities carry ids of the template's own (`tpl:<template>:<name>`);
 * applying prefixes them with the project's id, so the same template can
 * sit in several projects, and applying it again updates rather than
 * duplicates. Everything an entity, a saved arrangement or a route says
 * about another template entity is rewritten the same way.
 */
export interface TemplateInfo {
  id: string
  label: string
  description?: string
  /** Types the template's pictures are over; a project without them gets the pictures, empty, and a warning. */
  requires?: string[]
  /**
   * Types whose Library entities are the data this template is for. Starting a project from the template adopts
   * them — the ones in no project yet — so a Library that holds a pipeline's output loose gets a project with the
   * data and the pictures in one step. `requires` is used when this is absent.
   */
  adopts?: string[]
  /** Where the project opens once the template is in: a route, rewritten like the entities. */
  home?: string
  /** What the template is for, one line, for the picker. */
  hint?: string
}

export interface TemplateDocument extends AegraphDocument {
  template: TemplateInfo
}

export const isTemplateDocument = (raw: unknown): raw is TemplateDocument => !!raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { template?: unknown }).template === 'object' && Array.isArray((raw as { entities?: unknown }).entities)

/** The id an entity of the template gets inside a project. */
export const templateEntityId = (projectId: EntityId, id: string) => `${projectId}:${id}`

export interface TemplateReport {
  template: TemplateInfo
  project: ProjectEntity
  created: number
  updated: number
  /** Library entities (and the relationships among them) taken into the project, when asked to adopt. */
  adopted: number
  /** Required types the project has none of. */
  missing: string[]
  /** Where to go next. */
  route?: string
}

/**
 * Put a template's entities into a project. Ids are rewritten to the
 * project (see above), marks set, timestamps now; the template's UI
 * arrangement is stashed for the project (or written live when the
 * project is the open one); the project remembers the template and takes
 * its home route when it has none of its own.
 */
export function applyTemplate(store: EntityStore, doc: TemplateDocument, projectId: EntityId, opts: { /** Take the Library's loose entities of the template's data types into the project first. */ adopt?: boolean } = {}): TemplateReport {
  const project = store.get(projectId)
  if (!isProjectEntity(project)) throw new Error(`No project ${projectId}.`)
  if (!isSafeProjectId(projectId)) throw new Error(`A template cannot be applied to project ${JSON.stringify(projectId)}: its id has quotes or control characters.`)
  const info = doc.template
  let adopted = 0
  if (opts.adopt) {
    const types = info.adopts ?? info.requires ?? []
    const loose = types.flatMap((t) => store.library.ofType(t)).filter((e) => !isRelationship(e) && !(e.meta.projects ?? []).length).map((e) => e.id)
    if (loose.length) adopted = store.mark(loose, projectId)
  }
  const ids = doc.entities.map((e) => e.id).filter((id) => typeof id === 'string' && id.length > 0).sort((a, b) => b.length - a.length)
  // Within each string: an id in a route, a saved arrangement or a data value is rewritten wherever it stands. Over
  // the parsed values, never the JSON text — a project id is the reader's, but it was spliced into text once, and a
  // quote in it wrote keys of its own.
  const rewrite = (text: string) => {
    let out = text
    for (const id of ids) if (out.includes(id)) out = out.split(id).join(templateEntityId(projectId, id))
    return out
  }
  const now = new Date().toISOString()
  const entities = (rewriteStrings(doc.entities, rewrite) as AnyEntity[]).map((e) => ({ ...e, meta: { ...e.meta, createdAt: e.meta.createdAt ?? now, updatedAt: now, source: `template:${info.id}`, projects: isProjectEntity(e) ? undefined : [projectId] } }))
  const tags: TagInfo[] = doc.tags ?? []
  let created = 0
  let updated = 0
  store.transaction(() => {
    for (const t of tags) store.setTagInfo(t.tag, t)
    for (const e of entities) {
      if (isProjectEntity(e)) continue
      const prev = store.get(e.id)
      if (prev) {
        updated++
        // A project may have added marks of its own; keep them.
        const marks = new Set([...(prev.meta.projects ?? []), projectId])
        store.upsert({ ...e, meta: { ...e.meta, createdAt: prev.meta.createdAt, projects: [...marks] } })
      } else {
        created++
        store.upsert(e)
      }
    }
    const data: ProjectData = { ...project.data, template: info.id, ...(project.data.home?.route ? {} : info.home ? { home: { ...project.data.home, route: rewrite(info.home) } } : {}) }
    store.update(project.id, { data })
  })
  // The pages' arrangement for this project: the Analytics tabs are the template's point and are always set; anything
  // else (a Workstation the project already has, an explorer view) is only filled in where the project has none.
  if (doc.state?.ui) {
    const live = getActiveProjectId() === projectId
    const have = live ? readUiState() : readStashedUiState(projectId)
    const ui = { ...have }
    for (const [k, v] of Object.entries(doc.state.ui)) if (k === 'aegraph:analytics:v1' || have[k] === undefined) ui[k] = rewrite(v)
    if (live) writeUiState(ui)
    else stashUiState(projectId, ui)
  }
  const missing = (info.requires ?? []).filter((t) => !store.library.ofType(t).some((e) => !isRelationship(e) && (e.meta.projects ?? []).includes(projectId)))
  const route = info.home ? rewrite(info.home) : doc.state?.route ? rewrite(doc.state.route) : undefined
  return { template: info, project: store.get(project.id) as ProjectEntity, created, updated, adopted, missing, route }
}

/** A copy of a JSON value with every string — keys too — passed through `f`; `__proto__` keys are left out. Iterative: a template is data. */
function rewriteStrings(value: unknown, f: (s: string) => string): unknown {
  const root: { v: unknown } = { v: undefined }
  const stack: [unknown, Record<string, unknown> | unknown[], string | number][] = [[value, root as Record<string, unknown>, 'v']]
  while (stack.length) {
    const [v, into, at] = stack.pop()!
    let out: unknown = v
    if (typeof v === 'string') out = f(v)
    else if (Array.isArray(v)) {
      const arr = new Array<unknown>(v.length)
      for (let i = 0; i < v.length; i++) stack.push([v[i], arr, i])
      out = arr
    } else if (v && typeof v === 'object') {
      const obj: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) {
        const key = f(k)
        if (key === '__proto__') continue
        stack.push([x, obj, key])
      }
      out = obj
    }
    ;(into as Record<string | number, unknown>)[at] = out
  }
  return root.v
}

/** The templates the app ships, at `public/templates/<id>.template.ae.json`. */
export const TEMPLATE_CATALOG: TemplateInfo[] = [
  {
    id: 'conversation-atlas',
    label: 'Conversation atlas',
    description: 'Analytics over a ChatGPT export run through the atlas pipeline: activity over time, what the conversations were about and how that shifted, stakes and modes, the regions and clusters, the hubs — as charts, scripts and graph scenes, arranged in Analytics tabs.',
    requires: ['segment', 'conversation'],
    adopts: ['segment', 'conversation', 'topic', 'named-entity', 'cluster', 'domain', 'theme', 'persona', 'region'],
    hint: 'for a ChatGPT export labelled as a conversation atlas',
  },
]
export const templateUrl = (id: string) => `/templates/${id}.template.ae.json`

export async function fetchTemplate(id: string): Promise<TemplateDocument> {
  const r = await fetch(templateUrl(id))
  if (!r.ok) throw new Error(`Template ${id}: ${r.status}`)
  const raw = (await r.json()) as unknown
  if (!isTemplateDocument(raw)) throw new Error(`Template ${id}: not a template document.`)
  return raw
}
