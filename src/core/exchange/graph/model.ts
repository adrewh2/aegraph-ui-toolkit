import type { TypeRegistry } from '../../entity/typeRegistry'
import type { AnyEntity, EntityId, Relationship } from '../../entity/types'
import type { Positions } from '../../graph/layouts'
import type { EdgeStyle, NodeStyle } from '../../graph/rendering'

/**
 * Format-neutral shape every interchange format parses into and writes
 * from. Keeping it plain keeps the format modules small and testable.
 */

export interface GNode {
  id: string
  label?: string
  attrs: Record<string, unknown>
  viz?: { color?: string; size?: number; x?: number; y?: number; z?: number; shape?: string }
}

export interface GEdge {
  id?: string
  source: string
  target: string
  directed?: boolean
  label?: string
  weight?: number
  attrs: Record<string, unknown>
}

export interface ParsedGraph {
  nodes: GNode[]
  edges: GEdge[]
  directedDefault: boolean
  attributeKeys: { nodes: string[]; edges: string[] }
  warnings: string[]
}

export interface ExportFile {
  name: string
  text: string
  mime: string
}

export interface GraphExportInput {
  nodes: AnyEntity[]
  edges: Relationship[]
  positions?: Positions
  styles?: { nodes: Map<EntityId, NodeStyle>; edges: Map<EntityId, EdgeStyle> }
  registry?: TypeRegistry
  /** Base file name without extension. */
  name?: string
}

/**
 * Keys that name an object's machinery rather than a field of its own. A graph file's attribute names become object
 * keys (a node's `attrs`, then an entity's `data`); one of these would write through the object's prototype instead
 * of into it. Every reader drops them, as `nodeLink.ts` always has.
 */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])
export const isUnsafeKey = (k: string) => UNSAFE_KEYS.has(k)
/**
 * Every name a plain object already answers to (`toString`, `hasOwnProperty`, `__proto__`, `constructor`…) and
 * `prototype`: what a library that looks a file's names up in a plain object would find there instead of nothing.
 */
export const isObjectMachinery = (k: string) => k === 'prototype' || Object.hasOwn(Object.prototype, k)

/** Copy `from` into `to`, leaving out the keys that name an object's machinery; returns `to`. */
export function assignSafe(to: Record<string, unknown>, from: Record<string, unknown>, skip?: ReadonlySet<string>): Record<string, unknown> {
  for (const k of Object.keys(from)) if (!UNSAFE_KEYS.has(k) && !skip?.has(k)) to[k] = from[k]
  return to
}

/** Collect attribute keys across nodes/edges, most common first. */
export function attributeKeys(items: { attrs: Record<string, unknown> }[]): string[] {
  const counts = new Map<string, number>()
  for (const it of items) for (const k of Object.keys(it.attrs)) counts.set(k, (counts.get(k) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k)
}
