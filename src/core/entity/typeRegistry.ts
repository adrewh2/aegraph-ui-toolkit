import { isCssColor } from '../../lib/cssColor'
import { avalanche, COLOR_BANDS, hashColor, HUE_SLOTS, slotColor } from '../../lib/format'
import { CATEGORY_ORDER, SCHEMA_TYPE, normalizeCategory, schemaTypeId, type TypeCategory } from './categories'
import { createEntity } from './entity'
import { defaultTypeDef, getEntityType, listEntityTypes, mergeFields, propertyToField, type EntityTypeDef, type FieldDef, type PropertyDef } from './schema'
import type { EntityStore } from './store'
import type { AnyEntity, Entity, EntityData } from './types'

/**
 * The effective ontology: static definitions from code merged with
 * `schema:type` entities from the store. Store-side definitions can add
 * types nobody registered (e.g. from an import) and can override the
 * label, plural, category, parent, color, description and kind of
 * registered ones, add properties to their fields, and carry a table
 * layout.
 */

export interface SchemaTypeData extends EntityData {
  name: string
  category?: TypeCategory
  parent?: string
  color?: string
  pluralLabel?: string
  /** `relationship`: the name is relationship vocabulary (a definition alone would otherwise read as an entity type with no instances). */
  kind?: 'relationship'
  /** Properties entities of this type carry (`data` keys), as columns and inspector rows. */
  properties?: PropertyDef[]
  /** How the type's entities are laid out in a table; a subtype inherits its parent's unless it sets its own. */
  table?: TableLayout
}

/**
 * A table layout, stored on a type definition (`data.table`) so it exports
 * with the data and an importer (or the `table_layout` tool) can say how a
 * type reads best: `columns` come first, in this order, and are shown even
 * if the field is hidden by default; `hidden` are hidden by default; `sort`
 * is the order rows come in until someone clicks a header.
 */
export interface TableLayout {
  columns?: string[]
  hidden?: string[]
  sort?: { key: string; dir: 'asc' | 'desc' }
}

export interface ResolvedType extends EntityTypeDef {
  /** How the definition came to be. */
  origin: 'code' | 'schema' | 'code+schema' | 'inferred'
  /** Entities of this type (relationships counted separately). */
  count: number
  relationshipCount: number
  /** The type's own table layout (not the parent's). */
  table?: TableLayout
}

export class TypeRegistry {
  private readonly byType = new Map<string, ResolvedType>()
  private readonly store: EntityStore

  constructor(store: EntityStore) {
    this.store = store
    const { entities: counts, relationships: relCounts } = store.countByTypeAndKind()
    const overrides = new Map<string, Entity<SchemaTypeData>>()
    for (const e of store.ofType(SCHEMA_TYPE)) {
      const d = e.data as SchemaTypeData
      if (typeof d.name === 'string' && d.name) overrides.set(d.name, e as Entity<SchemaTypeData>)
    }
    const names = new Set<string>([...listEntityTypes().map((t) => t.type), ...overrides.keys(), ...counts.keys(), ...relCounts.keys()])
    for (const name of names) {
      // A type is a name. An entity whose `type` is anything else (an object a damaged import left behind) is not a
      // type to resolve: skipped here, so one bad record cannot take every page that reads the ontology down with it.
      if (typeof name !== 'string') continue
      const code = getEntityType(name)
      const over = overrides.get(name)
      const base = code ?? defaultTypeDef(name)
      const d = over?.data
      const entityCount = counts.get(name) ?? 0
      const relationshipCount = relCounts.get(name) ?? 0
      const resolved: ResolvedType = {
        ...base,
        // A name used only by relationships is a relationship type, unless code says otherwise; a definition can say so too.
        kind: base.kind ?? (d?.kind === 'relationship' || (relationshipCount > 0 && entityCount === 0 && !over) ? 'relationship' : undefined),
        label: over?.label ?? base.label,
        pluralLabel: d?.pluralLabel ?? (over?.label && !code ? over.label : base.pluralLabel),
        category: name === SCHEMA_TYPE ? 'schema' : (normalizeCategory(d?.category) ?? base.category),
        parent: d?.parent ?? base.parent,
        // A colour from data is a colour or nothing (`lib/cssColor`): it reaches `style` in the panels, the legend, the dots.
        color: isCssColor(d?.color) ? d.color.trim() : base.color,
        description: over?.description ?? base.description,
        // Properties defined in the data come after the code's fields; same key = the data's definition wins.
        fields: d?.properties?.length ? dedupeFields([...base.fields, ...d.properties.map(propertyToField)]) : base.fields,
        origin: code && over ? 'code+schema' : code ? 'code' : over ? 'schema' : 'inferred',
        count: entityCount,
        relationshipCount,
        table: d?.table && typeof d.table === 'object' ? d.table : undefined,
      }
      this.byType.set(name, resolved)
    }
  }

  /**
   * The colour a type is drawn in: the one it declares, else one of its own from the palette — the same colour on
   * every reload, and never another type's. A hash alone cannot promise the second part (two names can land on one
   * slot), so the types that declare no colour are spread over the grid here: each asks for the slot its name
   * hashes to and takes the next free one if it is taken, in name order, over the registry's whole set — the
   * ontology's, not the view's, so a filter cannot recolour anything. Computed once per registry.
   */
  colorOf(type: string): string {
    const declared = this.get(type).color
    if (declared) return declared
    if (!this.spread) {
      this.spread = new Map()
      const slots = HUE_SLOTS * COLOR_BANDS.length
      const taken = new Set<number>()
      for (const name of [...this.byType.keys()].sort()) {
        if (this.byType.get(name)?.color) continue
        let slot = avalanche(name) % slots
        for (let i = 0; i < slots && taken.has(slot); i++) slot = (slot + 1) % slots
        taken.add(slot)
        this.spread.set(name, slotColor(slot))
      }
    }
    // A name the registry never saw (a relationship read off an edge, a type just typed in) still gets its hash colour.
    return this.spread.get(type) ?? hashColor(type)
  }
  private spread: Map<string, string> | undefined

  /** Base fields, then the type's fields — code-defined and data-defined, and the parent chain's — laid out as the type's table layout says. */
  fieldsFor(type: string | undefined): FieldDef[] {
    if (!type) return mergeFields(undefined)
    const own: FieldDef[] = []
    const seen = new Set<string>()
    let cur: string | undefined = type
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const t: ResolvedType = this.get(cur)
      for (const f of t.fields) if (!own.some((o) => o.key === f.key)) own.push(f)
      cur = t.parent
    }
    return applyLayout(mergeFields(own), this.tableOf(type))
  }

  /** The table layout in force for a type: its own, else the nearest ancestor's. */
  tableOf(type: string | undefined): TableLayout | undefined {
    const seen = new Set<string>()
    let cur = type
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const t = this.get(cur)
      if (t.table) return t.table
      cur = t.parent
    }
    return undefined
  }

  /** The chain from a type up to its root: `['sight', 'location']`. */
  ancestry(type: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    let cur: string | undefined = type
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      out.push(cur)
      cur = this.get(cur).parent
    }
    return out
  }

  /** A type and every registered type below it in the parent chain, the type first: what "all scenes" or "all scripts" means. */
  withSubtypes(type: string): string[] {
    const out = [type]
    for (const t of this.all()) if (t.type !== type && this.ancestry(t.type).includes(type)) out.push(t.type)
    return out
  }

  /** The root of a type's parent chain — the type itself when it has no parent. */
  rootOf(type: string): string {
    const chain = this.ancestry(type)
    return chain[chain.length - 1] ?? type
  }

  /** The data-defined properties of a type (not the code's, not the parent's). */
  propertiesOf(type: string): PropertyDef[] {
    const e = this.store.get(schemaTypeId(type))
    const props = e?.data.properties
    return Array.isArray(props) ? (props as PropertyDef[]) : []
  }

  get(type: string): ResolvedType {
    return this.byType.get(type) ?? { ...defaultTypeDef(typeof type === 'string' ? type : String(type ?? '')), origin: 'inferred', count: 0, relationshipCount: 0 }
  }

  /** Types used by relationships, most common first. */
  relationshipTypes(): ResolvedType[] {
    return [...this.byType.values()]
      .filter((t) => t.type !== '__relationship__' && (t.relationshipCount > 0 || t.kind === 'relationship'))
      .sort((a, b) => b.relationshipCount - a.relationshipCount)
  }

  categoryOf(type: string): TypeCategory {
    return this.get(type).category
  }

  all(): ResolvedType[] {
    return [...this.byType.values()].sort(byLabel)
  }

  /** Entity types in a category (relationship vocabulary left out), by label; `withInstancesOnly` drops the ones with no entities. */
  inCategory(category: TypeCategory, { withInstancesOnly = false } = {}): ResolvedType[] {
    return this.all().filter((t) => t.category === category && t.kind !== 'relationship' && (!withInstancesOnly || t.count > 0))
  }

  /** Types grouped by parent, for facet rails. Roots first, children nested. */
  tree(category: TypeCategory): { type: ResolvedType; children: ResolvedType[] }[] {
    const inCat = this.inCategory(category)
    const known = new Set(inCat.map((t) => t.type))
    const roots = inCat.filter((t) => !t.parent || !known.has(t.parent))
    const byParent = new Map<string, ResolvedType[]>()
    for (const t of inCat) if (t.parent && known.has(t.parent)) byParent.set(t.parent, [...(byParent.get(t.parent) ?? []), t])
    return roots.map((type) => ({ type, children: (byParent.get(type.type) ?? []).sort(byLabel) }))
  }

  countInCategory(category: TypeCategory): number {
    let n = 0
    for (const t of this.byType.values()) if (t.category === category && t.kind !== 'relationship') n += t.count
    return n
  }

  categoriesInUse(): TypeCategory[] {
    return CATEGORY_ORDER.filter((c) => this.countInCategory(c) > 0)
  }
}

/** Build (or update) the `schema:type` entity that describes a type. */
export function schemaTypeEntity(
  name: string,
  patch: { label?: string; description?: string } & Partial<Omit<SchemaTypeData, 'name'>>,
  existing?: AnyEntity,
): Entity<SchemaTypeData> {
  const prev = existing?.type === SCHEMA_TYPE ? (existing as Entity<SchemaTypeData>) : undefined
  const { label, description, ...data } = patch
  return {
    ...(prev ?? createEntity<SchemaTypeData>({ id: schemaTypeId(name), type: SCHEMA_TYPE, data: { name }, meta: { source: 'user' } })),
    label: label ?? prev?.label ?? name,
    description: description ?? prev?.description,
    data: { ...(prev?.data ?? { name }), ...stripUndefined(data), name },
    meta: { ...(prev?.meta ?? { createdAt: now(), updatedAt: now() }), updatedAt: now() },
  }
}

/** Fields in a layout's order: the named columns first (shown), the rest as they were; `hidden` hides by default. */
export function applyLayout(fields: FieldDef[], layout: TableLayout | undefined): FieldDef[] {
  if (!layout || (!layout.columns?.length && !layout.hidden?.length)) return fields
  const hidden = new Set(layout.hidden ?? [])
  const first = layout.columns ?? []
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const out: FieldDef[] = []
  for (const k of first) {
    const f = byKey.get(k)
    if (!f) continue
    out.push(hidden.has(k) ? { ...f, hidden: true } : f.hidden ? { ...f, hidden: false } : f)
    byKey.delete(k)
  }
  for (const f of fields) if (byKey.has(f.key)) out.push(hidden.has(f.key) && !f.hidden ? { ...f, hidden: true } : f)
  // The first field is a row's identity (the label): it stays first and shown whatever the layout says.
  const id = fields[0]?.key
  const at = out.findIndex((f) => f.key === id)
  if (at > 0) out.unshift(...out.splice(at, 1))
  return out.map((f, i) => (i === 0 && f.hidden ? { ...f, hidden: false } : f))
}

function dedupeFields(fields: FieldDef[]): FieldDef[] {
  const out = new Map<string, FieldDef>()
  for (const f of fields) out.set(f.key, f)
  return [...out.values()]
}

/**
 * Add (or update) a property on a type's definition, so every entity of
 * the type shows it as a column and an inspector row. Returns the entity to
 * upsert.
 */
export function withProperty(store: EntityStore, type: string, prop: PropertyDef): Entity<SchemaTypeData> {
  const existing = store.get(schemaTypeId(type))
  const prev = existing?.type === SCHEMA_TYPE ? ((existing.data.properties as PropertyDef[] | undefined) ?? []) : []
  const properties = prev.some((p) => p.key === prop.key) ? prev.map((p) => (p.key === prop.key ? { ...p, ...prop } : p)) : [...prev, prop]
  const patch: Parameters<typeof schemaTypeEntity>[1] = { properties }
  if (!existing) {
    const t = new TypeRegistry(store).get(type)
    patch.label = t.label
    patch.category = t.category
  }
  return schemaTypeEntity(type, patch, existing)
}

/** Remove a property from a type's definition (entities keep their values). */
export function withoutProperty(store: EntityStore, type: string, key: string): Entity<SchemaTypeData> | undefined {
  const existing = store.get(schemaTypeId(type))
  if (existing?.type !== SCHEMA_TYPE) return undefined
  const prev = (existing.data.properties as PropertyDef[] | undefined) ?? []
  return schemaTypeEntity(type, { properties: prev.filter((p) => p.key !== key) }, existing)
}

const now = () => new Date().toISOString()
const byLabel = (a: ResolvedType, b: ResolvedType) => a.label.localeCompare(b.label)
function stripUndefined<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out as T
}
