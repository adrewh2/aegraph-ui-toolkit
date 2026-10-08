import { BitSet } from '../packed/bitset'

/**
 * A set of entity handles (`EntityStore.handleOf`): a bit each, growing as the store does, with its size kept as it
 * changes — so "how many?" is a field, never a count over the set. What a project's working diff holds (added,
 * modified, touched since the last read) for a project of two million entities: 250 KB a set, where a Map of the
 * entities was about 80 MB and every count of it an array of two million built and thrown away.
 */
export class HandleSet {
  private bits = new BitSet(1024)
  size = 0

  has(h: number): boolean {
    return h < this.bits.size && this.bits.has(h)
  }

  add(h: number): void {
    if (h >= this.bits.size) this.bits.resize(Math.max(h + 1, this.bits.size * 2))
    if (this.bits.has(h)) return
    this.bits.set(h)
    this.size++
  }

  delete(h: number): boolean {
    if (!this.has(h)) return false
    this.bits.clear(h)
    this.size--
    return true
  }

  clear(): void {
    if (this.size) this.bits.clearAll()
    this.size = 0
  }

  /** Each handle in the set, lowest first (the store's order: handles are given out as entities arrive). */
  forEach(fn: (h: number) => void): void {
    if (this.size) this.bits.forEach(fn)
  }
}
