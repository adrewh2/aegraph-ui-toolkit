import type { AegraphDocument } from '../../entity/types'
import schema from './aegraph-v1.schema.json'

/**
 * The `.ae.json` file: one `aegraph/v1` document, exactly what the loader reads.
 * `aegraph-v1.schema.json` is the specification other systems build to; this
 * validator is the same rules in code, so a producer can be checked here
 * without a schema library, and the app can say precisely what is off.
 * The loader itself stays lenient (see `normalizeEntity`): anything with an
 * id gets in. Validation is for people writing files, not a gate.
 */

export const AE_EXTENSION = '.ae.json'
export const AE_SCHEMA_VERSION = 'aegraph/v1'
/** Where the schema is served from the app, for `$schema`-style references and for other systems to fetch. */
export const AE_SCHEMA_PATH = '/spec/aegraph-v1.schema.json'
export const AE_SCHEMA = schema

export interface AeIssue {
  /** JSON pointer to the offending value: `/entities/3/meta/createdAt`. */
  path: string
  message: string
}

export interface AeReport {
  ok: boolean
  issues: AeIssue[]
  entities: number
  relationships: number
  /** Ids referenced by relationships or `derivedFrom` that are not in the document. Not an error — they may exist in the workspace. */
  unresolved: string[]
  /** Ids that occur more than once; the last one wins on load. */
  duplicates: string[]
}

const SELECTOR_KEYS: Record<string, { required: string[]; optional: string[] }> = {
  text: { required: ['exact'], optional: ['prefix', 'suffix'] },
  range: { required: ['start', 'end'], optional: [] },
  region: { required: ['x', 'y', 'width', 'height'], optional: [] },
  time: { required: ['start'], optional: ['end', 'region'] },
  geo: { required: ['lat', 'lng'], optional: ['radius', 'at', 'until'] },
  fragment: { required: ['value'], optional: [] },
}
const FIELD_KINDS = new Set(['text', 'longtext', 'number', 'boolean', 'date', 'datetime', 'url', 'image', 'color', 'tags', 'ref', 'json', 'availability'])
// `graph` is the category's old name, still read (and mapped to `project`) from older files.
const CATEGORIES = new Set(['resource', 'knowledge', 'project', 'schema', 'graph'])

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isIso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v))

/** Check a parsed document against the aegraph/v1 rules. Never throws. */
export function validateAe(doc: unknown): AeReport {
  const issues: AeIssue[] = []
  const bad = (path: string, message: string) => issues.push({ path, message })
  const report = (extra: Partial<AeReport> = {}): AeReport => ({ ok: issues.length === 0, issues, entities: 0, relationships: 0, unresolved: [], duplicates: [], ...extra })

  if (!isObj(doc)) {
    bad('', 'the document must be a JSON object')
    return report()
  }
  if (doc.$schema !== AE_SCHEMA_VERSION) bad('/$schema', `must be "${AE_SCHEMA_VERSION}"`)
  if (doc.exportedAt !== undefined && !isIso(doc.exportedAt)) bad('/exportedAt', 'must be an ISO 8601 date-time')
  if (!Array.isArray(doc.entities)) {
    bad('/entities', 'must be an array of entities')
    return report()
  }
  if (doc.tags !== undefined) {
    if (!Array.isArray(doc.tags)) bad('/tags', 'must be an array')
    else
      doc.tags.forEach((t, i) => {
        if (!isObj(t) || typeof t.tag !== 'string' || !t.tag) return bad(`/tags/${i}`, 'must be { tag, color?, description? }')
        for (const k of Object.keys(t)) if (!['tag', 'color', 'description'].includes(k)) bad(`/tags/${i}/${k}`, 'unknown key')
      })
  }
  if (doc.project !== undefined && typeof doc.project !== 'string') bad('/project', 'must be an entity id')
  if (doc.state !== undefined) {
    if (!isObj(doc.state)) bad('/state', 'must be an object')
    else for (const k of Object.keys(doc.state)) if (k !== 'route' && k !== 'ui') bad(`/state/${k}`, 'unknown key')
  }

  const ids = new Map<string, number>()
  const refs: { id: string; path: string }[] = []
  let entities = 0
  let relationships = 0
  doc.entities.forEach((e, i) => {
    const at = `/entities/${i}`
    if (!isObj(e)) return bad(at, 'must be an object')
    if (typeof e.id !== 'string' || !e.id) bad(`${at}/id`, 'required: a non-empty string')
    else ids.set(e.id, (ids.get(e.id) ?? 0) + 1)
    if (typeof e.type !== 'string' || !e.type) bad(`${at}/type`, 'required: a non-empty string (use "entity" when there is no better word)')
    if (e.label !== undefined && typeof e.label !== 'string') bad(`${at}/label`, 'must be a string')
    if (e.description !== undefined && typeof e.description !== 'string') bad(`${at}/description`, 'must be a string')
    if (!Array.isArray(e.tags)) bad(`${at}/tags`, 'required: an array of strings (use [] for none)')
    else {
      e.tags.forEach((t, j) => (typeof t !== 'string' || !t) && bad(`${at}/tags/${j}`, 'must be a non-empty string'))
      if (new Set(e.tags).size !== e.tags.length) bad(`${at}/tags`, 'tags must be unique')
    }
    if (!isObj(e.data)) bad(`${at}/data`, 'required: an object (use {} for none)')
    if (!isObj(e.meta)) bad(`${at}/meta`, 'required: { createdAt, updatedAt, … }')
    else {
      for (const k of ['createdAt', 'updatedAt']) if (!isIso(e.meta[k])) bad(`${at}/meta/${k}`, 'required: an ISO 8601 date-time')
      if (e.meta.accessedAt !== undefined && !isIso(e.meta.accessedAt)) bad(`${at}/meta/accessedAt`, 'must be an ISO 8601 date-time')
      for (const k of ['createdBy', 'source']) if (e.meta[k] !== undefined && typeof e.meta[k] !== 'string') bad(`${at}/meta/${k}`, 'must be a string')
      if (e.meta.derivedFrom !== undefined) checkRef(e.meta.derivedFrom, `${at}/meta/derivedFrom`, bad, refs)
      if (e.meta.projects !== undefined && (!Array.isArray(e.meta.projects) || e.meta.projects.some((p) => typeof p !== 'string'))) bad(`${at}/meta/projects`, 'must be an array of project ids')
    }
    const isRel = e.kind === 'relationship' || e.source !== undefined || e.target !== undefined
    if (isRel) {
      relationships++
      if (e.kind !== 'relationship') bad(`${at}/kind`, 'must be "relationship" when source/target are present')
      checkRef(e.source, `${at}/source`, bad, refs)
      checkRef(e.target, `${at}/target`, bad, refs)
      if (e.directed !== undefined && typeof e.directed !== 'boolean') bad(`${at}/directed`, 'must be a boolean')
    } else {
      entities++
      if (e.kind !== undefined && e.kind !== 'entity') bad(`${at}/kind`, 'must be "entity" (or omitted)')
      if (e.type === 'schema:type') checkSchemaType(e, at, bad)
    }
  })

  const unresolved = [...new Set(refs.filter((r) => !ids.has(r.id)).map((r) => r.id))]
  const duplicates = [...ids].filter(([, n]) => n > 1).map(([id]) => id)
  return report({ entities, relationships, unresolved, duplicates })
}

function checkRef(v: unknown, at: string, bad: (p: string, m: string) => void, refs: { id: string; path: string }[]) {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return bad(at, 'must be { id, selector? }')
  refs.push({ id: v.id, path: at })
  for (const k of Object.keys(v)) if (k !== 'id' && k !== 'selector') bad(`${at}/${k}`, 'unknown key')
  if (v.selector === undefined) return
  const s = v.selector
  if (!isObj(s) || typeof s.kind !== 'string' || !Object.hasOwn(SELECTOR_KEYS, s.kind)) return bad(`${at}/selector`, `must have kind: ${Object.keys(SELECTOR_KEYS).join(' | ')}`)
  const spec = SELECTOR_KEYS[s.kind]
  for (const k of spec.required) if (s[k] === undefined) bad(`${at}/selector/${k}`, `required for a ${s.kind} selector`)
  for (const k of Object.keys(s)) if (k !== 'kind' && !spec.required.includes(k) && !spec.optional.includes(k)) bad(`${at}/selector/${k}`, `not a key of a ${s.kind} selector`)
  const num = (k: string) => s[k] !== undefined && typeof s[k] !== 'number' && bad(`${at}/selector/${k}`, 'must be a number')
  if (s.kind === 'text') for (const k of ['exact', 'prefix', 'suffix']) if (s[k] !== undefined && typeof s[k] !== 'string') bad(`${at}/selector/${k}`, 'must be a string')
  if (s.kind === 'range') for (const k of ['start', 'end']) num(k)
  if (s.kind === 'region') for (const k of ['x', 'y', 'width', 'height']) num(k)
  if (s.kind === 'time') {
    for (const k of ['start', 'end']) num(k)
    if (s.region !== undefined && (!isObj(s.region) || ['x', 'y', 'width', 'height'].some((k) => typeof s.region![k as never] !== 'number'))) bad(`${at}/selector/region`, 'must be { x, y, width, height } in 0–1 fractions')
  }
  if (s.kind === 'geo') {
    for (const k of ['lat', 'lng', 'radius']) num(k)
    if (typeof s.lat === 'number' && Math.abs(s.lat) > 90) bad(`${at}/selector/lat`, 'must be within -90..90')
    if (typeof s.lng === 'number' && Math.abs(s.lng) > 180) bad(`${at}/selector/lng`, 'must be within -180..180')
    for (const k of ['at', 'until']) if (s[k] !== undefined && !isIso(s[k])) bad(`${at}/selector/${k}`, 'must be an ISO 8601 date-time')
  }
  if (s.kind === 'fragment' && typeof s.value !== 'string') bad(`${at}/selector/value`, 'must be a string')
}

function checkSchemaType(e: Record<string, unknown>, at: string, bad: (p: string, m: string) => void) {
  if (typeof e.id === 'string' && !e.id.startsWith('type:')) bad(`${at}/id`, 'a type definition has id "type:<name>"')
  const d = isObj(e.data) ? e.data : {}
  if (typeof d.name !== 'string' || !d.name) bad(`${at}/data/name`, 'required: the type name')
  // An id without the prefix was reported above; only a prefixed id that names another type is a second fault.
  else if (typeof e.id === 'string' && e.id.startsWith('type:') && e.id !== `type:${d.name}`) bad(`${at}/id`, `must be "type:${d.name}"`)
  if (d.category !== undefined && !CATEGORIES.has(d.category as string)) bad(`${at}/data/category`, `must be one of ${[...CATEGORIES].join(', ')}`)
  for (const k of ['parent', 'color', 'pluralLabel']) if (d[k] !== undefined && typeof d[k] !== 'string') bad(`${at}/data/${k}`, 'must be a string')
  // A definition can say the name is relationship vocabulary; there is no other kind to be.
  if (d.kind !== undefined && d.kind !== 'relationship') bad(`${at}/data/kind`, 'must be "relationship" when given')
  if (d.properties !== undefined) {
    if (!Array.isArray(d.properties)) return bad(`${at}/data/properties`, 'must be an array of { key, label?, kind?, description?, options?, required? }')
    d.properties.forEach((p, i) => {
      const pp = `${at}/data/properties/${i}`
      if (!isObj(p) || typeof p.key !== 'string' || !p.key) return bad(pp, 'must be { key, … }')
      for (const k of Object.keys(p)) if (!['key', 'label', 'kind', 'description', 'options', 'required'].includes(k)) bad(`${pp}/${k}`, 'unknown key')
      if (p.kind !== undefined && !FIELD_KINDS.has(p.kind as string)) bad(`${pp}/kind`, `must be one of ${[...FIELD_KINDS].join(', ')}`)
      if (p.options !== undefined && (!Array.isArray(p.options) || p.options.some((o) => typeof o !== 'string'))) bad(`${pp}/options`, 'must be an array of strings')
      if (p.required !== undefined && typeof p.required !== 'boolean') bad(`${pp}/required`, 'must be a boolean')
    })
  }
}

/** Is this parsed JSON an aegraph document at all (before validating it)? */
export const isAeDocument = (v: unknown): v is AegraphDocument => isObj(v) && v.$schema === AE_SCHEMA_VERSION && Array.isArray(v.entities)

/** A minimal, valid document to start from. */
export function emptyAe(): AegraphDocument {
  return { $schema: AE_SCHEMA_VERSION, exportedAt: new Date().toISOString(), entities: [] }
}
