import { BitSet } from './bitset'

/**
 * The graph as packed arrays: nodes and edges are integer indices, types
 * are Uint16 codes, adjacency is CSR (compressed sparse row) — one offsets
 * array and one neighbours array, so a node's neighbourhood is a contiguous
 * range and a lookup costs its degree, never a hash walk. Edges added after
 * the CSR was built go into a small delta structure (per-node linked lists
 * of half-edges) that every neighbourhood walk also visits; when the delta
 * grows past a fraction of the graph, `compact` rebuilds the CSR in one
 * O(V+E) counting sort. Removals are tombstones (`edgeAlive`, `nodeAlive`),
 * skipped by every walk and dropped at the next compaction. Adding a hundred
 * edges to half a million therefore touches a hundred entries, not the
 * adjacency of everything.
 */
export class PackedGraph {
  nodeCount = 0
  edgeCount = 0
  nodeType: Uint16Array
  nodeAlive: BitSet
  degree: Uint32Array
  edgeSource: Uint32Array
  edgeTarget: Uint32Array
  edgeType: Uint16Array
  edgeDirected: BitSet
  edgeAlive: BitSet

  // ── CSR, over the edges that existed at the last build ──
  offsets = new Uint32Array(1)
  neighbors = new Uint32Array(0)
  edgeIndex = new Uint32Array(0)
  private csrEdges = 0
  private csrNodes = 0
  /** Alive edges when the CSR was built: fewer now means removals the CSR still lists. */
  private csrAlive = 0

  // ── Delta: half-edges of edges added since the last build, linked per node ──
  private deltaHead: Int32Array
  private deltaNext = new Int32Array(0)
  private deltaEdge = new Uint32Array(0)
  private deltaOther = new Uint32Array(0)
  private deltaCount = 0
  /** Edges in the delta before a walk is slower than a rebuild; rebuilt past this many, or an eighth of the CSR. */
  static readonly DELTA_MIN = 1024

  constructor(nodeCapacity = 1024, edgeCapacity = 4096) {
    this.nodeType = new Uint16Array(nodeCapacity)
    this.nodeAlive = new BitSet(nodeCapacity)
    this.degree = new Uint32Array(nodeCapacity)
    this.deltaHead = new Int32Array(nodeCapacity).fill(-1)
    this.edgeSource = new Uint32Array(edgeCapacity)
    this.edgeTarget = new Uint32Array(edgeCapacity)
    this.edgeType = new Uint16Array(edgeCapacity)
    this.edgeDirected = new BitSet(edgeCapacity)
    this.edgeAlive = new BitSet(edgeCapacity)
  }

  get nodeCapacity(): number {
    return this.nodeType.length
  }
  get edgeCapacity(): number {
    return this.edgeSource.length
  }
  /** Edges added since the last CSR build (what `compact` would fold in). */
  get pendingEdges(): number {
    return this.deltaCount
  }

  ensureNodeCapacity(n: number) {
    if (n <= this.nodeType.length) return
    let cap = Math.max(1024, this.nodeType.length)
    while (cap < n) cap *= 2
    this.nodeType = grow(this.nodeType, cap)
    this.degree = grow(this.degree, cap)
    const head = new Int32Array(cap).fill(-1)
    head.set(this.deltaHead)
    this.deltaHead = head
    this.nodeAlive.resize(cap)
  }
  ensureEdgeCapacity(e: number) {
    if (e <= this.edgeSource.length) return
    let cap = Math.max(4096, this.edgeSource.length)
    while (cap < e) cap *= 2
    this.edgeSource = grow(this.edgeSource, cap)
    this.edgeTarget = grow(this.edgeTarget, cap)
    this.edgeType = grow(this.edgeType, cap)
    this.edgeDirected.resize(cap)
    this.edgeAlive.resize(cap)
  }

  // ── Nodes ──
  /** A new node at the next index. */
  addNode(type: number): number {
    const i = this.nodeCount
    this.setNode(i, type)
    return i
  }
  /** A node at a chosen index (the id registry's), alive from now; a reused slot starts with no edges. */
  setNode(i: number, type: number) {
    this.ensureNodeCapacity(i + 1)
    if (i >= this.nodeCount) this.nodeCount = i + 1
    this.nodeType[i] = type
    if (!this.nodeAlive.has(i)) {
      this.nodeAlive.set(i)
      this.degree[i] = 0
      this.deltaHead[i] = -1
    }
  }
  /** Remove a node and every edge at it. */
  removeNode(i: number) {
    if (!this.nodeAlive.has(i)) return
    this.forEachIncident(i, (e) => this.removeEdge(e))
    this.nodeAlive.clear(i)
    this.degree[i] = 0
  }
  hasNode(i: number): boolean {
    return i < this.nodeCount && this.nodeAlive.has(i)
  }

  // ── Edges ──
  addEdge(source: number, target: number, type: number, directed = false): number {
    const e = this.edgeCount++
    this.ensureEdgeCapacity(this.edgeCount)
    this.edgeSource[e] = source
    this.edgeTarget[e] = target
    this.edgeType[e] = type
    this.edgeDirected.put(e, directed)
    this.edgeAlive.set(e)
    this.degree[source]++
    if (target !== source) this.degree[target]++
    this.linkDelta(e, source, target)
    if (target !== source) this.linkDelta(e, target, source)
    return e
  }
  removeEdge(e: number) {
    if (!this.edgeAlive.has(e)) return
    this.edgeAlive.clear(e)
    const s = this.edgeSource[e], t = this.edgeTarget[e]
    this.degree[s]--
    if (t !== s) this.degree[t]--
  }
  hasEdge(e: number): boolean {
    return e < this.edgeCount && this.edgeAlive.has(e)
  }
  private linkDelta(e: number, at: number, other: number) {
    const k = this.deltaCount++
    if (k >= this.deltaNext.length) {
      const cap = Math.max(256, this.deltaNext.length * 2)
      this.deltaNext = grow(this.deltaNext, cap)
      this.deltaEdge = grow(this.deltaEdge, cap)
      this.deltaOther = grow(this.deltaOther, cap)
    }
    this.deltaNext[k] = this.deltaHead[at]
    this.deltaEdge[k] = e
    this.deltaOther[k] = other
    this.deltaHead[at] = k
  }

  // ── Adjacency ──
  /** Every alive edge at `i`, with the node at its other end. Zero allocation. */
  forEachIncident(i: number, fn: (edge: number, other: number) => void) {
    if (i < this.csrNodes) {
      const end = this.offsets[i + 1]
      for (let k = this.offsets[i]; k < end; k++) {
        const e = this.edgeIndex[k]
        if (this.edgeAlive.has(e)) fn(e, this.neighbors[k])
      }
    }
    for (let k = this.deltaHead[i]; k >= 0; k = this.deltaNext[k]) {
      const e = this.deltaEdge[k]
      if (this.edgeAlive.has(e)) fn(e, this.deltaOther[k])
    }
  }
  /** Neighbour indices of `i` into `out` (up to its length); returns how many were written. */
  neighborsOf(i: number, out: Uint32Array): number {
    let n = 0
    this.forEachIncident(i, (_e, other) => {
      if (n < out.length) out[n++] = other
    })
    return n
  }
  /** Mark, in `out`, every node within one hop of a set node in `from` (not the set itself unless linked back). */
  neighborhood(from: BitSet, out: BitSet) {
    from.forEach((i) => this.forEachIncident(i, (_e, other) => out.set(other)))
  }

  /** Whether the CSR alone is the adjacency: no delta, no edge removed since it was built. */
  csrIsExact(): boolean {
    return this.deltaCount === 0 && this.csrNodes === this.nodeCount && this.csrEdges === this.edgeCount && this.edgeAlive.count() === this.csrAlive
  }
  /** Whether the delta has grown enough that a walk pays for a rebuild. */
  needsCompact(): boolean {
    return this.deltaCount > Math.max(PackedGraph.DELTA_MIN, this.csrEdges >>> 3)
  }
  compactIfNeeded(): boolean {
    if (!this.needsCompact()) return false
    this.compact()
    return true
  }

  /** Rebuild the CSR over every alive edge (one counting sort) and empty the delta. */
  compact() {
    const N = this.nodeCount
    const E = this.edgeCount
    const offsets = new Uint32Array(N + 1)
    const src = this.edgeSource, dst = this.edgeTarget, alive = this.edgeAlive
    for (let e = 0; e < E; e++) {
      if (!alive.has(e)) continue
      offsets[src[e] + 1]++
      if (dst[e] !== src[e]) offsets[dst[e] + 1]++
    }
    for (let i = 0; i < N; i++) offsets[i + 1] += offsets[i]
    const total = offsets[N]
    const neighbors = new Uint32Array(total)
    const edgeIndex = new Uint32Array(total)
    const fill = new Uint32Array(N)
    let aliveCount = 0
    for (let e = 0; e < E; e++) {
      if (!alive.has(e)) continue
      aliveCount++
      const s = src[e], t = dst[e]
      let k = offsets[s] + fill[s]++
      neighbors[k] = t
      edgeIndex[k] = e
      if (t !== s) {
        k = offsets[t] + fill[t]++
        neighbors[k] = s
        edgeIndex[k] = e
      }
    }
    this.offsets = offsets
    this.neighbors = neighbors
    this.edgeIndex = edgeIndex
    this.csrEdges = E
    this.csrNodes = N
    this.csrAlive = aliveCount
    this.deltaHead.fill(-1, 0, N)
    this.deltaCount = 0
  }

  /** Alive edge count. */
  aliveEdges(): number {
    return this.edgeAlive.count()
  }
  aliveNodes(): number {
    return this.nodeAlive.count()
  }

  /** Drop every edge (nodes stay); edge indices start again from 0. */
  clearEdges() {
    this.edgeCount = 0
    this.edgeAlive.clearAll()
    this.edgeDirected.clearAll()
    this.degree.fill(0, 0, this.nodeCount)
    this.deltaHead.fill(-1, 0, this.nodeCount)
    this.deltaCount = 0
    this.offsets = new Uint32Array(1)
    this.neighbors = new Uint32Array(0)
    this.edgeIndex = new Uint32Array(0)
    this.csrEdges = 0
    this.csrNodes = 0
  }

  /** Throw away everything (capacities kept). */
  clear() {
    this.nodeCount = 0
    this.edgeCount = 0
    this.nodeAlive.clearAll()
    this.edgeAlive.clearAll()
    this.degree.fill(0)
    this.deltaHead.fill(-1)
    this.deltaCount = 0
    this.offsets = new Uint32Array(1)
    this.neighbors = new Uint32Array(0)
    this.edgeIndex = new Uint32Array(0)
    this.csrEdges = 0
    this.csrNodes = 0
  }

  /**
   * Build from whole arrays at once (a generator's output, a worker's reply): the arrays become the graph's own,
   * the CSR is built, nothing is copied.
   */
  static fromArrays(a: { nodeType: Uint16Array; edgeSource: Uint32Array; edgeTarget: Uint32Array; edgeType: Uint16Array; directed?: Uint8Array | boolean }): PackedGraph {
    const N = a.nodeType.length
    const E = a.edgeSource.length
    const g = new PackedGraph(N, E)
    g.nodeType = a.nodeType
    g.nodeAlive = new BitSet(N)
    g.nodeAlive.setAll()
    g.degree = new Uint32Array(N)
    g.deltaHead = new Int32Array(N).fill(-1)
    g.nodeCount = N
    g.edgeSource = a.edgeSource
    g.edgeTarget = a.edgeTarget
    g.edgeType = a.edgeType
    g.edgeAlive = new BitSet(E)
    g.edgeAlive.setAll()
    g.edgeDirected = new BitSet(E)
    if (a.directed === true) g.edgeDirected.setAll()
    else if (a.directed instanceof Uint8Array) for (let e = 0; e < E; e++) if (a.directed[e]) g.edgeDirected.set(e)
    g.edgeCount = E
    for (let e = 0; e < E; e++) {
      g.degree[a.edgeSource[e]]++
      if (a.edgeTarget[e] !== a.edgeSource[e]) g.degree[a.edgeTarget[e]]++
    }
    g.compact()
    return g
  }
}

function grow<T extends Uint32Array | Uint16Array | Int32Array | Float32Array>(a: T, cap: number): T {
  const out = new (a.constructor as new (n: number) => T)(cap)
  out.set(a as unknown as ArrayLike<number>)
  return out
}
export { grow }
