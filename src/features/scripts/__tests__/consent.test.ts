import { beforeEach, describe, expect, it } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import { autorunRefusal, codeHash, hasConsent, recordConsent, withRunningMarker, wasRunning } from '../consent'
import { saveScript } from '../script'
import { withoutAutorun } from '../../projects/projectActions'

/**
 * What runs without being asked (security review, pass 6, findings 1, 4 and 6): only code its owner ran or saved in
 * this browser, never a Visual script, never one whose last run did not finish — and a bundle's route cannot ask.
 */
const storage = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 }
}
const g = globalThis as Record<string, unknown>
beforeEach(() => {
  g.localStorage = storage()
  g.sessionStorage = storage()
})

describe('consent to run on arrival', () => {
  it('is the id and the code: a script nobody ran here waits, and a rewrite of a consented one waits again', () => {
    expect(autorunRefusal('s1', 'return 1', 'js')).toMatch(/press Run/)
    recordConsent('s1', 'return 1')
    expect(hasConsent('s1', 'return 1')).toBe(true)
    expect(autorunRefusal('s1', 'return 1', 'js')).toBeNull()
    // The same id with other code (an import updated it), and the same code under another id, are not consented.
    expect(hasConsent('s1', 'return 2')).toBe(false)
    expect(hasConsent('s2', 'return 1')).toBe(false)
    expect(codeHash('a')).not.toBe(codeHash('b'))
  })

  it('never runs a Visual script on arrival, consented or not', () => {
    recordConsent('v', 'draw()')
    expect(autorunRefusal('v', 'draw()', 'view')).toMatch(/Visual/)
  })

  it('a script saved here is consented; one that only arrived in the store is not', () => {
    const store = new EntityStore()
    const mine = saveScript(store, 'return 42', 'Mine')
    expect(hasConsent(mine.id, 'return 42')).toBe(true)
    store.upsert({ ...mine, id: 'from-bundle', data: { ...mine.data, code: 'return 7', lastRun: { at: '2026-01-01', summary: 'value', ms: 1 } }, meta: { ...mine.meta, source: 'user' } })
    expect(autorunRefusal('from-bundle', 'return 7', 'js')).not.toBeNull()
  })

  it('a run that never finished is not run again by the next load', async () => {
    recordConsent('s', 'loop()')
    let release!: () => void
    const pending = withRunningMarker('s', () => new Promise<void>((r) => (release = r)))
    // A reload now would find the marker.
    expect(wasRunning('s')).toBe(true)
    expect(autorunRefusal('s', 'loop()', 'js')).toMatch(/did not finish/)
    release()
    await pending
    expect(wasRunning('s')).toBe(false)
    expect(autorunRefusal('s', 'loop()', 'js')).toBeNull()
  })

  it('with no storage nothing runs on its own', () => {
    g.localStorage = undefined
    recordConsent('s', 'x')
    expect(hasConsent('s', 'x')).toBe(false)
  })
})

describe('a bundle’s route cannot run a script', () => {
  it('drops run and keeps the rest', () => {
    expect(withoutAutorun('/analytics/scripts?script=abc&run=1')).toBe('/analytics/scripts?script=abc')
    expect(withoutAutorun('/analytics/scripts?run=1')).toBe('/analytics/scripts')
    expect(withoutAutorun('/analytics/scripts?run=1&script=x#top')).toBe('/analytics/scripts?script=x#top')
    expect(withoutAutorun('/workstation')).toBe('/workstation')
    expect(withoutAutorun(undefined)).toBeUndefined()
  })
})
