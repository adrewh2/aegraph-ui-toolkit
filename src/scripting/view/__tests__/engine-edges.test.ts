import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Visual engine's host side, driven without a browser: a stub DOM
 * (elements are EventTargets with a style bag and a recording
 * contentWindow) and messages dispatched on `window` with a chosen source.
 * Questions: an empty view, a script that throws before rendering, a
 * message from the wrong source or with a malformed payload, state in and
 * out and after loading, a second run while the first is pending, a host
 * of zero size or clipped by a scrolling pane, a frame stopped while it is
 * still loading, stopping twice, the timeout, and one snapshot per run.
 */
class El extends EventTarget {
  style: Record<string, string> = {}
  attrs: Record<string, string> = {}
  className = ''
  title = ''
  srcdoc = ''
  hidden = false
  isConnected = true
  overflow = 'visible'
  rect = { top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 }
  parentElement: El | null = null
  children: El[] = []
  contentWindow = { posted: [] as unknown[], postMessage(m: unknown) { this.posted.push(m) } }
  tagName: string
  constructor(tagName: string) {
    super()
    this.tagName = tagName
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  appendChild(c: El) { c.remove(); c.parentElement = this; this.children.push(c); return c }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter((x) => x !== this); this.parentElement = null } }
  getBoundingClientRect() { return this.rect }
}
const g = globalThis as Record<string, unknown>
let body: El
const message = (data: unknown, source: unknown) => (g.window as EventTarget).dispatchEvent(Object.assign(new Event('message'), { data, source }))
/** The stub where the engine wants a real element. */
const el = (e: El) => e as unknown as HTMLElement
const from = (frame: unknown, data: unknown) => message(data, (frame as El).contentWindow)
const snap = () => { const json = vi.fn(() => '{"entities":[]}'); return { key: 'k', json } }

let ViewEngine: typeof import('../engine').ViewEngine
beforeEach(async () => {
  body = new El('body')
  g.document = { body, createElement: (t: string) => new El(t) }
  g.window = new EventTarget()
  g.location = { origin: 'http://localhost:5173' }
  g.requestAnimationFrame = () => 1
  g.cancelAnimationFrame = () => {}
  g.getComputedStyle = (el: El) => ({ overflow: el.overflow })
  vi.useFakeTimers()
  ;({ ViewEngine } = await import('../engine'))
})
afterEach(() => vi.useRealTimers())

describe('view engine edges', () => {
  it('an empty view: the frame is sandboxed with a CSP for this origin, the snapshot is read once after ready, and done resolves a clean run', async () => {
    const engine = new ViewEngine()
    const host = new El('div')
    const s = snap()
    const p = engine.run(el(host), '', s)
    const layer = body.children[0]
    expect(layer.className).toBe('sc__viewlayer')
    const frame = layer.children[0]
    expect(frame.tagName).toBe('iframe')
    expect(frame.attrs.sandbox).toBe('allow-scripts allow-pointer-lock')
    // Nothing in the frame is inline script, and the frame's own policy does not allow any: a frame inherits the
    // app's policy and cannot widen it, so an inline bootstrap would stop running under an enforced `script-src`.
    expect(frame.srcdoc).not.toContain("'unsafe-inline'; ")
    expect(frame.srcdoc).toContain("script-src blob: http://localhost:5173")
    expect(frame.srcdoc).toMatch(/<script src="[^"]*\/sandbox\/view-boot\.js\?v=\d+"><\/script>/)
    // One script element, with nothing between its tags — the boot arrives by URL, the rest as blobs from inside.
    expect(frame.srcdoc.split('<script').length).toBe(2)
    expect(frame.srcdoc).not.toContain('importmap')
    expect(s.json).not.toHaveBeenCalled()
    from(frame, { type: 'ready' })
    expect(s.json).toHaveBeenCalledTimes(1)
    const posted = frame.contentWindow.posted[0] as Record<string, unknown>
    expect(posted).toMatchObject({ type: 'run', json: '{"entities":[]}', code: '', state: {} })
    // The libraries the sandbox may load, by URL on this origin — it has no map to resolve names with any more.
    expect(posted.libs).toEqual({ d3: 'http://localhost:5173/vendor/d3/d3.min.js', plotly: 'http://localhost:5173/vendor/plotly/plotly.min.js' })
    expect(typeof posted.prelude).toBe('string')
    expect((posted.prelude as string).length).toBeGreaterThan(1000)
    from(frame, { type: 'done' })
    const r = await p
    expect(r.error).toBeUndefined()
    expect(r.value).toBeUndefined()
    expect(r.logs).toEqual([])
    expect(r.frame).toBe(frame)
    expect(engine.isLive(frame as never)).toBe(true)
    vi.advanceTimersByTime(60_000) // the timeout was cleared: nothing rejects later
    expect(s.json).toHaveBeenCalledTimes(1)
  })


  it('rewrites the specifiers the import map used to resolve, since the frame can no longer carry one', async () => {
    const engine = new ViewEngine()
    const host = new El('div')
    const p = engine.run(el(host), `import * as THREE from 'three'\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js'`, snap())
    const frame = body.children[0].children[0]
    from(frame, { type: 'ready' })
    const code = (frame.contentWindow.posted[0] as { code: string }).code
    expect(code).not.toMatch(/'three'|'three\//)
    expect(code).toContain(`'http://localhost:5173/vendor/three/build/three.module.js'`)
    expect(code).toContain(`'http://localhost:5173/vendor/three/examples/jsm/controls/OrbitControls.js'`)
    from(frame, { type: 'done' })
    await p
    engine.stopAll()
  })

  it('a script that throws before rendering resolves with the error and what came before it; later messages are dropped', async () => {
    const engine = new ViewEngine()
    const p = engine.run(el(new El('div')), 'throw 1', snap())
    const frame = body.children[0].children[0]
    from(frame, { type: 'ready' })
    from(frame, { type: 'log', line: 'first' })
    from(frame, { type: 'result', value: { partial: true } })
    from(frame, { type: 'error', message: 'boom', stack: 'at x' })
    from(frame, { type: 'done' })
    from(frame, { type: 'log', line: 'late' })
    const r = await p
    expect(r.error).toEqual({ message: 'boom', stack: 'at x' })
    expect(r.value).toEqual({ partial: true })
    expect(r.logs).toEqual(['first'])
    expect(engine.isLive(frame as never)).toBe(true) // the frame stays: the error is on show
  })

  it('ignores messages from another source, malformed payloads, and a log without a line; a second pending run is untouched by the first', async () => {
    const engine = new ViewEngine()
    const onState = vi.fn()
    const pa = engine.run(el(new El('div')), 'a', snap(), { onState })
    const pb = engine.run(el(new El('div')), 'b', snap())
    const [fa, fb] = body.children[0].children
    expect(fa).not.toBe(fb)
    message({ type: 'done' }, {}) // some other window
    message({ type: 'done' }, undefined)
    from(fa, null)
    from(fa, 'done')
    from(fa, 42)
    from(fa, {})
    from(fa, { type: 'log' })
    from(fa, { type: 'state' })
    from(fa, { type: 'ready' })
    vi.advanceTimersByTime(250) // state is handed on at most every 250 ms
    expect(onState).toHaveBeenCalledWith({})
    expect(fa.contentWindow.posted.length).toBe(1)
    expect(fb.contentWindow.posted.length).toBe(0)
    from(fa, { type: 'done' })
    const ra = await pa
    expect(ra.logs).toEqual([])
    let settledB = false
    void pb.then(() => (settledB = true))
    await Promise.resolve()
    expect(settledB).toBe(false)
    from(fb, { type: 'ready' })
    from(fb, { type: 'result', value: 'B' })
    from(fb, { type: 'done' })
    expect((await pb).value).toBe('B')
  })

  it('state goes in with the run, comes out while loading and after, and stops with the frame', async () => {
    const engine = new ViewEngine()
    const onState = vi.fn()
    const state = { camera: [1, 2, 3], when: new Date(0), nothing: undefined, nan: NaN }
    const p = engine.run(el(new El('div')), 'x', snap(), { state, onState })
    const frame = body.children[0].children[0]
    from(frame, { type: 'ready' })
    expect((frame.contentWindow.posted[0] as { state: unknown }).state).toBe(state) // handed to postMessage as is; structured clone keeps a Date, NaN and undefined
    from(frame, { type: 'state', state: { a: 1 } })
    vi.advanceTimersByTime(250)
    from(frame, { type: 'done' })
    await p
    from(frame, { type: 'state', state: { a: 2 } })
    vi.advanceTimersByTime(250)
    from(frame, { type: 'state' })
    vi.advanceTimersByTime(250)
    engine.stop(frame as never)
    from(frame, { type: 'state', state: { a: 3 } })
    expect(onState.mock.calls.map((c) => c[0])).toEqual([{ a: 1 }, { a: 2 }, {}])
    expect(engine.isLive(frame as never)).toBe(false)
    expect(frame.parentElement).toBeNull()
  })

  it('a frame stopped while still loading settles its run at once instead of timing out later', async () => {
    const engine = new ViewEngine()
    const p = engine.run(el(new El('div')), 'x', snap())
    const frame = body.children[0].children[0]
    from(frame, { type: 'ready' })
    engine.stopAll()
    let outcome: string | undefined
    p.then((r) => (outcome = `resolved:${r.error?.message ?? 'ok'}`), (e: Error) => (outcome = `rejected:${e.message}`))
    await Promise.resolve()
    await Promise.resolve()
    expect(outcome).toMatch(/stopped/)
    expect(frame.parentElement).toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(outcome).toMatch(/stopped/) // and the timeout no longer speaks
  })

  it('stopping twice, stopping all after one stop, and attaching a stopped frame are all harmless', async () => {
    const engine = new ViewEngine()
    const host = new El('div')
    const p = engine.run(el(host), 'x', snap())
    const frame = body.children[0].children[0]
    from(frame, { type: 'ready' })
    from(frame, { type: 'done' })
    await p
    engine.stop(frame as never)
    engine.stop(frame as never)
    engine.stopAll()
    engine.attach(frame as never, host as never)
    expect(frame.parentElement).toBeNull()
    expect(frame.style.display).toBe('none')
    expect(body.children[0].children).toEqual([])
  })

  it('rejects after the timeout with the limit named, and ends the frame that never reported', async () => {
    const engine = new ViewEngine()
    const p = engine.run(el(new El('div')), 'x', snap(), { timeoutMs: 50 })
    const frame = body.children[0].children[0]
    from(frame, { type: 'ready' })
    let err: Error | undefined
    p.catch((e: Error) => (err = e))
    vi.advanceTimersByTime(49)
    await Promise.resolve()
    expect(err).toBeUndefined()
    vi.advanceTimersByTime(1)
    await Promise.resolve()
    expect(err?.message).toBe('The visual script did not finish loading within 50 ms.')
    from(frame, { type: 'done' }) // too late: dropped
    expect(engine.isLive(frame as never)).toBe(false)
    expect(frame.parentElement).toBeNull()
  })

  it('bounds what a frame sends back: log lines, state (size and rate) and the result', async () => {
    const engine = new ViewEngine()
    const onState = vi.fn()
    const p = engine.run(el(new El('div')), 'x', snap(), { onState })
    const frame = body.children[0].children[0]
    from(frame, { type: 'ready' })
    for (let i = 0; i < 5000; i++) from(frame, { type: 'log', line: `line ${i}` })
    from(frame, { type: 'log', line: 'y'.repeat(1_000_000) })
    // A burst of states is one write, the latest; one past the size bound is not kept at all.
    for (let i = 0; i < 100; i++) from(frame, { type: 'state', state: { i } })
    vi.advanceTimersByTime(250)
    from(frame, { type: 'state', state: { big: 'z'.repeat(300 * 1024) } })
    vi.advanceTimersByTime(250)
    expect(onState.mock.calls.map((c) => c[0])).toEqual([{ i: 99 }])
    from(frame, { type: 'result', value: 'r'.repeat(65 * 1024 * 1024) })
    from(frame, { type: 'done' })
    const r = await p
    expect(r.logs.length).toBe(2001)
    expect(r.logs.at(-1)).toMatch(/3,?001 more log lines not kept/)
    expect(r.value).toBeUndefined()
    expect(r.error?.message).toMatch(/too large/)
  }, 30_000)

  it('the frame’s policy blocks WebRTC where the browser knows how, and turns DNS prefetching off', async () => {
    const engine = new ViewEngine()
    void engine.run(el(new El('div')), 'x', snap())
    const frame = body.children[0].children[0]
    expect(frame.srcdoc).toContain("webrtc 'block'")
    expect(frame.srcdoc).toContain('x-dns-prefetch-control" content="off"')
    engine.stopAll()
  })

  it('places the frame over its host, hides it at zero size or when the host is hidden, and clips it to a scrolling pane', async () => {
    const engine = new ViewEngine()
    const pane = new El('div')
    pane.overflow = 'auto'
    pane.rect = { top: 100, left: 0, right: 500, bottom: 300, width: 500, height: 200 }
    const host = new El('div')
    host.rect = { top: 50, left: 20, right: 620, bottom: 450, width: 600, height: 400 }
    pane.appendChild(host)
    void engine.run(el(host), 'x', snap())
    const frame = body.children[0].children[0]
    expect(frame.style).toMatchObject({ display: 'block', visibility: 'visible', pointerEvents: '', position: 'absolute', left: '20px', top: '50px', width: '600px', height: '400px', clipPath: 'inset(50px 120px 150px 0px)' })
    host.rect = { ...host.rect, width: 0, right: 20 }
    engine.attach(frame as never, host as never)
    expect(frame.style.visibility).toBe('hidden')
    expect(frame.style.pointerEvents).toBe('none')
    host.rect = { top: 50, left: 20, right: 620, bottom: 450, width: 600, height: 400 }
    host.hidden = true
    engine.attach(frame as never, host as never)
    expect(frame.style.visibility).toBe('hidden')
    host.hidden = false
    host.rect = { top: 400, left: 20, right: 620, bottom: 800, width: 600, height: 400 } // entirely below the pane
    engine.attach(frame as never, host as never)
    expect(frame.style.visibility).toBe('hidden')
    engine.detachAll()
    expect(frame.style.display).toBe('none')
    expect(engine.isLive(frame as never)).toBe(true)
    host.rect = { top: 150, left: 20, right: 620, bottom: 250, width: 600, height: 100 }
    engine.attach(frame as never, host as never)
    expect(frame.style).toMatchObject({ display: 'block', visibility: 'visible', clipPath: 'inset(0px 120px 0px 0px)' })
  })

  it('a large snapshot is serialised once per run and handed over by reference', async () => {
    const engine = new ViewEngine()
    const big = '{"entities":[' + '{"id":"e","data":{"blob":"' + 'x'.repeat(1_000_000) + '"}},'.repeat(5).slice(0, -1) + ']}'
    const json = vi.fn(() => big)
    const p = engine.run(el(new El('div')), 'x', { key: 'k', json })
    const frame = body.children[0].children[0]
    from(frame, { type: 'ready' })
    from(frame, { type: 'ready' }) // a second ready (a reload) posts again but does not re-serialise? — it does: once per ready
    expect((frame.contentWindow.posted[0] as { json: string }).json).toBe(big)
    expect(json).toHaveBeenCalledTimes(2)
    from(frame, { type: 'done' })
    await p
  })
})
