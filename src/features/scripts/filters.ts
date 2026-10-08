import type { EntityStore } from '../../core/entity/store'
import type { EntityId } from '../../core/entity/types'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { outputsOf } from '../../scripting/outputs'
import { idsOfOutputs, isScript, markScriptUse, refuseVisual } from './script'
import { runScript } from './runner'

/**
 * Filters judged by a saved script: the script runs in the sandbox
 * (JavaScript or Python, over `ds` like any other) and what it returns is
 * the set of entities to keep — a collection (`entities.types.person.filter(…)`),
 * a list of ids, `{ ids }`, or a table with an `id` column. The Graph
 * Explorer keeps just those (`only`) and remembers the script (`script`),
 * so the filter can be run again as the data changes. The sandbox is
 * asynchronous, so this runs on apply, never inside the filter pipeline.
 */
export interface FilterRun {
  script: EntityId
  ids: EntityId[]
  ms: number
  /** Why there are no ids: the script failed, or returned nothing that names entities. */
  error?: string
}

export async function runFilterScript(store: EntityStore, registry: TypeRegistry, id: EntityId, opts: { timeoutMs?: number } = {}): Promise<FilterRun> {
  const script = store.get(id)
  if (!isScript(script)) throw new Error(`No script with id ${id}.`)
  refuseVisual(script.data.language, 'a filter')
  const r = await runScript(store, registry, script.data.code, { scriptId: script.id, language: script.data.language ?? 'js', timeoutMs: opts.timeoutMs, ...(script.data.types?.length ? { types: script.data.types } : {}) })
  if (r.error) return { script: id, ids: [], ms: r.ms.run, error: r.error.message }
  let ids: EntityId[]
  try {
    ids = idsOfOutputs(outputsOf(r.value), store)
  } catch (e) {
    return { script: id, ids: [], ms: r.ms.run, error: e instanceof Error ? e.message : String(e) }
  }
  if (!ids.length) return { script: id, ids, ms: r.ms.run, error: 'The script returned nothing that names entities: return a collection, a list of ids, or a table with an id column.' }
  // Applied as a filter, the script is a filter script — unless it is already something else.
  markScriptUse(store, id, 'filter')
  return { script: id, ids, ms: r.ms.run }
}
