import { Table2, Waypoints } from 'lucide-react'
import type { MenuItem } from '../components/ui/Menu'
import { isRelationship } from '../core/entity/types'
import type { EntityStore } from '../core/entity/store'
import { displayLabel } from '../core/entity/entity'
import type { AnyEntity, EntityId, Relationship } from '../core/entity/types'
import type { TypeRegistry } from '../core/entity/typeRegistry'
import type { TypeCategory } from '../core/entity/categories'
import { RESOURCE_TYPES } from '../core/resources/types'
import { askItem } from '../features/assistant/ask'
import { entityHref, typeHref } from './routes'

/**
 * Cross-link from any content list to the Entities browser, landing with
 * the table prefiltered to the entity's category and type and the entity
 * selected, so the inspector opens on it. Relationships go to their tab.
 */
export function browserHref(e: AnyEntity, registry?: TypeRegistry): string {
  if (isRelationship(e)) return `/entities?category=relationships&sel=${e.id}`
  const category: TypeCategory = registry ? registry.categoryOf(e.type) : (Object.values(RESOURCE_TYPES) as string[]).includes(e.type) ? 'resource' : 'knowledge'
  return typeHref(e.type, category) + `&sel=${e.id}`
}

/**
 * Context-menu items shared by every list: Documents, Images, Videos, Audio, Diagrams, Maps, and the browser itself.
 * With `related` (the store and a tab opener), "Related entities" follows: the table on the entity's links and their other ends — and "Ask about this" sends the entity to the assistant.
 */
export function openInItems(e: AnyEntity, navigate: (to: string) => void, registry?: TypeRegistry, related?: { store: EntityStore; open: (to: string, title?: string) => void }): MenuItem[] {
  return [{ kind: 'item', label: 'Open in Entities', icon: Table2, onSelect: () => navigate(browserHref(e, registry)) }, ...(related ? [...relatedItems(related.store, [e.id], related.open), askItem(related.store, [e.id])] : [])]
}

export { entityHref }

/**
 * Hand a set of ids to the Entities table without a mile-long URL: the ids
 * go to sessionStorage under a short key and the browser reads `?pick=`.
 */
export function pickHref(ids: EntityId[], label: string, category: 'all' | 'resource' | 'knowledge' | 'project' = 'all'): string {
  return `/entities?category=${category}&pick=${storePick(ids, label)}`
}

/** A pick: the ids, what to call them — and, when a filter script produced them, that script, so the explorer can say so and run it again. */
export interface Pick {
  ids: EntityId[]
  label: string
  script?: EntityId
  /** Place the nodes where they are on Earth (a map's rows): the geographic placement, applied once the view holds them. */
  geo?: boolean
}

/** Picks kept in memory as well: a very long list can exceed the storage quota, and the hand-off is within this tab anyway. */
const memPicks = new Map<string, Pick>()
export function storePick(ids: EntityId[], label: string, script?: EntityId, geo?: boolean): string {
  const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pick: Pick = { ids, label, ...(script ? { script } : {}), ...(geo ? { geo } : {}) }
  memPicks.set(key, pick)
  if (memPicks.size > 20) memPicks.delete(memPicks.keys().next().value!)
  try {
    sessionStorage.setItem(`aegraph:pick:${key}`, JSON.stringify(pick))
  } catch {
    /* storage full or unavailable: the in-memory copy serves this tab */
  }
  return key
}

/**
 * Unigraph restricted to a set of ids — a table's rows, handed over
 * the same way (`?only=<key>`); the explorer keeps only those nodes until the
 * restriction is lifted in its filter panel. `fresh` starts from an empty
 * filter instead of layering the restriction on the current one: a new graph
 * of just these entities, whatever the last tab was filtering.
 */
export function graphHref(ids: EntityId[], label: string, mode: '2d' | '3d' = '2d', fresh = false, script?: EntityId, geo = false): string {
  return `/graph/${mode}?only=${storePick(ids, label, script, geo)}${fresh ? '&fresh=1' : ''}`
}

/**
 * A graph to open as a new explorer tab, set up from a finding or a tool: the filter, style, layout and the entities
 * to select, handed over like a pick (`/unigraph/2d?setup=<key>`) and applied by the tab that opens on it.
 */
export interface GraphSetup {
  label: string
  filter?: Record<string, unknown>
  /** Rendering as a spec, ready to load. */
  rendering?: unknown
  /** Metrics the style needs computed first. */
  metrics?: string[]
  layout?: string
  labels?: 'auto' | 'all' | 'none'
  focus?: EntityId[]
}
const memSetups = new Map<string, GraphSetup>()
export function graphSetupHref(setup: GraphSetup, mode: '2d' | '3d' = '2d'): string {
  const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  memSetups.set(key, setup)
  if (memSetups.size > 20) memSetups.delete(memSetups.keys().next().value!)
  try {
    sessionStorage.setItem(`aegraph:setup:${key}`, JSON.stringify(setup))
  } catch {
    /* the in-memory copy serves this tab */
  }
  return `/graph/${mode}?setup=${key}`
}
export function readGraphSetup(key: string): GraphSetup | undefined {
  const mem = memSetups.get(key)
  if (mem) return mem
  try {
    const raw = sessionStorage.getItem(`aegraph:setup:${key}`)
    return raw ? (JSON.parse(raw) as GraphSetup) : undefined
  } catch {
    return undefined
  }
}

export function readPick(key: string): Pick | undefined {
  const mem = memPicks.get(key)
  if (mem) return mem
  try {
    const raw = sessionStorage.getItem(`aegraph:pick:${key}`)
    if (!raw) return undefined
    const v = JSON.parse(raw) as { ids?: unknown; label?: unknown; script?: unknown; geo?: unknown }
    return Array.isArray(v.ids) ? { ids: v.ids.map(String), label: typeof v.label === 'string' ? v.label : 'picked', ...(typeof v.script === 'string' ? { script: v.script } : {}), ...(v.geo === true ? { geo: true } : {}) } : undefined
  } catch {
    return undefined
  }
}

/**
 * Everything one hop from a set of entities: the relationships touching
 * them and the entities on the other end. The set itself is left out, so
 * the table answers "what is this linked to?" rather than repeating it.
 * A relationship in the set is the exception: it comes along with its
 * source and target, so a selection of relationships opens as the
 * relationships and the entities they connect.
 */
export function relatedTo(store: EntityStore, ids: EntityId[]): { entities: EntityId[]; relationships: EntityId[] } {
  const seed = new Set(ids)
  const entities = new Set<EntityId>()
  const relationships = new Set<EntityId>()
  for (const id of seed) {
    const e = store.get(id)
    if (e && isRelationship(e)) {
      relationships.add(e.id)
      for (const end of [e.source.id, e.target.id]) if (!seed.has(end) && store.has(end)) entities.add(end)
      continue
    }
    for (const r of store.relationshipsOf(id)) {
      relationships.add(r.id)
      const other = r.source.id === id ? r.target.id : r.source.id
      if (!seed.has(other) && store.has(other)) entities.add(other)
    }
  }
  return { entities: [...entities], relationships: [...relationships] }
}

/** What a "related to" pick is called, from what was picked. */
export function relatedLabel(store: EntityStore, ids: EntityId[]): string {
  const first = store.get(ids[0])
  if (allLinks(store, ids)) return ids.length === 1 && first && isRelationship(first) ? `${relationshipLabel(store, first)} with its source and target` : `${ids.length} relationships with their sources and targets`
  return ids.length === 1 && first ? `Related to ${displayLabel(first)}` : `Related to ${ids.length} entities`
}

/** The Entities table filtered to what a set of entities is linked to, labelled by what was picked. */
export function relatedHref(store: EntityStore, ids: EntityId[]): string {
  const { entities, relationships } = relatedTo(store, ids)
  return pickHref([...entities, ...relationships], relatedLabel(store, ids), 'all')
}

/** Context-menu item: open the Entities table on everything linked to these entities (a relationship: with its source and target) — as a new tab where there is a pane. */
export function relatedItems(store: EntityStore, ids: EntityId[], open: (to: string, title?: string) => void): MenuItem[] {
  if (!ids.length) return []
  const { entities, relationships } = relatedTo(store, ids)
  const n = entities.length + relationships.length
  const links = allLinks(store, ids)
  const label = links ? `Open with source & target${entities.length ? ` (${entities.length})` : ''}` : `Related entities${n ? ` (${entities.length} · ${relationships.length} links)` : ''}`
  return [{ kind: 'item', label, icon: Waypoints, disabled: n === 0, onSelect: () => open(relatedHref(store, ids), relatedLabel(store, ids)) }]
}

/** A relationship by name — or, unnamed, as "source → target (type)" rather than its id. */
function relationshipLabel(store: EntityStore, r: Relationship): string {
  if (r.label) return r.label
  const end = (id: EntityId) => {
    const e = store.get(id)
    return e ? displayLabel(e) : id
  }
  return `${end(r.source.id)} ${r.directed ? '→' : '—'} ${end(r.target.id)} (${r.type})`
}

const allLinks = (store: EntityStore, ids: EntityId[]) =>
  ids.every((id) => {
    const e = store.get(id)
    return !!e && isRelationship(e)
  })

export type PlotRows = { types?: string[]; tags?: string[]; text?: string; ids?: EntityId[]; label?: string }
const PLOT_HANDOFF = 'aegraph:plot:handoff'

/**
 * A chart over a set of entities, made without writing a spec: the plot
 * page opens on the default chart with its rows narrowed to a type, a tag,
 * a search, or a picked list of ids. The rows ride in the URL for links
 * typed by hand and, because the Scenes page rewrites its URL as soon as
 * it shows the plot, in a one-shot session slot the plot page consumes.
 */
export function plotHref(rows: PlotRows): string {
  const p = new URLSearchParams({ plot: 'new' })
  if (rows.types?.length) p.set('types', rows.types.join(','))
  if (rows.tags?.length) p.set('tags', rows.tags.join(','))
  if (rows.text) p.set('text', rows.text)
  try {
    sessionStorage.setItem(PLOT_HANDOFF, JSON.stringify({ ...rows, at: Date.now() }))
  } catch {
    /* storage unavailable: the URL still carries everything but a picked list */
  }
  return `/analytics/charts?${p}`
}

/** The rows a plot page was opened for: its URL params, else the slot `plotHref` left moments ago (taken once). */
export function takePlotRows(params: URLSearchParams): PlotRows | undefined {
  const types = params.get('types')?.split(',').filter(Boolean)
  const tags = params.get('tags')?.split(',').filter(Boolean)
  const text = params.get('text') ?? undefined
  if (types?.length || tags?.length || text) return { ...(types?.length ? { types } : {}), ...(tags?.length ? { tags } : {}), ...(text ? { text } : {}) }
  try {
    const raw = sessionStorage.getItem(PLOT_HANDOFF)
    if (!raw) return undefined
    sessionStorage.removeItem(PLOT_HANDOFF)
    const slot = JSON.parse(raw) as PlotRows & { at: number }
    if (Date.now() - slot.at > 30_000) return undefined
    const { at: _at, ...rows } = slot
    return rows
  } catch {
    return undefined
  }
}
