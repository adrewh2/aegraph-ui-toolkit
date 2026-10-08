/**
 * A fixed-size set of small integers, one bit each. The GPU graph keeps every
 * per-node and per-edge predicate this way — selected, visible, filtered,
 * around the selection — so combining them (visible AND selected, neighbours
 * AND visible) is a word-wise pass over a few kilobytes, never a Set walk.
 * No method allocates once the set exists; `and`/`or`/`andNot` write into
 * a set the caller owns.
 */
export class BitSet {
  words: Uint32Array
  size: number

  constructor(size: number) {
    this.size = size
    this.words = new Uint32Array((size + 31) >>> 5)
  }

  /**
   * Hold `size` bits; the bits already set below it stay set. The words are never given back — a set shrunk for a
   * small graph keeps its storage for the next big one — but the bits past the new size are cleared, so growing
   * again finds them empty rather than set from before. Growing copies only the words that exist: after a shrink
   * the storage can be longer than a smaller-but-growing size needs (a 16k set shrunk to 1k, then grown to 8k), and
   * copying all of it into the new array threw ("offset is out of bounds").
   */
  resize(size: number) {
    if (size <= this.size) {
      this.clearFrom(size)
      this.size = size
      return
    }
    const need = (size + 31) >>> 5
    if (need > this.words.length) {
      const words = new Uint32Array(need)
      words.set(this.words)
      this.words = words
    }
    this.size = size
  }

  /** Clear every bit from `from` to the end of the storage. */
  private clearFrom(from: number) {
    const w = from >>> 5
    if (w >= this.words.length) return
    const r = from & 31
    this.words[w] &= r ? (1 << r) - 1 : 0
    this.words.fill(0, w + 1)
  }

  has(i: number): boolean {
    return (this.words[i >>> 5] & (1 << (i & 31))) !== 0
  }
  set(i: number) {
    this.words[i >>> 5] |= 1 << (i & 31)
  }
  clear(i: number) {
    this.words[i >>> 5] &= ~(1 << (i & 31))
  }
  put(i: number, on: boolean) {
    if (on) this.set(i)
    else this.clear(i)
  }
  toggle(i: number) {
    this.words[i >>> 5] ^= 1 << (i & 31)
  }
  clearAll() {
    this.words.fill(0)
  }
  /** Set every bit below `size` (the padding bits of the last word stay clear). */
  setAll() {
    this.words.fill(0xffffffff)
    const rest = this.size & 31
    if (rest) this.words[this.words.length - 1] = (1 << rest) - 1 >>> 0
    if (this.size === 0) this.words.fill(0)
  }
  isEmpty(): boolean {
    const w = this.words
    for (let i = 0; i < w.length; i++) if (w[i]) return false
    return true
  }

  /** How many bits are set. */
  count(): number {
    const w = this.words
    let n = 0
    for (let i = 0; i < w.length; i++) {
      let v = w[i]
      v = v - ((v >>> 1) & 0x55555555)
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
      n += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
    }
    return n
  }

  /** `out = this AND other` (out may be this). */
  and(other: BitSet, out: BitSet = this): BitSet {
    const a = this.words, b = other.words, o = out.words
    for (let i = 0; i < o.length; i++) o[i] = (a[i] ?? 0) & (b[i] ?? 0)
    return out
  }
  or(other: BitSet, out: BitSet = this): BitSet {
    const a = this.words, b = other.words, o = out.words
    for (let i = 0; i < o.length; i++) o[i] = (a[i] ?? 0) | (b[i] ?? 0)
    return out
  }
  /** `out = this AND NOT other`. */
  andNot(other: BitSet, out: BitSet = this): BitSet {
    const a = this.words, b = other.words, o = out.words
    for (let i = 0; i < o.length; i++) o[i] = (a[i] ?? 0) & ~(b[i] ?? 0)
    return out
  }
  xor(other: BitSet, out: BitSet = this): BitSet {
    const a = this.words, b = other.words, o = out.words
    for (let i = 0; i < o.length; i++) o[i] = (a[i] ?? 0) ^ (b[i] ?? 0)
    return out
  }
  copyFrom(other: BitSet) {
    this.words.set(other.words.subarray(0, this.words.length))
  }
  equals(other: BitSet): boolean {
    if (other.size !== this.size) return false
    for (let i = 0; i < this.words.length; i++) if (this.words[i] !== other.words[i]) return false
    return true
  }

  /** Call `fn` with every set index, ascending. */
  forEach(fn: (i: number) => void) {
    const w = this.words
    for (let wi = 0; wi < w.length; wi++) {
      let v = w[wi]
      while (v) {
        const t = v & -v
        const bit = 31 - Math.clz32(t)
        fn((wi << 5) + bit)
        v ^= t
      }
    }
  }

  /** The set indices as a typed array (allocates; for handing to a worker or a caller that wants a list). */
  toArray(): Uint32Array {
    const out = new Uint32Array(this.count())
    let k = 0
    this.forEach((i) => (out[k++] = i))
    return out
  }

  /** The first set index, or -1. */
  first(): number {
    const w = this.words
    for (let wi = 0; wi < w.length; wi++) {
      const v = w[wi]
      if (v) return (wi << 5) + (31 - Math.clz32(v & -v))
    }
    return -1
  }

  clone(): BitSet {
    const b = new BitSet(this.size)
    b.words.set(this.words)
    return b
  }

  static from(indices: ArrayLike<number>, size: number): BitSet {
    const b = new BitSet(size)
    for (let i = 0; i < indices.length; i++) b.set(indices[i])
    return b
  }
}
