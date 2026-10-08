/**
 * The bounds on what an entity from outside may be. A bundle, an import or a tool call is data nobody vetted: these
 * are the shapes past which the app's own machinery — the recursive pack encoder, `structuredClone` on the way into
 * IndexedDB, the history's hashing — fails, and the sizes past which a small file becomes a tab out of memory.
 */

/**
 * How deep a value in an entity may nest (`data`, a selector, a meta value). Real data is a handful of levels — a
 * GeoJSON multipolygon is six, a diagram's elements four or five. A value nested 100,000 deep stopped every later
 * save in the tab; 5,000 broke the history's hashing. An entity past this is refused on the way in.
 */
export const MAX_DATA_DEPTH = 64

/**
 * The same bound for what this app wrote itself and reads back (IndexedDB pages, history blobs): looser, so a value
 * written before `MAX_DATA_DEPTH` was enforced still reads, and still well inside what the decoder's recursion takes.
 */
export const MAX_STORED_DEPTH = 1000

/** How many entities a pack may hold. A million-entity project is the biggest the app is built for; this is five. */
export const MAX_PACK_ENTITIES = 5_000_000

/**
 * How many array items and map entries a pack's values may hold in all. Each costs a pointer or more once decoded
 * from a byte or two, so this, with `MAX_PACK_ENTITIES`, is what keeps a 512 MB pack from becoming tens of gigabytes.
 */
export const MAX_PACK_VALUES = 200_000_000

/**
 * Whether a JSON-like value nests deeper than `maxDepth` (a scalar is depth 0, `{}` or `[]` depth 1). The recursion
 * goes no further than `maxDepth + 1` levels whatever the value, so one built to exhaust the stack is answered, not
 * followed — and a cycle (an object graph, not JSON) answers true. A flat value costs a look at each of its fields.
 */
export function nestsDeeperThan(value: unknown, maxDepth: number): boolean {
  const deeper = (v: object, depth: number): boolean => {
    if (depth > maxDepth) return true
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const c: unknown = v[i]
        if (c !== null && typeof c === 'object' && deeper(c, depth + 1)) return true
      }
      return false
    }
    for (const k in v) {
      const c = (v as Record<string, unknown>)[k]
      if (c !== null && typeof c === 'object' && deeper(c, depth + 1)) return true
    }
    return false
  }
  return value !== null && typeof value === 'object' && deeper(value, 1)
}
