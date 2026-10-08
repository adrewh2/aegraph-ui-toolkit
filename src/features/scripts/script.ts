import { Code2 } from 'lucide-react'
import { createEntity, displayLabel } from '../../core/entity/entity'
import { defineEntityType, type EntityTypeDef } from '../../core/entity/schema'
import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type AnyEntity, type Entity, type EntityData, type EntityId } from '../../core/entity/types'
import { recordConsent } from './consent'

export const SCRIPT_TYPE = 'script'

import type { Language, Output } from '../../scripting/types'

/**
 * What a saved script is for, once it is put to use, is its **subtype** — a
 * child type of `script` in the ontology (`parent: 'script'`), the way a
 * scene made by a script is a `scene:script`: a **filter** (`script:filter`)
 * returns the entities Unigraph should keep; a **constraint**
 * (`script:constraint`) judges the dataset for a constraint entity
 * (`rule.script`); a **scene** (`script:scene`) returns positions that become
 * a scene on the Scenes page. A draft has none; a script is a plain `script`
 * until it is saved with a kind (chosen, or read off what its last run
 * produced) or first connected to a filter, a constraint or a scene.
 */
export type ScriptSubtype = 'filter' | 'constraint' | 'scene' | 'layout' | 'style'
export const SCRIPT_SUBTYPES: { id: ScriptSubtype; type: string; label: string; hint: string }[] = [
  { id: 'filter', type: 'script:filter', label: 'Filter', hint: 'Returns the entities to keep — a collection, or a list of ids — and is applied in Unigraph' },
  { id: 'constraint', type: 'script:constraint', label: 'Constraint', hint: 'Judges the dataset for a constraint: true passes; false, a message or a list of { id, message } fails' },
  { id: 'scene', type: 'script:scene', label: 'Scene', hint: 'Returns scene(positions) and is opened on the Scenes page as a scene' },
  { id: 'layout', type: 'script:layout', label: 'Layout', hint: 'Returns layout(positions) — a position per entity, computed however it likes — and is applied on the Graph Explorer as a saved layout that remembers it' },
  { id: 'style', type: 'script:style', label: 'Style', hint: 'Returns style(nodes) — colours, sizes, shapes per entity, computed however it likes — and is applied on the Graph Explorer as a saved style that remembers it' },
]
/** The type keys a script may carry: the root and its subtypes. */
export const SCRIPT_FAMILY: string[] = [SCRIPT_TYPE, ...SCRIPT_SUBTYPES.map((s) => s.type)]
export const isScriptSubtype = (v: unknown): v is ScriptSubtype => SCRIPT_SUBTYPES.some((s) => s.id === v)
/** The kind a script's type says, or undefined for a plain `script`. */
export const scriptKindOf = (type: string): ScriptSubtype | undefined => SCRIPT_SUBTYPES.find((s) => s.type === type)?.id
export const scriptTypeOf = (kind: ScriptSubtype | undefined | null): string => SCRIPT_SUBTYPES.find((s) => s.id === kind)?.type ?? SCRIPT_TYPE

export interface ScriptData extends EntityData {
  code: string
  language?: Language
  /**
   * A locked script cannot be overwritten — not its code, name, description
   * or kind — and cannot be deleted; Save as makes a copy. The scripts a
   * demo ships with are locked; the Details dialog (or the tool) unlocks.
   */
  locked?: boolean
  /**
   * Read only these entity types (with the relationships between them) rather than the whole project. What a
   * project of hundreds of thousands of entities needs if a script is to run over it at all — the genera and the
   * wards of a city's trees are four hundred entities; the trees are 688,000 — and what makes any script's first
   * run faster. Subtypes come with their parent.
   */
  types?: string[]
  /** What the last run produced, for the picker. */
  lastRun?: { at: string; summary: string; ms: number; error?: string }
}
export type ScriptEntity = Entity<ScriptData>
export const isScript = (e: AnyEntity | undefined): e is ScriptEntity => !!e && !isRelationship(e) && SCRIPT_FAMILY.includes(e.type) && typeof (e.data as ScriptData).code === 'string'
/** Every script in scope, whatever its kind. */
export const scriptsIn = (store: EntityStore): ScriptEntity[] => SCRIPT_FAMILY.flatMap((t) => store.ofType(t)).filter(isScript)
export const isLockedScript = (e: AnyEntity | undefined): boolean => isScript(e) && e.data.locked === true

/** The kinds whose result is data the app applies (a filter, a style, a layout, a constraint's verdict) take no Visual script: it would draw nowhere and run on. */
export function refuseVisual(language: Language | undefined, what: string): void {
  if (language === 'view') throw new Error(`A Visual script cannot be used as ${what}: it draws into a page and returns nothing to apply. Use JavaScript or Python.`)
}

/** Thrown by every write that would change a locked script. */
export class ScriptLockedError extends Error {
  constructor(label: string) {
    super(`“${label}” is locked: unlock it in its details, or Save as a copy.`)
    this.name = 'ScriptLockedError'
  }
}

export const scriptType: EntityTypeDef = defineEntityType({
  type: SCRIPT_TYPE,
  label: 'Script',
  pluralLabel: 'Scripts',
  category: 'project',
  icon: Code2,
  color: '#7c3aed',
  description: 'JavaScript over a read-only snapshot of the dataset, run in a sandbox; returns a figure, a table or a scene.',
  fields: [
    { key: 'data.language', label: 'Language', kind: 'text', width: 90 },
    { key: 'data.locked', label: 'Locked', kind: 'boolean', width: 70, description: 'A locked script cannot be overwritten or deleted; Save as makes a copy.' },
    { key: 'data.lastRun.summary', label: 'Last run', kind: 'text', width: 220 },
    { key: 'data.lastRun.at', label: 'Ran', kind: 'datetime', width: 140 },
  ],
})

/** The subtypes, defined under `script` so they inherit its columns and read as "Script · Filter" in tables. */
export const scriptSubtypeDefs: EntityTypeDef[] = SCRIPT_SUBTYPES.map((s) =>
  defineEntityType({
    type: s.type,
    parent: SCRIPT_TYPE,
    label: `${s.label} script`,
    pluralLabel: `${s.label} scripts`,
    category: 'project',
    icon: Code2,
    color: scriptType.color,
    description: `A script put to use as a ${s.id}: ${s.hint.charAt(0).toLowerCase()}${s.hint.slice(1)}.`,
    fields: [],
  }),
)

/**
 * Save a script. `subtype` undefined keeps the kind the script has (none for
 * a new one); a kind retypes it to `script:<kind>`; null makes it a plain
 * `script` again. Saving over a locked script throws (`ScriptLockedError`).
 */
export function saveScript(store: EntityStore, code: string, label: string, existing?: EntityId, lastRun?: ScriptData['lastRun'], language: Language = 'js', description?: string, subtype?: ScriptSubtype | null): ScriptEntity {
  const prev = existing ? store.get(existing) : undefined
  if (isScript(prev)) {
    if (prev.data.locked) throw new ScriptLockedError(displayLabel(prev))
    store.update(prev.id, { label, ...(subtype !== undefined ? { type: scriptTypeOf(subtype) } : {}), ...(description !== undefined ? { description: description || undefined } : {}), data: { ...prev.data, code, language, ...(lastRun ? { lastRun } : {}) } })
    // Saved here, by the owner or their assistant: this code may run on arrival (consent.ts). An import never comes through here.
    recordConsent(prev.id, code)
    return store.get(prev.id) as ScriptEntity
  }
  const e = createEntity<ScriptData>({ type: scriptTypeOf(subtype), label, description: description || undefined, tags: [], data: { code, language, ...(lastRun ? { lastRun } : {}) }, meta: { source: 'user' } })
  store.upsert(e)
  recordConsent(e.id, code)
  return e
}

/**
 * A script put to use as a filter, a constraint or a scene takes that kind
 * if it has none yet — the connection names it; a kind it already has stays,
 * and a locked script is left as it is. Returns the kind the script has
 * afterwards.
 */
export function markScriptUse(store: EntityStore, id: EntityId | undefined, subtype: ScriptSubtype): ScriptSubtype | undefined {
  const e = id ? store.get(id) : undefined
  if (!isScript(e)) return undefined
  const have = scriptKindOf(e.type)
  if (have || e.data.locked) return have
  store.update(e.id, { type: scriptTypeOf(subtype) })
  return subtype
}

/**
 * The details a script carries beside its code — its name, description and
 * kind — and its lock. Changing the lock is always allowed (that is how a
 * locked script is unlocked); anything else on a locked script throws.
 */
export function updateScriptDetails(store: EntityStore, id: EntityId, details: { label?: string; description?: string | null; subtype?: ScriptSubtype | null; locked?: boolean; types?: string[] | null }): ScriptEntity {
  const e = store.get(id)
  if (!isScript(e)) throw new Error(`No script with id ${id}.`)
  const wantsMore = details.label !== undefined || details.description !== undefined || details.subtype !== undefined || details.types !== undefined
  // Unlocking and changing details in one go is allowed: the unlock comes first.
  if (e.data.locked && wantsMore && details.locked !== false) throw new ScriptLockedError(displayLabel(e))
  const label = details.label?.trim()
  const { locked: _was, ...rest } = e.data
  store.update(e.id, {
    ...(label ? { label } : {}),
    ...(details.description !== undefined ? { description: details.description?.trim() || undefined } : {}),
    ...(details.subtype !== undefined ? { type: scriptTypeOf(details.subtype) } : {}),
    ...(details.locked !== undefined || details.types !== undefined
      ? {
          data: {
            ...(details.locked === false ? rest : e.data),
            ...(details.locked ? { locked: true } : {}),
            ...(details.types === null ? { types: undefined } : details.types ? { types: details.types } : {}),
          },
        }
      : {}),
  })
  return store.get(e.id) as ScriptEntity
}

/** The kind a run's result suggests, for a script saved without one: a scene, the entities to keep, or a verdict. */
export function subtypeOfOutputs(outs: Output[], store: EntityStore): ScriptSubtype | undefined {
  if (outs.some((o) => o.kind === 'style')) return 'style'
  if (outs.some((o) => o.kind === 'layout')) return 'layout'
  if (outs.some((o) => o.kind === 'scene')) return 'scene'
  if (outs.some((o) => isVerdictOutput(o))) return 'constraint'
  if (idsOfOutputs(outs, store).length) return 'filter'
  return undefined
}

/**
 * The entity ids a result names, for a filter: a collection returned as is
 * (a table whose first column is `id`), a list of ids, `{ ids }`, or a
 * table with an `id` column. Only ids the store holds count; a table of
 * violations ({ id, message }) is a verdict, not a filter.
 */
export function idsOfOutputs(outs: Output[], store: EntityStore): EntityId[] {
  const seen = new Set<EntityId>()
  const take = (v: unknown) => {
    if (typeof v === 'string' && store.has(v) && !seen.has(v)) seen.add(v)
  }
  for (const o of outs) {
    if (o.kind === 'table') {
      const col = o.columns.findIndex((c) => /^(id|entityId|entity)$/i.test(c))
      if (col < 0 || o.columns.some((c) => /^(message|reason|why)$/i.test(c))) continue
      for (const r of o.rows) take(r[col])
    } else if (o.kind === 'value') {
      const v = o.value as { ids?: unknown }
      const list = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray(v.ids) ? v.ids : []
      for (const x of list) take(typeof x === 'string' ? x : x && typeof x === 'object' && 'id' in x ? (x as { id: unknown }).id : undefined)
    }
  }
  return [...seen]
}

/** Whether an output reads as a constraint's verdict: a boolean, a list of { id, message }, or a table with a message column. */
export function isVerdictOutput(o: Output): boolean {
  if (o.kind === 'table') return o.columns.some((c) => /^(message|reason|why)$/i.test(c))
  if (o.kind !== 'value') return false
  const v = o.value
  if (typeof v === 'boolean') return true
  return Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && typeof (x as { message?: unknown }).message === 'string')
}

/**
 * The comment block a script opens with — what it shows and how to read it —
 * as prose: `//` or `#` lines, or a leading docstring, up to the first line
 * of code. Blank comment lines break paragraphs. The description a script
 * carries on its entity wins over this when it has one.
 */
export function headerComment(code: string): string {
  const lines = code.split('\n')
  const out: string[] = []
  let i = 0
  const doc = /^\s*("{3}|'{3})/.exec(lines[0] ?? '')
  if (doc) {
    const q = doc[1]
    const rest = lines[0].replace(/^\s*("{3}|'{3})/, '')
    if (rest.includes(q)) return rest.slice(0, rest.indexOf(q)).trim()
    out.push(rest)
    for (i = 1; i < lines.length; i++) {
      const k = lines[i].indexOf(q)
      if (k >= 0) {
        out.push(lines[i].slice(0, k))
        break
      }
      out.push(lines[i])
    }
    return paragraphs(out)
  }
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim()) {
      if (out.length) out.push('')
      continue
    }
    const m = /^\s*(?:\/\/|#)\s?(.*)$/.exec(l)
    if (!m) break
    out.push(m[1])
  }
  return paragraphs(out)
}

const paragraphs = (lines: string[]) =>
  lines
    .join('\n')
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')

export const scriptLabel = (e: AnyEntity) => displayLabel(e)
