import variant from '@jitl/quickjs-singlefile-browser-release-sync'
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from 'quickjs-emscripten-core'
import prelude from './prelude.js?raw'
import metrics from './metrics.js?raw'
import { capLogs, MAX_RESULT_CHARS, resultTooLarge } from './limits'
import type { RunOptions, RunResult } from './types'

/**
 * One QuickJS runtime and one context per dataset: the snapshot is parsed
 * into the VM once (the slow part — ~15 ms per thousand entities), the
 * prelude is evaluated once, and `ds` is frozen through, so every script
 * runs in the same warm context: a run costs only what the script does.
 *
 * Sharing a context is safe only if no run can leave anything behind for the
 * next, so once the prelude is in, the context is **locked down** (LOCKDOWN):
 * every built-in, its prototype and the intrinsics no global names (iterator
 * and generator prototypes, %TypedArray%), the prelude's functions, classes
 * and constants, and every global binding are frozen — `Array.prototype.map`,
 * `JSON.stringify`, `ds`, `figure`, `log` cannot be replaced. A global a run
 * adds is deleted when it ends, the log is a fresh array per run, and the
 * host reads the result through functions it took before any script ran. A
 * run that leaves something that cannot be swept (a non-configurable global,
 * a non-extensible global object) costs the context, as an interrupted run
 * (time or memory) does: the next run rebuilds it. So does every run of code
 * its owner has not run here before (`untrusted`).
 *
 * The interpreter has no I/O: the only globals beyond ECMAScript are `ds` and
 * the prelude's helpers.
 */
let modulePromise: Promise<QuickJSWASMModule> | undefined
/** How long a snapshot may take to parse, index and freeze before the run is abandoned (not the script's timeout). */
const LOAD_CAP_MS = 120_000
const FREEZE = `(function () {
  const deep = (o) => {
    if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return
    Object.freeze(o)
    if (Array.isArray(o)) for (let i = 0; i < o.length; i++) deep(o[i])
    else for (const k in o) deep(o[k])
  }
  const d = globalThis.ds
  Object.freeze(d)
  for (const list of [d.entities, d.relationships]) {
    if (!Array.isArray(list)) continue
    Object.freeze(list)
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      if (e === null || typeof e !== 'object') continue
      Object.freeze(e)
      if (e.tags) Object.freeze(e.tags)
      const data = e.data
      if (data !== null && typeof data === 'object') {
        Object.freeze(data)
        for (const k in data) {
          const v = data[k]
          if (v !== null && typeof v === 'object') deep(v)
        }
      }
      for (const k in e) {
        if (k === 'tags' || k === 'data') continue
        const v = e[k]
        if (v !== null && typeof v === 'object') deep(v)
      }
    }
  }
  for (const k in d) if (k !== 'entities' && k !== 'relationships') deep(d[k])
})()`
const loadModule = () => (modulePromise ??= newQuickJSWASMModuleFromVariant(variant))

/** The prelude's top-level bindings — not properties of the global object, so the lockdown names them to reach them. */
const PRELUDE_BINDINGS = [...`${prelude}\n${metrics}`.matchAll(/^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]).filter((n) => n !== '__logs')

/**
 * Freeze everything a script can reach, once per context, after the prelude and the snapshot's own freeze. Returns the
 * host's helpers, taken before any script runs: `finish` (the result as JSON, or a promise marker), `logs` (the run's
 * lines as JSON) and `sweep` (delete the globals a run added; false when it cannot).
 *
 * A few properties scripts commonly shadow on their own objects (`name` and `message` on an error, `toString`) become
 * accessors first — freezing them as data properties would make `this.name = …` in an Error subclass throw.
 */
const LOCKDOWN = `(function (roots) {
  'use strict'
  const freeze = Object.freeze
  const getProto = Object.getPrototypeOf
  const ownKeys = Reflect.ownKeys
  const desc = Object.getOwnPropertyDescriptor
  const define = Object.defineProperty
  const stringify = JSON.stringify
  const replacer = __replacer
  const isExtensible = Object.isExtensible
  const del = Reflect.deleteProperty
  const G = globalThis
  const stack = []
  const overridable = (obj, key) => {
    const d = obj && desc(obj, key)
    if (!d || !('value' in d) || !d.configurable) return
    const value = d.value
    stack.push(value)
    define(obj, key, {
      get() { return value },
      set(v) {
        if (this === obj) throw new TypeError("Cannot assign to read only property '" + String(key) + "'")
        define(this, key, { value: v, writable: true, enumerable: true, configurable: true })
      },
      enumerable: d.enumerable,
      configurable: false,
    })
  }
  for (const k of ['toString', 'valueOf', 'toLocaleString', 'constructor', 'hasOwnProperty']) overridable(Object.prototype, k)
  for (const E of [Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, typeof AggregateError === 'function' ? AggregateError : null]) {
    if (!E) continue
    for (const k of ['name', 'message', 'constructor', 'toString']) overridable(E.prototype, k)
  }
  for (const k of ['toString', 'constructor']) overridable(Array.prototype, k)
  overridable(Function.prototype, 'toString')
  // Intrinsics no global names, reached through an instance.
  const hidden = [
    function* () {}, (function* () {})(), async function () {}, Promise.resolve(),
    [][Symbol.iterator](), new Map().entries(), new Set().values(), ''[Symbol.iterator](), /a/g[Symbol.matchAll]('a'),
    typeof Int8Array === 'function' ? getProto(Int8Array) : null,
  ]
  try { hidden.push(async function* () {}, (async function* () {})()) } catch (e) {}
  const d = G.ds
  const lists = [d.entities, d.relationships]
  const seen = new Set()
  // Every global binding: not writable, not configurable; and what it holds frozen through.
  for (const k of ownKeys(G)) {
    const p = desc(G, k)
    if (!p) continue
    if ('value' in p) {
      if (p.configurable || p.writable) define(G, k, { value: p.value, writable: false, enumerable: p.enumerable, configurable: false })
      if (k !== 'ds') stack.push(p.value)
    } else stack.push(p.get, p.set)
  }
  // ds: frozen through already (the snapshot's freeze), save its functions and the collections' prototypes.
  seen.add(d)
  for (const k of ownKeys(d)) {
    const v = desc(d, k).value
    if (typeof v === 'function') stack.push(v)
  }
  for (const l of lists) {
    if (!l || typeof l !== 'object') continue
    seen.add(l)
    freeze(l)
    stack.push(getProto(l))
  }
  stack.push(...roots, ...hidden)
  while (stack.length) {
    const o = stack.pop()
    if (o === null || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o) || o === G) continue
    seen.add(o)
    try { freeze(o) } catch (e) { /* a typed array with elements cannot be frozen; none is global */ }
    stack.push(getProto(o))
    for (const k of ownKeys(o)) {
      const p = desc(o, k)
      if (!p) continue
      if ('value' in p) stack.push(p.value)
      else stack.push(p.get, p.set)
    }
  }
  freeze(getProto(G))
  const baseline = new Set(ownKeys(G))
  return {
    finish(r) {
      if (r !== null && (typeof r === 'object' || typeof r === 'function') && typeof r.then === 'function') return '\u0001promise'
      const t = stringify(r === undefined ? null : r, replacer)
      return t === undefined ? 'null' : t
    },
    logs() {
      try { return stringify(__logs) || '[]' } catch (e) { return '[]' }
    },
    sweep() {
      if (!isExtensible(G)) return false
      for (const k of ownKeys(G)) if (!baseline.has(k) && !del(G, k)) return false
      return true
    },
  }
})`

interface Warm {
  vm: QuickJSContext
  finish: QuickJSHandle
  logs: QuickJSHandle
  sweep: QuickJSHandle
}

export class Sandbox {
  private runtime: QuickJSRuntime | null = null
  private key: string | null = null
  private module: QuickJSWASMModule | null = null
  private snapshotJson: string | null = null
  private warm: Warm | null = null

  /** Load a snapshot (JSON text) under a key; a repeat with the same key is free. */
  async load(key: string, json: string, opts: RunOptions = {}): Promise<number> {
    if (this.key === key && this.runtime) return 0
    const t0 = now()
    this.module ??= await loadModule()
    this.dispose()
    const rt = this.module.newRuntime()
    rt.setMemoryLimit((opts.memoryMb ?? 512) * 1024 * 1024)
    this.runtime = rt
    this.key = key
    this.snapshotJson = json
    return Math.round(now() - t0)
  }

  /** Run a script over the loaded snapshot. `return` gives the result; `log()` collects lines. */
  async run(code: string, opts: RunOptions = {}): Promise<RunResult> {
    if (!this.runtime || !this.snapshotJson) throw new Error('No dataset loaded into the sandbox.')
    const rt = this.runtime
    const t0 = now()
    let load = 0
    let warm: Warm | null = null
    // Code its owner has not run here: the context it ran in is not handed to the next run.
    let poisoned = !!opts.untrusted
    try {
      // Building the context (parsing the snapshot, the prelude, freezing) is the host's work, not the script's: it
      // gets its own generous cap, and the script's deadline starts once the context is warm — a big dataset takes a
      // few seconds to land and used to eat the script's whole budget.
      const t1 = now()
      rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + LOAD_CAP_MS))
      try {
        warm = this.context()
      } catch (e) {
        const mb = Math.round(this.snapshotJson.length / 1048576)
        const why = e instanceof Error ? e.message : String(e)
        throw new Error(`The dataset did not fit the JavaScript sandbox (${mb} MB of snapshot: ${why}). A script sees the whole project unless it says otherwise: name the types it reads — script {types: ["genus", "ward"]}, or the Types it keeps in the script's Details — and it is handed those and the relationships between them. Failing that, open a smaller project.`)
      }
      const vm = warm.vm
      load = Math.round(now() - t1)
      rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + (opts.timeoutMs ?? 5000)))
      vm.unwrapResult(vm.evalCode('__logs = []')).dispose()
      const wrapped = `(function () {\n${code}\n})()`
      const r = vm.evalCode(wrapped, 'script.js')
      if (r.error) {
        const err = vm.dump(r.error) as { message?: string; stack?: string } | string
        r.error.dispose()
        // A thrown object with no message (`throw { code: 7 }`) is shown as its JSON, not "[object Object]".
        let message = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : err && typeof err === 'object' ? JSON.stringify(err) : String(err)
        // Writing into the frozen dataset reads as "'0' is read-only" / "object is not extensible": say what it means.
        if (/read-only|not extensible/i.test(message)) message = `${message} — the dataset and the built-ins are read-only; copy before sorting or changing it (sortBy, [...list], { ...entity })`
        // An interrupted run (the deadline, the memory cap) may have left the interpreter anywhere: start afresh next time.
        if (/interrupted|out of memory/i.test(message)) poisoned = true
        return { value: undefined, logs: this.logs(warm), error: { message, stack: typeof err === 'string' ? undefined : err?.stack }, ms: { load, run: Math.round(now() - t0) } }
      }
      // The result is read by the host's own functions, taken before any script ran: a script cannot have replaced them.
      const fin = vm.callFunction(warm.finish, vm.undefined, r.value)
      r.value.dispose()
      if (fin.error) {
        const err = vm.dump(fin.error) as { message?: string } | string
        fin.error.dispose()
        const message = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : String(err)
        if (/interrupted|out of memory/i.test(message)) poisoned = true
        return { value: undefined, logs: this.logs(warm), error: { message: `The result could not be read: ${message}` }, ms: { load, run: Math.round(now() - t0) } }
      }
      const text = vm.typeof(fin.value) === 'string' ? vm.getString(fin.value) : 'null'
      fin.value.dispose()
      // There is no event loop in here: a promise would never settle, and would read as `{}`.
      if (text === '\u0001promise') return { value: undefined, logs: this.logs(warm), error: { message: 'The script returned a promise; scripts are synchronous — return a value.' }, ms: { load, run: Math.round(now() - t0) } }
      if (text.length > MAX_RESULT_CHARS) return { value: undefined, logs: this.logs(warm), error: { message: resultTooLarge(text.length) }, ms: { load, run: Math.round(now() - t0) } }
      return { value: JSON.parse(text), logs: this.logs(warm), ms: { load, run: Math.round(now() - t0) } }
    } catch (e) {
      poisoned = true
      return { value: undefined, logs: [], error: { message: e instanceof Error ? e.message : String(e) }, ms: { load, run: Math.round(now() - t0) } }
    } finally {
      // Globals the run added go; one that will not go (made non-configurable) costs the context.
      if (warm && !poisoned && !this.sweep(warm)) poisoned = true
      rt.removeInterruptHandler()
      if (poisoned) this.discardContext()
    }
  }

  /** The warm context: the snapshot parsed and frozen, the prelude in place, everything locked down. Built on first use after a load. */
  private context(): Warm {
    if (this.warm) return this.warm
    const vm = this.runtime!.newContext()
    try {
      const h = vm.newString(this.snapshotJson!)
      vm.setProp(vm.global, '__snapshot', h)
      h.dispose()
      vm.unwrapResult(vm.evalCode('globalThis.ds = JSON.parse(__snapshot); delete globalThis.__snapshot;')).dispose()
      vm.unwrapResult(vm.evalCode(prelude, 'prelude.js')).dispose()
      vm.unwrapResult(vm.evalCode(metrics, 'metrics.js')).dispose()
      // Frozen through, so a script that sorts an array in place or writes a field changes nothing for the next run.
      // The entity and relationship lists are walked by hand — each record, its tags, its data and whatever objects the
      // data holds — and only what is left (ontology, tags, metrics, …) by the general recursion: the generic walk
      // called Object.keys and isFrozen on every scalar and took twice as long as parsing the snapshot did.
      vm.unwrapResult(vm.evalCode(FREEZE, 'freeze.js')).dispose()
      // Then the language itself and the prelude: nothing a run can reach can be changed for the next one.
      const helpers = vm.unwrapResult(vm.evalCode(`${LOCKDOWN}([${PRELUDE_BINDINGS.join(', ')}])`, 'lockdown.js'))
      const warm: Warm = { vm, finish: vm.getProp(helpers, 'finish'), logs: vm.getProp(helpers, 'logs'), sweep: vm.getProp(helpers, 'sweep') }
      helpers.dispose()
      this.warm = warm
      return warm
    } catch (e) {
      vm.dispose()
      throw e
    }
  }

  private sweep(warm: Warm): boolean {
    try {
      const r = warm.vm.callFunction(warm.sweep, warm.vm.undefined)
      if (r.error) {
        r.error.dispose()
        return false
      }
      const ok = warm.vm.dump(r.value) === true
      r.value.dispose()
      return ok
    } catch {
      return false
    }
  }

  private discardContext() {
    const w = this.warm
    this.warm = null
    if (!w) return
    for (const h of [w.finish, w.logs, w.sweep]) if (h.alive) h.dispose()
    w.vm.dispose()
  }

  private logs(warm: Warm): string[] {
    try {
      const r = warm.vm.callFunction(warm.logs, warm.vm.undefined)
      if (r.error) {
        r.error.dispose()
        return []
      }
      const s = warm.vm.typeof(r.value) === 'string' ? warm.vm.getString(r.value) : '[]'
      r.value.dispose()
      const v = JSON.parse(s) as unknown
      return Array.isArray(v) ? capLogs(v.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))) : []
    } catch {
      return []
    }
  }

  dispose() {
    this.discardContext()
    this.runtime?.dispose()
    this.runtime = null
    this.key = null
    this.snapshotJson = null
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
