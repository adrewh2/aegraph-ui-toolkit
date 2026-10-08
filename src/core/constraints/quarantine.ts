import type { EntityStore } from '../entity/store'
import type { AnyEntity } from '../entity/types'
import { CONSTRAINT_TYPE, isConstraint, type ConstraintEntity } from './constraint'
import { CONSTRAINT_TEMPLATE_TYPE } from './templates'

/**
 * Constraints that arrive in a bundle come in **switched off**. A constraint
 * is code the guard runs on every write — on the page's own thread, before
 * the write lands — and one in force the moment a project opens can reject
 * every write, or spend each one's time, before its reader has looked at it.
 * So an import that brings a constraint the Library does not have, or changes
 * one it has, writes it with `enabled: false`; its owner reads it on the
 * Ontology page and turns it on. A constraint the import leaves as it was
 * keeps the owner's own setting.
 *
 * A template's code is the code of every constraint that follows it, so a
 * template the import brings new or changed switches off each of those too —
 * the ones already in the Library and the ones in the same file.
 *
 * `meta.source` cannot decide this: it is the file's to write.
 */

/** A constraint's or template's content, without the switch: what decides whether an import changed it. */
const content = (e: AnyEntity): string => {
  const { enabled: _enabled, ...rest } = (e.data ?? {}) as Record<string, unknown>
  return JSON.stringify([e.type, rest])
}

/** Whether an import's copy of an entity says something other than what the store holds. */
const differs = (incoming: AnyEntity, prev: AnyEntity | undefined) => !prev || prev.type !== incoming.type || content(prev) !== content(incoming)

const off = (c: ConstraintEntity): ConstraintEntity => ({ ...c, data: { ...c.data, enabled: false } })

/**
 * The entities an import is about to write, with every constraint it brings new or changed switched off, a
 * constraint it leaves alone keeping the store's setting, and the store's constraints that follow a template it brings
 * new or changed appended, switched off. `onChange` is told of every entity that is not the one the file carried.
 */
export function quarantineImportedConstraints(store: EntityStore, members: AnyEntity[], onChange: (e: AnyEntity) => void = () => {}): AnyEntity[] {
  const changedTemplates = new Set<string>()
  let any = false
  for (const e of members) {
    if (e.type === CONSTRAINT_TYPE) any = true
    else if (e.type === CONSTRAINT_TEMPLATE_TYPE) {
      any = true
      if (differs(e, store.get(e.id))) changedTemplates.add(e.id)
    }
  }
  // The common open — no constraint, no template — is one pass and the same array back (a bundle may hold millions).
  if (!any) return members
  const out: AnyEntity[] = []
  const seen = new Set<string>()
  for (const e of members) {
    seen.add(e.id)
    if (!isConstraint(e)) {
      out.push(e)
      continue
    }
    const prev = store.get(e.id)
    const follows = !!e.data.template && changedTemplates.has(e.data.template)
    let next: ConstraintEntity = e
    if (follows || differs(e, prev)) {
      if (e.data.enabled !== false) next = off(e)
    } else if (isConstraint(prev) && (prev.data.enabled !== false) !== (e.data.enabled !== false)) {
      // Unchanged: whatever the file says, the owner's switch stands.
      next = { ...e, data: { ...e.data, enabled: prev.data.enabled } }
    }
    if (next !== e) onChange(next)
    out.push(next)
  }
  if (changedTemplates.size) {
    for (const c of store.library.ofType(CONSTRAINT_TYPE)) {
      if (seen.has(c.id) || !isConstraint(c) || c.data.enabled === false || !c.data.template || !changedTemplates.has(c.data.template)) continue
      const next = off(c)
      onChange(next)
      out.push(next)
    }
  }
  return out
}
