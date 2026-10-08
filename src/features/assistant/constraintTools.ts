import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { CONSTRAINT_TYPE, createConstraint, describeRule, describeWatches, inForce, isConstraint, scopeOf, type ConstraintApplies, type ConstraintEntity, type ConstraintRule, type ConstraintScope, type Severity, type Violation } from '../../core/constraints/constraint'
import { ConstraintEngine } from '../../core/constraints/engine'
import { GRAPH_HELPERS, loadRuleRealm, RULE_HELPERS } from '../../core/constraints/rules'
import { CONSTRAINT_TEMPLATE_TYPE, createTemplate, findTemplate, instantiate, isTemplateEntity, listTemplates, paramsSchema, type ParamSpec } from '../../core/constraints/templates'
import { displayLabel } from '../../core/entity/entity'
import type { EntityId } from '../../core/entity/types'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import { normalizeEntity } from '../../core/exchange/formats'
import { FIELD_OPS } from '../../core/graph/fields'
import { listProjects, projectLabel } from '../../core/projects/project'
import { auditScripted } from '../scripts/constraints'
import { isScript, markScriptUse } from '../scripts/script'
import { json } from './toolkit'
import type { AppHost } from './tools'

/**
 * Constraints over MCP: what rules are in force, define or change one — by
 * hand, from a template, or backed by a script — scope it to a project,
 * enable and disable it, audit the data against them, and check a
 * would-be entity without adding it. A rejected create_entity /
 * create_relationship / update_entity already comes back as an error
 * naming the constraint; this is how an agent finds the rules first, and
 * writes new ones.
 */

const vocab = (hs: typeof RULE_HELPERS) => hs.map((h) => h.signature).join(', ')

const RULE_SCHEMA = {
  type: 'object',
  description: 'What must hold. Declarative parts are cheap and explain themselves; `js` is for anything else; `script` hands the judgement to a saved script.',
  properties: {
    required: { type: 'array', items: { type: 'string' }, description: 'Paths that must be present and not empty: label, description, tags, data.<key>, meta.<key>' },
    forbidden: { type: 'array', items: { type: 'string' }, description: 'Paths that must be absent' },
    fields: {
      type: 'array',
      description: 'Conditions in the filter language, all of which must hold, e.g. {path:"data.year", op:"gte", value:1900}',
      items: { type: 'object', properties: { path: { type: 'string' }, op: { type: 'string', enum: FIELD_OPS.map((o) => o.id) }, value: { description: 'Scalar; [lo, hi] for between; list for in; omitted for exists' } }, required: ['path', 'op'], additionalProperties: false },
    },
    unique: { type: 'array', items: { type: 'string' }, description: 'Paths whose value must be unique among entities of the same type' },
    labelPattern: { type: 'string', description: 'A regular expression the label must match' },
    ends: {
      type: 'object',
      description: 'For relationships: what they may join',
      properties: {
        source: { type: 'array', items: { type: 'string' }, description: 'Types the source may have' },
        target: { type: 'array', items: { type: 'string' }, description: 'Types the target may have' },
        sameType: { type: 'boolean' },
        noSelf: { type: 'boolean' },
        maxPerSource: { type: 'integer', minimum: 0, description: 'At most this many relationships of the type may leave one source' },
        maxPerTarget: { type: 'integer', minimum: 0 },
        endsExist: { type: 'boolean', description: 'Both ends must exist (or arrive in the same write)' },
      },
      additionalProperties: false,
    },
    js: {
      type: 'string',
      description: `JavaScript in the rule vocabulary of the constraint's scope; with a \`return\` it is a function body, otherwise an expression. Scope entity — over e, the entity being written; true passes, false or a string (the message) fails: ${vocab(RULE_HELPERS)}. E.g. "has('data.born') && get('data.born') > 1000 || 'needs a plausible birth year'". Scope graph — over the whole dataset as it would stand after the write; true passes, false or a string fails the write, a list of violation(id, message) names the entities at fault: ${vocab(GRAPH_HELPERS)}. E.g. "ofType('paper').filter((p) => !inn(p, 'wrote').length).map((p) => violation(p, 'no author'))" or "cycle('parent') ? 'parent must not cycle' : true". A template's parameters are bound as params.`,
    },
    script: { type: 'string', description: 'The id of a saved script (see the script tool) that judges the whole dataset in the sandbox — JavaScript or Python over ds — returning true, a message, a list of {id, message}, or a table/DataFrame with id and message columns. Asynchronous: checked by audit, not at write time.' },
  },
  additionalProperties: false,
} as const

const APPLIES_SCHEMA = {
  type: 'object',
  description: 'Scope entity: which entities the rule watches (default: every entity and relationship). Ignored for scope graph.',
  properties: {
    kinds: { type: 'array', items: { type: 'string', enum: ['entity', 'relationship'] } },
    types: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' }, description: 'Only entities carrying any of these tags' },
  },
  additionalProperties: false,
} as const

const PARAM_SPEC_SCHEMA = {
  type: 'array',
  description: 'define_template: the parameters the template asks for; each becomes a field of its form and a key of params',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      label: { type: 'string' },
      kind: { type: 'string', enum: ['type', 'types', 'relationship', 'path', 'string', 'number', 'boolean', 'regex', 'list', 'enum'] },
      options: { type: 'array', items: { type: 'string' }, description: 'For kind enum' },
      default: {},
      required: { type: 'boolean', description: 'Default true' },
      doc: { type: 'string' },
    },
    required: ['name', 'kind'],
    additionalProperties: false,
  },
} as const

export function createConstraintTools(host: AppHost) {
  const { store } = host
  const registry = () => host.registry ?? new TypeRegistry(store)
  const engine = new ConstraintEngine(store)

  const project = (c: ConstraintEntity) => (c.meta.projects?.length ? c.meta.projects.map((p) => ({ id: p, label: projectLabel(store, p) })) : 'library')
  const summary = (c: ConstraintEntity) => ({
    id: c.id,
    label: displayLabel(c),
    description: c.description,
    enabled: c.data.enabled !== false,
    inForce: inForce(c, store.scope),
    severity: c.data.severity ?? 'reject',
    scope: scopeOf(c),
    watches: describeWatches(c),
    rule: describeRule(c.data.rule ?? {}),
    ...(c.data.template ? { template: c.data.template, params: c.data.params ?? {} } : {}),
    spec: { applies: c.data.applies, rule: c.data.rule, message: c.data.message },
    project: project(c),
  })
  const templateSummary = (t: ReturnType<typeof listTemplates>[number]) => ({ id: t.id, label: t.label, description: t.description, scope: t.scope, builtin: t.builtin, params: t.params, paramsSchema: paramsSchema(t.params), ...(t.entity ? { code: t.entity.data.code, applies: t.entity.data.applies } : {}) })

  /** A project by id or label, `library` for none, or undefined to leave the scope as it is. */
  const resolveProject = (p: string | undefined): EntityId[] | null | undefined => {
    if (p === undefined) return undefined
    if (/^(library|none|all|global)$/i.test(p)) return null
    const list = listProjects(store)
    const hit = list.find((x) => x.id === p) ?? list.find((x) => (x.label ?? '').toLowerCase() === p.toLowerCase())
    if (!hit) throw new Error(`No project “${p}”. Use project_list, or "library" for a constraint that applies everywhere.`)
    return [hit.id]
  }
  const setProject = (c: ConstraintEntity, projects: EntityId[] | null) => {
    const cur = c.meta.projects ?? []
    for (const p of cur) if (!projects?.includes(p)) store.unmark([c.id], p)
    for (const p of projects ?? []) if (!cur.includes(p)) store.mark([c.id], p)
  }
  const require = (id: string | undefined) => {
    const c = store.get(id ?? '')
    if (!isConstraint(c)) throw new Error(`No constraint with id ${id}. Use constraint {action:"list"}.`)
    return c
  }
  const audit = async (types: string[] | undefined, limit: number) => {
    const r = engine.audit({ types, limit })
    const scripted = engine.scripted()
    const s = scripted.length ? await auditScripted(store, registry(), engine) : { violations: [] as Violation[], runs: [] }
    const list = [...r.violations, ...(types ? s.violations.filter((v) => !v.entityId || types.includes(store.get(v.entityId)?.type ?? '')) : s.violations)].slice(0, limit)
    return { checked: r.checked, violations: list.length, inForce: engine.active().length, scripted: s.runs, list }
  }

  const constraint = betaTool({
    name: 'constraint',
    description:
      'The constraint engine: rules the ES, the ontology and the graph must satisfy. Scope entity (default): a rule every new or changed entity must satisfy to get into the store — a write that fails a rejecting constraint is refused (create_entity and friends return the reason), a warning one is reported. Scope graph: an invariant over the whole dataset, judged once per write over the store as it would stand afterwards (no cycles through parent, every paper has an author, every type in use is declared, at most n of a type) — only what a write introduces is held against it; what was already violated is the audit\'s business. Constraints are entities of type "constraint" (category project: they travel with a project\'s bundle). They are scoped to projects: pass `project` (an id, a label, or "library" for everywhere) on define/update; without it, one made while a project is open belongs to that project. Enable and disable with the actions of those names.\n\nActions: list (the rules, their scope, project and whether in force), templates (the built-in and user templates with their parameter forms — the quickest way to state a common invariant), define (create one: either `template` + `params`, or label + rule [+ applies, scope]; severity reject|warn, message, description, project), update (change fields by id — label, rule, applies, scope, params, severity, message, project…), enable, disable, delete, audit (every violation in the data as it stands, including script-backed constraints, optionally for some types), check (would this entity be accepted? pass `entity` as it would go to create_entity; nothing is written), define_template (a reusable rule with holes: label, description, scope, params, code in the rule vocabulary reading params.<name>, applies with {{name}} holes, label_pattern), delete_template. Most constraints are best written as code: the js rule of scope entity or graph (it runs in a QuickJS sandbox with the rule vocabulary only — no network, no host objects, `store` read-only — and a budget of 250 ms per entity, 5 s per graph run), or `rule.script` naming a saved script (JavaScript or Python over ds, run in the sandbox by the audit).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'templates', 'define', 'update', 'enable', 'disable', 'delete', 'audit', 'check', 'define_template', 'delete_template'] },
        id: { type: 'string', description: 'update/enable/disable/delete: the constraint id; delete_template: the template id' },
        label: { type: 'string' },
        description: { type: 'string', description: 'Why the rule exists — for people and for agents' },
        scope: { type: 'string', enum: ['entity', 'graph'], description: 'entity (each entity of a write on its own; default) or graph (the whole dataset at once)' },
        applies: APPLIES_SCHEMA,
        rule: RULE_SCHEMA,
        template: { type: 'string', description: 'define: the template id (see action templates) to render the rule from, with params' },
        params: { type: 'object', description: 'define/update: the template’s parameters, by name; also bound as `params` in a js rule', additionalProperties: true },
        severity: { type: 'string', enum: ['reject', 'warn'] },
        enabled: { type: 'boolean' },
        message: { type: 'string', description: 'Shown when the rule fails, before the detail' },
        project: { type: 'string', description: 'define/update: the project the constraint belongs to (id or label), or "library" for one that applies everywhere' },
        types: { type: 'array', items: { type: 'string' }, description: 'audit: only violations on these types' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'audit: at most this many violations (default 200)' },
        entity: { type: 'object', description: 'check: the entity as a record (id optional, type, label, tags, data; source/target for a relationship)', additionalProperties: true },
        code: { type: 'string', description: 'define_template: the rule in the vocabulary of the template’s scope, reading its parameters as params.<name>' },
        param_specs: PARAM_SPEC_SCHEMA,
        label_pattern: { type: 'string', description: 'define_template: the name constraints made from it get, with {{name}} holes' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, id, label, description, scope, applies, rule, template, params, severity, enabled, message, project: projectArg, types, limit, entity, code, param_specs, label_pattern }) => {
      // A js rule runs in the QuickJS realm, which loads once: every verdict this call returns must include it.
      if (action !== 'list' && action !== 'templates') await loadRuleRealm()
      if (action === 'list') {
        const all = store.library.ofType(CONSTRAINT_TYPE).filter(isConstraint)
        return json({ scope: store.scope ? { id: store.scope, label: projectLabel(store, store.scope) } : 'library', constraints: all.map(summary) })
      }
      if (action === 'templates') return json({ templates: listTemplates(store).map(templateSummary), hint: 'constraint {action:"define", template:<id>, params:{…}} renders one; a user template is made with define_template.' })
      if (action === 'define') {
        const projects = resolveProject(projectArg)
        let c: ConstraintEntity
        if (template) {
          const t = findTemplate(store, template)
          if (!t) throw new Error(`No template “${template}”. Use constraint {action:"templates"}.`)
          const r = instantiate(t, (params ?? {}) as Record<string, unknown>)
          c = createConstraint({ label: label ?? r.label, description, applies: r.applies, rule: r.rule, scope: r.scope, template: t.id, params: r.params, severity: (severity ?? 'reject') as Severity, enabled: enabled ?? true, message: message ?? r.message, projects: projects ?? undefined })
        } else {
          if (!label) throw new Error('define needs a label (or a template).')
          if (!rule || !Object.keys(rule).length) throw new Error('define needs a rule with at least one condition, or a template.')
          if (rule.script && !isScript(store.get(rule.script))) throw new Error(`No script with id ${rule.script}. Use script {action:"list"}.`)
          c = createConstraint({ label, description, applies: (applies ?? {}) as ConstraintApplies, rule: rule as ConstraintRule, scope: (scope ?? 'entity') as ConstraintScope, params: params as Record<string, unknown> | undefined, severity: (severity ?? 'reject') as Severity, enabled: enabled ?? true, message, projects: projects ?? undefined })
        }
        // A Library constraint asked for while a project is open must not be auto-marked with the project.
        if (projects === null && store.scope) c = { ...c, meta: { ...c.meta, projects: [] } }
        store.upsert(c)
        if (projects === null && store.scope) store.unmark([c.id], store.scope)
        if (c.data.rule.script) markScriptUse(store, c.data.rule.script, 'constraint')
        const saved = store.get(c.id) as ConstraintEntity
        const compiled = engine.active().find((x) => x.entity.id === c.id)
        return json({ defined: summary(saved), ...(compiled?.jsError ? { error: compiled.jsError } : {}), audit: saved.data.rule.script ? 'script-backed: run audit to judge it' : engine.audit({ limit: 20, types: saved.data.applies?.types }) })
      }
      if (action === 'update' || action === 'enable' || action === 'disable') {
        const c = require(id)
        const data = { ...c.data }
        if (action === 'enable') data.enabled = true
        else if (action === 'disable') data.enabled = false
        else {
          if (applies) data.applies = applies as ConstraintApplies
          if (rule) {
            if (rule.script && !isScript(store.get(rule.script))) throw new Error(`No script with id ${rule.script}. Use script {action:"list"}.`)
            data.rule = rule as ConstraintRule
            if (rule.script) markScriptUse(store, rule.script, 'constraint')
          }
          if (scope) data.scope = scope as ConstraintScope
          if (severity) data.severity = severity as Severity
          if (enabled !== undefined) data.enabled = enabled
          if (message !== undefined) data.message = message || undefined
          if (params) {
            // New parameters for a templated constraint re-render its rule; for a plain one they are just rebound.
            const t = c.data.template ? findTemplate(store, c.data.template) : undefined
            if (t) {
              const r = instantiate(t, { ...(c.data.params ?? {}), ...(params as Record<string, unknown>) })
              data.params = r.params
              data.rule = r.rule
              data.applies = r.applies
              data.scope = r.scope
            } else data.params = { ...(c.data.params ?? {}), ...(params as Record<string, unknown>) }
          }
        }
        const next = store.update(c.id, { ...(label ? { label } : {}), ...(description !== undefined ? { description } : {}), data })
        const projects = resolveProject(projectArg)
        if (projects !== undefined) setProject(next as ConstraintEntity, projects)
        return json({ updated: summary(store.get(c.id) as ConstraintEntity) })
      }
      if (action === 'delete') {
        const c = require(id)
        store.remove([c.id])
        return json({ deleted: c.id })
      }
      if (action === 'audit') return json(await audit(types, limit ?? 200))
      if (action === 'define_template') {
        if (!label) throw new Error('define_template needs a label.')
        if (!code) throw new Error('define_template needs code in the rule vocabulary (reading its parameters as params.<name>).')
        const t = createTemplate({ label, description, scope: (scope ?? 'entity') as ConstraintScope, params: (param_specs ?? []) as ParamSpec[], code, applies: applies as ConstraintApplies | undefined, labelPattern: label_pattern, message })
        store.upsert(t)
        return json({ defined: templateSummary(findTemplate(store, t.id)!), hint: `constraint {action:"define", template:"${t.id}", params:{…}} makes a constraint from it.` })
      }
      if (action === 'delete_template') {
        const t = store.get(id ?? '')
        if (!isTemplateEntity(t)) throw new Error(`No template with id ${id}. Built-in templates cannot be deleted.`)
        const made = store.library.ofType(CONSTRAINT_TYPE).filter(isConstraint).filter((c) => c.data.template === t.id)
        store.remove([t.id])
        return json({ deleted: t.id, note: made.length ? `${made.length} constraint${made.length === 1 ? '' : 's'} made from it keep their last rendered rule.` : undefined })
      }
      // check
      if (!entity) throw new Error('check needs an entity.')
      const e = normalizeEntity(entity, 'candidate')
      if (!e) throw new Error('That is not an entity: give it at least a type.')
      const r = engine.check([e], { previous: (x) => store.get(x) })
      return json({ accepted: r.rejected.length === 0, violations: r.violations, inForce: engine.active().filter((c) => engine.applies(c, e) || c.scope === 'graph').map((c) => c.entity.label), note: engine.scripted().length ? 'Script-backed constraints are not checked here; run audit.' : undefined })
    },
  })

  return [constraint]
}

export { CONSTRAINT_TEMPLATE_TYPE }
