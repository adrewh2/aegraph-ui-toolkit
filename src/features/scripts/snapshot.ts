import { useSyncExternalStore } from 'react'
import { displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import type { AnyEntity, Relationship } from '../../core/entity/types'
import type { StoreEvent } from '../../core/entity/store'
import { SCHEMA_TYPE } from '../../core/entity/categories'
import { getEntityType } from '../../core/entity/schema'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { datasetGraph } from '../../core/graph/dataset'
import { isProjectEntity } from '../../core/projects/project'
import type { SnapTag, SnapType, Snapshot } from '../../scripting/types'
import { getLatestAnalysis } from '../analysis/latest'

/**
 * What of an entity's `data` reaches a script. Scripts analyse structure and
 * numbers, and the snapshot crosses into a worker and a sandbox with a
 * memory cap, so text stays short and no single entity may be huge:
 *  - a string longer than LONG (at any depth: a message's content inside a
 *    conversation's `messages` as much as a document's body) is cut to a
 *    stub with its length;
 *  - past a BUDGET of JSON per entity, the largest values are replaced by
 *    `{ $omitted: true, kind, items, bytes }` until it fits — a script can
 *    still see that the value was there, how big it was, and any count
 *    field beside it (`messageCount`, `charLength`).
 * A dataset of chat transcripts went from hundreds of MB in the sandbox to
 * a few.
 */
const LONG = 1000
const DATA_BUDGET = 4_000

/** The first 200 characters, then the whole length — a reader (or a script) should not take it for the count cut. */
const stub = (v: string) => `${v.slice(0, 200)}… [cut: ${v.length.toLocaleString('en-US')} chars in all]`

/** Long strings cut, at any depth. Returns the same object when nothing changed. */
function slimStrings(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > LONG ? stub(v) : v
  if (!v || typeof v !== 'object' || depth > 6) return v
  if (Array.isArray(v)) {
    let out: unknown[] | null = null
    for (let i = 0; i < v.length; i++) {
      const w = slimStrings(v[i], depth + 1)
      if (w !== v[i]) (out ??= [...v])[i] = w
    }
    return out ?? v
  }
  let out: Record<string, unknown> | null = null
  const o = v as Record<string, unknown>
  for (const k in o) {
    const w = slimStrings(o[k], depth + 1)
    if (w !== o[k]) (out ??= { ...o })[k] = w
  }
  return out ?? v
}

const sizeOf = (v: unknown) => {
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * A quick estimate of a value's JSON size (escaping not counted), stopping as soon as it passes `limit`: most entities'
 * data is a handful of scalars, and stringifying each of a city's worth just to learn it is small was two thirds of a
 * second.
 */
function boundedSize(v: unknown, limit: number, depth = 0): number {
  if (v === null || v === undefined) return 4
  if (typeof v === 'string') return v.length + 2
  if (typeof v !== 'object') return 16
  if (depth > 6) return limit + 1
  let n = 2
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      n += boundedSize(v[i], limit, depth + 1) + 1
      if (n > limit) return n
    }
    return n
  }
  for (const k in v as Record<string, unknown>) {
    n += k.length + 4 + boundedSize((v as Record<string, unknown>)[k], limit, depth + 1)
    if (n > limit) return n
  }
  return n
}

/** Data a reader can take in: long strings cut, and past `budget` bytes the largest values replaced by stubs. */
export function slimData(data: Record<string, unknown>, opts: { budget?: number } = {}): Record<string, unknown> {
  const BUDGET = opts.budget ?? DATA_BUDGET
  let out = slimStrings(data) as Record<string, unknown>
  // The estimate ignores escaping, so only well under budget by it settles the matter; anything near is measured.
  if (boundedSize(out, BUDGET / 2) <= BUDGET / 2 || sizeOf(out) <= BUDGET) return out
  // Over budget: drop the biggest values first, largest to smallest, until it fits.
  const sizes = Object.keys(out)
    .map((k) => ({ k, n: sizeOf(out[k]) }))
    .sort((a, b) => b.n - a.n)
  let total = sizes.reduce((s, x) => s + x.n, 0)
  out = out === data ? { ...data } : out
  for (const { k, n } of sizes) {
    if (total <= BUDGET) break
    const v = out[k]
    out[k] = { $omitted: true, kind: Array.isArray(v) ? 'array' : typeof v, ...(Array.isArray(v) ? { items: v.length } : {}), bytes: n }
    total -= n - 60
  }
  return out
}

/** The ontology as a script sees it: the types in use (and the declared ones), with the properties they and their ancestors declare. */
export function snapshotOntology(registry: TypeRegistry, nodes: { type: string }[], edges: { type: string }[]): SnapType[] {
  const counts = new Map<string, number>()
  for (const e of nodes) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
  const relCounts = new Map<string, number>()
  for (const r of edges) relCounts.set(r.type, (relCounts.get(r.type) ?? 0) + 1)
  const out: SnapType[] = []
  for (const t of registry.all()) {
    if (t.type === 'schema:type' || t.category === 'project' || t.category === 'schema') continue
    const rel = t.kind === 'relationship' || (relCounts.has(t.type) && !counts.has(t.type))
    const count = rel ? relCounts.get(t.type) ?? 0 : counts.get(t.type) ?? 0
    if (!count && t.origin === 'inferred') continue
    const seen = new Set<string>()
    const properties: SnapType['properties'] = []
    for (const p of registry.propertiesOf(t.type)) {
      if (seen.has(p.key)) continue
      seen.add(p.key)
      properties.push({ key: p.key, ...(p.label ? { label: p.label } : {}), ...(p.kind ? { kind: p.kind } : {}), ...(p.description ? { description: p.description } : {}), ...(p.options?.length ? { options: p.options } : {}), ...(p.required ? { required: true } : {}) })
    }
    out.push({ type: t.type, label: t.label, category: t.category, kind: rel ? 'relationship' : 'entity', ...(t.parent ? { parent: t.parent } : {}), ...(t.description ? { description: t.description } : {}), ...(t.color ? { color: t.color } : {}), count, properties })
  }
  return out.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
}

/**
 * The dataset as scripts see it: every entity and relationship the graph
 * views would show (the open project, or the Library), the project, the
 * ontology and the tags, plus the latest analysis run's metric columns.
 * Built once per store version; the JSON is what crosses into the worker
 * and the sandbox.
 */
export function buildSnapshot(store: EntityStore, registry: TypeRegistry, types?: string[]): { key: string; snapshot: Snapshot } {
  const { key, head, nodes, edges } = snapshotParts(store, registry, types)
  return { key, snapshot: { ...head, entities: nodes.map(snapEntity), relationships: edges.map(snapRelationship) } }
}

/**
 * The types a scoped snapshot keeps: the ones named, and everything under them in the ontology — `location` brings
 * the city's trees with it, `tree` brings only the trees. A name nothing matches is kept as it is, so a typo shows
 * as an empty dataset rather than as the whole project.
 */
function typeScope(registry: TypeRegistry, types: string[]): Set<string> {
  const want = new Set(types)
  for (const t of types) for (const sub of registry.withSubtypes(t)) want.add(sub)
  return want
}

type SnapHead = Omit<Snapshot, 'entities' | 'relationships'>
const snapEntity = (e: AnyEntity): Snapshot['entities'][number] => ({ id: e.id, type: e.type, label: displayLabel(e), ...(e.description ? { description: e.description } : {}), tags: e.tags, data: slimData(e.data), createdAt: e.meta.createdAt, updatedAt: e.meta.updatedAt })
const snapRelationship = (r: Relationship): Snapshot['relationships'][number] => ({ id: r.id, type: r.type, source: r.source.id, target: r.target.id, directed: r.directed, data: r.data })

/** Everything but the two big lists, which the callers shape as they need — as objects, or straight into JSON a chunk at a time. */
function snapshotParts(store: EntityStore, registry: TypeRegistry, types?: string[]): { key: string; head: SnapHead; nodes: AnyEntity[]; edges: Relationship[] } {
  const all = datasetGraph(store, registry)
  // Narrowed to a few types: the entities of those types, and the relationships with both ends still in.
  let { nodes, edges } = all
  if (types?.length) {
    const want = typeScope(registry, types)
    nodes = all.nodes.filter((e) => want.has(e.type))
    const ids = new Set(nodes.map((n) => n.id))
    edges = all.edges.filter((r) => ids.has(r.source.id) && ids.has(r.target.id))
  }
  const latest = getLatestAnalysis()
  const metrics: Record<string, Record<string, number>> = {}
  if (latest && latest.report.nodes === nodes.length) {
    for (const [name, col] of Object.entries(latest.metrics.columns)) {
      if (!col) continue
      const m: Record<string, number> = {}
      latest.metrics.ids.forEach((id, i) => {
        if (Number.isFinite(col[i])) m[id] = col[i]
      })
      metrics[name] = m
    }
  }
  const project = store.scope ? store.get(store.scope) : undefined
  const tagCounts = new Map<string, number>()
  for (const e of nodes) for (const t of e.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  const tags: SnapTag[] = [...tagCounts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => {
      const info = store.getTagInfo(tag)
      return { tag, count, ...(info.color ? { color: info.color } : {}), ...(info.description ? { description: info.description } : {}) }
    })
  const head: SnapHead = {
    scope: { label: project ? displayLabel(project) : 'Library', projectId: project?.id, ...(types?.length ? { types: [...types].sort() } : {}) },
    ...(project && isProjectEntity(project) ? { project: { id: project.id, label: displayLabel(project), ...(project.description ? { description: project.description } : {}), includes: project.data.includes ?? [], source: project.data.source, createdAt: project.meta.createdAt, updatedAt: project.meta.updatedAt } } : {}),
    ontology: snapshotOntology(registry, nodes, edges),
    tags,
    ...(Object.keys(metrics).length ? { metrics } : {}),
  }
  return { key: snapshotKey(store, types), head, nodes, edges }
}

/** Entities serialised per piece, the event loop between pieces: a city's worth stringifies in many short tasks, not one long one. */
const JSON_CHUNK = 20_000
const yieldToEvents = (): Promise<void> => {
  const sch = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return sch?.yield ? sch.yield() : new Promise((r) => setTimeout(r, 0))
}

/**
 * The snapshot as JSON, the same text `JSON.stringify(buildSnapshot(…).snapshot)`
 * gives, but the two big lists are written a chunk at a time with the event
 * loop let in between — 360,000 entities were one second the page could not
 * scroll through.
 */
export async function snapshotJson(store: EntityStore, registry: TypeRegistry, types?: string[]): Promise<string> {
  const { head, nodes, edges } = snapshotParts(store, registry, types)
  const list = async <T>(items: T[], one: (x: T) => unknown): Promise<string> => {
    const pieces: string[] = []
    for (let i = 0; i < items.length; i += JSON_CHUNK) {
      const slice = items.slice(i, i + JSON_CHUNK)
      const strs = new Array<string>(slice.length)
      for (let j = 0; j < slice.length; j++) strs[j] = JSON.stringify(one(slice[j]))
      pieces.push(strs.join(','))
      if (i + JSON_CHUNK < items.length) await yieldToEvents()
    }
    return pieces.join(',')
  }
  // The head first, so the text reads in the same order as the object would.
  const { scope, project, ...rest } = head
  const opening = JSON.stringify({ scope, ...(project ? { project } : {}) })
  const entities = await list(nodes, snapEntity)
  const relationships = await list(edges, snapRelationship)
  const tail = JSON.stringify(rest)
  return `${opening.slice(0, -1)},"entities":[${entities}],"relationships":[${relationships}]${tail.length > 2 ? `,${tail.slice(1)}` : '}'}`
}

/**
 * The version of what a snapshot reads. The store's data version moves on
 * every material write, but a snapshot holds none of the project-category
 * entities (styles, layouts, scripts, scenes, plots…) or the type
 * definitions: saving a style script's rendering, or the script itself,
 * must not cost the next run a reload of a few hundred thousand entities.
 * So this counts only writes that touch something else, and removals.
 */
const datasetVersions = new WeakMap<EntityStore, { version: number }>()
const outsideDataset = (e: AnyEntity) => {
  if (e.type === SCHEMA_TYPE) return true
  const cat = getEntityType(e.type)?.category
  return cat === 'project' || cat === 'schema'
}
const touchesDataset = (ev: StoreEvent): boolean => {
  if (ev.type === 'upsert') return !ev.volatile && ev.entities.some((e) => !outsideDataset(e))
  if (ev.type === 'remove' || ev.type === 'reset') return true
  if (ev.type === 'batch') return ev.events.some(touchesDataset)
  return false
}
/**
 * The same counter as a hook: a view that rebuilds on `dataVersion` rebuilds when a metrics run saves its analysis,
 * when a layout or a style is written, when a scene is saved — none of which change what the graph *is*. Subscribing
 * to this instead means the picture is left alone while the tools work beside it.
 */
export function useDatasetVersion(store: EntityStore): number {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => datasetVersion(store),
    () => datasetVersion(store),
  )
}

export function datasetVersion(store: EntityStore): number {
  let t = datasetVersions.get(store)
  if (!t) {
    t = { version: store.dataVersion }
    datasetVersions.set(store, t)
    const tracker = t
    store.subscribe((ev) => {
      if (touchesDataset(ev)) tracker.version++
    })
  }
  return t.version
}

/**
 * A snapshot provider for the runner: keyed by the dataset's version (a
 * script recording its own run, a style or layout it produced, does not
 * invalidate it), the JSON serialised only when the worker asks for it —
 * and not kept here afterwards: the worker holds the copy it parsed, and a
 * string the size of the dataset has no business staying on the main
 * thread.
 */
export function snapshotProvider(store: EntityStore, registry: TypeRegistry) {
  // `scope` is the project: the Python engine restarts its worker rather than carry one project's run into another's.
  return (types?: string[]) => ({ key: snapshotKey(store, types), scope: store.scope ?? 'library', json: () => snapshotJson(store, registry, types) })
}

/** What identifies a snapshot: the project, the dataset's version, the analysis it carries, and the types it was narrowed to. */
function snapshotKey(store: EntityStore, types?: string[]): string {
  const scope = types?.length ? `:t=${[...types].sort().join(',')}` : ''
  return `${store.scope ?? 'library'}:${datasetVersion(store)}:${getLatestAnalysis()?.report.key ?? ''}${scope}`
}
