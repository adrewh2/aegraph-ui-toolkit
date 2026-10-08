import { isCssColor } from '../../lib/cssColor'
import { SCHEMA_TYPE, schemaTypeId, type TypeCategory } from './categories'
import { coerceToKind, getEntityType, propertyKey, type FieldKind, type PropertyDef } from './schema'
import type { EntityStore } from './store'
import { schemaTypeEntity, type SchemaTypeData, type TypeRegistry } from './typeRegistry'
import type { AnyEntity, Entity } from './types'

/**
 * An entity type as something to edit: the draft a form holds, what it would do to the data, and saving it.
 *
 * A type is a `schema:type` entity; its properties are `data` keys its entities carry. Editing one is more than
 * writing the definition: renaming a property moves the value on every entity of the type (and its subtypes), and
 * giving it a kind converts the values that can be converted — the same conversion the inspector makes for one
 * entity. `planTypeDraft` says how many values each change touches before anything is written, so the form can say
 * so; `applyTypeDraft` does it all in one store transaction. The New type dialog, the type's Edit view and the
 * `define_entity_type` tool all go through here.
 */

export interface PropertyDraft extends PropertyDef {
  /** The key it had when the editor opened: a different `key` now is a rename, and the values move with it. */
  was?: string
}

export interface TypeDraft {
  /** The type's name — what entities carry in `type`. Fixed once the type exists. */
  name: string
  label: string
  pluralLabel: string
  category: TypeCategory
  parent?: string
  color?: string
  description?: string
  /** The properties the type defines itself (not its parent's, not the built-in code's). */
  properties: PropertyDraft[]
}

/** A property the type has without defining it: from its parent chain, or from the app's own code. Read-only in the editor. */
export interface InheritedProperty {
  key: string
  label: string
  kind: FieldKind
  /** The type it comes from — the parent, a grandparent, or the type itself for a built-in field. */
  from: string
  builtIn: boolean
}

/** A new type's name from what someone typed: "Research paper" → "research-paper". */
export const typeSlug = (name: string) => name.trim().toLowerCase().replace(/\s+/g, '-')

/** The draft for an existing type, or an empty one for a new type. */
export function typeDraft(store: EntityStore, registry: TypeRegistry, type?: string): TypeDraft {
  if (!type) return { name: '', label: '', pluralLabel: '', category: 'knowledge', properties: [] }
  const t = registry.get(type)
  const def = store.get(schemaTypeId(type)) as Entity<SchemaTypeData> | undefined
  return {
    name: type,
    label: t.label,
    pluralLabel: t.pluralLabel,
    category: t.category,
    ...(t.parent ? { parent: t.parent } : {}),
    ...(isCssColor(def?.data.color) ? { color: def.data.color.trim() } : {}),
    ...(t.description ? { description: t.description } : {}),
    properties: registry.propertiesOf(type).map((p) => ({ ...p, was: p.key })),
  }
}

/** What a type carries without defining it: its built-in fields, then each ancestor's properties, nearest first. */
export function inheritedProperties(registry: TypeRegistry, type: string | undefined, parent: string | undefined): InheritedProperty[] {
  const out: InheritedProperty[] = []
  const seen = new Set<string>()
  const add = (key: string, label: string, kind: FieldKind, from: string, builtIn: boolean) => {
    if (seen.has(key)) return
    seen.add(key)
    out.push({ key, label, kind, from, builtIn })
  }
  // The type's own built-in fields (a `data.` key the app's code gives it).
  const code = type ? getEntityType(type) : undefined
  for (const f of code?.fields ?? []) if (f.key.startsWith('data.')) add(f.key.slice(5), f.label, f.kind, type!, true)
  const chain = parent ? registry.ancestry(parent) : []
  for (const t of chain) {
    for (const p of registry.propertiesOf(t)) add(p.key, p.label ?? p.key, p.kind ?? 'text', t, false)
    for (const f of getEntityType(t)?.fields ?? []) if (f.key.startsWith('data.')) add(f.key.slice(5), f.label, f.kind, t, true)
  }
  return out
}

export interface DraftIssue {
  /** Where it is: `name`, `label`, `parent`, `color`, or `property:<index>`. */
  at: string
  message: string
}

/** What is wrong with a draft, for the form to show beside each field; empty means it can be saved. */
export function checkTypeDraft(draft: TypeDraft, registry: TypeRegistry, opts: { isNew: boolean; store?: EntityStore }): DraftIssue[] {
  const issues: DraftIssue[] = []
  const name = draft.name.trim()
  if (!name) issues.push({ at: 'name', message: 'A type needs a name.' })
  else if (/[\s]/.test(name)) issues.push({ at: 'name', message: 'A name has no spaces: use - between words.' })
  else if (opts.isNew) {
    const t = registry.get(name)
    const defined = opts.store?.get(schemaTypeId(name)) || t.origin === 'code' || t.origin === 'code+schema'
    if (defined) issues.push({ at: 'name', message: `There is already a type called ${name}.` })
  }
  if (!draft.label.trim()) issues.push({ at: 'label', message: 'A type needs a label.' })
  // A colour is a colour: it is written into styles wherever the type is drawn, so `url(…)` or `red;background:…` is not one.
  if (draft.color && !isCssColor(draft.color)) issues.push({ at: 'color', message: `${JSON.stringify(String(draft.color).slice(0, 40))} is not a colour: a hex (#4f46e5), rgb(), hsl() or a colour name.` })
  if (draft.parent) {
    if (draft.parent === name) issues.push({ at: 'parent', message: 'A type cannot specialise itself.' })
    else if (name && registry.ancestry(draft.parent).includes(name)) issues.push({ at: 'parent', message: `${registry.get(draft.parent).label} already specialises this type: that would be a loop.` })
  }
  const keys = new Map<string, number>()
  draft.properties.forEach((p, i) => {
    const key = propertyKey(p.key)
    if (!key) {
      issues.push({ at: `property:${i}`, message: 'A property needs a name.' })
      return
    }
    if (keys.has(key)) issues.push({ at: `property:${i}`, message: `${key} is listed twice.` })
    keys.set(key, i)
    if (p.options && p.options.length && new Set(p.options).size !== p.options.length) issues.push({ at: `property:${i}`, message: 'The allowed values repeat.' })
  })
  return issues
}

export interface TypeChangePlan {
  /** Entities of the type and its subtypes: what a rename or a conversion walks. */
  entities: number
  renamed: { from: string; to: string; values: number }[]
  /** A kind given or changed: how many values convert, and how many cannot (they are kept as they are). */
  converted: { key: string; kind: FieldKind; values: number; kept: number }[]
  /** Dropped from the definition: entities keep their values, which read as undeclared properties. */
  removed: { key: string; values: number }[]
}

const hasValue = (e: AnyEntity, key: string) => e.data[key] !== undefined && e.data[key] !== null && e.data[key] !== ''
/** A value that converts to `kind` without loss: coerced, and not a string standing in for what the kind wanted. */
const converts = (v: unknown, kind: FieldKind) => {
  const c = coerceToKind(v, kind)
  if (c === undefined) return false
  if (kind === 'number') return typeof c === 'number' && Number.isFinite(c)
  // Any word reads as false to `coerceToKind`; in bulk, only what plainly says yes or no converts.
  if (kind === 'boolean') return typeof v === 'boolean' || /^(true|false|yes|no|1|0|on|off)$/i.test(String(v).trim())
  return true
}

function affected(store: EntityStore, registry: TypeRegistry, type: string): AnyEntity[] {
  const types = new Set(registry.withSubtypes(type))
  const out: AnyEntity[] = []
  for (const t of types) for (const e of store.library.ofType(t)) if (e.kind === 'entity') out.push(e)
  return out
}

/** What saving the draft would do to the entities that have the type, before anything is written. */
export function planTypeDraft(store: EntityStore, registry: TypeRegistry, draft: TypeDraft): TypeChangePlan {
  const before = new Map(registry.propertiesOf(draft.name).map((p) => [p.key, p]))
  const ents = before.size || draft.properties.some((p) => p.kind) ? affected(store, registry, draft.name) : []
  const count = (key: string) => ents.reduce((n, e) => n + (hasValue(e, key) ? 1 : 0), 0)
  const plan: TypeChangePlan = { entities: ents.length, renamed: [], converted: [], removed: [] }
  const kept = new Set<string>()
  for (const p of draft.properties) {
    const key = propertyKey(p.key)
    const was = p.was && before.has(p.was) ? p.was : undefined
    if (was) kept.add(was)
    if (was && was !== key) plan.renamed.push({ from: was, to: key, values: count(was) })
    const oldKind = was ? before.get(was)?.kind : undefined
    if (p.kind && p.kind !== (oldKind ?? undefined)) {
      const source = was ?? key
      let values = 0
      let lossy = 0
      for (const e of ents)
        if (hasValue(e, source)) {
          values++
          if (!converts(e.data[source], p.kind)) lossy++
        }
      if (values) plan.converted.push({ key, kind: p.kind, values: values - lossy, kept: lossy })
    }
  }
  for (const key of before.keys()) if (!kept.has(key)) plan.removed.push({ key, values: count(key) })
  return plan
}

/**
 * Save a draft: the type's definition, and in the same transaction the values a rename moves and a kind converts.
 * A value that cannot convert is left as it is (the plan counted it). Returns the definition entity and the plan.
 */
export function applyTypeDraft(store: EntityStore, registry: TypeRegistry, draft: TypeDraft): { entity: Entity<SchemaTypeData>; plan: TypeChangePlan } {
  const name = draft.name.trim()
  const plan = planTypeDraft(store, registry, { ...draft, name })
  const properties: PropertyDef[] = draft.properties.map(({ was: _was, ...p }) => {
    const out: PropertyDef = { key: propertyKey(p.key) }
    if (p.label?.trim()) out.label = p.label.trim()
    if (p.kind) out.kind = p.kind
    if (p.description?.trim()) out.description = p.description.trim()
    if (p.options?.length) out.options = p.options.map((o) => o.trim()).filter(Boolean)
    if (p.required) out.required = true
    return out
  })
  const existing = store.get(schemaTypeId(name))
  const entity = schemaTypeEntity(
    name,
    {
      label: draft.label.trim(),
      description: draft.description?.trim() || undefined,
      category: draft.category,
      parent: draft.parent || undefined,
      color: isCssColor(draft.color) ? draft.color.trim() : undefined,
      pluralLabel: draft.pluralLabel.trim() || draft.label.trim(),
      properties,
    },
    existing?.type === SCHEMA_TYPE ? existing : undefined,
  )
  // A cleared parent, colour or description is taken off the definition, not left as it was.
  if (!draft.parent) delete (entity.data as Partial<SchemaTypeData>).parent
  if (!isCssColor(draft.color)) delete (entity.data as Partial<SchemaTypeData>).color
  if (!draft.description?.trim()) delete (entity as { description?: string }).description
  const moves = new Map(plan.renamed.map((r) => [r.from, r.to]))
  const kinds = new Map(plan.converted.map((c) => [c.key, c.kind]))
  store.transaction(() => {
    store.upsert(entity)
    if (!moves.size && !kinds.size) return
    const changed: AnyEntity[] = []
    for (const e of affected(store, registry, name)) {
      let data: Record<string, unknown> | undefined
      for (const [from, to] of moves)
        if (from in e.data) {
          data ??= { ...e.data }
          data[to] = data[from]
          delete data[from]
        }
      for (const [key, kind] of kinds) {
        const v = (data ?? e.data)[key]
        if (v === undefined || v === null || v === '' || !converts(v, kind)) continue
        const c = coerceToKind(v, kind)
        if (c === v) continue
        data ??= { ...e.data }
        data[key] = c
      }
      if (data) changed.push({ ...e, data, meta: { ...e.meta, updatedAt: new Date().toISOString() } } as AnyEntity)
    }
    if (changed.length) store.upsertMany(changed)
  })
  return { entity, plan }
}
