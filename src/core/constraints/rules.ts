import type { EntityStore } from '../entity/store'
import { isRelationship, type AnyEntity, type EntityId, type Relationship } from '../entity/types'
import { getPath } from '../graph/fields'
import { call, ENTITY_RULE_BUDGET_MS, GRAPH_RULE_BUDGET_MS, prepare } from './realm'

export { loadRuleRealm, ruleRealmReady, RulePending } from './realm'

/**
 * The rule language: JavaScript over one entity, with a small vocabulary
 * bound as plain names so a rule reads like a sentence —
 *
 *     has('data.born') && get('data.born') > 1000
 *     out('wrote').length <= 3 || 'writes too much'
 *     neighbors('cites').every((p) => p.type === 'paper')
 *
 * A rule is an expression (its value decides: true passes; false, or a
 * string — the message — fails) or, when it contains a `return`, a
 * function body. `e` is the entity being written; the helpers below read
 * the store as it stands plus the rest of the same write. The same
 * vocabulary is what the editor completes and documents (`RULE_HELPERS`,
 * `ENTITY_FIELDS`, `STORE_METHODS` below).
 *
 * A rule is data — it travels in bundles and arrives from tool calls — so it
 * never runs in this realm: it is compiled into an in-process QuickJS
 * interpreter (realm.ts) where the vocabulary crosses as copies and nothing
 * of the host is in reach.
 */

export interface RuleScope {
  store: EntityStore
  /** The other entities in the same write, by id. */
  others: Map<EntityId, AnyEntity>
  /** A template's parameters, bound as `params`. */
  params?: Record<string, unknown>
  /** What is left of the write's budget for checks (engine.ts › WRITE_BUDGET_MS): the call gets no more than this. */
  budgetMs?: number
}

export interface RuleHelper {
  name: string
  signature: string
  doc: string
  /** For completion: what the first string argument is (a relationship type, a path, an entity type…). */
  arg?: 'rel' | 'path' | 'type' | 'id' | 'regex'
}

export const RULE_HELPERS: RuleHelper[] = [
  { name: 'e', signature: 'e', doc: 'The entity being written: id, type, label, description, tags, data, meta — and source, target, directed for a relationship.' },
  { name: 'get', signature: "get(path) → value", doc: "A value on e by path: 'label', 'tags', 'data.year', 'meta.source', 'source.id'.", arg: 'path' },
  { name: 'has', signature: "has(path) → boolean", doc: 'Whether the path is set and not empty (null, "" and [] count as empty).', arg: 'path' },
  { name: 'isEmpty', signature: 'isEmpty(value) → boolean', doc: 'undefined, null, "" or [].' },
  { name: 'matches', signature: "matches(path, regex) → boolean", doc: "Whether the string at the path matches the regular expression: matches('label', /^[A-Z]/).", arg: 'path' },
  { name: 'out', signature: "out(rel?) → relationships", doc: 'Relationships leaving e (or, for a relationship, its source), optionally of one type.', arg: 'rel' },
  { name: 'inn', signature: "inn(rel?) → relationships", doc: 'Relationships arriving at e, optionally of one type.', arg: 'rel' },
  { name: 'links', signature: "links(rel?) → relationships", doc: 'Relationships touching e in either direction, optionally of one type.', arg: 'rel' },
  { name: 'neighbors', signature: "neighbors(rel?) → entities", doc: 'The entities at the other end of e’s relationships, optionally through one type. Missing ends are left out.', arg: 'rel' },
  { name: 'source', signature: 'source() → entity | undefined', doc: 'For a relationship: the entity at its source (in the store or in this write).' },
  { name: 'target', signature: 'target() → entity | undefined', doc: 'For a relationship: the entity at its target.' },
  { name: 'entity', signature: 'entity(id) → entity | undefined', doc: 'An entity by id, from the store or this write.', arg: 'id' },
  { name: 'typeOf', signature: "typeOf(id) → string | undefined", doc: 'The type of an entity by id.', arg: 'id' },
  { name: 'ofType', signature: "ofType(type) → entities", doc: 'Every entity of a type in the store.', arg: 'type' },
  { name: 'unique', signature: "unique(path) → boolean", doc: 'Whether no other entity of e’s type carries the same value at the path.', arg: 'path' },
  { name: 'count', signature: 'count(list) → number', doc: 'The length of a list (0 for nothing).' },
  { name: 'others', signature: 'others() → entities', doc: 'The other entities in the same write.' },
  { name: 'previous', signature: 'previous → entity | undefined', doc: 'What e replaces, when the write changes an existing entity.' },
  { name: 'store', signature: 'store', doc: 'The entity store, read-only (copies): get(id), has(id), ofType(type), relationshipsOf(id, dir?), query({ type, text, tags }), all().' },
  { name: 'fail', signature: 'fail(message) → string', doc: 'Fail with a message — the same as returning the string; reads better in a body.' },
  { name: 'params', signature: 'params', doc: 'The parameters the constraint was made with (from its template’s form): params.min, params.path…' },
]

export const RULE_HELPER_NAMES = RULE_HELPERS.map((h) => h.name)

/** The entity's own fields, for completion after `e.`. */
export const ENTITY_FIELDS: { name: string; doc: string; kind?: 'relationship' }[] = [
  { name: 'id', doc: 'The id (string).' },
  { name: 'type', doc: 'The type name.' },
  { name: 'label', doc: 'The label, if any.' },
  { name: 'description', doc: 'The description, if any.' },
  { name: 'tags', doc: 'The tags (string[]).' },
  { name: 'data', doc: 'The properties (data.<key>).' },
  { name: 'meta', doc: 'createdAt, updatedAt, source, createdBy, projects…' },
  { name: 'source', doc: '{ id, selector? } — the source end.', kind: 'relationship' },
  { name: 'target', doc: '{ id, selector? } — the target end.', kind: 'relationship' },
  { name: 'directed', doc: 'Whether the relationship is directed.', kind: 'relationship' },
]

export const META_FIELDS = ['createdAt', 'updatedAt', 'accessedAt', 'createdBy', 'source', 'projects', 'derivedFrom']

export const STORE_METHODS: { name: string; signature: string; doc: string }[] = [
  { name: 'get', signature: 'get(id)', doc: 'An entity by id.' },
  { name: 'has', signature: 'has(id)', doc: 'Whether an entity exists.' },
  { name: 'ofType', signature: 'ofType(type)', doc: 'Every entity of a type.' },
  { name: 'relationshipsOf', signature: "relationshipsOf(id, 'out' | 'in' | 'both')", doc: 'The relationships touching an entity.' },
  { name: 'query', signature: 'query({ type, tags, text, kind })', doc: 'Entities matching a query.' },
  { name: 'all', signature: 'all()', doc: 'Every entity.' },
  { name: 'tags', signature: 'tags()', doc: 'Every tag in use.' },
]

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/** Is the source an expression (evaluate) or a body (run)? A `return` anywhere makes it a body. */
export const isBody = (code: string) => /\breturn\b/.test(code)

export type CompiledRule = (e: AnyEntity, scope: RuleScope, previous?: AnyEntity) => unknown

const ENTITY_ARG_NAMES = RULE_HELPER_NAMES.filter((n) => n !== 'e' && n !== 'previous')

/**
 * Compile a rule into the QuickJS realm (realm.ts) — never this one: a rule is data from a bundle, an import or a tool
 * call. Throws a SyntaxError with the message when it does not parse, and `RulePending` until the realm has loaded.
 */
export function compileRule(code: string): CompiledRule {
  const body = isBody(code) ? code : `return (\n${code}\n)`
  const source = `(function () {
const __f = function (e, scope, previous, ${ENTITY_ARG_NAMES.join(', ')}) {
${body}
}
const cur = { e: undefined }
const H = __entityHelpers(cur)
let lastParams, params, scope
return function (eJson, prevJson, paramsJson) {
  const e = (cur.e = JSON.parse(eJson))
  const previous = prevJson === undefined ? undefined : JSON.parse(prevJson)
  if (paramsJson !== lastParams) {
    lastParams = paramsJson
    params = JSON.parse(paramsJson)
    scope = Object.freeze({ params })
  }
  return __out(__f(e, scope, previous, ${ENTITY_ARG_NAMES.map((n) => (n === 'params' ? 'params' : `H.${n}`)).join(', ')}))
}
})()`
  const key = `entity\u0000${code}`
  prepare(key, source)
  let paramsOf: Record<string, unknown> | undefined
  let paramsJson = '{}'
  return (e, scope, previous) => {
    // The host's helpers are built only if the rule asks the store something.
    let h: Record<string, unknown> | undefined
    const host = (name: string, args: unknown[]) => (name.startsWith('store.') ? storeCall(scope.store, name.slice(6), args) : ((h ??= helpersFor(e, scope))[name] as (...a: unknown[]) => unknown)(...args))
    if (scope.params !== paramsOf) {
      paramsOf = scope.params
      paramsJson = JSON.stringify(scope.params ?? {})
    }
    return call(key, source, [JSON.stringify(e), previous === undefined ? undefined : JSON.stringify(previous), paramsJson], host, Math.min(ENTITY_RULE_BUDGET_MS, scope.budgetMs ?? Infinity))
  }
}

/** The store as a rule reads it: the same few reads, answered with copies. */
function storeCall(store: EntityStore, name: string, args: unknown[]): unknown {
  switch (name) {
    case 'get':
      return store.get(args[0] as EntityId)
    case 'has':
      return store.has(args[0] as EntityId)
    case 'ofType':
      return store.ofType(args[0] as string)
    case 'relationshipsOf':
      return store.relationshipsOf(args[0] as EntityId, (args[1] as 'out' | 'in' | 'both' | undefined) ?? 'both')
    case 'query':
      return store.query((args[0] ?? {}) as Parameters<EntityStore['query']>[0])
    case 'all':
      return store.all()
    default:
      throw new Error(`store.${name} is not available to a check`)
  }
}

/** The vocabulary bound to one entity and one write. */
export function helpersFor(e: AnyEntity, scope: RuleScope): Record<string, unknown> {
  const { store, others } = scope
  const at = (id: EntityId): AnyEntity | undefined => others.get(id) ?? store.get(id)
  const rels = (dir: 'out' | 'in' | 'both', rel?: string): Relationship[] => {
    const id = e.id
    const all = store.relationshipsOf(id, dir)
    // Relationships in the same write count too.
    const extra: Relationship[] = []
    for (const o of others.values()) if (isRelationship(o) && o.id !== e.id && ((dir !== 'in' && o.source.id === id) || (dir !== 'out' && o.target.id === id))) extra.push(o)
    const list = extra.length ? [...all, ...extra] : all
    return rel ? list.filter((r) => r.type === rel) : list
  }
  const otherEnd = (r: Relationship) => (r.source.id === e.id ? r.target.id : r.source.id)
  return {
    get: (path: string) => getPath(e, path),
    has: (path: string) => !isEmpty(getPath(e, path)),
    isEmpty,
    matches: (path: string, re: RegExp | string) => {
      const v = getPath(e, path)
      return typeof v === 'string' && (typeof re === 'string' ? new RegExp(re) : re).test(v)
    },
    out: (rel?: string) => rels('out', rel),
    inn: (rel?: string) => rels('in', rel),
    links: (rel?: string) => rels('both', rel),
    neighbors: (rel?: string) => rels('both', rel).map((r) => at(otherEnd(r))).filter((x): x is AnyEntity => !!x),
    source: () => (isRelationship(e) ? at(e.source.id) : undefined),
    target: () => (isRelationship(e) ? at(e.target.id) : undefined),
    entity: at,
    typeOf: (id: EntityId) => at(id)?.type,
    ofType: (type: string) => store.ofType(type),
    unique: (path: string) => {
      const v = getPath(e, path)
      if (isEmpty(v)) return true
      const key = typeof v === 'string' ? v : JSON.stringify(v)
      const same = (x: AnyEntity) => {
        const w = getPath(x, path)
        return !isEmpty(w) && (typeof w === 'string' ? w : JSON.stringify(w)) === key
      }
      if (store.library.ofType(e.type).some((x) => x.id !== e.id && same(x))) return false
      for (const o of others.values()) if (o.id !== e.id && o.type === e.type && same(o)) return false
      return true
    },
    count: (list: unknown) => (Array.isArray(list) ? list.length : list && typeof list === 'object' && 'size' in (list as object) ? (list as { size: number }).size : list ? 1 : 0),
    others: () => [...others.values()].filter((o) => o.id !== e.id),
    store,
    fail: (message: string) => message || 'failed',
    params: scope.params ?? {},
  }
}

/** A rule's verdict, as a message or nothing. */
export function verdict(value: unknown): string | undefined {
  if (value === false) return 'the check returned false'
  if (typeof value === 'string' && value) return value
  return undefined
}

// ── Graph rules ──────────────────────────────────────────────────────────

/**
 * A graph rule judges the dataset as a whole — the store as it would stand
 * after the write (the write's entities laid over it) — and says which
 * entities are at fault:
 *
 *     ofType('paper').filter((p) => !inn(p.id, 'wrote').length).map((p) => violation(p.id, 'no author'))
 *     cycle('parent') ? 'parent must not cycle' : true
 *     count(ofType('project')) <= params.max
 *
 * The verdict: true (or nothing) passes; false or a string fails the write;
 * a list of violation(id, message) — or of entities — names the culprits.
 */

export interface GraphView {
  /** Every entity and relationship. */
  all(): AnyEntity[]
  entities(): AnyEntity[]
  relationships(): Relationship[]
  ofType(type: string): AnyEntity[]
  entity(id: EntityId): AnyEntity | undefined
  relationshipsOf(id: EntityId, dir?: 'out' | 'in' | 'both'): Relationship[]
  /** Entity type names in use (relationship types under relTypes). */
  types(): string[]
  relTypes(): string[]
}

export interface GraphViolation {
  id?: EntityId
  message: string
}

export const GRAPH_HELPERS: RuleHelper[] = [
  { name: 'all', signature: 'all() → entities and relationships', doc: 'Everything in the dataset, as it would stand after the write.' },
  { name: 'entities', signature: 'entities() → entities', doc: 'Every entity (no relationships).' },
  { name: 'relationships', signature: 'relationships(type?) → relationships', doc: 'Every relationship, optionally of one type.', arg: 'rel' },
  { name: 'ofType', signature: 'ofType(type) → entities', doc: 'Every entity or relationship of a type.', arg: 'type' },
  { name: 'entity', signature: 'entity(id) → entity | undefined', doc: 'An entity by id.', arg: 'id' },
  { name: 'typeOf', signature: 'typeOf(id) → string | undefined', doc: 'The type of an entity by id.', arg: 'id' },
  { name: 'types', signature: 'types() → string[]', doc: 'The entity types in use.' },
  { name: 'relTypes', signature: 'relTypes() → string[]', doc: 'The relationship types in use.' },
  { name: 'out', signature: 'out(id, rel?) → relationships', doc: 'Relationships leaving an entity, optionally of one type.', arg: 'id' },
  { name: 'inn', signature: 'inn(id, rel?) → relationships', doc: 'Relationships arriving at an entity.', arg: 'id' },
  { name: 'links', signature: 'links(id, rel?) → relationships', doc: 'Relationships touching an entity in either direction.', arg: 'id' },
  { name: 'neighbors', signature: 'neighbors(id, rel?) → entities', doc: 'The entities at the other end of an entity’s relationships.', arg: 'id' },
  { name: 'degree', signature: 'degree(id, rel?) → number', doc: 'How many relationships touch an entity.', arg: 'id' },
  { name: 'get', signature: 'get(entity, path) → value', doc: "A value on an entity by path: get(p, 'data.year')." },
  { name: 'has', signature: 'has(entity, path) → boolean', doc: 'Whether the path is set and not empty on the entity.' },
  { name: 'isEmpty', signature: 'isEmpty(value) → boolean', doc: 'undefined, null, "" or [].' },
  { name: 'count', signature: 'count(list) → number', doc: 'The length of a list (0 for nothing).' },
  { name: 'cycle', signature: 'cycle(rel) → ids | undefined', doc: 'The ids of a cycle through relationships of the type, if there is one (source → target as the direction).', arg: 'rel' },
  { name: 'others', signature: 'others() → entities', doc: 'The entities in the write being checked (none in an audit).' },
  { name: 'violation', signature: 'violation(id, message) → violation', doc: 'Name an entity at fault; return a list of these.' },
  { name: 'fail', signature: 'fail(message) → string', doc: 'Fail the whole write with a message.' },
  { name: 'params', signature: 'params', doc: 'The parameters the constraint was made with (from its template’s form).' },
  { name: 'store', signature: 'store', doc: 'The entity store as it stands (before the write), read-only: get, has, ofType, relationshipsOf, query, all. Prefer the helpers, which see the write too.' },
]

export const GRAPH_HELPER_NAMES = GRAPH_HELPERS.map((h) => h.name)

export type CompiledGraphRule = (scope: RuleScope) => unknown

/** Compile a graph rule into the QuickJS realm; throws a SyntaxError when it does not parse, `RulePending` until loaded. */
export function compileGraphRule(code: string): CompiledGraphRule {
  const body = isBody(code) ? code : `return (\n${code}\n)`
  const source = `(function () {
const __f = function (scope, ${GRAPH_HELPER_NAMES.join(', ')}) {
${body}
}
return function (paramsJson) {
  const params = JSON.parse(paramsJson)
  const H = __graphHelpers(params)
  return __out(__f(Object.freeze({ params }), ${GRAPH_HELPER_NAMES.map((n) => `H.${n}`).join(', ')}))
}
})()`
  const key = `graph\u0000${code}`
  prepare(key, source)
  return (scope) => {
    const h = graphHelpersFor(scope)
    const host = (name: string, args: unknown[]) => (name.startsWith('store.') ? storeCall(scope.store, name.slice(6), args) : (h[name] as (...a: unknown[]) => unknown)(...args))
    return call(key, source, [JSON.stringify(scope.params ?? {})], host, Math.min(GRAPH_RULE_BUDGET_MS, scope.budgetMs ?? Infinity))
  }
}

/**
 * The store with a write laid over it: entities in the write replace (or
 * join) what the store holds, so a rule judges the graph as it will be.
 * Built lazily — a rule that only looks up ids never lists everything.
 */
export function overlay(store: EntityStore, others: Map<EntityId, AnyEntity>): GraphView {
  const plain = others.size === 0
  let allCache: AnyEntity[] | undefined
  const all = (): AnyEntity[] => {
    if (plain) return store.all()
    if (!allCache) {
      const seen = new Set<EntityId>()
      const out: AnyEntity[] = []
      for (const e of store.all()) {
        const o = others.get(e.id)
        out.push(o ?? e)
        seen.add(e.id)
      }
      for (const o of others.values()) if (!seen.has(o.id)) out.push(o)
      allCache = out
    }
    return allCache
  }
  const entity = (id: EntityId) => others.get(id) ?? store.get(id)
  const relationshipsOf = (id: EntityId, dir: 'out' | 'in' | 'both' = 'both'): Relationship[] => {
    const base = store.relationshipsOf(id, dir)
    if (plain) return base
    // Same-write relationships replace their stored version and add the new ones; a moved end drops out.
    const out: Relationship[] = []
    for (const r of base) {
      const o = others.get(r.id)
      if (!o) out.push(r)
    }
    for (const o of others.values()) if (isRelationship(o) && ((dir !== 'in' && o.source.id === id) || (dir !== 'out' && o.target.id === id))) out.push(o)
    return out
  }
  return {
    all,
    entities: () => all().filter((e) => !isRelationship(e)),
    relationships: () => (plain ? store.relationships() : all().filter(isRelationship)),
    ofType: (type) => (plain ? store.ofType(type) : all().filter((e) => e.type === type)),
    entity,
    relationshipsOf,
    types: () => [...new Set(all().filter((e) => !isRelationship(e)).map((e) => e.type))].sort(),
    relTypes: () => [...new Set(all().filter(isRelationship).map((e) => e.type))].sort(),
  }
}

/** A cycle through relationships of one type, source → target, as the ids along it; undefined when there is none. */
export function findCycle(view: GraphView, rel: string): EntityId[] | undefined {
  const out = new Map<EntityId, EntityId[]>()
  for (const r of view.relationships()) if (r.type === rel && r.source.id !== undefined) out.set(r.source.id, [...(out.get(r.source.id) ?? []), r.target.id])
  const state = new Map<EntityId, 1 | 2>()
  const stack: EntityId[] = []
  const visit = (id: EntityId): EntityId[] | undefined => {
    state.set(id, 1)
    stack.push(id)
    for (const next of out.get(id) ?? []) {
      const s = state.get(next)
      if (s === 1) return [...stack.slice(stack.indexOf(next)), next]
      if (s === undefined) {
        const c = visit(next)
        if (c) return c
      }
    }
    stack.pop()
    state.set(id, 2)
    return undefined
  }
  for (const id of out.keys()) {
    if (state.has(id)) continue
    const c = visit(id)
    if (c) return c
  }
  return undefined
}

/** The graph vocabulary bound to one store and one write. */
export function graphHelpersFor(scope: RuleScope): Record<string, unknown> {
  const { store, others } = scope
  const view = overlay(store, others)
  const otherEnd = (r: Relationship, id: EntityId) => (r.source.id === id ? r.target.id : r.source.id)
  const asId = (x: EntityId | AnyEntity) => (typeof x === 'string' ? x : x.id)
  const rels = (x: EntityId | AnyEntity, dir: 'out' | 'in' | 'both', rel?: string) => {
    const list = view.relationshipsOf(asId(x), dir)
    return rel ? list.filter((r) => r.type === rel) : list
  }
  return {
    all: view.all,
    entities: view.entities,
    relationships: (type?: string) => (type ? view.relationships().filter((r) => r.type === type) : view.relationships()),
    ofType: view.ofType,
    entity: view.entity,
    typeOf: (id: EntityId) => view.entity(id)?.type,
    types: view.types,
    relTypes: view.relTypes,
    out: (x: EntityId | AnyEntity, rel?: string) => rels(x, 'out', rel),
    inn: (x: EntityId | AnyEntity, rel?: string) => rels(x, 'in', rel),
    links: (x: EntityId | AnyEntity, rel?: string) => rels(x, 'both', rel),
    neighbors: (x: EntityId | AnyEntity, rel?: string) => {
      const id = asId(x)
      return rels(id, 'both', rel).map((r) => view.entity(otherEnd(r, id))).filter((e): e is AnyEntity => !!e)
    },
    degree: (x: EntityId | AnyEntity, rel?: string) => rels(x, 'both', rel).length,
    get: (e: AnyEntity, path: string) => getPath(e, path),
    has: (e: AnyEntity, path: string) => !isEmpty(getPath(e, path)),
    isEmpty,
    count: (list: unknown) => (Array.isArray(list) ? list.length : list && typeof list === 'object' && 'size' in (list as object) ? (list as { size: number }).size : list ? 1 : 0),
    cycle: (rel: string) => findCycle(view, rel),
    others: () => [...others.values()],
    violation: (id: EntityId | AnyEntity, message: string): GraphViolation => ({ id: asId(id), message: message || 'flagged' }),
    fail: (message: string) => message || 'failed',
    params: scope.params ?? {},
    store,
  }
}

/**
 * A graph rule's verdict as violations: nothing on true; one unnamed
 * violation on false or a string; one per item of a list — a string, a
 * violation(id, message), or an entity (flagged as such).
 */
export function graphVerdict(value: unknown): GraphViolation[] {
  if (value === true || value === undefined || value === null) return []
  if (value === false) return [{ message: 'the check returned false' }]
  if (typeof value === 'string') return value ? [{ message: value }] : []
  const list = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { violations?: unknown }).violations) ? ((value as { violations: unknown[] }).violations) : undefined
  if (!list) return [{ message: `the check returned ${JSON.stringify(value)}` }]
  const out: GraphViolation[] = []
  for (const item of list) {
    if (item === undefined || item === null || item === true) continue
    if (item === false) out.push({ message: 'the check returned false' })
    else if (typeof item === 'string') out.push({ message: item })
    else if (typeof item === 'object') {
      const o = item as { id?: unknown; message?: unknown; type?: unknown; entityId?: unknown }
      const id = typeof o.id === 'string' ? o.id : typeof o.entityId === 'string' ? o.entityId : undefined
      const message = typeof o.message === 'string' && o.message ? o.message : o.type ? 'flagged by the check' : 'flagged'
      out.push(id ? { id, message } : { message })
    }
  }
  return out
}
