/**
 * Semantic ids (entity ids, generated names) ↔ dense integer indices. Every
 * hot path of the GPU graph — rendering, adjacency, picking, selection —
 * works on the index; the string is looked up only at the boundary (a tool
 * reply, the inspector). Indices are stable for as long as the id is known:
 * removing an id frees its slot for a later `intern`, and whoever reuses a
 * slot must reset what the per-index arrays held for it (`PackedGraph` does).
 */
export class IdRegistry {
  private readonly map = new Map<string, number>()
  /** index → id (undefined for a freed slot). */
  ids: (string | undefined)[] = []
  private free: number[] = []
  /**
   * Virtual mode: ids are `<prefix><index>` for `count` indices and nothing is stored — a generated graph of a
   * million nodes has ids without a million strings. `intern` of other ids still works (they go in the map).
   */
  private virtualPrefix: string | null = null
  private virtualCount = 0

  /** Make indices 0..count-1 answer to `<prefix><index>` without storing them. */
  setVirtual(prefix: string, count: number) {
    this.virtualPrefix = prefix
    this.virtualCount = count
  }
  private virtualIndex(id: string): number {
    const p = this.virtualPrefix
    if (p === null || !id.startsWith(p)) return -1
    const n = Number(id.slice(p.length))
    return Number.isInteger(n) && n >= 0 && n < this.virtualCount && String(n) === id.slice(p.length) ? n : -1
  }

  /** The index of `id`, or -1. */
  index(id: string): number {
    const i = this.map.get(id)
    if (i !== undefined) return i
    return this.virtualIndex(id)
  }
  has(id: string): boolean {
    return this.index(id) >= 0
  }
  id(index: number): string | undefined {
    const s = this.ids[index]
    if (s !== undefined) return s
    return this.virtualPrefix !== null && index < this.virtualCount ? `${this.virtualPrefix}${index}` : undefined
  }
  /** The index of `id`, allocating one when it is new. Returns the index and whether it was allocated now. */
  intern(id: string): number {
    const v = this.virtualIndex(id)
    if (v >= 0) return v
    const known = this.map.get(id)
    if (known !== undefined) return known
    const i = this.free.length ? this.free.pop()! : Math.max(this.ids.length, this.virtualCount)
    this.ids[i] = id
    this.map.set(id, i)
    return i
  }
  /** Bind `id` to a chosen index (an edge id to its edge index); whatever the slot held is forgotten. */
  assign(id: string, index: number) {
    const old = this.ids[index]
    if (old !== undefined && old !== id) this.map.delete(old)
    const prev = this.map.get(id)
    if (prev !== undefined && prev !== index) this.ids[prev] = undefined
    this.ids[index] = id
    this.map.set(id, index)
  }
  /** Forget `id`; its slot is reused by a later intern. Returns the freed index, or -1. */
  remove(id: string): number {
    const i = this.map.get(id)
    if (i === undefined) return -1
    this.map.delete(id)
    this.ids[i] = undefined
    this.free.push(i)
    return i
  }
  /** How many ids are known. */
  get size(): number {
    return this.map.size + this.virtualCount
  }
  /** Highest index ever allocated + 1: the length the per-index arrays need. */
  get capacity(): number {
    return Math.max(this.ids.length, this.virtualCount)
  }
  clear() {
    this.map.clear()
    this.ids.length = 0
    this.free.length = 0
    this.virtualPrefix = null
    this.virtualCount = 0
  }
}

/** Small interned vocabulary (node types, relationship types) → Uint16 codes. */
export class TypeTable {
  names: string[] = []
  private readonly map = new Map<string, number>()
  code(name: string): number {
    let c = this.map.get(name)
    if (c === undefined) {
      c = this.names.length
      this.names.push(name)
      this.map.set(name, c)
    }
    return c
  }
  lookup(name: string): number {
    const c = this.map.get(name)
    return c === undefined ? -1 : c
  }
  name(code: number): string {
    return this.names[code] ?? ''
  }
  get size(): number {
    return this.names.length
  }
}
