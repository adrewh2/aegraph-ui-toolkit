import { beforeEach, describe, expect, it } from 'vitest'
import type { Output } from '../../../scripting/types'
import { clearLastRun, readLastRun, runStateOf, writeLastRun } from '../lastRun'

/**
 * What a reload finds: the last run of each script, kept in this browser.
 * A result too big for storage is not kept (and does not leave a stale one
 * behind), the whole store is bounded with the oldest dropped first, a
 * browser with no storage is silent rather than fatal, and what comes back
 * rebuilds the page's run state without the frame a Visual run had.
 */
const store = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0, map: m }
}
const g = globalThis as Record<string, unknown>
const figure = (points: number): Output => ({ kind: 'figure', data: [{ x: Array.from({ length: points }, (_, i) => i), y: Array.from({ length: points }, (_, i) => i * 2), type: 'scatter' }], layout: { title: 'A chart' } })
const run = (outputs: Output[], at = '2026-09-19T10:00:00Z') => ({ at, outputs, logs: ['hello'], ms: 12 })

beforeEach(() => {
  g.localStorage = store()
})

describe('the last run outlives the page', () => {
  it('keeps a run per script and gives it back as the page holds it, the frame aside', () => {
    expect(readLastRun('new')).toBeUndefined()
    writeLastRun('new', run([figure(3)]))
    writeLastRun('script:1', { ...run([{ kind: 'text', text: 'done' }]), view: true })
    const back = readLastRun('new')!
    expect(back.outputs[0]).toEqual(figure(3))
    expect(readLastRun('script:1')?.view).toBe(true)
    const state = runStateOf(back)
    expect(state.outputs).toEqual(back.outputs)
    expect(state.error).toBeUndefined()
    expect(state.run.logs).toEqual(['hello'])
    expect(state.run.ms.run).toBe(12)
    expect((state.run as { frame?: unknown }).frame).toBeUndefined() // a live view cannot survive a reload; its outputs do
    // An error is what the pane should show again too.
    writeLastRun('new', { ...run([]), error: 'boom' })
    expect(runStateOf(readLastRun('new')!)).toMatchObject({ error: 'boom', outputs: [] })
  })

  it('refuses a result too big to keep, and leaves no stale one in its place', () => {
    writeLastRun('big', run([figure(10)]))
    expect(readLastRun('big')).toBeDefined()
    writeLastRun('big', run([figure(200_000)])) // megabytes
    expect(readLastRun('big')).toBeUndefined()
    expect(readLastRun('other')).toBeUndefined()
  })

  it('bounds what it keeps, dropping the oldest first, and the newest always fits', () => {
    // Each of these is a few hundred KB: a dozen of them is past the budget, so the older ones go.
    for (let i = 0; i < 12; i++) writeLastRun(`s${i}`, run([figure(20_000)], `2026-09-19T10:${String(i).padStart(2, '0')}:00Z`))
    const kept = Array.from({ length: 12 }, (_, i) => `s${i}`).filter((k) => readLastRun(k))
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(12)
    expect(kept).toContain('s11') // the newest is never the one dropped
    expect(kept).not.toContain('s0')
    expect(JSON.stringify(readLastRun('s11'))!.length).toBeGreaterThan(1000)
    expect((g.localStorage as ReturnType<typeof store>).getItem('aegraph:scripts:lastrun')!.length).toBeLessThan(2_100_000)
  })

  it('forgets one or all of them, and says nothing when the browser has no storage', () => {
    writeLastRun('a', run([{ kind: 'text', text: 'a' }]))
    writeLastRun('b', run([{ kind: 'text', text: 'b' }]))
    clearLastRun('a')
    expect(readLastRun('a')).toBeUndefined()
    expect(readLastRun('b')).toBeDefined()
    clearLastRun()
    expect(readLastRun('b')).toBeUndefined()
    const throwing = { getItem: () => { throw new DOMException('denied', 'SecurityError') }, setItem: () => { throw new DOMException('denied', 'SecurityError') }, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 }
    g.localStorage = throwing
    expect(() => writeLastRun('x', run([{ kind: 'text', text: 'x' }]))).not.toThrow()
    expect(readLastRun('x')).toBeUndefined()
    // Nonsense in storage reads as nothing kept.
    const s = store()
    s.setItem('aegraph:scripts:lastrun', 'not json')
    g.localStorage = s
    expect(readLastRun('x')).toBeUndefined()
    s.setItem('aegraph:scripts:lastrun', JSON.stringify({ x: { at: 'now', outputs: 'not an array' } }))
    expect(readLastRun('x')).toBeUndefined()
  })
})
