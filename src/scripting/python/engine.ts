import prelude from './prelude.py?raw'
import workerSource from './worker.js?raw'
import type { RunOptions, RunResult } from '../types'
import { sandboxBootUrl } from '../sandboxBoot'

/**
 * The Python engine: Pyodide (CPython in WebAssembly) with numpy, pandas,
 * plotly and — on first import — matplotlib, scipy, scikit-learn,
 * networkx, statsmodels. It runs in a worker inside a sandboxed iframe:
 * the iframe has an opaque origin (no cookies, storage or DOM of ours)
 * and a Content-Security-Policy that allows the network only to where
 * the runtime and wheels come from — this origin when they are served
 * from public/pyodide (npm run pyodide), else the CDN. Scripts cannot
 * exfiltrate data anywhere else; a stuck script is terminated with its
 * worker, and the next run boots a fresh one.
 */

export const PYODIDE_VERSION = '0.27.7'
export type PythonStage = 'idle' | 'runtime' | 'packages' | 'ready' | 'failed'
export interface PythonStatus {
  stage: PythonStage
  message?: string
  versions?: Record<string, string>
}

type Pending = { resolve: (r: RunResult & { ms: { load: number; run: number; snapshot: number } }) => void; reject: (e: Error) => void; retry: () => void; timer: ReturnType<typeof setTimeout> }

interface Source {
  indexURL: string
  plotly: string
  /** Origins the sandbox may connect to: where the files come from. */
  connect: string[]
}

/** What the engine asks before it would reach for a third party: throws to refuse (the app passes the third-party switch). */
export type CdnGuard = (what: string) => void

/** Said when the app does not serve the runtime: the only source Python is loaded from is this origin. */
export const PYODIDE_NOT_SERVED = 'Python scripts need the Python runtime served by this app, and this build does not serve it: run `npm run pyodide` (it fetches Pyodide and plotly, checked against pinned SHA-256 digests, into public/pyodide) and reload. The runtime is not loaded from a CDN: nothing there is pinned or checked.'

/**
 * Where the runtime comes from: this origin, as `npm run pyodide` lays it out (every file checked against a pinned
 * digest when it was fetched). There used to be a fallback to jsDelivr and PyPI — the latest plotly, unpinned, and
 * `pyodide.js` with no integrity check — which is refused now: the third-party switch is asked first (so with it off
 * the reason given is the switch), and then the build is told how to serve the runtime itself.
 */
async function locate(beforeCdn?: CdnGuard): Promise<Source> {
  const origin = typeof location !== 'undefined' ? location.origin : ''
  try {
    const res = await fetch(`${origin}/pyodide/manifest.json`, { cache: 'no-cache' })
    if (res.ok) {
      const m = (await res.json()) as { plotly?: string }
      if (m.plotly && /^[\w.+-]+\.whl$/.test(m.plotly)) return { indexURL: `${origin}/pyodide/`, plotly: `${origin}/pyodide/${m.plotly}`, connect: [origin] }
    }
  } catch {
    /* not self-hosted */
  }
  beforeCdn?.('Python scripts, whose runtime this app does not serve (it would load from cdn.jsdelivr.net, with packages from PyPI)')
  throw new Error(PYODIDE_NOT_SERVED)
}

export class PythonEngine {
  /** `beforeCdn`: asked before the runtime is fetched from the CDN rather than this origin; a throw refuses the boot. */
  private readonly opts: { beforeCdn?: CdnGuard }
  constructor(opts: { beforeCdn?: CdnGuard } = {}) {
    this.opts = opts
  }
  private frame: HTMLIFrameElement | null = null
  /** What the sandbox's worker runs: the config and the worker source, handed over once the bootstrap says it is ready. */
  private workerBundle = ''
  private pending = new Map<number, Pending>()
  private seq = 0
  private booting: Promise<void> | null = null
  private status: PythonStatus = { stage: 'idle' }
  private listeners = new Set<(s: PythonStatus) => void>()
  private source: Source | null = null
  /** The project the worker's state belongs to: a run for another restarts the worker first. */
  private scope: string | undefined

  getStatus = () => this.status
  onStatus(l: (s: PythonStatus) => void): () => void {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  private setStatus(s: PythonStatus) {
    this.status = s
    this.listeners.forEach((l) => l(s))
  }

  /** Start the runtime (idempotent); resolves once packages are loaded. */
  async boot(): Promise<void> {
    if (this.booting) return this.booting
    this.booting = (async () => {
      try {
        this.source ??= await locate(this.opts.beforeCdn)
      } catch (err) {
        this.setStatus({ stage: 'failed', message: err instanceof Error ? err.message : String(err) })
        throw err
      }
      const src = this.source
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.style.display = 'none'
      frame.title = 'Python sandbox'
      // The frame's own policy, narrowing what it inherits. `unsafe-eval` is Pyodide's: CPython's JS glue
      // compiles functions at run time. `blob:` is how the bootstrap's worker — and the bootstrap's own
      // scripts — arrive, since inline is refused by the inherited policy.
      const csp = `default-src 'none'; script-src 'unsafe-eval' 'wasm-unsafe-eval' blob: ${location.origin} ${src.connect.join(' ')}; connect-src ${src.connect.join(' ')}; worker-src blob:`
      // From this origin, never from `src.connect` — that may be a CDN when Pyodide is not served locally.
      const bootSrc = sandboxBootUrl('/sandbox/python-boot.js', location.origin)
      // What the worker runs, which used to be baked into the inline bootstrap and is posted to it now.
      this.workerBundle = `self.__aegraphPython = ${JSON.stringify({ indexURL: src.indexURL, plotly: src.plotly, prelude })};\n${workerSource}`
      frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script src="${bootSrc}"></script>`
      window.addEventListener('message', this.onMessage)
      // Python runs in a worker, which cannot navigate the frame; the bootstrap is ours. A second load would still
      // mean the frame left its document, so it is ended rather than trusted (see the visual engine).
      let loads = 0
      frame.addEventListener('load', () => {
        if (++loads < 2 || this.frame !== frame) return
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(new Error('The script tried to leave its sandbox (it navigated its frame) and was stopped.'))
        }
        this.pending.clear()
        window.removeEventListener('message', this.onMessage)
        frame.remove()
        this.frame = null
        this.booting = null
        this.setStatus({ stage: 'failed', message: 'The sandbox frame navigated away and was removed.' })
      })
      document.body.appendChild(frame)
      this.frame = frame
      this.setStatus({ stage: 'runtime' })
      await new Promise<void>((resolve, reject) => {
        const off = this.onStatus((s) => {
          if (s.stage === 'ready') {
            off()
            resolve()
          } else if (s.stage === 'failed') {
            off()
            reject(new Error(s.message ?? 'Python failed to start'))
          }
        })
      })
    })()
    this.booting.catch(() => {
      this.booting = null
    })
    return this.booting
  }

  private onMessage = (e: MessageEvent) => {
    if (!this.frame || e.source !== this.frame.contentWindow) return
    const m = e.data as { type: string; id?: number; stage?: PythonStage; message?: string; versions?: Record<string, string>; result?: RunResult & { ms: { load: number; run: number; snapshot: number } } }
    if (!m || typeof m !== 'object') return
    // The bootstrap has run and is waiting for what the worker should run.
    if (m.type === 'boot-ready') return void this.frame.contentWindow?.postMessage({ type: 'init', source: this.workerBundle }, '*')
    if (m.type === 'status') return this.setStatus({ stage: m.stage ?? 'failed', message: m.message, versions: m.versions })
    if (m.id === undefined) return
    const p = this.pending.get(m.id)
    if (!p) return
    if (m.type === 'need-snapshot') return p.retry()
    clearTimeout(p.timer)
    this.pending.delete(m.id)
    if (m.type === 'result' && m.result) p.resolve(m.result)
    else p.reject(new Error(m.message ?? 'The Python worker failed.'))
  }

  /**
   * Run Python over a snapshot. Python in one interpreter cannot be fenced from itself — a script can patch a module,
   * `sys`, a prelude function's globals — so the worker is restarted when what it holds stops being the owner's: before
   * a run over another project's snapshot (`scope`), and after a run of code they have not run here (`untrusted`).
   */
  async run(code: string, snapshot: { key: string; json: () => string | Promise<string>; scope?: string }, options: RunOptions = {}): Promise<RunResult & { ms: { load: number; run: number; snapshot: number } }> {
    if (snapshot.scope !== undefined) {
      if (this.scope !== undefined && this.scope !== snapshot.scope && this.status.stage !== 'idle') this.reset()
      this.scope = snapshot.scope
    }
    await this.boot()
    const id = ++this.seq
    const timeoutMs = options.timeoutMs ?? 30000
    const run = this.runOnce(id, code, snapshot, timeoutMs)
    if (!options.untrusted) return run
    // Whatever the code left in the interpreter goes with the worker, before any other run can meet it.
    return run.finally(() => this.reset())
  }

  private runOnce(id: number, code: string, snapshot: { key: string; json: () => string | Promise<string> }, timeoutMs: number): Promise<RunResult & { ms: { load: number; run: number; snapshot: number } }> {
    return new Promise((resolve, reject) => {
      const send = async (withJson: boolean) => this.frame?.contentWindow?.postMessage({ type: 'run', id, key: snapshot.key, code, ...(withJson ? { json: await snapshot.json() } : {}) }, '*')
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.reset()
        reject(new Error(`Python script interrupted after ${timeoutMs} ms; the runtime is restarting.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, retry: () => void send(true).catch(reject), timer })
      void send(false).catch(reject)
    })
  }

  /** Terminate the worker (a stuck script) and boot a fresh one; the snapshot reloads on the next run. */
  reset() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(Object.assign(new Error('Script cancelled.'), { name: 'AbortError' }))
    }
    this.pending.clear()
    this.setStatus({ stage: 'idle' })
    if (!this.frame) {
      this.booting = null
      return
    }
    this.frame.contentWindow?.postMessage({ type: 'reset' }, '*')
    // The restarted worker reports its own status; boot() waits on it without recreating the frame.
    this.booting = new Promise<void>((resolve, reject) => {
      const off = this.onStatus((s) => {
        if (s.stage === 'ready') {
          off()
          resolve()
        } else if (s.stage === 'failed') {
          off()
          reject(new Error(s.message ?? 'Python failed to restart'))
        }
      })
    })
    this.booting.catch(() => {
      this.booting = null
    })
  }

  dispose() {
    window.removeEventListener('message', this.onMessage)
    this.frame?.remove()
    this.frame = null
    this.booting = null
    this.setStatus({ stage: 'idle' })
  }
}
