import { displayLabel } from '../../core/entity/entity'
import type { EntityId } from '../../core/entity/types'
import type { GraphSlice } from '../../core/graph/filter'
import type { Positions } from '../../core/graph/layouts'
import type { EdgeStyle, NodeStyle } from '../../core/graph/rendering'
import { curvatureFor, indexParallelEdges } from '../../core/graph/parallel'
import { packColor } from '../../core/packed/color'
import { BitSet } from '../../core/packed/bitset'
import { nodeColor } from '../graph/style'
import type { GraphEngine } from './engine/engine'
import { measure } from '../../lib/measure'

/**
 * The explorer's slice (entities, resolved styles, held positions) compiled
 * into the engine. Node indices are stable across slices — the id registry
 * keeps them — so a filter change hides and shows nodes in place and the
 * GPU buffers for nodes are patched, not rebuilt; edges are rebuilt as a
 * set (one O(E) pass and one CSR build), which is what a slice change
 * costs. Positions are synced separately, and only where they differ.
 */
export interface CompileOptions {
  showEdges: boolean
  /** Bend parallel edges apart (the style's `curvedEdges`). */
  curvedEdges?: boolean
  pinned: Set<EntityId>
  /**
   * Leave the positions of nodes the engine already holds where they are, and place only the ones arriving. For a
   * running simulation, whose positions are the newest there are: a write to the project rebuilds the slice, and
   * compiling the held positions over the engine's would throw the picture back to wherever the run was last read
   * from. What arrives is placed from `positions` as usual — beside the picture, for the simulation to take up.
   */
  keepPositions?: boolean
}

export function compileSlice(engine: GraphEngine, slice: GraphSlice, styles: { nodes: Map<EntityId, NodeStyle>; edges: Map<EntityId, EdgeStyle> }, positions: Positions, opts: CompileOptions) {
  const t0 = performance.now()
  engine.beginUpdate()
  const seen = new BitSet(Math.max(engine.nodeCapacity, slice.nodes.length))
  for (const n of slice.nodes) {
    const st = styles.nodes.get(n.id)
    const p = positions[n.id]
    const hex = nodeColor(st?.color, n.type)
    // A node the engine already holds keeps where it is when the caller says so (a live simulation owns the picture).
    const keep = opts.keepPositions && engine.nodeIndex(n.id) >= 0
    const i = engine.setNode(n.id, {
      type: n.type,
      x: keep ? undefined : (p?.x ?? 0),
      y: keep ? undefined : (p?.y ?? 0),
      z: keep ? undefined : (p?.z ?? 0),
      size: st?.size ?? 4,
      packed: packColor(hex, st && st.opacity < 1 ? st.opacity : 1),
      label: displayLabel(n),
      labelOk: st?.label ?? true,
      shape: st?.shape ?? 'circle',
      visible: st?.visible ?? true,
    })
    if (i >= seen.size) seen.resize(engine.nodeCapacity)
    seen.set(i)
  }
  // Nodes known from earlier slices but not in this one: hidden in place (their slot and position stay).
  const g = engine.graph
  for (let i = 0; i < g.nodeCount; i++) {
    if (!g.nodeAlive.has(i) || seen.has(i)) continue
    const id = engine.nodeId(i)
    if (id !== undefined) engine.setNode(id, { visible: false })
  }
  engine.clearEdges()
  if (opts.showEdges) {
    // Parallel edges bend to their own side when the style asks for curves, the same way the SVG writer bends them.
    const parallel = opts.curvedEdges ? indexParallelEdges(slice.edges) : undefined
    for (const e of slice.edges) {
      if (e.source.id === e.target.id) continue
      const s = engine.nodeIndex(e.source.id), t = engine.nodeIndex(e.target.id)
      if (s < 0 || t < 0) continue
      const st = styles.edges.get(e.id)
      engine.addEdge(e.id, s, t, { type: e.type, directed: e.directed && (st?.arrow ?? true), packed: packColor(st?.color ?? '#b5b2aa', st && st.opacity < 1 ? st.opacity : 1), width: st?.width ?? 1, curvature: parallel ? (curvatureFor(parallel.get(e.id)) ?? 0) : 0, label: e.label ?? e.type, visible: st?.visible ?? true })
    }
  }
  engine.graph.compact()
  const pins: number[] = []
  for (const id of opts.pinned) {
    const i = engine.nodeIndex(id)
    if (i >= 0) pins.push(i)
  }
  engine.setPinned(pins)
  engine.endUpdate()
  measure('gg:compile', { start: t0, detail: { nodes: slice.nodes.length, edges: slice.edges.length } })
}

/** Push held positions into the engine where they differ from what it draws. */
export function syncPositions(engine: GraphEngine, positions: Positions) {
  const t0 = performance.now()
  let moved = 0
  for (const id in positions) {
    const i = engine.nodeIndex(id)
    if (i < 0) continue
    const p = positions[id]
    const z = p.z ?? 0
    if (engine.x(i) !== p.x || engine.y(i) !== p.y || engine.z(i) !== z) {
      engine.setPosition(i, p.x, p.y, z)
      moved++
    }
  }
  if (moved) engine.commit()
  measure('gg:positions', { start: t0, detail: { moved } })
  return moved
}

/** Ids → indices, dropping unknown ids. */
export function indicesOf(engine: GraphEngine, ids: Iterable<EntityId>): Uint32Array {
  const out: number[] = []
  for (const id of ids) {
    const i = engine.nodeIndex(id)
    if (i >= 0) out.push(i)
  }
  return Uint32Array.from(out)
}
