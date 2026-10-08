import { LayoutTemplate } from 'lucide-react'
import { createEntity } from '../entity/entity'
import { defineEntityType, type EntityTypeDef } from '../entity/schema'
import type { EntityStore } from '../entity/store'
import type { AnyEntity, Entity, EntityData, EntityId } from '../entity/types'
import type { ConstraintApplies, ConstraintEntity, ConstraintRule, ConstraintScope } from './constraint'

/**
 * Constraint templates: a rule with holes. A template declares its
 * parameters (a type, a relationship, a path, a number…) and renders a
 * constraint from a filled-in form — the form the Ontology page draws and
 * the `constraint {action: "templates"}` tool describes come from the same
 * declaration, so an agent and a person fill the same fields.
 *
 * Built-in templates cover the invariants most ontologies want and render
 * to the cheapest rule that states them (declarative where they can,
 * code where they must). A user template is an entity of type
 * `constraint-template`: code in the rule vocabulary that reads its
 * parameters as `params.<name>`, and the same parameter declarations. A
 * constraint made from one keeps the template's id, so editing the
 * template's code changes every constraint made from it.
 */

export const CONSTRAINT_TEMPLATE_TYPE = 'constraint-template'

export type ParamKind = 'type' | 'types' | 'relationship' | 'path' | 'string' | 'number' | 'boolean' | 'regex' | 'list' | 'enum'

export interface ParamSpec {
  name: string
  label?: string
  /** What the form draws: a type picker, a relationship picker, a path, a number… */
  kind: ParamKind
  /** For `enum`. */
  options?: string[]
  default?: unknown
  required?: boolean
  doc?: string
}

export interface Rendered {
  label: string
  applies: ConstraintApplies
  rule: ConstraintRule
  message?: string
}

export interface ConstraintTemplate {
  id: string
  label: string
  description: string
  scope: ConstraintScope
  params: ParamSpec[]
  /** Built-in templates render in code; user ones from their `code` and `applies`. */
  render: (params: Record<string, unknown>) => Rendered
  builtin: boolean
  /** For a user template: the entity. */
  entity?: TemplateEntity
}

export interface TemplateData extends EntityData {
  scope?: ConstraintScope
  params: ParamSpec[]
  /** Code in the rule vocabulary of the scope; the parameters are bound as `params`. */
  code: string
  /** What an entity-scoped rule watches; string values may hold `{{name}}` for a parameter (a `types` parameter expands to a list). */
  applies?: ConstraintApplies
  /** The constraint's name, with `{{name}}` holes. */
  labelPattern?: string
  message?: string
}
export type TemplateEntity = Entity<TemplateData>
export const isTemplateEntity = (e: AnyEntity | undefined): e is TemplateEntity => !!e && e.kind === 'entity' && e.type === CONSTRAINT_TEMPLATE_TYPE && typeof (e.data as Partial<TemplateData>).code === 'string'

export const constraintTemplateType: EntityTypeDef = defineEntityType({
  type: CONSTRAINT_TEMPLATE_TYPE,
  label: 'Constraint template',
  pluralLabel: 'Constraint templates',
  category: 'project',
  icon: LayoutTemplate,
  color: '#a16207',
  description: 'A constraint with holes: code in the rule vocabulary plus the parameters a form asks for. Constraints made from it keep its id and follow its code.',
  fields: [
    { key: 'data.scope', label: 'Scope', kind: 'text', width: 70 },
    { key: 'data.params', label: 'Parameters', kind: 'json', width: 200, format: (v) => (Array.isArray(v) ? (v as ParamSpec[]).map((p) => p.name).join(', ') : '') },
  ],
})

// ── Rendering ────────────────────────────────────────────────────────────

const str = (v: unknown) => (v === undefined || v === null ? '' : Array.isArray(v) ? v.map(String).join(', ') : String(v))
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' ? v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : [])
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v))
const q = (s: string) => JSON.stringify(s)

/** Fill `{{name}}` holes in a string. */
export const fill = (s: string, params: Record<string, unknown>) => s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => str(params[k]))

/** Coerce raw values (from a form or a tool call) to what each parameter wants; throws naming a missing required one. */
export function coerceParams(specs: ParamSpec[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of specs) {
    let v = raw[p.name] ?? p.default
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
    if (empty) {
      if (p.required !== false) throw new Error(`The parameter “${p.label ?? p.name}” is required.`)
      continue
    }
    if (p.kind === 'number') {
      v = num(v)
      if (Number.isNaN(v)) throw new Error(`“${p.label ?? p.name}” must be a number.`)
    } else if (p.kind === 'boolean') v = v === true || v === 'true'
    else if (p.kind === 'types' || p.kind === 'list') v = list(v)
    else if (p.kind === 'regex') {
      v = String(v)
      new RegExp(v as string)
    } else if (p.kind === 'enum') {
      v = String(v)
      if (p.options && !p.options.includes(v as string)) throw new Error(`“${p.label ?? p.name}” must be one of ${p.options.join(', ')}.`)
    } else v = String(v).trim()
    out[p.name] = v
  }
  return out
}

const T = (t: Omit<ConstraintTemplate, 'builtin'>): ConstraintTemplate => ({ ...t, builtin: true })
const type = (doc = 'The type the rule watches'): ParamSpec => ({ name: 'type', label: 'Type', kind: 'type', required: true, doc })
const rel = (doc = 'The relationship type'): ParamSpec => ({ name: 'rel', label: 'Relationship', kind: 'relationship', required: true, doc })
const path = (name = 'path', label = 'Property', doc = 'A path on the entity: label, data.<key>, tags'): ParamSpec => ({ name, label, kind: 'path', required: true, doc })
const watch = (p: Record<string, unknown>, kinds?: ('entity' | 'relationship')[]): ConstraintApplies => ({ ...(kinds ? { kinds } : {}), types: [String(p.type)] })

/**
 * The built-in templates. Each renders to the cheapest rule that states
 * it: the declarative parts of a rule where they fit, code — entity- or
 * graph-scoped — where they do not.
 */
export const BUILTIN_TEMPLATES: ConstraintTemplate[] = [
  T({
    id: 'required',
    label: 'A property is required',
    description: 'Every entity of a type carries a property (set and not empty).',
    scope: 'entity',
    params: [type(), path()],
    render: (p) => ({ label: `${p.type} must have ${p.path}`, applies: watch(p), rule: { required: [String(p.path)] } }),
  }),
  T({
    id: 'unique',
    label: 'A property is unique',
    description: 'No two entities of a type share a value at a path.',
    scope: 'entity',
    params: [type(), path()],
    render: (p) => ({ label: `${p.type}: ${p.path} is unique`, applies: watch(p), rule: { unique: [String(p.path)] } }),
  }),
  T({
    id: 'label-pattern',
    label: 'Labels match a pattern',
    description: 'Every label of a type matches a regular expression.',
    scope: 'entity',
    params: [type(), { name: 'pattern', label: 'Pattern', kind: 'regex', required: true, doc: 'A regular expression, e.g. ^[A-Z]' }],
    render: (p) => ({ label: `${p.type} labels match /${p.pattern}/`, applies: watch(p), rule: { labelPattern: String(p.pattern) } }),
  }),
  T({
    id: 'value-in',
    label: 'A property takes one of some values',
    description: 'A property, when set, is one of a fixed set of values.',
    scope: 'entity',
    params: [type(), path(), { name: 'values', label: 'Allowed values', kind: 'list', required: true, doc: 'Comma-separated' }],
    render: (p) => ({ label: `${p.type}: ${p.path} is one of ${str(p.values)}`, applies: watch(p), rule: { js: `!has(${q(String(p.path))}) || params.values.includes(String(get(${q(String(p.path))}))) || ${q(`${p.path} must be one of ${str(p.values)}`)}` } }),
  }),
  T({
    id: 'range',
    label: 'A number is within a range',
    description: 'A numeric property, when set, lies between a minimum and a maximum (either may be left open).',
    scope: 'entity',
    params: [type(), path(), { name: 'min', label: 'Minimum', kind: 'number', required: false }, { name: 'max', label: 'Maximum', kind: 'number', required: false }],
    render: (p) => {
      const fields: ConstraintRule['fields'] = []
      if (p.min !== undefined) fields.push({ path: String(p.path), op: 'gte', value: p.min })
      if (p.max !== undefined) fields.push({ path: String(p.path), op: 'lte', value: p.max })
      if (!fields.length) throw new Error('Give a minimum, a maximum, or both.')
      return { label: `${p.type}: ${p.path} in [${p.min ?? '…'}, ${p.max ?? '…'}]`, applies: watch(p), rule: { js: `!has(${q(String(p.path))}) || (typeof get(${q(String(p.path))}) === 'number' && ${p.min !== undefined ? `get(${q(String(p.path))}) >= params.min` : 'true'} && ${p.max !== undefined ? `get(${q(String(p.path))}) <= params.max` : 'true'}) || ${q(`${p.path} must be a number between ${p.min ?? '−∞'} and ${p.max ?? '∞'}`)}` } }
    },
  }),
  T({
    id: 'date-order',
    label: 'One date comes before another',
    description: 'When both are set, one property is not after another (born before died, started before ended).',
    scope: 'entity',
    params: [type(), path('before', 'Earlier', 'The property that must not come later'), path('after', 'Later', 'The property that must not come earlier')],
    render: (p) => ({ label: `${p.type}: ${p.before} ≤ ${p.after}`, applies: watch(p), rule: { js: `!has(params.before) || !has(params.after) || get(params.before) <= get(params.after) || ${q(`${p.before} must not come after ${p.after}`)}` } }),
  }),
  T({
    id: 'relationship-ends',
    label: 'What a relationship may join',
    description: 'A relationship type only joins entities of some types.',
    scope: 'entity',
    params: [rel(), { name: 'source', label: 'Source types', kind: 'types', required: false }, { name: 'target', label: 'Target types', kind: 'types', required: false }],
    render: (p) => {
      const ends: NonNullable<ConstraintRule['ends']> = {}
      if (list(p.source).length) ends.source = list(p.source)
      if (list(p.target).length) ends.target = list(p.target)
      if (!Object.keys(ends).length) throw new Error('Give source types, target types, or both.')
      return { label: `${p.rel} joins ${ends.source?.join('|') ?? 'anything'} → ${ends.target?.join('|') ?? 'anything'}`, applies: { kinds: ['relationship'], types: [String(p.rel)] }, rule: { ends } }
    },
  }),
  T({
    id: 'no-self-links',
    label: 'No self-links',
    description: 'A relationship type never joins an entity to itself.',
    scope: 'entity',
    params: [rel()],
    render: (p) => ({ label: `${p.rel} has no self-links`, applies: { kinds: ['relationship'], types: [String(p.rel)] }, rule: { ends: { noSelf: true } } }),
  }),
  T({
    id: 'at-most',
    label: 'At most n relationships per entity',
    description: 'An entity has at most n relationships of a type leaving it (or reaching it).',
    scope: 'entity',
    params: [rel(), { name: 'end', label: 'Counted at', kind: 'enum', options: ['source', 'target'], default: 'source', required: true }, { name: 'n', label: 'At most', kind: 'number', required: true }],
    render: (p) => ({ label: `≤ ${p.n} ${p.rel} per ${p.end}`, applies: { kinds: ['relationship'], types: [String(p.rel)] }, rule: { ends: p.end === 'target' ? { maxPerTarget: num(p.n) } : { maxPerSource: num(p.n) } } }),
  }),
  T({
    id: 'at-least',
    label: 'At least n relationships per entity',
    description: 'Every entity of a type has at least n relationships of a type (leaving, arriving, or either) — a paper has an author, a task has an owner.',
    scope: 'graph',
    params: [type(), rel(), { name: 'dir', label: 'Direction', kind: 'enum', options: ['out', 'in', 'both'], default: 'both', required: true }, { name: 'n', label: 'At least', kind: 'number', default: 1, required: true }],
    render: (p) => ({
      label: `every ${p.type} has ≥ ${p.n} ${p.rel}`,
      applies: {},
      rule: { js: `ofType(params.type).filter((x) => (params.dir === 'out' ? out(x, params.rel) : params.dir === 'in' ? inn(x, params.rel) : links(x, params.rel)).length < params.n).map((x) => violation(x, ${q(`needs at least ${p.n} ${p.rel}`)}))` },
    }),
  }),
  T({
    id: 'acyclic',
    label: 'No cycles',
    description: 'Relationships of a type never form a cycle (parent, depends-on, includes).',
    scope: 'graph',
    params: [rel()],
    render: (p) => ({ label: `${p.rel} is acyclic`, applies: {}, rule: { js: `const c = cycle(params.rel)\nreturn c ? c.map((id) => violation(id, ${q(`on a ${p.rel} cycle: `)} + c.join(' → '))) : true` } }),
  }),
  T({
    id: 'no-orphans',
    label: 'No orphans',
    description: 'Every entity of a type has at least one relationship of any type.',
    scope: 'graph',
    params: [type()],
    render: (p) => ({ label: `no orphan ${p.type}`, applies: {}, rule: { js: `ofType(params.type).filter((x) => !degree(x)).map((x) => violation(x, 'has no relationships'))` } }),
  }),
  T({
    id: 'max-count',
    label: 'At most n entities of a type',
    description: 'The dataset holds at most n entities of a type.',
    scope: 'graph',
    params: [type(), { name: 'n', label: 'At most', kind: 'number', required: true }],
    render: (p) => ({ label: `≤ ${p.n} ${p.type}`, applies: {}, rule: { js: `count(ofType(params.type)) <= params.n || ${q(`more than ${p.n} ${p.type}`)}` } }),
  }),
  T({
    id: 'declared-types',
    label: 'Every type in use is declared',
    description: 'Ontology: every entity type in use has a definition (a schema:type entity, or one in code) — no inferred types.',
    scope: 'graph',
    params: [{ name: 'allow', label: 'Also allowed', kind: 'types', required: false, doc: 'Types that need no definition' }],
    render: () => ({
      label: 'every type in use is declared',
      applies: {},
      rule: { js: `const declared = new Set([...ofType('schema:type').map((d) => d.data.name), ...(params.allow ?? []), 'schema:type', 'project', 'constraint', 'constraint-template', 'script'])\nreturn types().filter((t) => !declared.has(t)).map((t) => \`type \${t} is in use but not declared\`)` },
    }),
  }),
  T({
    id: 'declared-properties',
    label: 'Every property is declared on its type',
    description: 'Ontology: entities of a type carry only the properties its definition (or an ancestor’s) declares.',
    scope: 'graph',
    params: [type(), { name: 'allow', label: 'Also allowed', kind: 'list', required: false, doc: 'Property keys that need no declaration' }],
    render: (p) => ({
      label: `${p.type} carries only declared properties`,
      applies: {},
      rule: {
        js: `const defs = new Map(ofType('schema:type').map((d) => [d.data.name, d]))
const declared = new Set(params.allow ?? [])
for (let t = params.type, seen = 0; t && seen < 20; t = defs.get(t)?.data.parent, seen++) for (const prop of defs.get(t)?.data.properties ?? []) declared.add(prop.key)
return ofType(params.type).flatMap((x) => Object.keys(x.data ?? {}).filter((k) => !declared.has(k)).map((k) => violation(x, \`property \${k} is not declared on \${params.type}\`)))`,
      },
    }),
  }),
  T({
    id: 'types-described',
    label: 'Every declared type has a description',
    description: 'Ontology: every schema:type entity carries a description.',
    scope: 'graph',
    params: [],
    render: () => ({ label: 'every type is described', applies: {}, rule: { js: `ofType('schema:type').filter((d) => !has(d, 'description')).map((d) => violation(d, 'type ' + d.data.name + ' has no description'))` } }),
  }),
]

/** A user template entity as a template. */
export function templateOf(e: TemplateEntity): ConstraintTemplate {
  const d = e.data
  const scope: ConstraintScope = d.scope ?? 'entity'
  return {
    id: e.id,
    label: e.label ?? e.id,
    description: e.description ?? '',
    scope,
    params: Array.isArray(d.params) ? d.params : [],
    builtin: false,
    entity: e,
    render: (params) => {
      const applies: ConstraintApplies = {}
      const a = d.applies ?? {}
      if (a.kinds?.length) applies.kinds = a.kinds
      const expand = (xs: string[] | undefined) => xs?.flatMap((x) => (/^\{\{\s*[\w.]+\s*\}\}$/.test(x) ? list(params[x.replace(/[{}\s]/g, '')]) : [fill(x, params)])).filter(Boolean)
      if (a.types?.length) applies.types = expand(a.types)
      if (a.tags?.length) applies.tags = expand(a.tags)
      return { label: d.labelPattern ? fill(d.labelPattern, params) : `${e.label ?? e.id}${Object.keys(params).length ? ` (${Object.values(params).map(str).join(', ')})` : ''}`, applies, rule: { js: d.code }, message: d.message ? fill(d.message, params) : undefined }
    },
  }
}

export function createTemplate(init: { id?: EntityId; label: string; description?: string; scope?: ConstraintScope; params?: ParamSpec[]; code: string; applies?: ConstraintApplies; labelPattern?: string; message?: string }): TemplateEntity {
  return createEntity<TemplateData>({
    id: init.id,
    type: CONSTRAINT_TEMPLATE_TYPE,
    label: init.label,
    description: init.description,
    tags: [],
    data: { code: init.code, params: init.params ?? [], ...(init.scope && init.scope !== 'entity' ? { scope: init.scope } : {}), ...(init.applies ? { applies: init.applies } : {}), ...(init.labelPattern ? { labelPattern: init.labelPattern } : {}), ...(init.message ? { message: init.message } : {}) },
    meta: { source: 'user' },
  })
}

/** Every template: the built-ins, then the user's (the Library's and the open project's). */
export function listTemplates(store: EntityStore): ConstraintTemplate[] {
  return [...BUILTIN_TEMPLATES, ...store.ofType(CONSTRAINT_TEMPLATE_TYPE).filter(isTemplateEntity).map(templateOf)]
}

export function findTemplate(store: EntityStore, id: string): ConstraintTemplate | undefined {
  const b = BUILTIN_TEMPLATES.find((t) => t.id === id)
  if (b) return b
  const e = store.get(id)
  return isTemplateEntity(e) ? templateOf(e) : undefined
}

/** Render a template with raw parameters: coerced, checked, and the rule built. */
export function instantiate(template: ConstraintTemplate, raw: Record<string, unknown>): Rendered & { scope: ConstraintScope; params: Record<string, unknown> } {
  const params = coerceParams(template.params, raw)
  return { ...template.render(params), scope: template.scope, params }
}

/**
 * The rule a constraint runs: a constraint from a user template follows the
 * template's current code and scope (editing a template changes every
 * constraint made from it); anything else runs what it stores.
 */
export function effectiveRule(store: EntityStore, c: ConstraintEntity): { rule: ConstraintRule; applies: ConstraintApplies; scope: ConstraintScope; params: Record<string, unknown> } {
  const params = c.data.params ?? {}
  if (c.data.template) {
    const e = store.get(c.data.template)
    if (isTemplateEntity(e)) {
      try {
        const r = templateOf(e).render(params)
        return { rule: r.rule, applies: r.applies, scope: e.data.scope ?? 'entity', params }
      } catch {
        // A template whose parameters no longer fit: the stored rendering stands.
      }
    }
  }
  return { rule: c.data.rule ?? {}, applies: c.data.applies ?? {}, scope: c.data.scope ?? 'entity', params }
}

/** The parameters of a template as a JSON schema, for a tool's description. */
export function paramsSchema(specs: ParamSpec[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const p of specs) {
    const base: Record<string, unknown> = { description: [p.label, p.doc].filter(Boolean).join(' — ') || undefined }
    if (p.kind === 'number') base.type = 'number'
    else if (p.kind === 'boolean') base.type = 'boolean'
    else if (p.kind === 'types' || p.kind === 'list') {
      base.type = 'array'
      base.items = { type: 'string' }
    } else {
      base.type = 'string'
      if (p.kind === 'enum' && p.options) base.enum = p.options
    }
    if (p.default !== undefined) base.default = p.default
    properties[p.name] = base
  }
  return { type: 'object', properties, required: specs.filter((p) => p.required !== false).map((p) => p.name) }
}
