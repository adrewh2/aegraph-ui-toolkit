import type { EntityId } from '../entity/types'
import type { LayoutAlgorithm, LayoutParams } from './layouts'
import { computeLayoutAsync, resolvePositionsAsync } from './layoutEngines'
import { multilevelWire } from './layouts'
import { packPositions, transferables, unpackPositions, unpackSlice, type PositionsWire, type SliceWire } from './layoutWire'

export type LayoutRequest = {
  type: 'run'
  /** The slice as columns: only what the layouts read (see `layoutWire.ts`). */
  slice: SliceWire
  algorithm: LayoutAlgorithm
  params: LayoutParams
} & (
  | /** Everything is laid out, force layouts refining `previous` (pinned nodes stay). */ { op: 'compute'; previous?: PositionsWire; pinned?: EntityId[] }
  | /** Only nodes missing from `saved` are placed, beside the held ones. */ { op: 'resolve'; saved?: PositionsWire }
)
export type LayoutResponse = { type: 'result'; positions: PositionsWire; unplaced: number } | { type: 'error'; message: string }

/** One job per worker; cancellation is `worker.terminate()` from the caller. */
self.onmessage = async (ev: MessageEvent<LayoutRequest>) => {
  const msg = ev.data
  if (msg.type !== 'run') return
  const post = (r: LayoutResponse) => (self as unknown as Worker).postMessage(r, r.type === 'result' ? transferables({ positions: r.positions }) : [])
  try {
    // The multilevel layout reads the columns as they came: at hundreds of thousands of nodes the objects would
    // cost more than the layout.
    const direct = msg.op === 'compute' && msg.algorithm === 'multilevel' ? multilevelWire(msg.slice, msg.params, msg.previous, msg.pinned) : undefined
    if (direct) return post({ type: 'result', positions: direct, unplaced: 0 })
    const slice = unpackSlice(msg.slice)
    // Engine layouts (ELK, WebCola, ngraph…) are imported here, on first use: their chunks never reach the page.
    if (msg.op === 'compute') post({ type: 'result', positions: packPositions(await computeLayoutAsync(msg.algorithm, slice, msg.params, unpackPositions(msg.previous), msg.pinned))!, unplaced: 0 })
    else {
      const r = await resolvePositionsAsync(slice, unpackPositions(msg.saved), msg.algorithm, msg.params)
      post({ type: 'result', positions: packPositions(r.positions)!, unplaced: r.unplaced })
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
