import type { EntityId } from '../../core/entity/types'
import type { NodeGeom } from '../../core/diagrams/geometry'
import type { ProjectionData, ProjectionGroup } from '../../core/graph/projection'

/**
 * Group behaviour on the Scenes page: a group is a box around its members
 * (entities, and nested groups) that keeps its padding when they move.
 */

const MIN_PAD = 8
const DEFAULT_PAD = { l: 16, t: 28, r: 16, b: 16 }

type Box = { x: number; y: number; width: number; height: number }

const nodeBox = (n: NodeGeom): Box => ({ x: n.x - n.width / 2, y: n.y - n.height / 2, width: n.width, height: n.height })
const contains = (b: Box, p: { x: number; y: number }) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
const containsBox = (outer: Box, inner: Box) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
const union = (boxes: Box[]): Box | null => {
  if (!boxes.length) return null
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.width))
  const y1 = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Groups whose `parent` is `gid`. */
export const childGroups = (groups: Record<string, ProjectionGroup>, gid: string) => Object.keys(groups).filter((k) => groups[k].parent === gid)

/** Every entity inside a group, including nested groups' members. */
export function descendants(groups: Record<string, ProjectionGroup>, gid: string, seen = new Set<string>()): EntityId[] {
  if (seen.has(gid)) return []
  seen.add(gid)
  const g = groups[gid]
  if (!g) return []
  return [...(g.members ?? []), ...childGroups(groups, gid).flatMap((c) => descendants(groups, c, seen))]
}

/** Parents before children is wrong for fitting; this is children first. */
export function fitOrder(groups: Record<string, ProjectionGroup>): string[] {
  const out: string[] = []
  const visit = (gid: string, seen: Set<string>) => {
    if (seen.has(gid)) return
    seen.add(gid)
    for (const c of childGroups(groups, gid)) visit(c, seen)
    out.push(gid)
  }
  const seen = new Set<string>()
  for (const gid of Object.keys(groups)) visit(gid, seen)
  return out
}

/**
 * Fill in what older or hand-made projections lack: members by containment,
 * parents by box containment, and padding measured from the captured box.
 */
export function normalizeGroups(data: ProjectionData): ProjectionData {
  const groups: Record<string, ProjectionGroup> = {}
  const ids = Object.keys(data.groups)
  const boxOf = (gid: string): Box => data.groups[gid]
  for (const gid of ids) {
    const g = { ...data.groups[gid] }
    // Parent: the smallest other group whose box fully contains this one.
    if (g.parent === undefined || !data.groups[g.parent]) {
      const outer = ids.filter((o) => o !== gid && containsBox(boxOf(o), g)).sort((a, b) => boxOf(a).width * boxOf(a).height - boxOf(b).width * boxOf(b).height)
      g.parent = outer[0]
    }
    groups[gid] = g
  }
  for (const gid of ids) {
    const g = groups[gid]
    if (!g.members?.length) {
      // Members: nodes whose centre is inside, and not inside a nested group of this one.
      const nested = childGroups(groups, gid)
      g.members = Object.entries(data.nodes)
        .filter(([, n]) => contains(g, n) && !nested.some((c) => contains(groups[c], n)))
        .map(([id]) => id)
    }
    if (!g.pad) {
      const inner = union([...g.members.map((m) => data.nodes[m]).filter(Boolean).map(nodeBox), ...childGroups(groups, gid).map((c) => groups[c] as Box)])
      g.pad = inner ? { l: Math.max(MIN_PAD, inner.x - g.x), t: Math.max(MIN_PAD, inner.y - g.y), r: Math.max(MIN_PAD, g.x + g.width - (inner.x + inner.width)), b: Math.max(MIN_PAD, g.y + g.height - (inner.y + inner.height)) } : { ...DEFAULT_PAD }
    }
  }
  return { ...data, groups }
}

/** Recompute every group's box from its members and nested groups, children first. */
export function fitGroups(data: ProjectionData): ProjectionData {
  const groups: Record<string, ProjectionGroup> = { ...data.groups }
  for (const gid of fitOrder(groups)) {
    const g = groups[gid]
    const pad = g.pad ?? DEFAULT_PAD
    const inner = union([...(g.members ?? []).map((m) => data.nodes[m]).filter(Boolean).map(nodeBox), ...childGroups(groups, gid).map((c) => groups[c] as Box)])
    if (!inner) continue
    groups[gid] = { ...g, x: inner.x - pad.l, y: inner.y - pad.t, width: inner.width + pad.l + pad.r, height: inner.height + pad.t + pad.b, label: g.label ? { x: inner.x - pad.l + 8, y: inner.y - pad.t + 16 } : undefined }
  }
  return { ...data, groups }
}

/** The deepest group whose box contains the point, ignoring `except` (and its descendants). */
export function groupAt(data: ProjectionData, p: { x: number; y: number }, except?: string): string | undefined {
  const skip = new Set<string>()
  if (except) {
    const walk = (gid: string) => {
      skip.add(gid)
      childGroups(data.groups, gid).forEach(walk)
    }
    walk(except)
  }
  const hits = Object.keys(data.groups).filter((gid) => !skip.has(gid) && contains(data.groups[gid], p))
  // Deepest = the one with the most ancestors.
  const depth = (gid: string): number => (data.groups[gid].parent ? 1 + depth(data.groups[gid].parent!) : 0)
  return hits.sort((a, b) => depth(b) - depth(a))[0]
}

/** Put an entity in a group (or in none), removing it from any other. */
export function setMembership(data: ProjectionData, id: EntityId, gid: string | undefined): ProjectionData {
  const groups: Record<string, ProjectionGroup> = {}
  for (const [k, g] of Object.entries(data.groups)) {
    const members = (g.members ?? []).filter((m) => m !== id)
    groups[k] = { ...g, members: k === gid ? [...members, id] : members }
  }
  return { ...data, groups }
}

/** Move a group: its members, nested groups, and the routes between members shift together. */
export function moveGroup(data: ProjectionData, gid: string, dx: number, dy: number, edges: { id: EntityId; source: EntityId; target: EntityId }[]): ProjectionData {
  const inside = new Set(descendants(data.groups, gid))
  const nodes = { ...data.nodes }
  for (const id of inside) if (nodes[id]) nodes[id] = { ...nodes[id], x: nodes[id].x + dx, y: nodes[id].y + dy }
  const edgeGeom = { ...data.edges }
  for (const e of edges) {
    const a = inside.has(e.source)
    const b = inside.has(e.target)
    if (!edgeGeom[e.id]) continue
    if (a && b) edgeGeom[e.id] = { ...edgeGeom[e.id], points: edgeGeom[e.id].points.map((p) => ({ x: p.x + dx, y: p.y + dy })), label: edgeGeom[e.id].label ? { x: edgeGeom[e.id].label!.x + dx, y: edgeGeom[e.id].label!.y + dy } : undefined }
    else if (a || b) delete edgeGeom[e.id]
  }
  return fitGroups({ ...data, nodes, edges: edgeGeom })
}
