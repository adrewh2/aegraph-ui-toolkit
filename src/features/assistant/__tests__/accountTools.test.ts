import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { describe, expect, it, vi } from 'vitest'

/** A localStorage for node: the settings are remembered in it. */
const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })

/** Stashes, in memory: the real ones copy IndexedDB, which node lacks (the app itself is checked in a browser). */
const stashes = vi.hoisted(() => ({ list: [] as { id: string; name: string; createdAt: string; records: number; bytes: number; databases: { name: string }[]; complete: boolean }[], restoring: [] as string[] }))
vi.mock('../../../app/stash', () => ({
  stashBrowser: async (name: string) => {
    const s = { id: `s${stashes.list.length + 1}`, name: name || 'Stash', createdAt: '2026-09-29T00:00:00.000Z', records: 3, bytes: 1024, databases: [{ name: 'aegraph' }], complete: true }
    stashes.list.unshift(s)
    return s
  },
  listStashes: async () => stashes.list,
  deleteStash: async (id: string) => {
    const i = stashes.list.findIndex((s) => s.id === id)
    if (i >= 0) stashes.list.splice(i, 1)
    return i >= 0
  },
  requestStashRestore: (id: string, reload: () => void) => {
    stashes.restoring.push(id)
    reload()
  },
}))

const { createAccountTools } = await import('../accountTools')

/** The user's answer to every confirmation, and what they were asked. */
const asked: string[] = []
let answer = true
const host = { confirm: async (m: string) => (asked.push(m), answer) }

const run = (tools: BetaRunnableTool[], name: string) => {
  const t = tools.find((x) => x.name === name)!
  return async (input: unknown) => {
    const r = await t.run(t.parse(input))
    return JSON.parse(typeof r === 'string' ? r : JSON.stringify(r)) as Record<string, unknown>
  }
}

describe('account tool', () => {
  it('reads the settings, and nothing about an account: there is none', async () => {
    const tools = createAccountTools(host)
    expect(tools.map((t) => t.name)).toEqual(['account'])
    const account = run(tools, 'account')
    expect(await account({})).toEqual({ settings: { developerTools: false, externalServices: true, theme: 'system', featuresOff: [] }, themeShown: 'paper', featuresOffNow: [] })
    expect(await account({ action: 'get' })).toEqual({ settings: { developerTools: false, externalServices: true, theme: 'system', featuresOff: [] }, themeShown: 'paper', featuresOffNow: [] })
    // Settings and the browser's actions are all it takes: nothing names an account.
    expect(Object.keys((tools[0] as unknown as { input_schema: { properties: object } }).input_schema.properties)).toEqual(['action', 'theme', 'features_off', 'developer_tools', 'external_services', 'name', 'id', 'stash_first'])
  })

  it('sets developer tools and remembers it', async () => {
    const account = run(createAccountTools(host), 'account')
    expect((await account({ action: 'set', developer_tools: true })).settings).toEqual({ developerTools: true, externalServices: true, theme: 'system', featuresOff: [] })
    expect(JSON.parse(mem['aegraph:account:settings'])).toEqual({ developerTools: true, externalServices: true, theme: 'system', featuresOff: [] })
    expect((await account({ action: 'set', developer_tools: false })).settings).toEqual({ developerTools: false, externalServices: true, theme: 'system', featuresOff: [] })
    await expect(account({ action: 'set' })).rejects.toThrow(/needs a setting/)
  })

  it('sets the theme without asking, remembers it, and refuses one it does not know', async () => {
    const account = run(createAccountTools(host), 'account')
    const before = asked.length
    expect((await account({ action: 'set', theme: 'dark' })).settings).toMatchObject({ theme: 'dark' })
    expect(JSON.parse(mem['aegraph:account:settings']).theme).toBe('dark')
    expect(asked.length).toBe(before)
    await expect(account({ action: 'set', theme: 'neon' })).rejects.toThrow()
    expect((await account({ action: 'set', theme: 'system', featuresOff: [] })).settings).toMatchObject({ theme: 'system', featuresOff: [] })
  })

  it('turns features off for this user, says a reload applies it, and refuses one it does not know', async () => {
    const account = run(createAccountTools(host), 'account')
    const r = await account({ action: 'set', features_off: ['audio', 'globe'] })
    expect((r.settings as { featuresOff: string[] }).featuresOff).toEqual(['globe', 'audio'])
    expect(r.reloadNeeded).toBe(true)
    await expect(account({ action: 'set', features_off: ['radio'] })).rejects.toThrow()
    const back = await account({ action: 'set', features_off: [] })
    expect((back.settings as { featuresOff: string[] }).featuresOff).toEqual([])
    expect(back.reloadNeeded).toBeUndefined()
  })

  it('turns third-party services off and on — one switch over everything that leaves the machine', async () => {
    const account = run(createAccountTools(host), 'account')
    expect((await account({ action: 'set', external_services: false })).settings).toMatchObject({ externalServices: false })
    expect(JSON.parse(mem['aegraph:account:settings']).externalServices).toBe(false)
    // One setting at a time: the other is left as it was.
    expect((await account({ action: 'set', developer_tools: true })).settings).toEqual({ developerTools: true, externalServices: false, theme: 'system', featuresOff: [] })
    expect((await account({ action: 'set', external_services: true })).settings).toEqual({ developerTools: true, externalServices: true, theme: 'system', featuresOff: [] })
    await account({ action: 'set', developer_tools: false })
  })

  it('asks the user before the switch changes, and keeps it when they decline — content cannot turn the network back on', async () => {
    const account = run(createAccountTools(host), 'account')
    asked.length = 0
    // Setting it to what it already is asks nothing.
    await account({ action: 'set', external_services: true })
    expect(asked).toEqual([])
    answer = false
    await expect(account({ action: 'set', external_services: false })).rejects.toThrow(/kept Third-party services/)
    expect(asked[0]).toMatch(/Turn Third-party services off/)
    expect((await account({})).settings).toMatchObject({ externalServices: true })
    answer = true
  })

  it('clears this browser only when the user says so, then reloads as a first visit', async () => {
    const session: Record<string, string> = {}
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => session[k] ?? null, setItem: (k: string, v: string) => (session[k] = v) })
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const account = run(createAccountTools(host), 'account')
      asked.length = 0
      answer = false
      await expect(account({ action: 'reset_browser' })).rejects.toThrow(/kept this browser/)
      expect(asked[0]).toMatch(/Clear everything aegraph keeps in this browser/)
      expect(session).toEqual({})
      answer = true
      expect(await account({ action: 'reset_browser' })).toMatchObject({ reset: true })
      expect(JSON.parse(session['aegraph:reset-browser'])).toEqual({})
      // The answer goes back first; the tab reloads a moment later.
      expect(reload).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(reload).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
    }
  })
})

describe('account tool: stashes', () => {
  it('stashes this browser, lists the stashes, and deletes one only when the user says so', async () => {
    const account = run(createAccountTools(host), 'account')
    stashes.list.length = 0
    expect(await account({ action: 'stash_browser', name: 'Before the demo' })).toMatchObject({ stashed: { id: 's1', name: 'Before the demo', databases: ['aegraph'] } })
    expect((await account({ action: 'stashes' })).stashes).toHaveLength(1)
    asked.length = 0
    answer = false
    await expect(account({ action: 'delete_stash', id: 's1' })).rejects.toThrow(/kept the stash/)
    expect(asked[0]).toMatch(/^Delete a stash for good .*: “Before the demo”\?$/)
    answer = true
    expect(await account({ action: 'delete_stash', id: 's1' })).toEqual({ deleted: 's1' })
    expect(stashes.list).toEqual([])
    await expect(account({ action: 'delete_stash', id: 's1' })).rejects.toThrow(/No stash s1/)
    await expect(account({ action: 'restore_stash' })).rejects.toThrow(/needs an id/)
  })

  it('restores a stash only when the user says so, stashing what is here first unless told not to, then reloads', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const account = run(createAccountTools(host), 'account')
      stashes.list.length = 0
      stashes.restoring.length = 0
      await account({ action: 'stash_browser', name: 'Good state' })
      asked.length = 0
      answer = false
      await expect(account({ action: 'restore_stash', id: 's1' })).rejects.toThrow(/kept this browser/)
      expect(stashes.restoring).toEqual([])
      expect(stashes.list).toHaveLength(1)
      answer = true
      const r = await account({ action: 'restore_stash', id: 's1' })
      expect(asked[1]).toMatch(/stashed first/)
      expect(r).toMatchObject({ restoring: 's1', stashedFirst: { name: 'Before restoring “Good state”' } })
      expect(stashes.restoring).toEqual(['s1'])
      vi.runAllTimers()
      expect(reload).toHaveBeenCalledOnce()
      // Told not to: nothing stashed first, and the question says what is lost.
      const n = stashes.list.length
      expect(await account({ action: 'restore_stash', id: 's1', stash_first: false })).not.toHaveProperty('stashedFirst')
      expect(asked[2]).toMatch(/gone for good/)
      expect(stashes.list).toHaveLength(n)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
      vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
    }
  })

  it('stashes before clearing when asked', async () => {
    const session: Record<string, string> = {}
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => session[k] ?? null, setItem: (k: string, v: string) => (session[k] = v) })
    vi.stubGlobal('location', { reload: vi.fn() })
    try {
      const account = run(createAccountTools(host), 'account')
      stashes.list.length = 0
      answer = true
      expect(await account({ action: 'reset_browser', stash_first: true })).toMatchObject({ reset: true, stashedFirst: { name: 'Before clearing' } })
    } finally {
      vi.unstubAllGlobals()
      vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
    }
  })
})
