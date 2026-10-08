import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The open chats' ids the sidebar counts: read from storage while the chats are not loaded (the sidebar never loads
 * them), then from the live list once its module has run, whoever imported it — and a reader is told only through
 * the list's own notifications and the load.
 */
const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })

beforeEach(() => {
  vi.resetModules()
  for (const k of Object.keys(mem)) delete mem[k]
})

describe('openChatIds', () => {
  it('reads the stored list until the chats load, then follows the live one', async () => {
    mem['aegraph:ai:chats'] = JSON.stringify({ ids: ['a', 'b'], active: 'a', projects: { a: 'project:p', b: null } })
    const { openChatIds, subscribeOpenChats, announceChats } = await import('../instance')
    // Each id with its project after a tab (empty: the Library).
    expect(openChatIds()).toBe('a\tproject:p\nb\t')
    let told = 0
    const off = subscribeOpenChats(() => told++)
    let ids = ['a', 'b', 'c']
    const listeners = new Set<() => void>()
    announceChats({ ids: () => ids, subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)) })
    expect(told).toBe(1)
    expect(openChatIds()).toBe('a\nb\nc')
    ids = ['c']
    listeners.forEach((l) => l())
    expect(told).toBe(2)
    expect(openChatIds()).toBe('c')
    off()
    expect(listeners.size).toBe(0)
  })

  it('answers nothing for no stored list, or a broken one', async () => {
    const { openChatIds } = await import('../instance')
    expect(openChatIds()).toBe('')
    vi.resetModules()
    mem['aegraph:ai:chats'] = '{not json'
    expect((await import('../instance')).openChatIds()).toBe('')
  })
})
