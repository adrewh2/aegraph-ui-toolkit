import type { EntityStore } from '../entity/store'
import { isRelationship, type AnyEntity, type EntityId } from '../entity/types'
import { getPath, matchPredicate, describePredicate } from '../graph/fields'
import { CONSTRAINT_TYPE, inForce, isConstraint, type ConstraintApplies, type ConstraintEntity, type ConstraintRule, type ConstraintScope, type Violation } from './constraint'
import { ENTITY_RULE_BUDGET_MS, GRAPH_RULE_BUDGET_MS } from './realm'
import { compileGraphRule, compileRule, graphVerdict, loadRuleRealm, RulePending, ruleRealmReady, verdict, type CompiledGraphRule, type CompiledRule } from './rules'
import { CONSTRAINT_TEMPLATE_TYPE, effectiveRule } from './templates'

/**
 * The constraint engine: compiles the enabled constraints once per change
 * to them, and checks writes. `check` is what the store's guard calls on
 * every upsert — it must be quick, so the per-entity work is a handful of
 * path reads; only uniqueness and endpoint counts touch the store's
 * indexes. A JavaScript rule (rules.ts: an expression or a body over `e`
 * with helpers such as has, get, out, neighbors, unique) is compiled once
 * — it is the user's own code, like a script — and any throw counts as a
 * failure with the error as the message.
 *
 * A graph-scoped constraint runs once per write, over the store with the
 * write laid on top, and once in an audit. Its violations blame the
 * entities they name; one that names none (or names entities outside the
 * write) fails the write as a whole. A constraint backed by a sandboxed
 * script (`rule.script`) is asynchronous and is left to the audit.
 *
 * A JavaScript rule (`rule.js`) runs in the QuickJS realm (realm.ts), never
 * in this one — a rule is data from bundles and tool calls. The realm's
 * WASM loads asynchronously the first time a rule needs it; until then a
 * JavaScript check is **pending**: left out of `check` and `audit` rather
 * than guessed, and the engine recompiles when the realm is up. Everything
 * that must see a JavaScript verdict on its first write — a tool, a test,
 * the headless engine — awaits `ready()` first. The window is one WASM
 * instantiation (tens of milliseconds) after the first rule appears.
 */

/**
 * All the time one write may spend on checks — every entity rule on every entity, every graph rule and its baseline —
 * on the page's own thread, before the write lands. A rule's own deadline (250 ms per entity, 5 s per graph rule) bounds
 * one call; this bounds the write. What does not fit is skipped, with one warning per constraint saying so: the write
 * goes through unjudged by it rather than the tab stalling, and the audit still sees everything.
 */
export const WRITE_BUDGET_MS = 300
/** Below this much of the budget a call is not started. */
const MIN_CALL_MS = 2

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** One write's budget for checks: when it runs out, and the constraints it had to skip. */
export interface WriteBudget {
  until: number
  skipped: Map<EntityId, Compiled>
}

export interface CheckContext {
  /** The write's budget for checks; none in an audit. */
  budget?: WriteBudget
  store: EntityStore
  /** The other entities in the same write — a relationship's ends may be among them. */
  others: Map<EntityId, AnyEntity>
  /** The entity as it was before this write, if it existed. */
  previous?: AnyEntity
  /** Per write: for a `unique` path, the value → entity map of a type, built once (a bulk write is O(n), not O(n²)). */
  uniqueIndex?: Map<string, Map<string, AnyEntity>>
}

export interface CheckResult {
  accepted: AnyEntity[]
  rejected: AnyEntity[]
  violations: Violation[]
}

export interface Compiled {
  entity: ConstraintEntity
  scope: ConstraintScope
  applies: ConstraintApplies
  kinds: Set<'entity' | 'relationship'> | null
  types: Set<string> | null
  tags: Set<string> | null
  rule: ConstraintRule
  params: Record<string, unknown>
  labelRe?: RegExp
  js?: CompiledRule
  graph?: CompiledGraphRule
  jsError?: string
  /** Backed by a sandboxed script: judged by the audit only. */
  scripted: boolean
  /** A JavaScript rule waiting for the realm to load: left out until it has. */
  pending?: boolean
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

function compile(store: EntityStore, c: ConstraintEntity): Compiled {
  const { rule, applies: a, scope, params } = effectiveRule(store, c)
  const out: Compiled = {
    entity: c,
    scope,
    applies: a,
    kinds: a.kinds?.length ? new Set(a.kinds) : null,
    types: a.types?.length ? new Set(a.types) : null,
    tags: a.tags?.length ? new Set(a.tags) : null,
    rule,
    params,
    scripted: !!rule.script && !rule.js,
  }
  if (out.rule.labelPattern) {
    try {
      out.labelRe = new RegExp(out.rule.labelPattern)
    } catch (err) {
      out.jsError = `bad label pattern: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (out.rule.js) {
    try {
      if (scope === 'graph') out.graph = compileGraphRule(out.rule.js)
      else out.js = compileRule(out.rule.js)
    } catch (err) {
      if (err instanceof RulePending) out.pending = true
      else out.jsError = `the JavaScript check does not compile: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return out
}

const nameOf = (e: AnyEntity) => (e.label ? `${e.label} (${e.type})` : `${e.type} ${e.id}`)

export class ConstraintEngine {
  private compiled: Compiled[] = []
  private seen: AnyEntity[] = []
  private seenScope: EntityId | null = null
  private readonly store: EntityStore

  constructor(store: EntityStore) {
    this.store = store
  }

  /** The store's guard: what `store.setGuard` takes. */
  guard = (entities: AnyEntity[], previous: (id: EntityId) => AnyEntity | undefined): CheckResult => this.check(entities, { previous })

  /**
   * The enabled constraints in force: the Library's and the open project's. Recompiled when the set — or a template
   * they follow — changes: the store hands out the same object for an unchanged entity, so identity is the test.
   */
  active(): Compiled[] {
    const scope = this.store.scope
    const list = this.store.library.ofType(CONSTRAINT_TYPE).filter(isConstraint).filter((c) => inForce(c, scope))
    const templates = this.store.library.ofType(CONSTRAINT_TEMPLATE_TYPE)
    const seen = [...list, ...templates]
    const same = scope === this.seenScope && seen.length === this.seen.length && seen.every((e, i) => e === this.seen[i])
    if (!same) {
      this.seen = seen
      this.seenScope = scope
      this.compiled = list.map((c) => compile(this.store, c))
      // A graph rule no longer in force (deleted, disabled, another project's) keeps no baseline: each is a key per violation.
      for (const id of this.baselines.keys()) if (!list.some((c) => c.id === id)) this.baselines.delete(id)
      // Recompile once the realm is up, so a pending JavaScript rule starts judging.
      if (this.compiled.some((c) => c.pending)) void loadRuleRealm().then(() => (this.seen = []), () => undefined)
    }
    return this.compiled
  }

  /** Resolves when every JavaScript rule in force can run: await it before a check that must see their verdicts. */
  async ready(): Promise<void> {
    if (ruleRealmReady()) return
    if (!this.active().some((c) => c.rule.js)) return
    await loadRuleRealm()
    this.seen = []
  }

  /** The graph-scoped constraints in force that run in code (the scripted ones are the audit's). */
  graphRules(): Compiled[] {
    return this.active().filter((c) => c.scope === 'graph' && !c.scripted)
  }
  /** The constraints in force that a sandboxed script judges. */
  scripted(): Compiled[] {
    return this.active().filter((c) => c.scripted)
  }

  /** Whether an entity-scoped constraint watches the entity's kind and type — the quick way out of a write that nothing watches. */
  applies(c: Compiled, e: AnyEntity): boolean {
    if (c.scope !== 'entity' || c.scripted) return false
    const kind = isRelationship(e) ? 'relationship' : 'entity'
    if (c.kinds && !c.kinds.has(kind)) return false
    if (c.types && !c.types.has(e.type)) return false
    if (c.tags && !e.tags.some((t) => c.tags!.has(t))) return false
    return true
  }

  /** Every violation of one entity, against every applicable constraint. */
  violations(e: AnyEntity, ctx: CheckContext): Violation[] {
    const out: Violation[] = []
    for (const c of this.active()) {
      if (!this.applies(c, e)) continue
      for (const message of this.failures(c, e, ctx)) out.push({ constraintId: c.entity.id, constraint: c.entity.label ?? c.entity.id, severity: c.entity.data.severity ?? 'reject', entityId: e.id, entity: nameOf(e), message: c.entity.data.message ? `${c.entity.data.message} — ${message}` : message })
    }
    return out
  }

  /** value → entity for one type and path, over the store, built once per check context. */
  private uniqueLookup(ctx: CheckContext, type: string, path: string): Map<string, AnyEntity> {
    ctx.uniqueIndex ??= new Map()
    const k = `${type}\u0001${path}`
    let m = ctx.uniqueIndex.get(k)
    if (!m) {
      m = new Map()
      for (const x of ctx.store.library.ofType(type)) {
        const v = getPath(x, path)
        if (!isEmpty(v)) m.set(typeof v === 'string' ? v : JSON.stringify(v), x)
      }
      ctx.uniqueIndex.set(k, m)
    }
    return m
  }

  private *failures(c: Compiled, e: AnyEntity, ctx: CheckContext): Generator<string> {
    const r = c.rule
    if (c.jsError) yield c.jsError
    for (const p of r.required ?? []) if (isEmpty(getPath(e, p))) yield `${p} is required`
    for (const p of r.forbidden ?? []) if (!isEmpty(getPath(e, p))) yield `${p} must not be set`
    for (const p of r.fields ?? []) if (!matchPredicate(e, p)) yield `${describePredicate(p)} does not hold (${JSON.stringify(getPath(e, p.path) ?? null)})`
    if (c.labelRe && !c.labelRe.test(e.label ?? '')) yield `label “${e.label ?? ''}” does not match /${r.labelPattern}/`
    for (const p of r.unique ?? []) {
      const v = getPath(e, p)
      if (isEmpty(v)) continue
      const key = typeof v === 'string' ? v : JSON.stringify(v)
      // The same value on another entity of the same type — in the store, or earlier in this same write (the first
      // of two twins in a write is the one that gets in: it claims the value here as it passes).
      const lookup = this.uniqueLookup(ctx, e.type, p)
      const clash = lookup.get(key)
      if (clash && clash.id !== e.id) yield `${p} must be unique: ${JSON.stringify(v)} is already on ${nameOf(clash)}`
      else if (!clash) lookup.set(key, e)
    }
    if (r.ends && isRelationship(e)) {
      const ends = r.ends
      const at = (id: EntityId) => ctx.others.get(id) ?? ctx.store.get(id)
      const s = at(e.source.id)
      const t = at(e.target.id)
      if (ends.endsExist && (!s || !t)) yield `${!s ? 'source' : 'target'} ${!s ? e.source.id : e.target.id} does not exist`
      if (ends.source?.length && s && !ends.source.includes(s.type)) yield `source must be ${ends.source.join(' or ')}, not ${s.type}`
      if (ends.target?.length && t && !ends.target.includes(t.type)) yield `target must be ${ends.target.join(' or ')}, not ${t.type}`
      if (ends.sameType && s && t && s.type !== t.type) yield `both ends must be of the same type (${s.type} → ${t.type})`
      if (ends.noSelf && e.source.id === e.target.id) yield 'an entity may not link to itself'
      if (ends.maxPerSource !== undefined) {
        const n = ctx.store.library.relationshipsOf(e.source.id).filter((x) => x.type === e.type && x.source.id === e.source.id && x.id !== e.id).length + 1
        if (n > ends.maxPerSource) yield `${nameOf(s ?? e)} would have ${n} ${e.type} relationships; at most ${ends.maxPerSource} allowed`
      }
      if (ends.maxPerTarget !== undefined) {
        const n = ctx.store.library.relationshipsOf(e.target.id).filter((x) => x.type === e.type && x.target.id === e.target.id && x.id !== e.id).length + 1
        if (n > ends.maxPerTarget) yield `${nameOf(t ?? e)} would be the target of ${n} ${e.type} relationships; at most ${ends.maxPerTarget} allowed`
      }
    }
    if (c.js) {
      const left = ctx.budget ? ctx.budget.until - clock() : Infinity
      if (left < MIN_CALL_MS) {
        ctx.budget!.skipped.set(c.entity.id, c)
        return
      }
      let v: unknown
      try {
        v = c.js(e, { store: ctx.store, others: ctx.others, params: c.params, ...(Number.isFinite(left) ? { budgetMs: left } : {}) }, ctx.previous)
      } catch (err) {
        // Stopped by what was left of the write's budget, not by its own deadline: skipped, not failed.
        if (ctx.budget && left < ENTITY_RULE_BUDGET_MS && /past its [\d.]+ ms budget/.test(err instanceof Error ? err.message : '')) {
          ctx.budget.skipped.set(c.entity.id, c)
          return
        }
        v = `the JavaScript check threw: ${err instanceof Error ? err.message : String(err)}`
      }
      const m = verdict(v)
      if (m) yield m
    }
  }

  /**
   * Check a write: entities that fail a rejecting constraint are dropped; a warning one only reports. Existing entities
   * are checked only when the write changes what a rule can see (a bookkeeping touch never trips an old violation).
   */
  check(entities: AnyEntity[], opts: { previous?: (id: EntityId) => AnyEntity | undefined } = {}): CheckResult {
    // Switching a constraint off is never judged by the constraints: a rule that rejects everything (or takes all the
    // time it may) must not be able to keep its owner from turning it off.
    if (entities.length && entities.every(switchesOff)) return { accepted: entities, rejected: [], violations: [] }
    const active = this.active()
    if (!active.length) return { accepted: entities, rejected: [], violations: [] }
    const others = new Map(entities.map((e) => [e.id, e]))
    let accepted: AnyEntity[] = []
    const rejected: AnyEntity[] = []
    const violations: Violation[] = []
    const budget: WriteBudget = { until: clock() + WRITE_BUDGET_MS, skipped: new Map() }
    const ctx: CheckContext = { store: this.store, others, uniqueIndex: new Map(), budget }
    let anyMaterial = false
    for (const e of entities) {
      const previous = opts.previous?.(e.id)
      if ((previous && !material(previous, e)) || switchesOff(e)) {
        accepted.push(e)
        continue
      }
      anyMaterial = true
      const vs = this.violations(e, { ...ctx, previous })
      violations.push(...vs)
      if (vs.some((v) => v.severity === 'reject')) rejected.push(e)
      else accepted.push(e)
    }
    // The graph rules see the write as it would land: what the entity rules let through, over the store. Only what the
    // write introduces counts — a violation already in the data (the audit's business) never blocks an unrelated write.
    const rules = this.graphRules()
    if (anyMaterial && rules.length && accepted.length) {
      const landing = new Map(accepted.map((e) => [e.id, e]))
      for (const c of rules) {
        // A graph rule runs twice for a write — over the store as it stands (the baseline, kept per store version) and
        // with the write on top — and both come out of the write's budget.
        const before = this.baseline(c, budget)
        const after = before && this.graphViolations(c, landing, budget)
        if (!before || !after) {
          budget.skipped.set(c.entity.id, c)
          continue
        }
        const vs = after.filter((v) => !before.has(`${v.entityId}\u0001${v.message}`))
        if (!vs.length) continue
        violations.push(...vs)
        if ((c.entity.data.severity ?? 'reject') !== 'reject') continue
        // Blame the entities named in the write; a violation naming nothing in it fails the whole write.
        const named = new Set(vs.map((v) => v.entityId).filter((id) => landing.has(id)))
        const whole = vs.some((v) => !landing.has(v.entityId))
        const drop = accepted.filter((e) => whole || named.has(e.id))
        if (!drop.length) continue
        rejected.push(...drop)
        accepted = accepted.filter((e) => !drop.includes(e))
        if (!accepted.length) break
      }
    }
    for (const c of budget.skipped.values()) violations.push({ constraintId: c.entity.id, constraint: c.entity.label ?? c.entity.id, severity: 'warn', entityId: '', entity: 'this write', message: `not checked: the write's ${WRITE_BUDGET_MS} ms for checks was spent before this constraint's turn — the audit still checks it` })
    return { accepted, rejected, violations }
  }

  private baselines = new Map<EntityId, { version: number; keys: Set<string> }>()
  /** A graph rule's violations in the store as it stands, keyed, memoised per store version; null when the write's budget ran out. */
  private baseline(c: Compiled, budget?: WriteBudget): Set<string> | null {
    const cached = this.baselines.get(c.entity.id)
    if (cached && cached.version === this.store.version) return cached.keys
    const vs = this.graphViolations(c, new Map(), budget)
    if (!vs) return null
    const keys = new Set(vs.map((v) => `${v.entityId}\u0001${v.message}`))
    this.baselines.set(c.entity.id, { version: this.store.version, keys })
    return keys
  }

  /** One graph rule over the store with a write laid on top (an empty map for the audit). */
  graphViolations(c: Compiled, others: Map<EntityId, AnyEntity>): Violation[]
  /** …within what is left of a write's budget: null when it ran out before the rule could finish. */
  graphViolations(c: Compiled, others: Map<EntityId, AnyEntity>, budget?: WriteBudget): Violation[] | null
  graphViolations(c: Compiled, others: Map<EntityId, AnyEntity>, budget?: WriteBudget): Violation[] | null {
    const base = { constraintId: c.entity.id, constraint: c.entity.label ?? c.entity.id, severity: c.entity.data.severity ?? 'reject' } as const
    const prefix = (m: string) => (c.entity.data.message ? `${c.entity.data.message} — ${m}` : m)
    if (c.jsError) return [{ ...base, entityId: '', entity: 'the graph', message: prefix(c.jsError) }]
    if (!c.graph) return []
    const left = budget ? budget.until - clock() : Infinity
    if (left < MIN_CALL_MS) return null
    let v: unknown
    try {
      v = c.graph({ store: this.store, others, params: c.params, ...(Number.isFinite(left) ? { budgetMs: left } : {}) })
    } catch (err) {
      if (budget && left < GRAPH_RULE_BUDGET_MS && /past its [\d.]+ ms budget/.test(err instanceof Error ? err.message : '')) return null
      v = `the JavaScript check threw: ${err instanceof Error ? err.message : String(err)}`
    }
    return graphVerdict(v).map((g) => {
      const e = g.id ? others.get(g.id) ?? this.store.get(g.id) : undefined
      return { ...base, entityId: g.id ?? '', entity: e ? nameOf(e) : g.id ?? 'the graph', message: prefix(g.message) }
    })
  }

  /** Every violation in the data as it stands — the audit. */
  audit(opts: { types?: string[]; limit?: number } = {}): { checked: number; violations: Violation[] } {
    const active = this.active()
    const limit = opts.limit ?? 500
    const violations: Violation[] = []
    let checked = 0
    if (!active.length) return { checked, violations }
    const ctx: CheckContext = { store: this.store, others: new Map(), uniqueIndex: new Map() }
    if (active.some((c) => c.scope === 'entity' && !c.scripted)) {
      for (const e of this.store.all()) {
        if (opts.types && !opts.types.includes(e.type)) continue
        if (!active.some((c) => this.applies(c, e))) continue
        checked++
        violations.push(...this.violations(e, ctx))
        if (violations.length >= limit) break
      }
    }
    const rules = this.graphRules()
    // A graph rule looks at everything.
    if (rules.length) checked = Math.max(checked, opts.types ? this.store.all().filter((e) => opts.types!.includes(e.type)).length : this.store.size())
    for (const c of rules) {
      if (violations.length >= limit) break
      const vs = this.graphViolations(c, ctx.others)
      violations.push(...(opts.types ? vs.filter((v) => !v.entityId || opts.types!.includes(this.store.get(v.entityId)?.type ?? '')) : vs))
    }
    return { checked, violations }
  }
}


/** A constraint written switched off: let through whatever the constraints in force say. */
const switchesOff = (e: AnyEntity) => isConstraint(e) && e.data.enabled === false

/** Whether a write changes anything a rule can see. */
const material = (a: AnyEntity, b: AnyEntity) => a.type !== b.type || a.label !== b.label || a.description !== b.description || a.tags !== b.tags || a.data !== b.data || (isRelationship(a) && isRelationship(b) && (a.source.id !== b.source.id || a.target.id !== b.target.id || a.directed !== b.directed))
