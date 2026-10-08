import { spawnSync } from 'node:child_process'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PythonEngine, PYODIDE_NOT_SERVED } from '../python/engine'

/**
 * Python between runs (security review, pass 6, findings 3 and 8): every run gets a namespace of its own, so a script
 * that rebinds a helper or leaves a `result` leaves nothing for the next; the worker answers only on the bootstrap's
 * private port, through the prelude functions it took at boot; the engine restarts the worker after untrusted code and
 * between projects; and the runtime is never loaded unpinned from a CDN.
 */

const preludePath = fileURLToPath(new URL('../python/prelude.py', import.meta.url))
const workerPath = fileURLToPath(new URL('../python/worker.js', import.meta.url))
const hasPython = spawnSync('python3', ['--version']).status === 0

const STUB_PANDAS = `
class DataFrame:
    def __init__(self, *a, **k):
        self.rows = a[0] if a else []
        self.index = type('I', (), {'name': None})()
    def __len__(self): return len(self.rows)
    def __getitem__(self, k): return [r.get(k) for r in self.rows]
    def __setitem__(self, k, v): pass
    def __contains__(self, k): return any(k in r for r in self.rows)
    @property
    def empty(self): return not self.rows
class Series: pass
class Index: pass
class Timestamp: pass
class Period: pass
def to_datetime(v, **k): return v
def isna(v): return v is None
`
const STUB_NUMPY = `
integer = int
floating = float
class datetime64: pass
class ndarray: pass
`

function runs(codes: string[]): { value: unknown; logs: string[]; error: unknown }[] {
  const dir = mkdtempSync(join(tmpdir(), 'aegraph-pyiso-'))
  mkdirSync(join(dir, 'pandas'))
  mkdirSync(join(dir, 'numpy'))
  writeFileSync(join(dir, 'pandas', '__init__.py'), STUB_PANDAS)
  writeFileSync(join(dir, 'numpy', '__init__.py'), STUB_NUMPY)
  const snap = { scope: { label: 't' }, entities: [{ id: 'a', type: 'x', label: 'A', tags: [], data: {} }, { id: 'b', type: 'x', label: 'B', tags: [], data: {} }], relationships: [] }
  const script = `
import asyncio, json, sys
sys.path.insert(0, ${JSON.stringify(dir)})
g = {}
exec(compile(open(${JSON.stringify(preludePath)}).read(), 'prelude.py', 'exec'), g)
load, run = g['_aegraph_load'], g['_aegraph_run']
load(${JSON.stringify(JSON.stringify(snap))})
print(json.dumps([json.loads(asyncio.run(run(c))) for c in ${JSON.stringify(codes)}]))
`
  const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout.trim().split('\n').pop()!)
}

describe.skipIf(!hasPython)('a Python run cannot change the next', () => {
  it('rebound helpers, a stale result and new globals are gone in the next run', () => {
    const honest = `figure([bar([e['id'] for e in entities], [1, 2])], 'T')`
    const [before, , after, globals] = runs([
      honest,
      `figure = lambda *a, **k: {'text': 'exfil'}\nbar = None\nresult = {'text': 'stale'}\nentities = []\n_aegraph_run = None\nleft = 1`,
      honest,
      `print('left' in globals(), 'result' in globals())`,
    ])
    expect(before.error).toBeNull()
    expect(after).toEqual(before)
    expect(globals.logs).toEqual(['False False'])
  })

  it('a script with no trailing expression does not get a result an earlier run left', () => {
    const [, second] = runs([`result = {'text': 'from the first run'}`, `x = 1`])
    expect(second.value).toBeNull()
  })
})

describe('the worker answers on its port only', () => {
  /** The worker's source in a context of its own, with Pyodide stubbed: what the bootstrap and a script can reach. */
  function bootWorker(stub: { run: (code: string) => Promise<string> }) {
    const posted: unknown[] = []
    const ctx: Record<string, unknown> = {
      MessagePort,
      Reflect,
      JSON: { parse: JSON.parse, stringify: JSON.stringify },
      performance,
      Promise,
      Math,
      Error,
      String,
      Array,
      queueMicrotask,
      postMessage: (m: unknown) => posted.push(m),
      importScripts: () => {},
      __aegraphPython: { indexURL: '/pyodide/', plotly: 'x.whl', prelude: '' },
    }
    const globals = new Map<string, unknown>([['_aegraph_load', () => 0], ['_aegraph_run', (c: string) => stub.run(c)]])
    ctx.loadPyodide = async () => ({
      loadPackage: async () => {},
      pyimport: () => ({ install: async () => {}, destroy: () => {} }),
      runPython: () => '1',
      loadPackagesFromImports: async () => {},
      globals: { get: (k: string) => globals.get(k) },
    })
    ctx.self = ctx
    vm.runInNewContext(readFileSync(workerPath, 'utf8'), ctx)
    const ch = new MessageChannel()
    const got: { type: string; id?: number; result?: { value: unknown; error?: { message: string }; logs: string[] } }[] = []
    ch.port1.onmessage = (e) => got.push(e.data)
    ;(ctx.onmessage as (e: unknown) => void)({ data: { type: 'port' }, ports: [ch.port2] })
    const run = (id: number, code: string) => ch.port1.postMessage({ type: 'run', id, key: 'k', code, json: '{}' })
    const until = async (n: number) => {
      for (let i = 0; i < 200 && got.filter((m) => m.type === 'result' || m.type === 'error').length < n; i++) await new Promise((r) => setTimeout(r, 5))
    }
    return { ctx, globals, posted, got, run, until, close: () => ch.port1.close() }
  }

  it('a forged postMessage goes nowhere, and a replaced _aegraph_run or JSON.parse is not what the next run calls', async () => {
    const w = bootWorker({ run: async () => JSON.stringify({ value: { text: 'honest' }, logs: [], error: null }) })
    w.run(1, 'x')
    await w.until(1)
    // The script tries everything in reach of a global lookup.
    ;(w.ctx.postMessage as (m: unknown) => void)({ type: 'result', id: 2, result: { value: { text: 'forged' } } })
    w.globals.set('_aegraph_run', async () => JSON.stringify({ value: { text: 'exfil' }, logs: [] }))
    ;(w.ctx.JSON as { parse: unknown }).parse = () => ({ value: { text: 'exfil' } })
    w.ctx.onmessage = () => {}
    w.run(2, 'x')
    await w.until(2)
    const results = w.got.filter((m) => m.type === 'result')
    expect(results.map((m) => m.result!.value)).toEqual([{ text: 'honest' }, { text: 'honest' }])
    w.close()
  })

  it('caps the logs and refuses a result too large to show', async () => {
    const big = 'x'.repeat(64 * 1024 * 1024 + 10)
    const w = bootWorker({ run: async (c) => (c === 'big' ? JSON.stringify({ value: big, logs: [] }) : JSON.stringify({ value: null, logs: Array.from({ length: 5000 }, (_, i) => `line ${i}`) })) })
    w.run(1, 'logs')
    w.run(2, 'big')
    await w.until(2)
    const [logs, big2] = w.got.filter((m) => m.type === 'result')
    expect(logs.result!.logs.length).toBe(2001)
    expect(logs.result!.logs.at(-1)).toMatch(/3,?000 more log lines/)
    expect(big2.result!.error!.message).toMatch(/too large/)
    w.close()
  }, 30_000)
})

describe('the engine', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('never loads the runtime from a CDN: a build that does not serve it is told to', async () => {
    vi.stubGlobal('location', new URL('http://127.0.0.1:5199/analytics/scripts'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const engine = new PythonEngine()
    await expect(engine.boot()).rejects.toThrow(PYODIDE_NOT_SERVED)
    expect(engine.getStatus().stage).toBe('failed')
  })

  it('restarts the worker after an untrusted run and before a run for another project', async () => {
    const engine = new PythonEngine()
    const e = engine as unknown as { boot: () => Promise<void>; runOnce: () => Promise<unknown>; reset: () => void; status: { stage: string } }
    e.boot = async () => {}
    e.status = { stage: 'ready' }
    e.runOnce = async () => ({ value: 1, logs: [], ms: { load: 0, run: 0, snapshot: 0 } })
    const reset = vi.fn(() => (e.status = { stage: 'ready' }))
    e.reset = reset
    const snap = (scope: string) => ({ key: scope, scope, json: () => '{}' })
    await engine.run('x', snap('p1'))
    expect(reset).not.toHaveBeenCalled()
    await engine.run('x', snap('p1'), { untrusted: true })
    expect(reset).toHaveBeenCalledTimes(1)
    await engine.run('x', snap('p2'))
    expect(reset).toHaveBeenCalledTimes(2)
    await engine.run('x', snap('p2'))
    expect(reset).toHaveBeenCalledTimes(2)
  })
})

describe('the Python bootstrap', () => {
  it('relays the worker’s port and nothing the worker’s own channel says', async () => {
    const bootPath = fileURLToPath(new URL('../../../public/sandbox/python-boot.js', import.meta.url))
    const toParent: { type: string }[] = []
    const listeners: ((e: { source: unknown; data: unknown }) => void)[] = []
    const parent = { postMessage: (m: { type: string }) => toParent.push(m) }
    class FakeWorker {
      static last: FakeWorker
      onmessage: ((e: unknown) => void) | null = null
      onerror: unknown = null
      port?: MessagePort
      constructor() {
        FakeWorker.last = this
      }
      postMessage(m: { type: string }, transfer?: MessagePort[]) {
        if (m.type === 'port') this.port = transfer![0]
      }
      terminate() {}
    }
    const ctx = { parent, window: { addEventListener: (_: string, l: (e: { source: unknown; data: unknown }) => void) => listeners.push(l), onerror: null }, Worker: FakeWorker, MessageChannel, Blob, URL: { createObjectURL: () => 'blob:x' } }
    vm.runInNewContext(readFileSync(bootPath, 'utf8'), ctx)
    listeners.forEach((l) => l({ source: parent, data: { type: 'init', source: '' } }))
    const worker = FakeWorker.last
    // A script in the worker posting on the worker's own channel: not relayed.
    worker.onmessage?.({ data: { type: 'result', id: 1, result: { value: 'forged' } } })
    // The worker's code on its port: relayed.
    worker.port!.postMessage({ type: 'status', stage: 'ready' })
    await new Promise((r) => setTimeout(r, 20))
    expect(toParent.map((m) => m.type)).toEqual(['boot-ready', 'status'])
    worker.port!.close()
  })
})
