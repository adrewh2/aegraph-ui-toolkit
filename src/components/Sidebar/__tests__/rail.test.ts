import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A localStorage for node: the rail state is remembered in it. */
const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })

const { isSidebarRail, setSidebarRail, toggleSidebarRail } = await import('../rail')

describe('sidebar rail state', () => {
  beforeEach(() => setSidebarRail(false))

  it('is one value for the page, remembered in localStorage', () => {
    expect(isSidebarRail()).toBe(false)
    setSidebarRail(true)
    expect(isSidebarRail()).toBe(true)
    expect(mem['aegraph:sidebar:rail']).toBe('1')
    toggleSidebarRail()
    expect(isSidebarRail()).toBe(false)
    expect(mem['aegraph:sidebar:rail']).toBe('0')
  })
})
