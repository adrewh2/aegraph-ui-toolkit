import type { Violation } from '../../core/constraints/constraint'
import type { Compiled, ConstraintEngine } from '../../core/constraints/engine'
import { graphVerdict, type GraphViolation } from '../../core/constraints/rules'
import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { isScript, refuseVisual } from './script'
import { runScript } from './runner'

/**
 * Constraints judged by a saved script: the script runs in the sandbox
 * (JavaScript or Python, over `ds` like any other) and what it returns is
 * the verdict — true passes; false or a string fails; a list of
 * { id, message } (or a table with those columns, a DataFrame in Python)
 * names the entities at fault. The sandbox is asynchronous, so these run
 * in the audit, never at write time.
 */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A script's return value, as the engines hand it back, read as a verdict. */
export function scriptVerdict(value: unknown): GraphViolation[] {
  if (isObj(value)) {
    if ('value' in value && Object.keys(value).length === 1) return graphVerdict(value.value)
    if (typeof value.text === 'string' && Object.keys(value).length === 1) {
      const t = value.text.trim()
      if (/^(true|ok|pass)$/i.test(t) || t === '') return []
      if (/^false$/i.test(t)) return [{ message: 'the check returned false' }]
      return [{ message: t }]
    }
    if (isObj(value.table)) {
      const columns = Array.isArray(value.table.columns) ? value.table.columns.map(String) : []
      const rows = Array.isArray(value.table.rows) ? value.table.rows : []
      const idCol = columns.findIndex((c) => /^(id|entityId|entity)$/i.test(c))
      const msgCol = columns.findIndex((c) => /^(message|reason|why)$/i.test(c))
      return rows.map((r) => {
        const cells = Array.isArray(r) ? r : [r]
        const id = idCol >= 0 ? String(cells[idCol] ?? '') : undefined
        const message = msgCol >= 0 ? String(cells[msgCol] ?? '') : cells.filter((_, i) => i !== idCol).map(String).join(' · ')
        return { ...(id ? { id } : {}), message: message || 'flagged' }
      })
    }
  }
  return graphVerdict(value)
}

export interface ScriptedAudit {
  violations: Violation[]
  /** Per constraint: what ran, and how long. */
  runs: { constraintId: EntityId; constraint: string; script?: EntityId; ms?: number; error?: string }[]
}
type EntityId = string

/** Run every script-backed constraint in force and read the verdicts. */
export async function auditScripted(store: EntityStore, registry: TypeRegistry, engine: ConstraintEngine, opts: { only?: Compiled[]; timeoutMs?: number } = {}): Promise<ScriptedAudit> {
  const out: ScriptedAudit = { violations: [], runs: [] }
  for (const c of opts.only ?? engine.scripted()) {
    const base = { constraintId: c.entity.id, constraint: c.entity.label ?? c.entity.id, severity: c.entity.data.severity ?? 'reject' } as const
    const prefix = (m: string) => (c.entity.data.message ? `${c.entity.data.message} — ${m}` : m)
    const script = store.get(c.rule.script ?? '')
    if (!isScript(script)) {
      out.violations.push({ ...base, entityId: '', entity: 'the graph', message: prefix(`the script ${c.rule.script ?? ''} does not exist`) })
      out.runs.push({ constraintId: c.entity.id, constraint: base.constraint, script: c.rule.script, error: 'no such script' })
      continue
    }
    try {
      refuseVisual(script.data.language, 'a constraint')
      const r = await runScript(store, registry, script.data.code, { scriptId: script.id, language: script.data.language ?? 'js', timeoutMs: opts.timeoutMs, ...(script.data.types?.length ? { types: script.data.types } : {}) })
      if (r.error) {
        out.violations.push({ ...base, entityId: '', entity: 'the graph', message: prefix(`the script failed: ${r.error.message}`) })
        out.runs.push({ constraintId: c.entity.id, constraint: base.constraint, script: script.id, ms: r.ms.run, error: r.error.message })
        continue
      }
      for (const g of scriptVerdict(r.value)) {
        const e = g.id ? store.get(g.id) : undefined
        out.violations.push({ ...base, entityId: g.id ?? '', entity: e ? (e.label ? `${e.label} (${e.type})` : `${e.type} ${e.id}`) : g.id ?? 'the graph', message: prefix(g.message) })
      }
      out.runs.push({ constraintId: c.entity.id, constraint: base.constraint, script: script.id, ms: r.ms.run })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      out.violations.push({ ...base, entityId: '', entity: 'the graph', message: prefix(`the script could not run: ${message}`) })
      out.runs.push({ constraintId: c.entity.id, constraint: base.constraint, script: script.id, error: message })
    }
  }
  return out
}
