import { createEntity, displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { GRAPH_TYPES, type LayoutData } from '../../core/graph/types'
import { describeOutputs, outputsOf } from '../../scripting/outputs'
import type { Output } from '../../scripting/types'
import { runScript } from './runner'
import { isScript, markScriptUse, refuseVisual } from './script'

/**
 * A layout script becomes a saved layout: the script runs, the positions
 * it returns (`layout(positions)`, or a scene's) go on a layout entity
 * that remembers the script — one per script, updated on each run — so
 * the explorer loads it like any saved layout and a graph scene can keep
 * it. Used by the Scripts page, `script {apply}` and `graph_layout {script}`.
 */

export type LayoutOutput = Extract<Output, { kind: 'layout' }>

export function layoutOfScript(store: EntityStore, scriptId: EntityId): AnyEntity | undefined {
  return store.ofType(GRAPH_TYPES.layout).find((e) => (e.data as LayoutData).source?.scriptId === scriptId)
}

export interface AppliedLayout {
  layout: AnyEntity
  positions: LayoutOutput['positions']
  dimensions: 2 | 3
  updated: boolean
  logs: string[]
  ms: number
}

/** Run a layout script and keep its positions as the script's layout. Throws when the script fails or places nothing. */
export async function applyLayoutScript(store: EntityStore, registry: TypeRegistry, scriptId: EntityId, opts: { timeoutMs?: number; dimensions?: 2 | 3 } = {}): Promise<AppliedLayout> {
  const e = store.get(scriptId)
  if (!isScript(e)) throw new Error(`No script with id ${scriptId}.`)
  refuseVisual(e.data.language, 'a layout')
  const r = await runScript(store, registry, e.data.code, { scriptId: e.id, language: e.data.language ?? 'js', timeoutMs: opts.timeoutMs, ...(e.data.types?.length ? { types: e.data.types } : {}) })
  if (r.error) throw new Error(`Script “${displayLabel(e)}” failed: ${r.error.message}`)
  const outs = outputsOf(r.value)
  const out = outs.find((o): o is LayoutOutput => o.kind === 'layout')
  // A scene script's positions serve as a layout too.
  const scene = outs.find((o): o is Extract<Output, { kind: 'scene' }> => o.kind === 'scene')
  const positions = out?.positions ?? scene?.positions
  if (!positions) throw new Error(`The script returned no layout: return layout(positions) — it produced ${describeOutputs(outs) || 'nothing'}.`)
  const dimensions: 2 | 3 = out?.dimensions ?? (Object.values(positions).some((p) => 'z' in p && typeof (p as { z?: number }).z === 'number') ? 3 : (opts.dimensions ?? 2))
  const ranAt = new Date().toISOString()
  const existing = layoutOfScript(store, e.id)
  const label = out?.label ?? scene?.label ?? existing?.label ?? displayLabel(e)
  const layout = createEntity<LayoutData>({
    ...(existing ? { id: existing.id } : {}),
    type: GRAPH_TYPES.layout,
    label,
    description: `From the script “${displayLabel(e)}”: ${Object.keys(positions).length.toLocaleString('en-US')} positions.`,
    tags: existing?.tags ?? [],
    data: { positions, algorithm: 'script', dimensions, source: { scriptId: e.id, label: displayLabel(e), ranAt } },
    meta: { ...(existing?.meta ?? {}), source: 'script', derivedFrom: { id: e.id }, updatedAt: ranAt },
  })
  store.upsert(layout)
  markScriptUse(store, e.id, 'layout')
  return { layout, positions, dimensions, updated: !!existing, logs: r.logs, ms: r.ms.run }
}
