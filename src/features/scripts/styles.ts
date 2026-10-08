import { createEntity, displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { DEFAULT_RENDERING, describeRendering, toRenderingSpec, type RenderingData, type RenderingSpec, type StyleOverlay } from '../../core/graph/rendering'
import { GRAPH_TYPES } from '../../core/graph/types'
import { describeOutputs, outputsOf } from '../../scripting/outputs'
import type { Output } from '../../scripting/types'
import { runScript } from './runner'
import { isScript, markScriptUse, refuseVisual, type ScriptEntity } from './script'

/**
 * A style script becomes a saved style: the script runs, what it returns
 * (`style(nodes, …)`) goes on a rendering entity as the overlay — styles
 * per id, the legend, which script and when — over the spec the script
 * gave or the default. One rendering per script, updated on each run, so
 * the Style picker lists it once and the explorer can reload the picture
 * without running anything. Used by the Scripts page, `script {apply}`
 * and `graph_style {script}`.
 */

export type StyleOutput = Extract<Output, { kind: 'style' }>

/** The rendering entity a script's style lives on, if it has run before. */
export function renderingOfScript(store: EntityStore, scriptId: EntityId): AnyEntity | undefined {
  return store.ofType(GRAPH_TYPES.rendering).find((e) => ((e.data as RenderingData).overlay as StyleOverlay | undefined)?.source?.scriptId === scriptId)
}

/** The spec a style output stands for: its own spec (or `base`, or the default) with the overlay on top. */
export function specFromStyleOutput(out: StyleOutput, script: { id: EntityId; label?: string }, base?: RenderingSpec, ranAt = new Date().toISOString()): RenderingSpec {
  const spec = out.spec ? toRenderingSpec(out.spec as Partial<RenderingData>) : (base ?? DEFAULT_RENDERING)
  return { ...spec, overlay: { ...out.overlay, source: { scriptId: script.id, ...(script.label ? { label: script.label } : {}), ranAt } } }
}

export interface AppliedStyle {
  rendering: AnyEntity
  spec: RenderingSpec
  output: StyleOutput
  updated: boolean
  logs: string[]
  ms: number
}

/**
 * Run a style script and keep its result as the script's rendering.
 * `base` is what the ids the script did not style follow when the
 * script gives no spec of its own — the explorer's current style, say.
 * Throws when the script fails or returns no style.
 */
export async function applyStyleScript(store: EntityStore, registry: TypeRegistry, scriptId: EntityId, opts: { base?: RenderingSpec; timeoutMs?: number } = {}): Promise<AppliedStyle> {
  const e = store.get(scriptId)
  if (!isScript(e)) throw new Error(`No script with id ${scriptId}.`)
  refuseVisual(e.data.language, 'a style')
  const r = await runScript(store, registry, e.data.code, { scriptId: e.id, language: e.data.language ?? 'js', timeoutMs: opts.timeoutMs, ...(e.data.types?.length ? { types: e.data.types } : {}) })
  if (r.error) throw new Error(`Script “${displayLabel(e)}” failed: ${r.error.message}`)
  const outs = outputsOf(r.value)
  const out = outs.find((o): o is StyleOutput => o.kind === 'style')
  if (!out) throw new Error(`The script returned no style: return style(nodes, { legend, spec }) — it produced ${describeOutputs(outs) || 'nothing'}.`)
  const ranAt = new Date().toISOString()
  const spec = specFromStyleOutput(out, { id: e.id, label: displayLabel(e) }, opts.base, ranAt)
  const existing = renderingOfScript(store, e.id)
  const label = out.label ?? existing?.label ?? displayLabel(e)
  const rendering = createEntity<RenderingData>({
    ...(existing ? { id: existing.id } : {}),
    type: GRAPH_TYPES.rendering,
    label,
    description: `From the script “${displayLabel(e)}”: ${describeRendering(spec)}.`,
    tags: existing?.tags ?? [],
    data: { ...spec } as RenderingData,
    meta: { ...(existing?.meta ?? {}), source: 'script', derivedFrom: { id: e.id }, updatedAt: ranAt },
  })
  store.upsert(rendering)
  markScriptUse(store, e.id, 'style')
  return { rendering, spec, output: out, updated: !!existing, logs: r.logs, ms: r.ms.run }
}

export const scriptOfRendering = (store: EntityStore, rendering: AnyEntity | undefined): ScriptEntity | undefined => {
  const id = ((rendering?.data as RenderingData | undefined)?.overlay as StyleOverlay | undefined)?.source?.scriptId
  const e = id ? store.get(id) : undefined
  return isScript(e) ? e : undefined
}
