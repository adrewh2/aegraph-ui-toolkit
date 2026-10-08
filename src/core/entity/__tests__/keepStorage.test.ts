import { describe, expect, it, vi } from 'vitest'
import { Persistence } from '../persistence'

describe('Persistence.keepStorage — asking the browser to keep the workspace', () => {
  it('asks once when storage is not yet persistent, and reports the answer', async () => {
    const persist = vi.fn(async () => true)
    expect(await Persistence.keepStorage({ persisted: async () => false, persist })).toBe(true)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(await Persistence.keepStorage({ persisted: async () => false, persist: async () => false })).toBe(false)
  })

  it('does not ask again when the browser already keeps it', async () => {
    const persist = vi.fn(async () => true)
    expect(await Persistence.keepStorage({ persisted: async () => true, persist })).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('says nothing where the browser has no persistent storage', async () => {
    expect(await Persistence.keepStorage(undefined)).toBeUndefined()
    expect(await Persistence.keepStorage({})).toBeUndefined()
  })

  it('never throws: a refusal is an answer', async () => {
    expect(await Persistence.keepStorage({ persisted: async () => Promise.reject(new Error('denied')), persist: async () => true })).toBe(false)
    expect(await Persistence.keepStorage({ persist: () => Promise.reject(new DOMException('no', 'SecurityError')) })).toBe(false)
  })
})
