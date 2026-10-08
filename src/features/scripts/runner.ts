import type { EntityStore } from '../../core/entity/store'
import { requireExternalServices } from '../account/settings'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { PythonEngine, type PythonStatus } from '../../scripting/python/engine'
import { ScriptRunner, type RunSummary } from '../../scripting/runner'
import { ViewEngine, type ViewRun } from '../../scripting/view/engine'
import type { Language, RunOptions } from '../../scripting/types'
import { snapshotProvider } from './snapshot'
import { hasConsent } from './consent'

/**
 * One JavaScript sandbox worker and one Python engine per app, shared by
 * the Scripts page and the assistant; the snapshot they hold follows the
 * store. Python boots on first use (the runtime and wheels load once).
 */
const g = globalThis as unknown as { __aegraphScriptRunner?: { runner: ScriptRunner; store: EntityStore }; __aegraphPython?: PythonEngine; __aegraphView?: ViewEngine }

export function scriptRunner(store: EntityStore, registry: TypeRegistry): ScriptRunner {
  const cur = g.__aegraphScriptRunner
  if (cur && cur.store === store) return cur.runner
  cur?.runner.cancel()
  const runner = new ScriptRunner(snapshotProvider(store, registry))
  g.__aegraphScriptRunner = { runner, store }
  return runner
}

// Python's runtime comes from this origin when it is served here (`npm run pyodide`), else from jsDelivr and PyPI —
// which, like every call to someone else's server, the third-party switch decides.
export const pythonEngine = (): PythonEngine => (g.__aegraphPython ??= new PythonEngine({ beforeCdn: requireExternalServices }))
export const pythonStatus = (): PythonStatus => g.__aegraphPython?.getStatus() ?? { stage: 'idle' }

/** The visual engine is cheap to make: after a hot update the old instance (with the old frame boot script) is replaced, not reused. */
export const viewEngine = (): ViewEngine => {
  if (!(g.__aegraphView instanceof ViewEngine)) {
    ;(g.__aegraphView as ViewEngine | undefined)?.stopAll()
    g.__aegraphView = new ViewEngine()
  }
  return g.__aegraphView
}

/**
 * Run a Visual script into `host`; without a host it runs in a hidden frame that is ended with the run (the assistant
 * checking a script): a frame nobody sees has no business going on drawing — or doing anything else — afterwards.
 */
export async function runView(store: EntityStore, registry: TypeRegistry, code: string, host?: HTMLElement, options: RunOptions & { state?: Record<string, unknown>; onState?: (state: Record<string, unknown>) => void } = {}): Promise<ViewRun> {
  const hidden = !host
  const el = host ?? Object.assign(document.createElement('div'), { style: 'position:fixed;left:-10000px;top:0;width:800px;height:600px;' })
  if (hidden) document.body.appendChild(el)
  let frame: HTMLIFrameElement | undefined
  try {
    const r = await viewEngine().run(el, code, snapshotProvider(store, registry)(), options)
    frame = r.frame
    return r
  } finally {
    if (hidden) {
      if (frame) viewEngine().stop(frame)
      setTimeout(() => el.remove(), 0)
    }
  }
}

/**
 * Run code in the engine its language names. `scriptId` names the saved script the code is (or the draft key): code
 * its owner has not run or saved here (consent.ts) runs `untrusted` — whatever it leaves in an engine is thrown away
 * after it — unless the caller says otherwise.
 */
export function runScript(store: EntityStore, registry: TypeRegistry, code: string, options: RunOptions & { language?: Language; host?: HTMLElement; state?: Record<string, unknown>; onState?: (state: Record<string, unknown>) => void; scriptId?: string } = {}): Promise<RunSummary> {
  // Only the visual engine takes a host and remembered state; the workers get plain options (a function would not survive postMessage).
  const { language, host, state, onState, scriptId, ...plain } = options
  if (plain.untrusted === undefined && scriptId !== undefined) plain.untrusted = !hasConsent(scriptId, code)
  if (language === 'python') return pythonEngine().run(code, snapshotProvider(store, registry)(plain.types), plain)
  if (language === 'view') return runView(store, registry, code, host, { ...plain, state, onState })
  return scriptRunner(store, registry).run(code, plain)
}

export function cancelScript(language?: Language) {
  if (language === 'python') g.__aegraphPython?.reset()
  else if (language === 'view') g.__aegraphView?.stopAll()
  else g.__aegraphScriptRunner?.runner.cancel()
}
