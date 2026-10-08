import type { Language } from '../../scripting/types'
import type { ExprSchema, PropertyInfo } from '../expr/schema'

/**
 * What an expression in a script *is*, inferred from the document and the
 * data schema — so completion can follow the data through the code:
 *
 *   const people = ds.byType('person')        people: entities of type person
 *   for (const r of ds.out(p.id, 'wrote'))     r: a wrote relationship
 *   ds.get(r.target).data.|                    the properties of a paper
 *   people.filter((e) => e.data.severity === '|   the values severity takes
 *   df = by_type('incident'); df['|            the columns of incidents (Python)
 *
 * The types are a small algebra over what the snapshot holds: entities and
 * relationships (with the type names they may have), their `data`, ids
 * (with the types they may point at), the ontology's definitions, the
 * project, tags, the summary — and lists of any of these. Bindings come
 * from `const x = …`, `for (const x of …)`, callback parameters
 * (`.map((e) => …)`), destructuring from `ds`, and `main({ … })`; Python
 * from `x = …` and `for x in …`. Anything else is unknown, and the
 * completion falls back to what it can offer by position.
 */

export type Ty =
  /** No idea what this is: the completion may guess from the name. */
  | { k: 'unknown' }
  /** Something we cannot describe — a mapped value, a computed number: nothing to guess. */
  | { k: 'any' }
  | { k: 'ds' }
  | { k: 'aegraph' }
  | { k: 'entity'; types: string[] | null }
  | { k: 'rel'; types: string[] | null }
  /** An entity's or relationship's `data`. */
  | { k: 'data'; types: string[] | null; rel?: boolean }
  /** One property's value: for the values a categorical property takes. */
  | { k: 'value'; types: string[] | null; key: string; rel?: boolean }
  /** An id, and the types the entity behind it may have. */
  | { k: 'id'; types: string[] | null }
  /** A string that names something. */
  | { k: 'name'; of: 'type' | 'tag' | 'rel' | 'metric' }
  | { k: 'typedef' }
  | { k: 'propdef' }
  | { k: 'propinfo' }
  | { k: 'tag' }
  | { k: 'project' }
  | { k: 'scope' }
  | { k: 'describe' }
  | { k: 'dtype' }
  | { k: 'drel' }
  | { k: 'metrics' }
  /** rollup rows: { key, value, n, items } where items are `of`. */
  | { k: 'rollup'; of: Ty }
  | { k: 'list'; of: Ty }
  /** A collection — the chained query API: entities / relationships with a vocabulary, in both languages. */
  | { k: 'coll'; rel: boolean; types: string[] | null }
  /** `.types` on a collection: a namespace whose members are the type names. */
  | { k: 'types'; coll: Ty & { k: 'coll' } }
  /** Python: a DataFrame of entities (or of relationships), and one of its rows. */
  | { k: 'df'; types: string[] | null; rel?: boolean }
  | { k: 'row'; types: string[] | null; rel?: boolean }
  | { k: 'number' }
  | { k: 'string' }
  | { k: 'method'; name: string; apply: (args: Ty[], raw: string[]) => Ty }

export const UNKNOWN: Ty = { k: 'unknown' }
export const ANY: Ty = { k: 'any' }
const list = (of: Ty): Ty => ({ k: 'list', of })
const coll = (rel: boolean, types: string[] | null): Ty & { k: 'coll' } => ({ k: 'coll', rel, types })
const method = (name: string, apply: (args: Ty[], raw: string[]) => Ty): Ty => ({ k: 'method', name, apply })

export interface Member {
  name: string
  ty: Ty
  doc?: string
  /** Shown beside the name. */
  detail?: string
}

/** The string literal in a raw argument, if it is one. */
const literal = (raw: string | undefined): string | undefined => {
  const m = raw && /^\s*(["'`])((?:\\.|(?!\1).)*)\1\s*$/.exec(raw)
  return m ? m[2] : undefined
}
const literals = (raw: string[]): string[] | null => {
  const out = raw.map(literal).filter((x): x is string => x !== undefined)
  return out.length ? out : null
}

export class Inference {
  private readonly schema: ExprSchema
  readonly language: Language

  constructor(schema: ExprSchema, language: Language) {
    this.schema = schema
    this.language = language
  }

  // ── The data schema, as questions ──────────────────────────────────

  entityTypes(): string[] {
    return this.schema.types.filter((t) => t.kind === 'entity').map((t) => t.type)
  }
  /** The properties entities (or relationships) of some types carry — of every type when null. */
  properties(types: string[] | null, rel = false): PropertyInfo[] {
    const names = types ?? (rel ? this.schema.relationshipTypes.map((r) => r.type) : this.entityTypes())
    const merged = new Map<string, PropertyInfo>()
    for (const t of names) for (const p of this.schema.properties.get(t) ?? []) if (!merged.has(p.key) || merged.get(p.key)!.coverage < p.coverage) merged.set(p.key, p)
    return [...merged.values()]
  }
  /** The values a property takes across some types, when it is categorical. */
  values(types: string[] | null, key: string, rel = false): string[] {
    const out: string[] = []
    for (const p of this.properties(types, rel)) if (p.key === key) for (const v of p.values ?? []) if (!out.includes(v)) out.push(v)
    return out
  }
  /** The types at the far end of relationships of some types (both ends when the direction is not known). */
  otherEnds(rels: string[] | null, end: 'source' | 'target' | 'both' = 'both'): string[] | null {
    const rs = this.schema.relationshipTypes.filter((r) => !rels || rels.includes(r.type))
    if (!rs.length) return null
    const out = new Set<string>()
    for (const r of rs) for (const t of end === 'both' ? [...r.sources, ...r.targets] : end === 'source' ? r.sources : r.targets) out.add(t)
    return out.size ? [...out] : null
  }

  /** The types at the far end of relationships from entities of some types: the side they are not on, when that is clear. */
  farEnds(from: string[] | null, rels: string[] | null, dir: 'out' | 'in' | 'both' = 'both'): string[] | null {
    if (dir === 'out') return this.otherEnds(rels, 'target')
    if (dir === 'in') return this.otherEnds(rels, 'source')
    const rs = this.schema.relationshipTypes.filter((r) => !rels || rels.includes(r.type))
    if (!from || !rs.length) return this.otherEnds(rels)
    const onSource = rs.some((r) => r.sources.some((t) => from.includes(t)))
    const onTarget = rs.some((r) => r.targets.some((t) => from.includes(t)))
    if (onSource && !onTarget) return this.otherEnds(rels, 'target')
    if (onTarget && !onSource) return this.otherEnds(rels, 'source')
    return this.otherEnds(rels)
  }

  // ── Members: what `.` offers on a value, and what each is ──────────

  members(ty: Ty): Member[] {
    const py = this.language === 'python'
    const entity = (types: string[] | null): Member[] => [
      { name: 'id', ty: { k: 'id', types }, doc: 'The id.' },
      { name: 'type', ty: { k: 'name', of: 'type' }, doc: 'The type name.', detail: types?.join(' | ') },
      { name: 'label', ty: { k: 'string' }, doc: 'The label.' },
      { name: 'description', ty: { k: 'string' }, doc: 'The description, if any.' },
      { name: 'tags', ty: list({ k: 'name', of: 'tag' }), doc: 'The tags.' },
      { name: 'data', ty: { k: 'data', types }, doc: 'The properties.', detail: this.properties(types).slice(0, 4).map((p) => p.key).join(', ') || undefined },
      { name: 'createdAt', ty: { k: 'string' }, doc: 'ISO date.' },
      { name: 'updatedAt', ty: { k: 'string' }, doc: 'ISO date.' },
    ]
    const rel = (types: string[] | null): Member[] => [
      { name: 'id', ty: { k: 'string' } },
      { name: 'type', ty: { k: 'name', of: 'rel' }, detail: types?.join(' | ') },
      { name: 'source', ty: { k: 'id', types: this.otherEnds(types, 'source') }, doc: 'The source entity’s id.', detail: this.otherEnds(types, 'source')?.join(' | ') },
      { name: 'target', ty: { k: 'id', types: this.otherEnds(types, 'target') }, doc: 'The target entity’s id.', detail: this.otherEnds(types, 'target')?.join(' | ') },
      { name: 'directed', ty: { k: 'unknown' } },
      { name: 'data', ty: { k: 'data', types, rel: true }, doc: 'The relationship’s properties.' },
    ]
    const plain = (names: string[], doc?: Record<string, string>, tys?: Record<string, Ty>): Member[] => names.map((n) => ({ name: n, ty: tys?.[n] ?? { k: 'unknown' }, doc: doc?.[n] }))
    switch (ty.k) {
      case 'ds':
        // Python: the raw snapshot dict.
        if (py) return [{ name: 'entities', ty: coll(false, null) }, { name: 'relationships', ty: coll(true, null) }, { name: 'ontology', ty: list({ k: 'typedef' }) }, { name: 'project', ty: { k: 'project' } }, { name: 'tags', ty: list({ k: 'tag' }) }, { name: 'metrics', ty: { k: 'metrics' } }, { name: 'scope', ty: { k: 'scope' } }]
        return [
          { name: 'entities', ty: coll(false, null), doc: 'Every entity — a collection.' },
          { name: 'relationships', ty: coll(true, null), doc: 'Every relationship — a collection.' },
          { name: 'get', ty: method('get', (args) => ({ k: 'entity', types: args[0]?.k === 'id' ? args[0].types : null })), doc: 'An entity by id.' },
          { name: 'byType', ty: method('byType', (_, raw) => coll(false, literals(raw))), doc: 'Entities of one or more types.' },
          { name: 'types', ty: method('types', () => list({ k: 'name', of: 'type' })), doc: 'The entity types in use.' },
          { name: 'tagged', ty: method('tagged', () => coll(false, null)), doc: 'Entities carrying a tag.' },
          { name: 'where', ty: method('where', () => coll(false, null)), doc: 'Entities matching a predicate.' },
          { name: 'count', ty: method('count', () => ({ k: 'number' })) },
          { name: 'out', ty: method('out', (_, raw) => coll(true, literals(raw.slice(1)))), doc: 'Relationships leaving an entity.' },
          { name: 'in', ty: method('in', (_, raw) => coll(true, literals(raw.slice(1)))), doc: 'Relationships arriving at an entity.' },
          { name: 'neighbors', ty: method('neighbors', (_, raw) => coll(false, this.otherEnds(literals(raw.slice(1))))), doc: 'The entities at the other end.' },
          { name: 'degree', ty: method('degree', () => ({ k: 'number' })) },
          { name: 'metric', ty: method('metric', () => ({ k: 'number' })) },
          { name: 'metricNames', ty: method('metricNames', () => list({ k: 'name', of: 'metric' })) },
          { name: 'metrics', ty: { k: 'metrics' }, doc: 'metric → entity id → value.' },
          { name: 'project', ty: { k: 'project' }, doc: 'The open project, or null.' },
          { name: 'scope', ty: { k: 'scope' } },
          { name: 'ontology', ty: list({ k: 'typedef' }), doc: 'Every type in use or declared.' },
          { name: 'type', ty: method('type', () => ({ k: 'typedef' })), doc: 'One type’s definition.' },
          { name: 'properties', ty: method('properties', () => list({ k: 'propinfo' })), doc: 'What entities of a type carry.' },
          { name: 'tags', ty: method('tags', () => list({ k: 'tag' })), doc: 'The tags in use.' },
          { name: 'describe', ty: method('describe', () => ({ k: 'describe' })), doc: 'Everything at once.' },
        ]
      case 'entity':
        return entity(ty.types)
      case 'rel':
        return rel(ty.types)
      case 'row':
        return ty.rel ? rel(ty.types) : entity(ty.types)
      case 'data': {
        const props = this.properties(ty.types, ty.rel)
        return props.map((p) => ({ name: p.key, ty: { k: 'value', types: ty.types, key: p.key, rel: ty.rel }, detail: `${p.kind} · ${Math.round(p.coverage * 100)}%`, doc: [p.description, p.sample !== undefined ? `e.g. ${p.sample}` : undefined, p.values?.length ? `values: ${p.values.slice(0, 8).join(', ')}${p.values.length > 8 ? '…' : ''}` : undefined].filter(Boolean).join('\n') || undefined }))
      }
      case 'df': {
        const cols = this.columns(ty)
        const same = ['head', 'tail', 'sort_values', 'query', 'drop_duplicates', 'dropna', 'fillna', 'reset_index']
        return [...cols, ...same.map((n) => ({ name: n, ty: method(n, () => ty) })), ...['groupby', 'merge', 'describe', 'value_counts', 'to_dict', 'iterrows', 'nlargest', 'nsmallest'].map((n) => ({ name: n, ty: method(n, () => UNKNOWN) })), { name: 'iloc', ty: UNKNOWN }, { name: 'loc', ty: UNKNOWN }, { name: 'columns', ty: UNKNOWN }, { name: 'shape', ty: UNKNOWN }]
      }
      case 'typedef':
        return [...plain(['type', 'label', 'category', 'kind', 'parent', 'description', 'color', 'count']), { name: 'properties', ty: list({ k: 'propdef' }), doc: 'The declared properties.' }]
      case 'propdef':
        return plain(['key', 'label', 'kind', 'description', 'options', 'required'])
      case 'propinfo':
        return plain(['key', 'kind', 'count', 'coverage', 'declared', 'sample', 'label', 'description'])
      case 'tag':
        return plain(['tag', 'count', 'color', 'description'])
      case 'project':
        return plain(['id', 'label', 'description', 'includes', 'source', 'createdAt', 'updatedAt'])
      case 'scope':
        return plain(['label', 'projectId'])
      case 'describe':
        return [
          { name: 'scope', ty: { k: 'scope' } },
          { name: 'project', ty: { k: 'project' } },
          { name: 'entities', ty: { k: 'number' } },
          { name: 'relationships', ty: { k: 'number' } },
          { name: 'types', ty: list({ k: 'dtype' }) },
          { name: 'relationshipTypes', ty: list({ k: 'drel' }) },
          { name: 'tags', ty: list({ k: 'string' }) },
          { name: 'metrics', ty: list({ k: 'name', of: 'metric' }) },
        ]
      case 'dtype':
        return plain(['type', 'count', 'properties'])
      case 'drel':
        return plain(['type', 'count', 'joins'])
      case 'metrics':
        return []
      case 'rollup':
        return [{ name: 'key', ty: { k: 'unknown' } }, { name: 'value', ty: { k: 'number' } }, { name: 'n', ty: { k: 'number' } }, { name: 'items', ty: ty.of, doc: 'The items of the group.' }]
      case 'coll':
        return this.collectionMembers(ty)
      case 'types': {
        const c = ty.coll
        const names = c.rel ? this.schema.relationshipTypes.map((r) => r.type) : this.entityTypes()
        const inColl = c.types ? names.filter((n) => c.types!.includes(n)) : names
        return [
          ...inColl.map((n) => ({ name: n, ty: coll(c.rel, [n]) as Ty, detail: `${(c.rel ? this.schema.relationshipTypes.find((r) => r.type === n)?.count : this.schema.types.find((t) => t.type === n)?.count)?.toLocaleString() ?? ''}`, doc: `The ${n} ${c.rel ? 'relationships' : 'entities'} — a plural works too.` })),
          { name: 'list', ty: method('list', () => list({ k: 'name', of: c.rel ? 'rel' : 'type' })), doc: 'The type names.' },
          { name: 'has', ty: method('has', () => ANY), doc: 'Whether a type is there.' },
        ]
      }
      case 'list': {
        const keep = (name: string) => ({ name, ty: method(name, () => ty) })
        const one = (name: string) => ({ name, ty: method(name, () => ty.of) })
        if (py) return []
        // A filter on `.type === 'x'` narrows what the list holds.
        const filter = { name: 'filter', ty: method('filter', (_, raw) => {
          const m = /\btype\s*===?\s*(['"])([^'"]+)\1/.exec(raw[0] ?? '')
          return m && (ty.of.k === 'entity' || ty.of.k === 'rel') ? list({ ...ty.of, types: [m[2]] }) : ty
        }) }
        return [{ name: 'length', ty: { k: 'number' } }, filter, one('find'), { name: 'map', ty: method('map', () => list(ANY)) }, { name: 'flatMap', ty: method('flatMap', () => list(ANY)) }, keep('slice'), keep('sort'), keep('reverse'), one('at'), { name: 'some', ty: method('some', () => ANY) }, { name: 'every', ty: method('every', () => ANY) }, { name: 'forEach', ty: method('forEach', () => ANY) }, { name: 'reduce', ty: method('reduce', () => ANY) }, keep('concat'), { name: 'includes', ty: method('includes', () => ANY) }, { name: 'join', ty: method('join', () => ({ k: 'string' })) }]
      }
      case 'aegraph':
        return plain(['load', 'width', 'height', 'result', 'remember', 'recall'])
      default:
        return []
    }
  }

  /** The chained query API on a collection — the same names in both languages. */
  collectionMembers(c: Ty & { k: 'coll' }): Member[] {
    const py = this.language === 'python'
    const same = (name: string, doc: string) => ({ name, ty: method(name, () => c), doc })
    const one = (name: string, doc: string) => ({ name, ty: method(name, () => this.element(c)), doc })
    const narrow = (arg: string): Ty => {
      const one = /\btypes?\s*[:=]\s*(['"])([^'"]+)\1/.exec(arg) ?? /\.type\s*===?\s*(['"])([^'"]+)\1/.exec(arg) ?? /\[\s*['"]type['"]\s*\]\s*==\s*(['"])([^'"]+)\1/.exec(arg)
      if (one) return coll(c.rel, [one[2]])
      const many = /\btypes?\s*[:=]\s*(?:new Set\()?[[{(]([^\]})]*)[\]})]/.exec(arg)
      if (many) {
        const names = [...many[1].matchAll(/(['"])([^'"]+)\1/g)].map((m) => m[2])
        if (names.length) return coll(c.rel, names)
      }
      return c
    }
    const specKeys = c.rel ? 'types, source, target, source_type, target_type, directed, has, data, text, where' : 'types, tags, all_tags, text, has, data, min_degree, max_degree, rel, ids, created_after/before, updated_after/before, where'
    const out: Member[] = [
      { name: 'types', ty: { k: 'types', coll: c }, doc: `.types.<name> — the members of one type (a plural works: types.documents).`, detail: (c.types ?? (c.rel ? this.schema.relationshipTypes.map((r) => r.type) : this.entityTypes())).slice(0, 4).join(', ') },
      { name: 'type', ty: method('type', (_, raw) => coll(c.rel, literals(raw))), doc: 'The members of one or more types.' },
      one('get', 'The member with this id.'),
      { name: 'ids', ty: method('ids', () => list({ k: 'id', types: c.types })), doc: 'The ids.' },
      { name: 'labels', ty: method('labels', () => list({ k: 'string' })), doc: 'The labels.' },
      { name: 'count', ty: method('count', () => ({ k: 'number' })), doc: 'How many.' },
      one('first', 'The first member.'),
      one('last', 'The last member.'),
      same('take', 'The first n.'),
      same('skip', 'All but the first n.'),
      same('sample', 'n at random.'),
      // A filter on the type narrows what the collection holds: (x) => x.type === 'a', { types: 'a' }, types=['a', 'b'].
      { name: 'filter', ty: method('filter', (_, raw) => narrow(raw[0] ?? '')), doc: `A predicate, or a spec${py ? ' (a dict or keywords)' : ' object'}: ${specKeys}.` },
      same('where', 'Members matching a predicate.'),
      same('exclude', 'The complement of a filter.'),
      same('sort', "By a field, a 'data.x' path or a function; desc for largest first. A copy."),
      same('top', 'The n largest by a field or path.'),
      { name: 'unique', ty: method('unique', () => list(ANY)), doc: 'The distinct values at a path.' },
      { name: 'pluck', ty: method('pluck', () => list(ANY)), doc: 'The values at a path.' },
      { name: 'group', ty: method('group', () => ANY), doc: '{ key: collection }.' },
      { name: 'rollup', ty: method('rollup', () => list({ k: 'rollup', of: c })), doc: '[{ key, value, n, items }] per group: count, sum, mean, median, min, max, distinct.' },
      { name: 'tags', ty: method('tags', () => list({ k: 'tag' })), doc: 'The tags members carry, with counts.' },
      { name: 'properties', ty: method('properties', () => list({ k: 'propinfo' })), doc: 'The properties members carry, with coverage.' },
      { name: 'table', ty: method('table', () => ANY), doc: "A table output; columns are fields or 'data.x' paths." },
      { name: 'json', ty: method('json', () => list(this.element(c))), doc: 'Plain records.' },
      { name: 'describe', ty: method('describe', () => ANY), doc: 'Counts by type, tags, properties.' },
    ]
    if (!c.rel) {
      out.push(
        same('tagged', 'Members carrying a tag.'),
        { name: 'out', ty: method('out', (_, raw) => coll(true, literals(raw))), doc: 'Relationships leaving members, optionally of one type.' },
        { name: 'into', ty: method('into', (_, raw) => coll(true, literals(raw))), doc: 'Relationships arriving at members.' },
        { name: 'links', ty: method('links', (_, raw) => coll(true, literals(raw))), doc: 'Relationships touching members.' },
        { name: 'neighbors', ty: method('neighbors', (_, raw) => coll(false, this.farEnds(c.types, literals(raw.slice(0, 1)), (literal(raw[1]) as 'out' | 'in' | 'both' | undefined) ?? 'both'))), doc: "The entities at the other ends; dir 'out' | 'in' | 'both'." },
        { name: 'degrees', ty: method('degrees', () => ANY), doc: '{ id: degree }.' },
      )
    } else {
      out.push(
        { name: 'sources', ty: method('sources', () => coll(false, this.otherEnds(c.types, 'source'))), doc: 'The entities at the sources.' },
        { name: 'targets', ty: method('targets', () => coll(false, this.otherEnds(c.types, 'target'))), doc: 'The entities at the targets.' },
        { name: 'ends', ty: method('ends', () => coll(false, this.otherEnds(c.types))), doc: 'The entities at both ends.' },
        same(py ? 'from_' : 'from', 'Members leaving an entity (an id or a collection).'),
        same('to', 'Members arriving at an entity.'),
      )
    }
    if (py) out.push({ name: 'df', ty: { k: 'df', types: c.types, rel: c.rel }, doc: 'The members as a DataFrame.' })
    else out.push({ name: 'length', ty: { k: 'number' } }, one('find', 'Array find.'), one('at', 'Array at.'), { name: 'map', ty: method('map', () => list(ANY)) }, { name: 'flatMap', ty: method('flatMap', () => list(ANY)) }, same('slice', 'A copy of a range.'), { name: 'some', ty: method('some', () => ANY) }, { name: 'every', ty: method('every', () => ANY) }, { name: 'forEach', ty: method('forEach', () => ANY) }, { name: 'reduce', ty: method('reduce', () => ANY) }, { name: 'includes', ty: method('includes', () => ANY) }, { name: 'join', ty: method('join', () => ({ k: 'string' })) })
    return out
  }

  /** A DataFrame's columns: the fixed ones, then every data key as its own column. */
  columns(ty: Ty & { k: 'df' }): Member[] {
    return [...(ty.rel ? ['id', 'type', 'source', 'target', 'directed'] : ['id', 'type', 'label', 'tags', 'createdAt', 'updatedAt']).map((n) => ({ name: n, ty: n === 'type' ? ({ k: 'name', of: ty.rel ? 'rel' : 'type' } as Ty) : n === 'tags' ? list({ k: 'name', of: 'tag' }) : ({ k: 'string' } as Ty) })), ...this.members({ k: 'data', types: ty.types, rel: ty.rel })]
  }

  /** A member by name — an index with a string literal reads the same as a dot. */
  member(ty: Ty, name: string): Ty {
    if (ty.k === 'metrics') return UNKNOWN
    if (ty.k === 'types') {
      const names = ty.coll.rel ? this.schema.relationshipTypes.map((r) => r.type) : this.entityTypes()
      const resolve = names.find((n) => n === name) ?? (name.endsWith('s') ? names.find((n) => n === name.slice(0, -1) || n === name.slice(0, -3) + 'y') : undefined) ?? names.find((n) => n === name.replace(/_/g, '-') || n === name.replace(/_/g, ':'))
      if (resolve) return coll(ty.coll.rel, [resolve])
      const m = this.members(ty).find((x) => x.name === name)
      if (m) return m.ty
      // A type the schema does not know (no data yet, or a type still to come): a collection of it all the same.
      return coll(ty.coll.rel, [name])
    }
    if (ty.k === 'coll' && this.language === 'python') {
      // entities['type'] is the DataFrame's column; a data key reads as its values.
      const m = this.members(ty).find((x) => x.name === name)
      if (m && m.ty.k !== 'method') return m.ty
      if (['id', 'type', 'label', 'tags', 'source', 'target'].includes(name)) return ANY
      if (this.properties(ty.types, ty.rel).some((p) => p.key === name)) return { k: 'value', types: ty.types, key: name, rel: ty.rel }
      return m?.ty ?? UNKNOWN
    }
    if (ty.k === 'row' || ty.k === 'entity' || ty.k === 'rel' || ty.k === 'df') {
      // Python rows and DataFrames carry data keys at the top level: df['born'], row['born'].
      const m = this.members(ty).find((x) => x.name === name)
      if (m) return m.ty
      if (ty.k === 'row' || ty.k === 'df') {
        const p = this.properties(ty.types, ty.rel).find((x) => x.key === name)
        if (p) return { k: 'value', types: ty.types, key: name, rel: ty.rel }
      }
      return UNKNOWN
    }
    return this.members(ty).find((x) => x.name === name)?.ty ?? UNKNOWN
  }

  /** The element of a list-like value. */
  element(ty: Ty): Ty {
    if (ty.k === 'any') return ANY
    if (ty.k === 'coll') return ty.rel ? { k: 'rel', types: ty.types } : { k: 'entity', types: ty.types }
    if (ty.k === 'list') return ty.of
    if (ty.k === 'rollup') return { k: 'rollup', of: ty.of }
    if (ty.k === 'df') return { k: 'row', types: ty.types, rel: ty.rel }
    return UNKNOWN
  }

  // ── Bare names: globals and helpers that return something typed ────

  global(name: string, args: Ty[], raw: string[]): Ty | undefined {
    if (this.language === 'python') {
      switch (name) {
        case 'ds':
          return { k: 'ds' }
        case 'entities':
          return coll(false, null)
        case 'relationships':
          return coll(true, null)
        case 'by_type':
          return { k: 'df', types: literals(raw) }
        case 'get':
          return { k: 'entity', types: args[0]?.k === 'id' ? args[0].types : null }
        case 'out':
        case 'inn':
          return coll(true, literals(raw.slice(1)))
        case 'neighbors':
          return coll(false, this.otherEnds(literals(raw.slice(1))))
        case 'ontology':
          return list({ k: 'typedef' })
        case 'type_def':
          return { k: 'typedef' }
        case 'properties':
          return { k: 'df', types: null }
        case 'tags':
          return list({ k: 'tag' })
        case 'project':
          return { k: 'project' }
        case 'describe':
          return { k: 'describe' }
        case 'metrics':
          return { k: 'metrics' }
        default:
          return undefined
      }
    }
    switch (name) {
      case 'ds':
        return { k: 'ds' }
      case 'entities':
        return coll(false, null)
      case 'relationships':
        return coll(true, null)
      case 'aegraph':
        return this.language === 'view' ? { k: 'aegraph' } : undefined
      case 'sortBy':
      case 'topK':
        return args[0]?.k === 'list' || args[0]?.k === 'coll' ? args[0] : undefined
      case 'rollup':
        return { k: 'list', of: { k: 'rollup', of: args[0]?.k === 'list' || args[0]?.k === 'coll' ? args[0] : list(ANY) } }
      default:
        return undefined
    }
  }

  // ── Expressions ────────────────────────────────────────────────────

  /**
   * The type of an expression's text, with the bindings in force. Parses a
   * chain — a head (a name, or a parenthesised expression) followed by
   * `.name`, `(args)` and `[index]` segments — and walks it.
   */
  typeOf(expr: string, bindings: Bindings, depth = 0): Ty {
    if (depth > 8) return UNKNOWN
    const chain = parseChain(expr.trim(), this.language === 'python')
    if (!chain) return UNKNOWN
    let ty: Ty | undefined
    const head = chain.head
    if (head.kind === 'name') {
      // A call of a global comes with its arguments; a bare global without.
      const next = chain.segments[0]
      if (next?.kind === 'call') {
        const args = next.args.map((a) => this.typeOf(a, bindings, depth + 1))
        const g = this.global(head.text, args, next.args)
        if (g) {
          ty = g
          chain.segments.shift()
        }
      }
      if (!ty) ty = this.global(head.text, [], []) ?? bindings.lookup(head.text, (e) => this.typeOf(e, bindings, depth + 1))
    } else if (head.kind === 'paren') ty = this.typeOf(head.text, bindings, depth + 1)
    else if (head.kind === 'string') ty = { k: 'string' }
    if (!ty) return UNKNOWN
    for (const seg of chain.segments) {
      if (ty.k === 'unknown' || ty.k === 'any') return ty
      if (seg.kind === 'member') ty = this.member(ty, seg.name)
      else if (seg.kind === 'call') {
        if (ty.k === 'method') ty = ty.apply(seg.args.map((a) => this.typeOf(a, bindings, depth + 1)), seg.args)
        else return ANY
      } else if (seg.kind === 'index') {
        const lit = literal(seg.text)
        if (lit !== undefined) ty = this.member(ty, lit)
        else if (ty.k === 'df') ty = /^\s*\d+\s*$/.test(seg.text) ? this.element(ty) : ty // df[mask] stays a frame; df[0] is not pandas, but a row is the useful guess
        else if (ty.k === 'metrics') ty = UNKNOWN
        else ty = this.element(ty)
      }
    }
    return ty.k === 'method' ? ANY : ty
  }

  /** One line saying what a value is, for hover. */
  describe(ty: Ty): string | undefined {
    const names = (types: string[] | null, what: string) => (types ? `${types.join(' | ')} ${what}` : `${what} of any type`)
    switch (ty.k) {
      case 'entity':
        return `an entity: ${names(ty.types, 'entity')}${ty.types ? ` — data: ${this.properties(ty.types).slice(0, 6).map((p) => p.key).join(', ')}` : ''}`
      case 'rel':
        return `a relationship: ${names(ty.types, 'relationship')}${ty.types ? ` (${this.schema.relationshipTypes.filter((r) => ty.types!.includes(r.type)).flatMap((r) => r.pairs).slice(0, 3).join(', ')})` : ''}`
      case 'data':
        return `the data of ${names(ty.types, ty.rel ? 'relationships' : 'entities')}: ${this.properties(ty.types, ty.rel).slice(0, 8).map((p) => p.key).join(', ')}`
      case 'value': {
        const p = this.properties(ty.types, ty.rel).find((x) => x.key === ty.key)
        return p ? `${p.kind} · ${Math.round(p.coverage * 100)}% carry it${p.values?.length ? ` · ${p.values.slice(0, 6).join(', ')}` : p.sample !== undefined ? ` · e.g. ${p.sample}` : ''}` : undefined
      }
      case 'id':
        return `an entity id${ty.types ? ` (${ty.types.join(' | ')})` : ''}`
      case 'coll': {
        const what = ty.rel ? 'relationships' : 'entities'
        const n = ty.types ? ty.types.reduce((s, t) => s + ((ty.rel ? this.schema.relationshipTypes.find((r) => r.type === t)?.count : this.schema.types.find((x) => x.type === t)?.count) ?? 0), 0) : undefined
        return `a collection of ${names(ty.types, what)}${n !== undefined ? ` (${n.toLocaleString()})` : ''}${!ty.rel && ty.types ? ` — data: ${this.properties(ty.types).slice(0, 6).map((p) => p.key).join(', ')}` : ''}`
      }
      case 'types':
        return `the types in the collection: ${(ty.coll.types ?? (ty.coll.rel ? this.schema.relationshipTypes.map((r) => r.type) : this.entityTypes())).slice(0, 6).join(', ')}`
      case 'list': {
        const inner = this.describe(ty.of)
        return inner ? `a list — each ${inner}` : ty.of.k === 'name' ? `${ty.of.of} names` : 'a list'
      }
      case 'df':
        return `a DataFrame of ${names(ty.types, ty.rel ? 'relationships' : 'entities')}: ${[...(ty.rel ? ['source', 'target'] : ['label']), ...this.properties(ty.types, ty.rel).slice(0, 6).map((p) => p.key)].join(', ')}`
      case 'row':
        return `a row: ${names(ty.types, ty.rel ? 'relationship' : 'entity')}`
      case 'rollup':
        return 'a rollup row: { key, value, n, items }'
      case 'typedef':
        return 'a type definition: type, label, category, parent, properties, count'
      case 'propinfo':
        return 'a property: key, kind, count, coverage, declared'
      case 'propdef':
        return 'a declared property: key, label, kind, description, options'
      case 'tag':
        return 'a tag: tag, count, color'
      case 'project':
        return 'the open project: id, label, description, includes'
      case 'describe':
        return 'the summary: project, types, relationshipTypes, tags, metrics'
      case 'ds':
        return 'the dataset'
      case 'name':
        return `a ${ty.of} name`
      case 'number':
        return 'a number'
      case 'string':
        return 'a string'
      default:
        return undefined
    }
  }
}

// ── Bindings: the names a document gives things ─────────────────────

export interface Binding {
  name: string
  /** Where the name is bound. */
  at: number
  /** Where its scope ends, for a callback parameter (the call's closing bracket); open-ended otherwise. */
  until?: number
  /** The expression it holds, or the expression it is an element of. */
  expr: string
  element?: boolean
}

export class Bindings {
  private readonly list: Binding[]
  private readonly infer: Inference
  private readonly pos: number
  private readonly resolving = new Set<string>()

  constructor(list: Binding[], infer: Inference, pos: number) {
    this.list = list
    this.infer = infer
    this.pos = pos
  }

  /** The nearest binding of a name in scope at the cursor, else any. */
  find(name: string): Binding | undefined {
    const inScope = this.list.filter((b) => b.name === name && b.at <= this.pos && (b.until === undefined || this.pos <= b.until))
    return inScope[inScope.length - 1] ?? this.list.find((b) => b.name === name && (b.until === undefined || (b.at <= this.pos && this.pos <= b.until)))
  }

  lookup(name: string, typeOf: (expr: string) => Ty): Ty | undefined {
    const b = this.find(name)
    if (!b || this.resolving.has(name)) return undefined
    this.resolving.add(name)
    try {
      const ty = typeOf(b.expr)
      return b.element ? this.infer.element(ty) : ty
    } finally {
      this.resolving.delete(name)
    }
  }

  all(): Binding[] {
    return this.list
  }
}

/** A line split at top-level semicolons (outside brackets and strings), each piece with its offset in the line. */
function statements(line: string): { at: number; code: string }[] {
  const out: { at: number; code: string }[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ';' && depth === 0) {
      out.push({ at: start, code: line.slice(start, i) })
      start = i + 1
    }
  }
  out.push({ at: start, code: line.slice(start) })
  return out
}

/** The bindings a document makes, in order. */
export function collectBindings(doc: string, language: Language): Binding[] {
  const out: Binding[] = []
  const python = language === 'python'
  const lines = doc.split('\n')
  let offset = 0
  for (const line of lines) {
    const lineAt = offset
    offset += line.length + 1
    const stripped = python ? line.replace(/#.*$/, '') : line.replace(/\/\/.*$/, '')
    if (!stripped.trim()) continue
    for (const st of python ? [{ at: 0, code: stripped }] : statements(stripped)) {
    const at = lineAt + st.at
    const code = st.code
    if (!code.trim()) continue
    let m: RegExpExecArray | null
    if (python) {
      if ((m = /^\s*for\s+(\w+)\s+in\s+(.+?):\s*$/.exec(code))) out.push({ name: m[1], at, expr: m[2], element: true })
      else if ((m = /^\s*(\w+)\s*=\s*(?!=)(.+?)\s*$/.exec(code)) && !/^(if|while|elif|return)$/.test(m[1])) out.push({ name: m[1], at, expr: m[2] })
      // A lambda given to a collection method, and a comprehension's variable: each an element of its receiver, in scope
      // until the call or the bracket closes.
      const lam = /\.(filter|where|exclude|sort|top|map|find|some|every|forEach)\(\s*lambda\s+(\w+)/g
      while ((m = lam.exec(code))) {
        const receiver = receiverBefore(code, m.index)
        if (!receiver) continue
        const close = matchBracket(code, m.index + m[1].length + 1)
        out.push({ name: m[2], at: at + m.index, until: close < 0 ? undefined : at + close, expr: receiver, element: true })
      }
      const comp = /\bfor\s+(\w+)\s+in\s+([^\]\n]+?)(?=\s+if\b|\]|\)|$)/g
      while ((m = comp.exec(code))) {
        if (/^\s*for\b/.test(code)) break
        // Scope: the bracket the comprehension sits in — the nearest one still open at the `for`.
        let open = -1
        let depth = 0
        for (let i = m.index; i >= 0; i--) {
          const ch = code[i]
          if (ch === ']' || ch === ')' || ch === '}') depth++
          else if (ch === '[' || ch === '(' || ch === '{') {
            if (depth === 0) {
              open = i
              break
            }
            depth--
          }
        }
        const close = open >= 0 ? matchBracket(code, open) : -1
        out.push({ name: m[1], at: at + (open >= 0 ? open : m.index), until: close < 0 ? undefined : at + close, expr: m[2].trim(), element: true })
      }
      continue
    }
    // for (const x of <expr>) — the header's brackets balanced, so the expression may hold calls; every loop on the line.
    const fors = /\bfor\s*\(/g
    while ((m = fors.exec(code))) {
      const open = m.index + m[0].length - 1
      const close = matchBracket(code, open)
      const header = /^\s*(?:const|let|var)\s+(\w+)\s+of\s+(.+)$/.exec(code.slice(open + 1, close < 0 ? undefined : close))
      if (header) out.push({ name: header[1], at: at + m.index, expr: header[2].trim(), element: true })
    }
    if ((m = /\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(.+?);?\s*$/.exec(code))) {
      for (const part of m[1].split(',')) {
        const [prop, alias] = part.split(':').map((s) => s.trim())
        if (prop) out.push({ name: alias || prop, at: at + m.index, expr: `${m[2].replace(/;\s*$/, '')}.${prop}` })
      }
    } else if ((m = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?!=)(.+?);?\s*$/.exec(code))) {
      out.push({ name: m[1], at: at + m.index, expr: m[2].replace(/;\s*$/, '').replace(/\s*\{\s*$/, '') })
      // Declarations inside a callback body on the same line — `(v) => { const a = …; return … }` — bind too, each up to
      // the next statement.
      const inner = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?!=)(.+?)(?=\s*;|\s+(?:const|let|var|return)\b|\s*\}|$)/g
      inner.lastIndex = m.index + 1
      let x: RegExpExecArray | null
      while ((x = inner.exec(code))) if (x.index > m.index) out.push({ name: x[1], at: at + x.index, expr: x[2].trim() })
    }
    // main({ project, ontology, … }) — the state scaffold: each name is what ds holds.
    if ((m = /\bfunction\s+\w+\s*\(\s*\{([^}]+)\}/.exec(code))) for (const part of m[1].split(',')) {
      const name = part.split(':')[0].trim()
      if (name) out.push({ name, at: at + m.index, expr: name === 'tags' ? 'ds.tags()' : `ds.${name}` })
    }
    // Callback parameters: <receiver>.map((e) => …), .filter(e => …), ds.where((e) => …)
    const cb = /\.(map|filter|find|findLast|some|every|forEach|flatMap|where|sort|reduce)\(\s*(?:\(\s*(\w+)[^)]*\)|(\w+))\s*=>/g
    while ((m = cb.exec(code))) {
      const name = m[2] ?? m[3]
      const receiver = receiverBefore(code, m.index)
      if (!receiver || m[1] === 'reduce') continue
      // The parameter is in scope until the call closes (or the line ends, when the call spans lines).
      const close = matchBracket(code, m.index + m[1].length + 1)
      const until = close < 0 ? undefined : at + close
      out.push({ name, at: at + m.index, until, expr: m[1] === 'where' ? 'ds.entities' : receiver, element: true })
    }
    }
  }
  return out
}

// ── Parsing: the receiver before a position, and a chain ────────────

const isWord = (ch: string) => /[\w$]/.test(ch)

/**
 * The expression that ends at `end` — a chain of names, `.member`, `(…)` and
 * `[…]` read backwards over balanced brackets — as its text, or null when
 * nothing expression-like ends there.
 */
export function receiverBefore(text: string, end: number): string | null {
  let i = end
  const skipBalanced = (open: string, close: string): boolean => {
    // text[i - 1] === close
    let depth = 0
    for (let j = i - 1; j >= 0; j--) {
      const ch = text[j]
      if (ch === '"' || ch === "'" || ch === '`') {
        // Skip a string literal backwards.
        let k = j - 1
        while (k >= 0 && !(text[k] === ch && text[k - 1] !== '\\')) k--
        j = k
        continue
      }
      if (ch === close) depth++
      else if (ch === open) {
        depth--
        if (depth === 0) {
          i = j
          return true
        }
      }
    }
    return false
  }
  for (;;) {
    if (i <= 0) break
    const ch = text[i - 1]
    if (ch === ' ' || ch === '\t') {
      // Whitespace ends the receiver — unless it sits between a dot and its member (`a . b`).
      let j = i
      while (j > 0 && (text[j - 1] === ' ' || text[j - 1] === '\t')) j--
      if (j > 0 && text[j - 1] === '.' && i < end) i = j
      else break
      continue
    }
    if (ch === ')') {
      if (!skipBalanced('(', ')')) return null
      continue
    }
    if (ch === ']') {
      if (!skipBalanced('[', ']')) return null
      continue
    }
    if (isWord(ch)) {
      while (i > 0 && isWord(text[i - 1])) i--
      // A keyword before a paren is not a receiver: `if (x)`, `for (…)`, `return (…)`.
      continue
    }
    if (ch === '.') {
      let j = i - 1
      while (j > 0 && (text[j - 1] === ' ' || text[j - 1] === '\t')) j--
      if (j > 0 && (isWord(text[j - 1]) || text[j - 1] === ')' || text[j - 1] === ']')) {
        i = j
        continue
      }
    }
    break
  }
  const out = text.slice(i, end).trim()
  if (!out || /^(if|for|while|return|const|let|var|function|await|typeof|new|else|in|of|and|or|not|lambda|import|from|def|elif|with)$/.test(out.split(/[.([\s]/)[0])) return null
  return out
}

export interface Chain {
  head: { kind: 'name' | 'paren' | 'string'; text: string }
  segments: ({ kind: 'member'; name: string } | { kind: 'call'; args: string[] } | { kind: 'index'; text: string })[]
}

/** Split the inside of brackets at top-level commas. */
export function splitArgs(inner: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote) {
      cur += ch
      if (ch === '\\') cur += inner[++i] ?? ''
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** The matching close bracket for the open one at `i`, or -1. */
function matchBracket(text: string, i: number): number {
  const open = text[i]
  const close = open === '(' ? ')' : open === '[' ? ']' : '}'
  let depth = 0
  let quote: string | null = null
  for (let j = i; j < text.length; j++) {
    const ch = text[j]
    if (quote) {
      if (ch === '\\') j++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return j
    }
  }
  return -1
}

export function parseChain(text: string, python = false): Chain | null {
  let i = 0
  let head: Chain['head']
  if (text[0] === '(') {
    const j = matchBracket(text, 0)
    if (j < 0) return null
    head = { kind: 'paren', text: text.slice(1, j) }
    i = j + 1
  } else if (text[0] === '"' || text[0] === "'" || text[0] === '`') {
    const q = text[0]
    let j = 1
    while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1
    head = { kind: 'string', text: text.slice(1, j) }
    i = j + 1
  } else {
    const m = /^[A-Za-z_$][\w$]*/.exec(text)
    if (!m) return null
    head = { kind: 'name', text: m[0] }
    i = m[0].length
  }
  const segments: Chain['segments'] = []
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    if (ch === '.') {
      const m = /^\.\s*([A-Za-z_$][\w$]*)/.exec(text.slice(i))
      if (!m) return null
      segments.push({ kind: 'member', name: m[1] })
      i += m[0].length
    } else if (ch === '(') {
      const j = matchBracket(text, i)
      if (j < 0) return null
      segments.push({ kind: 'call', args: splitArgs(text.slice(i + 1, j)) })
      i = j + 1
    } else if (ch === '[') {
      const j = matchBracket(text, i)
      if (j < 0) return null
      segments.push({ kind: 'index', text: text.slice(i + 1, j) })
      i = j + 1
    } else if (ch === '?' && text[i + 1] === '.') {
      // `?.name` reads as `.name`; `?.[i]` and `?.(…)` as the bracket.
      i += text[i + 2] === '[' || text[i + 2] === '(' ? 2 : 1
    } else if (ch === '!' && !python) {
      i++
    } else return null
  }
  return { head, segments }
}
