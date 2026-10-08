import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDraft, readDraft, writeDraft } from '../drafts'

/** A draft this browser will not keep is said to be lost, not passed over: the page tells the owner. */
describe('script drafts', () => {
  let full = false
  const mem = new Map<string, string>()
  beforeEach(() => {
    full = false
    mem.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        mem.set(k, v)
      },
      removeItem: (k: string) => void mem.delete(k),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps a draft, and says when it could not', () => {
    expect(writeDraft('s1', 'print(1)', 'python')).toBe(true)
    expect(readDraft('s1')?.code).toBe('print(1)')
    // The same contents again: nothing to write, and nothing lost.
    full = true
    expect(writeDraft('s1', 'print(1)', 'python')).toBe(true)
    // An edit that storage refuses: reported, and the last kept draft stands.
    expect(writeDraft('s1', 'print(2)', 'python')).toBe(false)
    expect(readDraft('s1')?.code).toBe('print(1)')
    full = false
    expect(writeDraft('s1', 'print(2)', 'python')).toBe(true)
    clearDraft('s1')
    expect(readDraft('s1')).toBeUndefined()
  })
})
