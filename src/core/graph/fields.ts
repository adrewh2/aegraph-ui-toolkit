import type { AnyEntity } from '../entity/types'
import type { ValueContext } from './values'

/**
 * Attribute predicates for filters: `data.year >= 1900`, `meta.createdAt
 * between …`, `label contains …`. Values are compared after coercion so a
 * string "1900" in the data still matches a numeric bound.
 */

export type FieldOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'exists' | 'in'

export interface FieldPredicate {
  /** `data.<key>`, `meta.createdAt`, `label`, `type`, `id`, `tags` */
  path: string
  op: FieldOp
  /** `between`: [lo, hi]; `in`: list; `exists`: ignored. */
  value?: unknown
}

export const FIELD_OPS: { id: FieldOp; label: string; arity: 0 | 1 | 2 | 'list' }[] = [
  { id: 'eq', label: '=', arity: 1 },
  { id: 'neq', label: '≠', arity: 1 },
  { id: 'contains', label: 'contains', arity: 1 },
  { id: 'gt', label: '>', arity: 1 },
  { id: 'gte', label: '≥', arity: 1 },
  { id: 'lt', label: '<', arity: 1 },
  { id: 'lte', label: '≤', arity: 1 },
  { id: 'between', label: 'between', arity: 2 },
  { id: 'in', label: 'in', arity: 'list' },
  { id: 'exists', label: 'exists', arity: 0 },
]

/** A data field by key; a dotted key that is not a field itself walks into nested objects (`address.city`). */
export function dataAt(data: Record<string, unknown>, key: string): unknown {
  if (key in data) return data[key]
  if (!key.includes('.')) return undefined
  let cur: unknown = data
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function getPath(e: AnyEntity, path: string): unknown {
  if (path.startsWith('data.')) return dataAt(e.data, path.slice(5))
  if (path.startsWith('meta.')) return (e.meta as unknown as Record<string, unknown>)[path.slice(5)]
  switch (path) {
    case 'label':
      return e.label
    case 'type':
      return e.type
    case 'id':
      return e.id
    case 'tags':
      return e.tags
    case 'description':
      return e.description
    default:
      return (e as unknown as Record<string, unknown>)[path]
  }
}

export const ISO = /^\d{4}-\d{2}-\d{2}(T|$)/

/**
 * Sort keyed items by their key — numbers as numbers, else through `coerce` — with the items that have no key
 * (undefined, NaN or '') last whichever way the sort runs. `desc` reverses the valued items only, so "top 5 by
 * PageRank" never opens with the blanks. Ties keep their order.
 */
export function sortWithBlanksLast<T extends { k: number | string | undefined }>(items: T[], desc = false): T[] {
  const blank = (k: T['k']) => k === undefined || k === '' || (typeof k === 'number' && Number.isNaN(k))
  const valued = items.filter((x) => !blank(x.k))
  const rest = items.filter((x) => blank(x.k))
  valued.sort((a, b) => {
    if (typeof a.k === 'number' && typeof b.k === 'number') return a.k - b.k
    const [x, y] = coerce(a.k, b.k)
    return x < y ? -1 : x > y ? 1 : 0
  })
  if (desc) valued.reverse()
  return [...valued, ...rest]
}

/** Bring two values onto a comparable axis: numbers, epoch ms for ISO dates, booleans as text, else lowercased strings. */
export function coerce(a: unknown, b: unknown): [number, number] | [string, string] {
  const na = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' && Number.isFinite(Number(a)) ? Number(a) : NaN
  const nb = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' && Number.isFinite(Number(b)) ? Number(b) : NaN
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return [na, nb]
  if (typeof a === 'string' && typeof b === 'string' && ISO.test(a) && ISO.test(b)) {
    const da = Date.parse(a)
    const db = Date.parse(b)
    if (!Number.isNaN(da) && !Number.isNaN(db)) return [da, db]
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return [String(a), String(b)]
  return [String(a ?? '').toLowerCase(), String(b ?? '').toLowerCase()]
}

const cmp = (a: unknown, b: unknown): number => {
  const [x, y] = coerce(a, b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Resolve the value a predicate path refers to; computed refs (metric., degree…) need a context. */
export function predicateValue(e: AnyEntity, path: string, ctx?: ValueContext): unknown {
  if (ctx && !/^(data|meta)\./.test(path) && path !== 'label' && path !== 'type' && path !== 'id' && path !== 'tags' && path !== 'description') {
    // values.ts imports this module, so computed refs resolve through the ctx-supplied function.
    return ctx.resolve ? ctx.resolve(e, path) : undefined
  }
  const v = getPath(e, path)
  // A loaded project's exported values read as data.
  if (v === undefined && ctx?.overlay && path.startsWith('data.')) return ctx.overlay.get(e.id)?.[path.slice(5)]
  return v
}

export function matchPredicate(e: AnyEntity, p: FieldPredicate, ctx?: ValueContext): boolean {
  const v = predicateValue(e, p.path, ctx)
  const present = v !== undefined && v !== null && v !== ''
  switch (p.op) {
    case 'exists':
      return present
    case 'eq':
      return present && (Array.isArray(v) ? v.some((x) => cmp(x, p.value) === 0) : cmp(v, p.value) === 0)
    case 'neq':
      return !present || (Array.isArray(v) ? !v.some((x) => cmp(x, p.value) === 0) : cmp(v, p.value) !== 0)
    case 'contains': {
      if (!present) return false
      const needle = String(p.value ?? '').toLowerCase()
      if (Array.isArray(v)) return v.some((x) => String(x).toLowerCase().includes(needle))
      return String(typeof v === 'object' ? JSON.stringify(v) : v).toLowerCase().includes(needle)
    }
    case 'gt':
      return present && cmp(v, p.value) > 0
    case 'gte':
      return present && cmp(v, p.value) >= 0
    case 'lt':
      return present && cmp(v, p.value) < 0
    case 'lte':
      return present && cmp(v, p.value) <= 0
    case 'between': {
      if (!present || !Array.isArray(p.value) || p.value.length < 2) return false
      const [lo, hi] = p.value as [unknown, unknown]
      return cmp(v, lo) >= 0 && cmp(v, hi) <= 0
    }
    case 'in': {
      if (!present) return false
      const list = Array.isArray(p.value) ? p.value : String(p.value ?? '').split(/[,;|]/).map((s) => s.trim()).filter(Boolean)
      const hit = (x: unknown) => list.some((y) => cmp(x, y) === 0)
      return Array.isArray(v) ? v.some(hit) : hit(v)
    }
  }
}

/** Paths worth offering in a predicate builder: primitive-valued `data.*` keys seen in the first `limit` nodes, plus the common base fields. */
export function sampleDataKeys(nodes: AnyEntity[], limit = 500): string[] {
  const keys = new Set<string>(['label', 'type', 'tags', 'meta.createdAt', 'meta.updatedAt'])
  const n = Math.min(nodes.length, limit)
  for (let i = 0; i < n; i++) {
    const d = nodes[i].data
    for (const k in d) {
      const v = d[k]
      if (v === null || v === undefined) continue
      const t = typeof v
      if (t === 'string' || t === 'number' || t === 'boolean') keys.add(`data.${k}`)
    }
  }
  return [...keys].sort()
}

export function describePredicate(p: FieldPredicate): string {
  const op = FIELD_OPS.find((o) => o.id === p.op)
  const fmt = (v: unknown) => (typeof v === 'string' ? (v.length > 24 ? `“${v.slice(0, 22)}…”` : /\s/.test(v) ? `“${v}”` : v) : String(v))
  if (p.op === 'exists') return `${p.path} exists`
  if (p.op === 'between' && Array.isArray(p.value)) return `${p.path} in [${fmt(p.value[0])}, ${fmt(p.value[1])}]`
  if (p.op === 'in') return `${p.path} in {${(Array.isArray(p.value) ? p.value : [p.value]).map(fmt).join(', ')}}`
  return `${p.path} ${op?.label ?? p.op} ${fmt(p.value)}`
}
