import { ShieldCheck } from 'lucide-react'
import { createEntity } from '../entity/entity'
import { defineEntityType, type EntityTypeDef } from '../entity/schema'
import type { AnyEntity, Entity, EntityData, EntityId } from '../entity/types'
import type { FieldPredicate } from '../graph/fields'

/**
 * A constraint: a rule every entity (or relationship) of some kind must
 * satisfy before it gets into the store. Constraints are entities of the
 * `project` category — they travel with a project's bundle and are edited
 * like any other definition — and the engine (engine.ts) compiles the
 * enabled ones and stands guard at the store's writes.
 *
 * A rule is declarative where it can be — required paths, field
 * predicates in the filter language, uniqueness, a label pattern, what a
 * relationship may join — and programmatic where it must be: `js` is the
 * body of a function `(e, ctx) => true | false | string`, a false or a
 * string (the message) meaning the entity fails.
 *
 * A constraint has a scope: `entity` (the default) judges each entity of a
 * write on its own; `graph` judges the whole dataset at once — the store
 * as it would stand after the write — and is how an invariant over the
 * graph or the ontology is stated (no cycles through `parent`, every paper
 * has an author, every type in use is declared). A constraint may come from
 * a template (templates.ts): `template` names it and `params` are what the
 * form was filled with; the rendered rule is stored alongside so the entity
 * stands on its own.
 */

export const CONSTRAINT_TYPE = 'constraint'

export type Severity = 'reject' | 'warn'
/** What a rule judges: one entity of a write at a time, or the whole dataset at once. */
export type ConstraintScope = 'entity' | 'graph'

export interface ConstraintApplies {
  /** Entities, relationships, or both (default: both). */
  kinds?: ('entity' | 'relationship')[]
  /** Only these types (default: every type). */
  types?: string[]
  /** Only entities carrying any of these tags. */
  tags?: string[]
}

export interface RelationshipEnds {
  /** Types the source may have. */
  source?: string[]
  /** Types the target may have. */
  target?: string[]
  /** Both ends must be of the same type. */
  sameType?: boolean
  /** An entity may not link to itself. */
  noSelf?: boolean
  /** At most this many relationships of the same type may leave a source / reach a target (counting the one being added). */
  maxPerSource?: number
  maxPerTarget?: number
  /** Both ends must exist in the store (or be added in the same write). */
  endsExist?: boolean
}

export interface ConstraintRule {
  /** Paths (`label`, `data.year`, `tags`…) that must be present and not empty. */
  required?: string[]
  /** Paths that must be absent. */
  forbidden?: string[]
  /** Predicates in the filter language, all of which must hold. */
  fields?: FieldPredicate[]
  /** Paths whose value must be unique among entities of the same type. */
  unique?: string[]
  /** A regular expression the label must match. */
  labelPattern?: string
  /** For relationships: what they may join. */
  ends?: RelationshipEnds
  /**
   * Code in the rule vocabulary (rules.ts). Scope `entity`: an expression over `e`, the entity being written — true
   * passes; false or a string (the message) fails. Scope `graph`: over the whole dataset — true passes; false or a
   * string fails the write; a list of `violation(id, message)` names the entities at fault.
   */
  js?: string
  /**
   * A saved script (type `script`) that judges the whole dataset in the sandbox — JavaScript or Python over `ds`,
   * returning true, a message, or rows of { id, message }. Asynchronous, so it is checked by the audit, not at
   * write time.
   */
  script?: EntityId
}

export interface ConstraintData extends EntityData {
  applies: ConstraintApplies
  rule: ConstraintRule
  severity: Severity
  enabled: boolean
  /** Shown when the rule fails, before the rule's own detail. */
  message?: string
  /** Default `entity`. */
  scope?: ConstraintScope
  /** The template this was made from — a built-in id or a `constraint-template` entity id. */
  template?: string
  /** The template's parameters, also bound as `params` in the rule's code. */
  params?: Record<string, unknown>
}

export type ConstraintEntity = Entity<ConstraintData>

export const isConstraint = (e: AnyEntity | undefined): e is ConstraintEntity => !!e && e.kind === 'entity' && e.type === CONSTRAINT_TYPE && !!(e.data as Partial<ConstraintData>).rule

export interface Violation {
  constraintId: EntityId
  constraint: string
  severity: Severity
  entityId: EntityId
  /** What the entity is, for a message. */
  entity: string
  message: string
}

export function createConstraint(init: { id?: EntityId; label: string; description?: string; applies?: ConstraintApplies; rule: ConstraintRule; severity?: Severity; enabled?: boolean; message?: string; tags?: string[]; scope?: ConstraintScope; template?: string; params?: Record<string, unknown>; projects?: EntityId[] }): ConstraintEntity {
  return createEntity<ConstraintData>({
    id: init.id,
    type: CONSTRAINT_TYPE,
    label: init.label,
    description: init.description,
    tags: init.tags ?? [],
    data: {
      applies: init.applies ?? {},
      rule: init.rule,
      severity: init.severity ?? 'reject',
      enabled: init.enabled ?? true,
      ...(init.message ? { message: init.message } : {}),
      ...(init.scope && init.scope !== 'entity' ? { scope: init.scope } : {}),
      ...(init.template ? { template: init.template } : {}),
      ...(init.params && Object.keys(init.params).length ? { params: init.params } : {}),
    },
    meta: { source: 'user', ...(init.projects?.length ? { projects: init.projects } : {}) },
  })
}

export const scopeOf = (c: ConstraintEntity): ConstraintScope => c.data.scope ?? 'entity'

/** Whether a constraint is in force: enabled, and either the Library's or the open project's. */
export const inForce = (c: ConstraintEntity, scope: EntityId | null): boolean => c.data.enabled !== false && (!c.meta.projects?.length || !scope || c.meta.projects.includes(scope))

/** One line saying what a rule checks. */
export function describeRule(rule: ConstraintRule): string {
  const parts: string[] = []
  if (rule.required?.length) parts.push(`requires ${rule.required.join(', ')}`)
  if (rule.forbidden?.length) parts.push(`forbids ${rule.forbidden.join(', ')}`)
  if (rule.fields?.length) parts.push(`${rule.fields.length} field condition${rule.fields.length > 1 ? 's' : ''}`)
  if (rule.unique?.length) parts.push(`unique ${rule.unique.join(', ')}`)
  if (rule.labelPattern) parts.push(`label matches /${rule.labelPattern}/`)
  if (rule.ends) {
    const e = rule.ends
    if (e.source?.length) parts.push(`source: ${e.source.join(' | ')}`)
    if (e.target?.length) parts.push(`target: ${e.target.join(' | ')}`)
    if (e.sameType) parts.push('same type at both ends')
    if (e.noSelf) parts.push('no self-links')
    if (e.maxPerSource !== undefined) parts.push(`≤ ${e.maxPerSource} per source`)
    if (e.maxPerTarget !== undefined) parts.push(`≤ ${e.maxPerTarget} per target`)
    if (e.endsExist) parts.push('both ends must exist')
  }
  if (rule.js) parts.push('a JavaScript check')
  if (rule.script) parts.push('a script (audited)')
  return parts.length ? parts.join(' · ') : 'no conditions'
}

/** One line saying what a constraint watches: for a graph-scoped one, the dataset as a whole. */
export function describeWatches(c: ConstraintEntity): string {
  return scopeOf(c) === 'graph' ? 'the whole graph' : describeApplies(c.data.applies ?? {})
}

export function describeApplies(a: ConstraintApplies): string {
  const kinds = a.kinds?.length && a.kinds.length < 2 ? (a.kinds[0] === 'relationship' ? 'relationships' : 'entities') : 'entities and relationships'
  const types = a.types?.length ? ` of type ${a.types.join(', ')}` : ''
  const tags = a.tags?.length ? ` tagged ${a.tags.join(', ')}` : ''
  return `${kinds}${types}${tags}`
}

export const constraintType: EntityTypeDef = defineEntityType({
  type: CONSTRAINT_TYPE,
  label: 'Constraint',
  pluralLabel: 'Constraints',
  category: 'project',
  icon: ShieldCheck,
  color: '#b45309',
  description: 'A rule entities must satisfy to be added: required properties, field conditions, uniqueness, what a relationship may join, or a JavaScript check. Rejecting or warning.',
  fields: [
    { key: 'data.severity', label: 'Severity', kind: 'text', editable: true, width: 80, options: [{ value: 'reject', label: 'Reject' }, { value: 'warn', label: 'Warn' }] },
    { key: 'data.enabled', label: 'Enabled', kind: 'boolean', editable: true, width: 70 },
    { key: 'data.scope', label: 'Scope', kind: 'text', editable: true, width: 70, options: [{ value: 'entity', label: 'Entity' }, { value: 'graph', label: 'Graph' }] },
    { key: 'data.applies', label: 'Applies to', kind: 'json', width: 180, format: (v) => describeApplies((v ?? {}) as ConstraintApplies) },
    { key: 'data.rule', label: 'Rule', kind: 'json', width: 260, format: (v) => describeRule((v ?? {}) as ConstraintRule) },
  ],
})
