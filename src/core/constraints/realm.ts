import type { InterruptHandler, QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from 'quickjs-emscripten-core'

/**
 * Where a constraint's JavaScript runs: an in-process QuickJS interpreter,
 * never the host's own realm. A rule arrives in bundles, imports and tool
 * calls — it is data, and compiling it with `new Function` would hand
 * whoever wrote it the app's origin (in a tab) or the machine (headless).
 * In here a rule sees ECMAScript and the rule vocabulary, nothing else: no
 * `fetch`, no `process`, no `document`, no way back to the host's objects.
 *
 * The vocabulary crosses as JSON: `e`, `previous` and `params` are copied
 * in; a helper that reads the store (`out`, `entity`, `ofType`, `unique`,
 * `store.get`…) is a host function that answers with a copy. `get`, `has`,
 * `matches`, `isEmpty`, `count`, `fail` and `violation` run inside, since
 * they need nothing the rule does not already hold.
 *
 * The interpreter is synchronous — the store's guard is — but the WASM
 * behind it loads asynchronously, once (`loadRuleRealm`). Until it has,
 * `compileRule` throws `RulePending` and the engine leaves JavaScript checks
 * out (see engine.ts). Every call runs under a deadline (a rule that loops
 * is stopped and fails with a message) and the runtime under a memory cap;
 * an interrupted interpreter is thrown away and rebuilt, and compiled rules
 * recompile into the new one on their next call.
 */

/** Per call: an entity rule runs once per entity written, a graph rule once per write. */
export const ENTITY_RULE_BUDGET_MS = 250
export const GRAPH_RULE_BUDGET_MS = 5000
const MEMORY_MB = 64
const CACHE_MAX = 256

export class RulePending extends Error {
  constructor() {
    super('the JavaScript sandbox for checks is still loading')
    this.name = 'RulePending'
  }
}

let module: QuickJSWASMModule | null = null
let deadline: ((ms: number) => InterruptHandler) | null = null
let loading: Promise<void> | null = null

/** Load the interpreter (once; later calls share the promise). */
export function loadRuleRealm(): Promise<void> {
  return (loading ??= (async () => {
    const [{ default: variant }, core] = await Promise.all([import('@jitl/quickjs-singlefile-browser-release-sync'), import('quickjs-emscripten-core')])
    module = await core.newQuickJSWASMModuleFromVariant(variant)
    deadline = (ms) => core.shouldInterruptAfterDeadline(Date.now() + ms)
  })())
}

export const ruleRealmReady = () => module !== null

/** Answers a helper call from inside: (name, args) → a JSON-able value. */
export type HostDispatch = (name: string, args: unknown[]) => unknown

const PRELUDE = String.raw`
const __call = (n, a) => { const r = __host(n, JSON.stringify(a)); return r === undefined ? undefined : JSON.parse(r) }
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
const count = (list) => Array.isArray(list) ? list.length : list && typeof list === 'object' && 'size' in list ? list.size : list ? 1 : 0
const fail = (m) => m || 'failed'
const dataAt = (data, key) => {
  if (!data || typeof data !== 'object') return undefined
  if (key in data) return data[key]
  if (!key.includes('.')) return undefined
  let cur = data
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = cur[part]
  }
  return cur
}
const getPath = (e, path) => {
  if (!e || typeof e !== 'object' || typeof path !== 'string') return undefined
  if (path.startsWith('data.')) return dataAt(e.data, path.slice(5))
  if (path.startsWith('meta.')) return e.meta ? e.meta[path.slice(5)] : undefined
  return e[path]
}
const store = Object.freeze({
  get: (id) => __call('store.get', [id]),
  has: (id) => __call('store.has', [id]),
  ofType: (type) => __call('store.ofType', [type]),
  relationshipsOf: (id, dir) => __call('store.relationshipsOf', [id, dir]),
  query: (q) => __call('store.query', [q]),
  all: () => __call('store.all', []),
})
// Built once per rule over a holder the invoker refills per call: a call costs the copy of e, not twenty closures.
globalThis.__entityHelpers = (cur) => ({
  get: (p) => getPath(cur.e, p),
  has: (p) => !isEmpty(getPath(cur.e, p)),
  isEmpty,
  matches: (p, re) => { const v = getPath(cur.e, p); return typeof v === 'string' && (typeof re === 'string' ? new RegExp(re) : re).test(v) },
  out: (rel) => __call('out', [rel]),
  inn: (rel) => __call('inn', [rel]),
  links: (rel) => __call('links', [rel]),
  neighbors: (rel) => __call('neighbors', [rel]),
  source: () => __call('source', []),
  target: () => __call('target', []),
  entity: (id) => __call('entity', [id]),
  typeOf: (id) => __call('typeOf', [id]),
  ofType: (type) => __call('ofType', [type]),
  unique: (p) => __call('unique', [p]),
  count,
  others: () => __call('others', []),
  store,
  fail,
})
// What a rule returns, as the host reads it: a primitive as itself, anything else as JSON behind a \u0001 (not a NUL,
// which the string's trip out through C would end it at).
globalThis.__out = (r) => (r === null || typeof r !== 'object' ? (typeof r === 'function' ? undefined : r) : '\u0001' + JSON.stringify(r))
const __id = (x) => (typeof x === 'string' ? x : x && x.id)
globalThis.__graphHelpers = (params) => ({
  all: () => __call('all', []),
  entities: () => __call('entities', []),
  relationships: (type) => __call('relationships', [type]),
  ofType: (type) => __call('ofType', [type]),
  entity: (id) => __call('entity', [id]),
  typeOf: (id) => __call('typeOf', [id]),
  types: () => __call('types', []),
  relTypes: () => __call('relTypes', []),
  out: (x, rel) => __call('out', [__id(x), rel]),
  inn: (x, rel) => __call('inn', [__id(x), rel]),
  links: (x, rel) => __call('links', [__id(x), rel]),
  neighbors: (x, rel) => __call('neighbors', [__id(x), rel]),
  degree: (x, rel) => __call('degree', [__id(x), rel]),
  get: (e, p) => getPath(e, p),
  has: (e, p) => !isEmpty(getPath(e, p)),
  isEmpty,
  count,
  cycle: (rel) => __call('cycle', [rel]),
  others: () => __call('others', []),
  violation: (id, message) => ({ id: __id(id), message: message || 'flagged' }),
  fail,
  params,
  store,
})
`

interface Realm {
  rt: QuickJSRuntime
  vm: QuickJSContext
  generation: number
}

let realm: Realm | null = null
let generation = 0
let dispatch: HostDispatch | null = null
/** Compiled rule functions inside the realm, by kind + source; oldest dropped first. */
const cache = new Map<string, { generation: number; fn: QuickJSHandle }>()

function open(): Realm {
  if (realm) return realm
  if (!module) throw new RulePending()
  const rt = module.newRuntime()
  rt.setMemoryLimit(MEMORY_MB * 1024 * 1024)
  rt.setMaxStackSize(1024 * 1024)
  const vm = rt.newContext()
  const host = vm.newFunction('__host', (nameH, argsH) => {
    const name = vm.getString(nameH)
    const args = JSON.parse(vm.getString(argsH)) as unknown[]
    if (!dispatch) return { error: vm.newError('no rule is running') }
    let out: unknown
    try {
      out = dispatch(name, args)
    } catch (err) {
      return { error: vm.newError(err instanceof Error ? err.message : String(err)) }
    }
    return out === undefined ? vm.undefined : vm.newString(JSON.stringify(out))
  })
  vm.setProp(vm.global, '__host', host)
  host.dispose()
  vm.unwrapResult(vm.evalCode(PRELUDE, 'rule-prelude.js')).dispose()
  realm = { rt, vm, generation: ++generation }
  return realm
}

/** Throw the interpreter away (after an interrupt, it may be anywhere); the next call builds a fresh one. */
function discard() {
  if (!realm) return
  for (const c of cache.values()) if (c.generation === realm.generation && c.fn.alive) c.fn.dispose()
  cache.clear()
  try {
    realm.vm.dispose()
    realm.rt.dispose()
  } catch {
    // An interpreter stopped mid-allocation may refuse a clean teardown; it is unreachable either way.
  }
  realm = null
}

function errorOf(vm: QuickJSContext, h: QuickJSHandle): { name: string; message: string } {
  const d = vm.dump(h) as { name?: string; message?: string } | string
  if (typeof d === 'string') return { name: 'Error', message: d }
  return { name: typeof d?.name === 'string' ? d.name : 'Error', message: typeof d?.message === 'string' ? d.message : JSON.stringify(d) }
}

/** The realm-side function for a source, compiled once; throws the rule's SyntaxError when it does not parse. */
function compiled(key: string, source: string): { r: Realm; fn: QuickJSHandle } {
  const r = open()
  const hit = cache.get(key)
  if (hit && hit.generation === r.generation && hit.fn.alive) {
    cache.delete(key)
    cache.set(key, hit)
    return { r, fn: hit.fn }
  }
  const res = r.vm.evalCode(source, 'rule.js')
  if (res.error) {
    const { name, message } = errorOf(r.vm, res.error)
    res.error.dispose()
    if (name === 'SyntaxError') throw new SyntaxError(message)
    throw new Error(message)
  }
  cache.set(key, { generation: r.generation, fn: res.value })
  while (cache.size > CACHE_MAX) {
    const [k, v] = cache.entries().next().value as [string, { fn: QuickJSHandle }]
    if (v.fn.alive) v.fn.dispose()
    cache.delete(k)
  }
  return { r, fn: res.value }
}

/** Check that a source compiles in the realm now (throws SyntaxError / RulePending), so a bad rule fails when saved. */
export function prepare(key: string, source: string): void {
  compiled(key, source)
}

/**
 * Run a compiled rule: `args` are JSON strings (or undefined) handed to the realm-side function, `host` answers its
 * helper calls. Returns the rule's value (`__out`: a primitive as itself, anything else through JSON), or throws with
 * the rule's error.
 */
export function call(key: string, source: string, args: (string | undefined)[], host: HostDispatch, budgetMs: number): unknown {
  const { r, fn } = compiled(key, source)
  const { vm, rt } = r
  const handles = args.map((a) => (a === undefined ? vm.undefined : vm.newString(a)))
  const outer = dispatch
  dispatch = host
  rt.setInterruptHandler(deadline!(budgetMs))
  let res
  try {
    res = vm.callFunction(fn, vm.undefined, ...handles)
  } finally {
    dispatch = outer
    rt.removeInterruptHandler()
    for (const h of handles) if (h !== vm.undefined && h.alive) h.dispose()
  }
  if (res.error) {
    const { message } = errorOf(vm, res.error)
    res.error.dispose()
    if (/interrupted/i.test(message)) {
      discard()
      throw new Error(`the check ran past its ${budgetMs} ms budget and was stopped`)
    }
    if (/out of memory/i.test(message)) {
      discard()
      throw new Error(`the check ran out of memory (${MEMORY_MB} MB) and was stopped`)
    }
    throw new Error(message)
  }
  const kind = vm.typeof(res.value)
  let out: unknown
  if (kind === 'string') {
    const text = vm.getString(res.value)
    out = text.charCodeAt(0) === 1 ? JSON.parse(text.slice(1)) : text
  } else if (kind === 'boolean' || kind === 'number') out = vm.dump(res.value)
  else if (kind === 'object') out = null
  res.value.dispose()
  return out
}
