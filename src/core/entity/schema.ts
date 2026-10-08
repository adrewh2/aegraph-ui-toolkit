import type { ComponentType } from 'react'
import type { TypeCategory } from './categories'
import type { AnyEntity } from './types'

/**
 * Optional structure, layered on top of the permissive entity model.
 *
 * A type definition says what an entity of that type usually carries and how
 * the UI should present it. Entities never *need* a definition — unknown
 * types still work everywhere — but a definition unlocks typed columns,
 * validation, icons, and type-specific actions.
 */

export type FieldKind =
  | 'text'
  | 'longtext'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'url'
  | 'image'
  | 'color'
  | 'tags'
  | 'ref'
  /** The type of the entity a reference points to; the key is the reference's key plus `.type` (`source.type`). Tables only. */
  | 'ref-type'
  | 'json'
  | 'availability'

export interface FieldDef {
  /** Property key. Top-level entity fields (`label`, `tags`, …) or a `data.*` path. */
  key: string
  label: string
  kind: FieldKind
  editable?: boolean
  required?: boolean
  /** Hidden from the default column set, still visible in the inspector. */
  hidden?: boolean
  width?: number
  /** Fixed set of allowed values; editors show a picker instead of free text. */
  options?: { value: string; label: string }[]
  /** What the property means — shown in the ontology and told to the assistant and MCP clients. */
  description?: string
  /** Custom formatting for table cells. */
  format?: (value: unknown, entity: AnyEntity) => string
  /** For the `type` column: a colour dot and plain text instead of a badge, so it lines up with label columns. */
  plain?: boolean
  /** For a `ref` column: the referenced entity's type after its label, in grey, with the type's colour. */
  withType?: boolean
}

export interface EntityAction {
  id: string
  label: string
  icon?: ComponentType<{ size?: number }>
  /** Applies to one entity (row action / context menu). */
  run: (entity: AnyEntity) => void
  /** If provided, action is hidden when false. */
  when?: (entity: AnyEntity) => boolean
}

export interface ValidationIssue {
  entityId: string
  field?: string
  message: string
  severity: 'error' | 'warning'
}

export interface EntityTypeDef {
  type: string
  label: string
  pluralLabel: string
  /** How this type's data is used. Defaults to 'knowledge' for anything not otherwise declared. */
  category: TypeCategory
  /** Broader type this one specialises (e.g. architect → person). A subtype inherits its parent's fields and table layout through `TypeRegistry.fieldsFor` / `tableOf`; the code's `fields` here are its own. */
  parent?: string
  icon?: ComponentType<{ size?: number }>
  color?: string
  description?: string
  kind?: AnyEntity['kind']
  fields: FieldDef[]
  /** Primary action on open / double-click. */
  open?: (entity: AnyEntity) => void
  actions?: EntityAction[]
  validate?: (entity: AnyEntity) => ValidationIssue[]
}

/** Columns every entity has regardless of type. */
export const BASE_FIELDS: FieldDef[] = [
  { key: 'label', label: 'Label', kind: 'text', editable: true, width: 260 },
  { key: 'type', label: 'Type', kind: 'text', width: 120 },
  { key: 'tags', label: 'Tags', kind: 'tags', editable: true, width: 220 },
  { key: 'description', label: 'Description', kind: 'longtext', editable: true, hidden: true },
  { key: 'meta.createdAt', label: 'Created', kind: 'date', width: 150 },
  { key: 'meta.updatedAt', label: 'Updated', kind: 'date', width: 150 },
  { key: 'meta.accessedAt', label: 'Last opened', kind: 'date', width: 150, hidden: true },
  { key: 'meta.source', label: 'Source', kind: 'text', width: 120, hidden: true },
  { key: 'id', label: 'ID', kind: 'text', width: 220, hidden: true },
]

const registry = new Map<string, EntityTypeDef>()
const registryListeners = new Set<() => void>()

/** Register a type in code. `category` defaults to 'knowledge'. */
export function defineEntityType(def: Omit<EntityTypeDef, 'category'> & { category?: TypeCategory }): EntityTypeDef {
  const full: EntityTypeDef = { category: 'knowledge', ...def }
  registry.set(full.type, full)
  registryListeners.forEach((l) => l())
  return full
}

/** "major work" → "Major work", "schema:type" → "Schema type". */
export function humanizeType(type: string): string {
  const s = type.replace(/[:_-]+/g, ' ').trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : type
}

/** A definition for a type nobody registered: a knowledge type with only base fields. */
export function defaultTypeDef(type: string): EntityTypeDef {
  const label = humanizeType(type)
  return { type, label, pluralLabel: label, category: 'knowledge', fields: [] }
}

export const getEntityType = (type: string) => registry.get(type)
export const listEntityTypes = () => [...registry.values()]
export const subscribeEntityTypes = (l: () => void) => {
  registryListeners.add(l)
  return () => registryListeners.delete(l)
}

/** Base fields, then type-specific fields, de-duplicated by key. Code-defined types only; `TypeRegistry.fieldsFor` adds the fields defined in the data. */
export function fieldsFor(type: string | undefined): FieldDef[] {
  return mergeFields(type ? registry.get(type)?.fields : undefined)
}

/** Base ordering, with the type's own fields after label/type/tags. */
export function mergeFields(typeFields: FieldDef[] | undefined): FieldDef[] {
  const merged = new Map<string, FieldDef>()
  for (const f of BASE_FIELDS) merged.set(f.key, f)
  for (const f of typeFields ?? []) merged.set(f.key, f)
  const base = BASE_FIELDS.map((f) => merged.get(f.key)!)
  const extra = (typeFields ?? []).filter((f) => !BASE_FIELDS.some((b) => b.key === f.key))
  return [...base.slice(0, 3), ...extra, ...base.slice(3)]
}

/**
 * A property as a type definition stores it: the `data` key, an optional
 * label and kind. Turned into a `FieldDef` (`data.<key>`) by the registry.
 */
export interface PropertyDef {
  key: string
  label?: string
  kind?: FieldKind
  description?: string
  /** Fixed set of allowed values. */
  options?: string[]
  /** Must be given when an entity of the type is created by hand. */
  required?: boolean
}

export function propertyToField(p: PropertyDef): FieldDef {
  return {
    key: `data.${p.key}`,
    label: p.label ?? humanizeType(p.key),
    kind: p.kind ?? 'text',
    editable: p.kind !== 'json',
    ...(p.required ? { required: true } : {}),
    ...(p.options?.length ? { options: p.options.map((v) => ({ value: v, label: v })) } : {}),
    ...(p.description ? { description: p.description } : {}),
  }
}

/** The kinds a property can be given by hand, with the label the pickers show. */
export const PROPERTY_KINDS: { kind: FieldKind; label: string; hint: string }[] = [
  { kind: 'text', label: 'Text', hint: 'A line of text' },
  { kind: 'longtext', label: 'Long text', hint: 'Paragraphs' },
  { kind: 'number', label: 'Number', hint: '42, 3.14' },
  { kind: 'boolean', label: 'True / false', hint: 'true or false' },
  { kind: 'date', label: 'Date', hint: '2026-09-12' },
  { kind: 'datetime', label: 'Date & time', hint: '2026-09-12 14:30' },
  { kind: 'url', label: 'URL', hint: 'https://…' },
  { kind: 'color', label: 'Colour', hint: '#4f6bed' },
  { kind: 'json', label: 'JSON', hint: 'Lists and objects' },
]

/** The field kind a value suggests, for a property defined from an example. */
export function kindOfValue(v: unknown): FieldKind {
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'string') {
    if (/^https?:\/\//.test(v)) return 'url'
    if (/^#[0-9a-f]{6}$/i.test(v)) return 'color'
    if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))) return 'date'
    if (/^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) return 'datetime'
    return v.length > 120 || v.includes('\n') ? 'longtext' : 'text'
  }
  return 'json'
}

/**
 * A value made to fit a kind: numbers parsed, booleans read, dates kept as
 * `YYYY-MM-DD`, date-times as ISO strings, JSON parsed when it arrives as
 * text. Returns undefined when the value can't be read as the kind.
 */
export function coerceToKind(v: unknown, kind: FieldKind | undefined): unknown {
  if (v === undefined || v === null || v === '') return undefined
  switch (kind) {
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).trim())
      return Number.isFinite(n) ? n : undefined
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : /^(true|yes|1|on)$/i.test(String(v).trim())
    case 'date': {
      const d = v instanceof Date ? v : new Date(String(v))
      if (Number.isNaN(d.getTime())) return undefined
      // Already a plain date: keep it as written (no timezone shift).
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : d.toISOString().slice(0, 10)
    }
    case 'datetime': {
      const d = v instanceof Date ? v : new Date(String(v))
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
    }
    case 'json':
      if (typeof v !== 'string') return v
      try {
        return JSON.parse(v)
      } catch {
        return undefined
      }
    case undefined:
      return typeof v === 'string' ? parsePropertyValue(v) : v
    default:
      return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
}

/**
 * What a typed value means: `true`/`false`, numbers, JSON arrays/objects
 * are taken as such; everything else is the string. Used wherever a
 * property value is typed by hand or arrives as text.
 */
export function parsePropertyValue(text: string, kind?: FieldKind): unknown {
  const t = text.trim()
  if (kind === 'text' || kind === 'longtext' || kind === 'url' || kind === 'color' || kind === 'date' || kind === 'datetime') return text
  if (kind === 'number') return t === '' ? undefined : Number(t)
  if (kind === 'boolean') return t === 'true' || t === 'yes' || t === '1'
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null') return null
  if (t !== '' && /^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (/^[[{]/.test(t)) {
    try {
      return JSON.parse(t)
    } catch {
      /* not JSON after all */
    }
  }
  return text
}

/** A data key from what someone typed: trimmed, spaces to underscores, no dots. */
export function propertyKey(name: string): string {
  return name.trim().replace(/\s+/g, '_').replace(/\./g, '_')
}

/** Read a dotted key off an entity (`label`, `data.url`, `meta.createdAt`). */
export function getField(entity: AnyEntity, key: string): unknown {
  let parts = fieldParts.get(key)
  if (parts === undefined) fieldParts.set(key, (parts = key.split('.')))
  // The split is remembered per key (there are a few dozen keys, asked about a city's worth of times): a two-part
  // key — `data.dbh`, by far the common shape — is two property reads.
  if (parts.length === 1) return (entity as unknown as Record<string, unknown>)[key]
  const head = (entity as unknown as Record<string, unknown>)[parts[0]]
  if (!head || typeof head !== 'object') return undefined
  if (parts.length === 2) return (head as Record<string, unknown>)[parts[1]]
  let acc: unknown = head
  for (let i = 1; i < parts.length; i++) {
    if (!acc || typeof acc !== 'object') return undefined
    acc = (acc as Record<string, unknown>)[parts[i]]
  }
  return acc
}
const fieldParts = new Map<string, string[]>()

/**
 * Segments that name an object's machinery rather than a field of its own. A key is data — it comes from a table
 * column, a tool call, an import — and walking one of these would write through an object's prototype instead of
 * into it. Nothing in the app needs a field called any of them.
 */
const RESERVED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

/** Returns a shallow patch object for `store.update` that sets a dotted key. */
export function fieldPatch(entity: AnyEntity, key: string, value: unknown): Partial<AnyEntity> {
  if (RESERVED_SEGMENTS.has(key)) throw new Error(`${key} is not a field that can be set.`)
  if (!key.includes('.')) return { [key]: value } as Partial<AnyEntity>
  const [head, ...rest] = key.split('.')
  if (head !== 'data') throw new Error(`Only top-level and data.* fields are editable (got ${key})`)
  const reserved = rest.find((r) => RESERVED_SEGMENTS.has(r))
  if (reserved) throw new Error(`${key} cannot be set: ${reserved} names an object's machinery, not a field.`)
  const data = { ...entity.data }
  let cursor: Record<string, unknown> = data
  for (let i = 0; i < rest.length - 1; i++) {
    const next = cursor[rest[i]]
    cursor[rest[i]] = next && typeof next === 'object' ? { ...(next as object) } : {}
    cursor = cursor[rest[i]] as Record<string, unknown>
  }
  cursor[rest[rest.length - 1]] = value
  return { data }
}

export function validateEntity(entity: AnyEntity): ValidationIssue[] {
  const def = registry.get(entity.type)
  const issues: ValidationIssue[] = []
  for (const f of def?.fields ?? []) {
    if (f.required) {
      const v = getField(entity, f.key)
      if (v === undefined || v === null || v === '') {
        issues.push({ entityId: entity.id, field: f.key, message: `${f.label} is required`, severity: 'error' })
      }
    }
  }
  if (def?.validate) issues.push(...def.validate(entity))
  return issues
}

/**
 * Fields a type has in practice: the `data.*` keys its existing entities
 * carry, with a kind guessed from the values. Complements the declared
 * fields so forms can offer everything seen so far, not only what the
 * type definition spelled out.
 */
export function inferFieldsFromEntities(entities: AnyEntity[], limit = 500): FieldDef[] {
  const seen = new Map<string, { kinds: Map<FieldKind, number>; n: number; values: Set<string> }>()
  const n = Math.min(entities.length, limit)
  for (let i = 0; i < n; i++) {
    const d = entities[i].data
    for (const k in d) {
      const v = d[k]
      if (v === null || v === undefined || k === 'diagramNodeId') continue
      const kind: FieldKind = Array.isArray(v) && v.every((x) => typeof x === 'string') ? 'tags' : kindOfValue(v)
      const s = seen.get(k) ?? { kinds: new Map(), n: 0, values: new Set() }
      s.kinds.set(kind, (s.kinds.get(kind) ?? 0) + 1)
      s.n++
      if (kind === 'text' && s.values.size <= 12) s.values.add(String(v))
      seen.set(k, s)
    }
  }
  return [...seen.entries()].map(([key, s]) => {
    const kind = [...s.kinds.entries()].sort((a, b) => b[1] - a[1])[0][0]
    // A short text field that only ever takes a handful of values across many entities reads as a choice.
    const options = kind === 'text' && s.n >= 5 && s.values.size >= 2 && s.values.size <= 8 && s.values.size < s.n / 2 ? [...s.values].sort().map((v) => ({ value: v, label: v })) : undefined
    return { key: `data.${key}`, label: humanizeType(key), kind, editable: kind !== 'json', ...(options ? { options } : {}) }
  })
}

