import preludeMain from '../prelude.js?raw'
import preludeMetrics from '../metrics.js?raw'
import { rewriteSpecifiers, viewImportMap } from './specifiers'

// The view's script sees the same helpers as a JavaScript script: the prelude and the metrics after it.
const prelude = `${preludeMain}\n${preludeMetrics}`
import type { RunResult } from '../types'
import { sandboxBootUrl } from '../sandboxBoot'
import { boundedState, LogSink, MAX_RESULT_CHARS, resultTooLarge } from '../limits'

/** How often a remembered state is handed on to be kept, at most: a frame posting state in a loop is coalesced. */
const STATE_EVERY_MS = 250

/**
 * The Visual engine: JavaScript with a DOM, a canvas and WebGL — three.js,
 * d3 and Plotly importable — for anything that has to be drawn by hand.
 * Each run is a fresh sandboxed iframe (opaque origin: none of the app's
 * cookies, storage or DOM) whose CSP allows scripts, styles, images and
 * connections only from this origin, where the libraries are served from
 * public/vendor (npm run vendor). The snapshot is posted in; the script
 * runs as an ES module with `ds` and the JavaScript prelude in scope; the
 * iframe itself is the output, shown in the page. `aegraph.result(v)`
 * can send a figure, table or scene back as well.
 *
 * Nothing in the frame is inline script, and that is load-bearing rather than
 * tidy: a frame inherits the app's Content-Security-Policy and its own `<meta>`
 * policy can only narrow it, never widen it. So the bootstrap is a file served
 * from this origin (`viewBoot.js`, by `?url`), and the prelude and the user's
 * code become `blob:` scripts inside the frame. An inline bootstrap would stop
 * running the moment the app enforces a `script-src`, with nothing a reader of
 * the error could act on. `import * as THREE from 'three'` used to work through
 * an inline import map, which has no external form; `specifiers.ts` rewrites
 * those to URLs instead.
 */

export interface ViewRun extends RunResult {
  ms: { load: number; run: number; snapshot: number }
  frame: HTMLIFrameElement
}

/**
 * Frames live in one fixed layer over the page and are positioned to cover
 * the host element they were run for (a scene keeps its WebGL context and
 * animation across React re-renders and page switches: an iframe reparented
 * in the DOM would reload and run the script again). `detach` hides a frame
 * without ending it; `attach` shows it over a host again.
 */
class FrameLayer {
  private el: HTMLDivElement | null = null
  private tracked = new Map<HTMLIFrameElement, { host: HTMLElement }>()
  private raf = 0
  root(): HTMLDivElement {
    if (!this.el) {
      this.el = document.createElement('div')
      this.el.className = 'sc__viewlayer'
      this.el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:40'
      document.body.appendChild(this.el)
    }
    return this.el
  }
  attach(frame: HTMLIFrameElement, host: HTMLElement) {
    if (frame.parentElement !== this.root()) this.root().appendChild(frame)
    this.tracked.set(frame, { host })
    frame.style.display = 'block'
    this.place(frame, host)
    this.tick()
  }
  detach(frame: HTMLIFrameElement) {
    this.tracked.delete(frame)
    frame.style.display = 'none'
  }
  isAttached(frame: HTMLIFrameElement) {
    return this.tracked.has(frame)
  }
  private place(frame: HTMLIFrameElement, host: HTMLElement) {
    const r = host.getBoundingClientRect()
    // Clip to every scrolling ancestor so the frame never floats outside its pane.
    let top = r.top, left = r.left, bottom = r.bottom, right = r.right
    for (let a = host.parentElement; a; a = a.parentElement) {
      const o = getComputedStyle(a).overflow
      if (!/auto|scroll|hidden/.test(o)) continue
      const b = a.getBoundingClientRect()
      top = Math.max(top, b.top); left = Math.max(left, b.left); bottom = Math.min(bottom, b.bottom); right = Math.min(right, b.right)
    }
    const hidden = !host.isConnected || host.hidden || r.width === 0 || bottom <= top || right <= left
    frame.style.visibility = hidden ? 'hidden' : 'visible'
    // Not set inline when shown: the stylesheet turns pointer events back on for the frame and off again while a gutter is dragged.
    frame.style.pointerEvents = hidden ? 'none' : ''
    frame.style.position = 'absolute'
    frame.style.left = `${r.left}px`; frame.style.top = `${r.top}px`; frame.style.width = `${r.width}px`; frame.style.height = `${r.height}px`
    frame.style.clipPath = `inset(${Math.max(0, top - r.top)}px ${Math.max(0, r.right - right)}px ${Math.max(0, r.bottom - bottom)}px ${Math.max(0, left - r.left)}px)`
  }
  private tick = () => {
    cancelAnimationFrame(this.raf)
    if (!this.tracked.size) return
    for (const [f, { host }] of this.tracked) this.place(f, host)
    this.raf = requestAnimationFrame(this.tick)
  }
}

export class ViewEngine {
  private frames = new Set<HTMLIFrameElement>()
  private layer = new FrameLayer()

  /** Run `code` in a new sandboxed iframe mounted in `host`; resolves when the module has evaluated (the scene may keep animating). */
  run(host: HTMLElement, code: string, snapshot: { key: string; json: () => string | Promise<string> }, opts: { timeoutMs?: number; state?: Record<string, unknown>; onState?: (state: Record<string, unknown>) => void } = {}): Promise<ViewRun> {
    const origin = location.origin
    // The frame's own policy, narrowing what it inherits: the sandbox may draw and load this origin's
    // libraries, and may not reach anywhere else. `blob:` is how its scripts arrive at all.
    // `webrtc 'block'` where the browser knows it (CSP's own fetch directives do not govern a peer connection's STUN/TURN
    // traffic); the bootstrap takes the constructors away as well, and turns DNS prefetching off.
    const csp = `default-src 'none'; script-src blob: ${origin}; connect-src ${origin}; img-src ${origin} data: blob:; style-src 'unsafe-inline' ${origin}; font-src ${origin} data:; worker-src blob:; media-src ${origin} blob:; webrtc 'block'`
    const bootSrc = sandboxBootUrl('/sandbox/view-boot.js', origin)
    const libs = { d3: `${origin}/vendor/d3/d3.min.js`, plotly: `${origin}/vendor/plotly/plotly.min.js` }
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock')
    frame.className = 'sc__view'
    frame.style.border = '0'
    frame.title = 'Visual script'
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="x-dns-prefetch-control" content="off"><style>html,body{margin:0;height:100%;overflow:hidden;background:#fff;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}canvas{display:block}#app{position:absolute;inset:0}</style></head><body><div id="app"></div><script src="${bootSrc}"></script></body></html>`
    this.frames.add(frame)
    const t0 = performance.now()
    return new Promise<ViewRun>((resolve, reject) => {
      const logs = new LogSink()
      let value: unknown
      let tooLarge: string | undefined
      let settled = false
      // What the script remembers is the frame's to send as often as it likes: kept only within its size bound, and
      // handed on at most every STATE_EVERY_MS (the latest wins) — every hand-on is a write to this browser's storage.
      let stateTimer: ReturnType<typeof setTimeout> | null = null
      let pendingState: Record<string, unknown> | undefined
      const takeState = (raw: unknown) => {
        if (!opts.onState) return
        const st = boundedState(raw ?? {})
        if (!st) return
        pendingState = st
        stateTimer ??= setTimeout(() => {
          stateTimer = null
          const next = pendingState
          pendingState = undefined
          if (next) opts.onState?.(next)
        }, STATE_EVERY_MS)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        // A frame that never reported is not left running behind the error: it goes.
        this.stop(frame)
        reject(new Error(`The visual script did not finish loading within ${opts.timeoutMs ?? 20000} ms.`))
      }, opts.timeoutMs ?? 20000)
      const cleanup = () => {
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        // What the script remembers (a camera, a toggle) keeps flowing after the module has loaded.
        if (opts.onState) {
          const onState = (e: MessageEvent) => {
            if (e.source !== frame.contentWindow) return
            const m = e.data as { type?: string; state?: unknown }
            if (m?.type === 'state') takeState(m.state)
          }
          window.addEventListener('message', onState)
          frame.addEventListener(
            'aegraph:stopped',
            () => {
              window.removeEventListener('message', onState)
              if (stateTimer) clearTimeout(stateTimer)
              stateTimer = null
            },
            { once: true },
          )
        }
      }
      /** A result the frame sent, kept only when its JSON fits; otherwise the run reports that it was too large. */
      const takeResult = (v: unknown) => {
        let chars = 0
        try {
          chars = JSON.stringify(v ?? null)?.length ?? 0
        } catch {
          chars = Infinity
        }
        if (chars > MAX_RESULT_CHARS) {
          value = undefined
          tooLarge = Number.isFinite(chars) ? resultTooLarge(chars) : 'The result could not be read as JSON.'
        } else {
          value = v
          tooLarge = undefined
        }
      }
      const onMessage = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow) return
        const m = e.data as { type: string; line?: string; message?: string; stack?: string; value?: unknown }
        if (!m || typeof m !== 'object') return
        if (m.type === 'ready') {
          // The snapshot text may come at once or, for a big dataset, after a few yields.
          // The import map the frame can no longer carry, applied to the source instead.
          const source = rewriteSpecifiers(code, viewImportMap(origin))
          const post = (json: string) => frame.contentWindow?.postMessage({ type: 'run', json, prelude, code: source, state: opts.state ?? {}, libs }, '*')
          const j = snapshot.json()
          if (typeof j === 'string') post(j)
          else void j.then(post)
        }
        else if (m.type === 'log' && m.line !== undefined) logs.push(m.line)
        else if (m.type === 'state') takeState((m as { state?: unknown }).state)
        else if (m.type === 'result') takeResult(m.value)
        else if (m.type === 'error') {
          if (settled) return
          settled = true
          cleanup()
          resolve({ value, logs: logs.lines(), error: { message: typeof m.message === 'string' ? m.message.slice(0, 4000) : 'error', stack: typeof m.stack === 'string' ? m.stack.slice(0, 20000) : undefined }, ms: { load: 0, run: Math.round(performance.now() - t0), snapshot: 0 }, frame })
        } else if (m.type === 'done') {
          if (settled) return
          settled = true
          cleanup()
          resolve({ value, logs: logs.lines(), ...(tooLarge ? { error: { message: tooLarge } } : {}), ms: { load: 0, run: Math.round(performance.now() - t0), snapshot: 0 }, frame })
        }
      }
      window.addEventListener('message', onMessage)
      // The frame may not leave. Its first load is the bootstrap; a second is the frame navigating itself — the one
      // way out a sandboxed script has (`location = 'https://…?' + data`), since the app's own frame-src must allow
      // https: for embeds. The request has gone by the time this fires, so this cannot un-send it: it ends the run
      // and removes the frame, so a page the script navigated to is never shown inside the app as if it were ours.
      let loads = 0
      frame.addEventListener('load', () => {
        if (++loads < 2) return
        if (!settled) {
          settled = true
          cleanup()
          resolve({ value, logs: logs.lines(), error: { message: 'The script tried to leave its sandbox (it navigated its frame) and was stopped.' }, ms: { load: 0, run: Math.round(performance.now() - t0), snapshot: 0 }, frame })
        }
        this.stop(frame)
      })
      // Stopped before it reported (Stop, or a new run): settle now rather than as a timeout twenty seconds later.
      frame.addEventListener('aegraph:stopped', () => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ value, logs: logs.lines(), error: { message: 'The visual script was stopped before it finished loading.' }, ms: { load: 0, run: Math.round(performance.now() - t0), snapshot: 0 }, frame })
      }, { once: true })
      this.layer.attach(frame, host)
    })
  }

  /** Show a frame over a host again (the page came back); a no-op for a frame that was stopped. */
  attach(frame: HTMLIFrameElement, host: HTMLElement) {
    if (this.frames.has(frame)) this.layer.attach(frame, host)
  }
  /** Hide the frames without ending them — the page is going away but may come back. */
  detachAll() {
    for (const f of this.frames) this.layer.detach(f)
  }
  isLive(frame: HTMLIFrameElement) {
    return this.frames.has(frame)
  }

  /** Remove every iframe this engine created (Stop, or a new run). */
  stopAll() {
    for (const f of this.frames) this.end(f)
    this.frames.clear()
  }

  stop(frame: HTMLIFrameElement) {
    this.end(frame)
    this.frames.delete(frame)
  }

  private end(frame: HTMLIFrameElement) {
    this.layer.detach(frame)
    frame.dispatchEvent(new Event('aegraph:stopped'))
    frame.remove()
  }
}
