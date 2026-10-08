import type { BitSet } from './bitset'

/**
 * A uniform grid over node positions, built by one counting sort: `cellStart`
 * holds where each cell's run of node indices begins in `items`. Picking the
 * node under the pointer, or the nodes in a marquee, then visits a handful of
 * cells instead of two hundred thousand nodes. The cell size adapts to the
 * density so a cell holds a few nodes; a build is O(N) and cheap enough to
 * redo after a layout lands or a drag ends (a few milliseconds at 200k), so
 * nothing tries to keep it incrementally correct during a drag — the engine
 * simply excludes the nodes being dragged.
 */
export class SpatialGrid {
  minX = 0
  minY = 0
  cellSize = 1
  /** Floats per node in the position arrays passed in (3 for x, y, z; 4 for the engine's x, y, z, r). */
  stride = 3
  cols = 0
  rows = 0
  cellStart = new Uint32Array(1)
  items = new Uint32Array(0)
  private fill = new Uint32Array(0)
  count = 0

  /** Index `count` nodes from `positions` (x, y, z[, r] interleaved, `stride` floats a node; the grid is over x, y); nodes not in `alive` (when given) are left out. */
  build(positions: Float32Array, count: number, alive?: BitSet | null, targetPerCell = 4, stride = 3) {
    this.stride = stride
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let n = 0
    for (let i = 0; i < count; i++) {
      if (alive && !alive.has(i)) continue
      const x = positions[i * stride], y = positions[i * stride + 1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      n++
    }
    this.count = n
    if (n === 0) {
      this.cols = this.rows = 0
      this.cellStart = new Uint32Array(1)
      this.items = new Uint32Array(0)
      return
    }
    const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6)
    // About `targetPerCell` nodes per cell at the mean density, at most ~1M cells whatever the spread.
    let cell = Math.sqrt((w * h * targetPerCell) / n)
    if (!(cell > 0)) cell = 1
    let cols = Math.ceil(w / cell) + 1, rows = Math.ceil(h / cell) + 1
    while (cols * rows > 1 << 20) {
      cell *= 2
      cols = Math.ceil(w / cell) + 1
      rows = Math.ceil(h / cell) + 1
    }
    this.minX = minX
    this.minY = minY
    this.cellSize = cell
    this.cols = cols
    this.rows = rows
    const cells = cols * rows
    if (this.cellStart.length < cells + 1) this.cellStart = new Uint32Array(cells + 1)
    else this.cellStart.fill(0, 0, cells + 1)
    if (this.fill.length < cells) this.fill = new Uint32Array(cells)
    else this.fill.fill(0, 0, cells)
    if (this.items.length < n) this.items = new Uint32Array(n)
    const start = this.cellStart, fill = this.fill, items = this.items
    const inv = 1 / cell
    for (let i = 0; i < count; i++) {
      if (alive && !alive.has(i)) continue
      start[this.cellOf(positions[i * stride], positions[i * stride + 1], inv) + 1]++
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c]
    for (let i = 0; i < count; i++) {
      if (alive && !alive.has(i)) continue
      const c = this.cellOf(positions[i * stride], positions[i * stride + 1], inv)
      items[start[c] + fill[c]++] = i
    }
  }

  private cellOf(x: number, y: number, inv: number): number {
    let cx = ((x - this.minX) * inv) | 0
    let cy = ((y - this.minY) * inv) | 0
    if (cx < 0) cx = 0
    else if (cx >= this.cols) cx = this.cols - 1
    if (cy < 0) cy = 0
    else if (cy >= this.rows) cy = this.rows - 1
    return cy * this.cols + cx
  }

  /**
   * The node nearest to (x, y) whose disc — `radiusOf(i)` in world units — covers the point, within `reach`
   * (the largest disc plus tolerance, in world units). Nodes rejected by `accept` are skipped. -1 when none.
   */
  nearest(positions: Float32Array, x: number, y: number, reach: number, radiusOf: (i: number) => number, accept?: (i: number) => boolean): number {
    if (this.count === 0) return -1
    const inv = 1 / this.cellSize
    const c0 = Math.max(0, Math.floor((x - reach - this.minX) * inv)), c1 = Math.min(this.cols - 1, Math.floor((x + reach - this.minX) * inv))
    const r0 = Math.max(0, Math.floor((y - reach - this.minY) * inv)), r1 = Math.min(this.rows - 1, Math.floor((y + reach - this.minY) * inv))
    let best = -1
    let bestD = Infinity
    const stride = this.stride
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const c = cy * this.cols + cx
        const end = this.cellStart[c + 1]
        for (let k = this.cellStart[c]; k < end; k++) {
          const i = this.items[k]
          if (accept && !accept(i)) continue
          const dx = positions[i * stride] - x, dy = positions[i * stride + 1] - y
          const d = dx * dx + dy * dy
          const r = radiusOf(i)
          // Inside the disc, and nearer to the centre than the best so far (a smaller node on top of a big one wins by distance).
          if (d <= r * r && d < bestD) {
            bestD = d
            best = i
          }
        }
      }
    }
    return best
  }

  /** How many indexed nodes the cells overlapping the rectangle hold — an estimate of what is in view, O(cells). */
  countInRect(minX: number, minY: number, maxX: number, maxY: number): number {
    if (this.count === 0) return 0
    const inv = 1 / this.cellSize
    const c0 = Math.max(0, Math.floor((minX - this.minX) * inv)), c1 = Math.min(this.cols - 1, Math.floor((maxX - this.minX) * inv))
    const r0 = Math.max(0, Math.floor((minY - this.minY) * inv)), r1 = Math.min(this.rows - 1, Math.floor((maxY - this.minY) * inv))
    if (c1 < c0 || r1 < r0) return 0
    let n = 0
    for (let cy = r0; cy <= r1; cy++) n += this.cellStart[cy * this.cols + c1 + 1] - this.cellStart[cy * this.cols + c0]
    return n
  }

  /** Every indexed node whose centre lies in the rectangle. */
  forEachInRect(positions: Float32Array, minX: number, minY: number, maxX: number, maxY: number, fn: (i: number) => void) {
    if (this.count === 0) return
    const inv = 1 / this.cellSize
    const c0 = Math.max(0, Math.floor((minX - this.minX) * inv)), c1 = Math.min(this.cols - 1, Math.floor((maxX - this.minX) * inv))
    const r0 = Math.max(0, Math.floor((minY - this.minY) * inv)), r1 = Math.min(this.rows - 1, Math.floor((maxY - this.minY) * inv))
    if (c1 < c0 || r1 < r0) return
    const stride = this.stride
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const c = cy * this.cols + cx
        const end = this.cellStart[c + 1]
        for (let k = this.cellStart[c]; k < end; k++) {
          const i = this.items[k]
          const x = positions[i * stride], y = positions[i * stride + 1]
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) fn(i)
        }
      }
    }
  }
}
