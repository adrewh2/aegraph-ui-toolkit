/**
 * What changed in a per-node or per-edge array since the last upload, as blocks of `DIRTY_BLOCK` indices. A single
 * min–max span was the old record, and it cost whatever lay between two changes: a ⌘-click on node 5 and then on
 * node 900,000 re-sent 900,000 flags. A bit per block keeps the record O(1) to mark and the upload a handful of
 * runs — each run the blocks that changed, joined across gaps short enough that one more call costs more than
 * the bytes it would skip.
 */
export const DIRTY_BLOCK = 1024
const SHIFT = 10
/** Two runs this many blocks apart (or closer) are sent as one. */
const JOIN_GAP = 4
/** Past this many runs, the span is sent whole: the calls cost more than the bytes. */
const MAX_RUNS = 64

export class DirtyBlocks {
  private words = new Uint32Array(1)
  private lo = Infinity
  private hi = -Infinity

  /** Whether anything is marked. */
  get any(): boolean {
    return this.hi > this.lo
  }

  mark(i: number) {
    const b = i >>> SHIFT
    const w = b >>> 5
    if (w >= this.words.length) {
      const grown = new Uint32Array(Math.max(w + 1, this.words.length * 2))
      grown.set(this.words)
      this.words = grown
    }
    this.words[w] |= 1 << (b & 31)
    if (i < this.lo) this.lo = i
    if (i + 1 > this.hi) this.hi = i + 1
  }

  /** Everything below `n`. */
  markAll(n: number) {
    if (n <= 0) return
    this.lo = 0
    this.hi = Math.max(this.hi, n)
    this.all = true
  }
  private all = false

  clear() {
    if (this.hi > this.lo && !this.all) {
      const last = ((this.hi - 1) >>> SHIFT) >>> 5
      this.words.fill(0, (this.lo >>> SHIFT) >>> 5, last + 1)
    } else if (this.all) this.words.fill(0)
    this.lo = Infinity
    this.hi = -Infinity
    this.all = false
  }

  /**
   * Call `send(from, to)` for each run to upload, clipped to `limit`, then clear. The runs are in index order and
   * never overlap; their union covers every marked index.
   */
  flush(limit: number, send: (from: number, to: number) => void) {
    if (!this.any) return
    const lo = this.lo, hi = Math.min(this.hi, limit)
    if (hi <= lo) return this.clear()
    if (this.all) {
      send(lo, hi)
      return this.clear()
    }
    const runs: number[] = []
    const b0 = lo >>> SHIFT, b1 = (hi - 1) >>> SHIFT
    let start = -1, end = -1
    for (let b = b0; b <= b1; b++) {
      if (!(this.words[b >>> 5] & (1 << (b & 31)))) continue
      if (start >= 0 && b - end <= JOIN_GAP) end = b + 1
      else {
        if (start >= 0) runs.push(start, end)
        start = b
        end = b + 1
      }
    }
    if (start >= 0) runs.push(start, end)
    if (runs.length / 2 > MAX_RUNS) send(lo, hi)
    else for (let k = 0; k < runs.length; k += 2) send(Math.max(lo, runs[k] << SHIFT), Math.min(hi, runs[k + 1] << SHIFT))
    this.clear()
  }
}
