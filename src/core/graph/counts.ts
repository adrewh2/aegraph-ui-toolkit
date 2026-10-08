import type { EntityStore } from '../entity/store'
import type { AnyEntity } from '../entity/types'
import { formatNumber } from '../../lib/format'
import { isGraphSceneType, type SceneData } from './scene'
import { PLOT_TYPE, type PlotData } from './plot'
import type { LayoutData } from './types'

/**
 * How much a saved thing holds, in its own terms: a chart's rows, a scene's
 * nodes and edges, a script's lines. Analytics lists and tables all show
 * it, so a chart of five hundred rows and one of five read differently at a
 * glance, and a scene says how big the picture is before it is opened.
 *
 * The number comes from what the thing recorded when it was saved — a
 * chart's `summary`, a scene's `stats` — and never from recomputing over
 * the dataset: a list of fifty scenes would otherwise run fifty filters to
 * draw one line of text each. Where that record is missing, something free
 * stands in (the positions a layout holds), and where nothing is known the
 * count is simply absent rather than wrong.
 */
export function savedCount(e: AnyEntity, store?: EntityStore): string | undefined {
  if (e.type === PLOT_TYPE) {
    const d = e.data as PlotData
    if (typeof d.summary?.rows === 'number') return `${formatNumber(d.summary.rows)} row${d.summary.rows === 1 ? '' : 's'}`
    const traces = d.spec?.traces?.length
    return traces ? `${traces} trace${traces === 1 ? '' : 's'}` : undefined
  }
  if (isGraphSceneType(e.type)) {
    const d = e.data as SceneData
    if (d.stats) return `${formatNumber(d.stats.nodes)} nodes · ${formatNumber(d.stats.edges)} edges`
    const layout = d.layoutId && store ? store.get(d.layoutId) : undefined
    const placed = layout ? Object.keys((layout.data as LayoutData).positions ?? {}).length : 0
    return placed ? `${formatNumber(placed)} placed` : undefined
  }
  if (e.type === 'script' || e.type.startsWith('script:')) {
    const code = (e.data as { code?: string }).code
    if (typeof code !== 'string' || !code.trim()) return undefined
    const lines = code.trimEnd().split('\n').length
    return `${formatNumber(lines)} line${lines === 1 ? '' : 's'}`
  }
  return undefined
}
