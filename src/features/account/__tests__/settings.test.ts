import { describe, expect, it, vi } from 'vitest'

/** A localStorage for node: the settings are remembered in it. */
const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })

const { getUserSettings, setUserSettings, externalServicesAllowed, requireExternalServices, OfflineError } = await import('../settings')

describe('user settings', () => {
  it('start at their defaults, patch, and are remembered', () => {
    expect(getUserSettings()).toEqual({ developerTools: false, externalServices: true, theme: 'system', featuresOff: [] })
    expect(setUserSettings({ developerTools: true })).toEqual({ developerTools: true, externalServices: true, theme: 'system', featuresOff: [] })
    expect(JSON.parse(mem['aegraph:account:settings'])).toEqual({ developerTools: true, externalServices: true, theme: 'system', featuresOff: [] })
    setUserSettings({ developerTools: false })
    expect(getUserSettings().developerTools).toBe(false)
  })

  it('third-party services are on until turned off, and a feature that needs the network is told which way it is', () => {
    expect(externalServicesAllowed()).toBe(true)
    expect(() => requireExternalServices('Place search')).not.toThrow()

    setUserSettings({ externalServices: false })
    expect(externalServicesAllowed()).toBe(false)
    expect(() => requireExternalServices('Place search')).toThrow(OfflineError)
    // The message names the feature and where to turn it back on.
    expect(() => requireExternalServices('Place search')).toThrow(/Place search.*Third-party services is off/s)
    expect(JSON.parse(mem['aegraph:account:settings']).externalServices).toBe(false)

    setUserSettings({ externalServices: true })
    expect(externalServicesAllowed()).toBe(true)
  })
})

describe('the switch a browser has not seen', () => {
  it('takes its default rather than silently turning a feature off', async () => {
    // A browser that last ran a build without the switch has only the old key.
    mem['aegraph:account:settings'] = JSON.stringify({ developerTools: true })
    vi.resetModules()
    const fresh = await import('../settings')
    expect(fresh.getUserSettings()).toEqual({ developerTools: true, externalServices: true, theme: 'system', featuresOff: [] })
  })

  it('keeps an explicit off through a reload', async () => {
    mem['aegraph:account:settings'] = JSON.stringify({ developerTools: false, externalServices: false })
    vi.resetModules()
    const fresh = await import('../settings')
    expect(fresh.externalServicesAllowed()).toBe(false)
  })
})
