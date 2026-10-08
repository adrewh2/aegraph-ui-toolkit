/* eslint-disable no-undef */
// The Python engine's worker: runs inside the sandboxed iframe (opaque
// origin, CSP-limited network), loads Pyodide and the wheels from
// `indexURL`, and answers { type: 'run' } messages. Plain classic-worker
// JavaScript — it is shipped as text and started from a Blob.
//
// A script runs in this worker's realm, and Python reaches JavaScript through
// `js` (globals, `eval` — Pyodide needs 'unsafe-eval'). So everything that
// decides what the host hears lives inside this function, out of reach of a
// global lookup or a global `eval`: the bootstrap's private MessagePort, which
// is the only channel the bootstrap listens to (a forged `self.postMessage`
// goes nowhere), and the prelude's `_aegraph_load` / `_aegraph_run`, taken
// once at boot and called by reference, never by name.
;(() => {
  const config = self.__aegraphPython
  delete self.__aegraphPython
  /** Characters of result JSON past which a run is refused (limits.ts › MAX_RESULT_CHARS). */
  const MAX_RESULT_CHARS = 64 * 1024 * 1024
  const MAX_LOG_LINES = 2000
  const MAX_LOG_CHARS = 512 * 1024
  let pyodide = null
  let aegraphLoad = null
  let aegraphRun = null
  let loadedKey = null
  let port = null
  const queue = []
  // Taken before any script runs: a script can replace MessagePort.prototype.postMessage or JSON.parse in this realm.
  const apply = Reflect.apply
  const portPost = MessagePort.prototype.postMessage
  const parse = JSON.parse
  const send = (m) => apply(portPost, port, [m])
  const post = (m) => (port ? send(m) : queue.push(m))

  const capLogs = (lines) => {
    const out = []
    let chars = 0
    let dropped = 0
    for (const l of Array.isArray(lines) ? lines : []) {
      const s = String(l)
      if (out.length >= MAX_LOG_LINES || chars + s.length > MAX_LOG_CHARS) dropped++
      else {
        out.push(s)
        chars += s.length
      }
    }
    if (dropped) out.push('… ' + dropped + ' more log line' + (dropped === 1 ? '' : 's') + ' not kept')
    return out
  }

  async function boot() {
    post({ type: 'status', stage: 'runtime' })
    importScripts(config.indexURL + 'pyodide.js')
    pyodide = await loadPyodide({ indexURL: config.indexURL })
    post({ type: 'status', stage: 'packages' })
    await pyodide.loadPackage(['numpy', 'pandas', 'micropip'])
    const micropip = pyodide.pyimport('micropip')
    await micropip.install(config.plotly)
    micropip.destroy()
    pyodide.runPython(config.prelude)
    aegraphLoad = pyodide.globals.get('_aegraph_load')
    aegraphRun = pyodide.globals.get('_aegraph_run')
    post({ type: 'status', stage: 'ready', versions: { python: pyodide.runPython('import sys; sys.version.split()[0]'), pandas: pyodide.runPython('import pandas; pandas.__version__'), numpy: pyodide.runPython('import numpy; numpy.__version__'), plotly: pyodide.runPython('import plotly; plotly.__version__') } })
  }
  const ready = boot().catch((e) => {
    post({ type: 'status', stage: 'failed', message: e && e.message ? e.message : String(e) })
    throw e
  })

  const onRun = async (ev) => {
    const m = ev.data
    if (!m || m.type !== 'run') return
    try {
      await ready
      let snapshot = 0
      if (loadedKey !== m.key) {
        if (m.json === undefined) return post({ type: 'need-snapshot', id: m.id })
        const t0 = performance.now()
        aegraphLoad(m.json)
        loadedKey = m.key
        snapshot = Math.round(performance.now() - t0)
      }
      const t1 = performance.now()
      // Packages imported by the script (matplotlib, scipy, networkx, …) load on first use, from the same origin.
      // The prelude's graph() imports networkx itself, which the import scan of the script cannot see.
      await pyodide.loadPackagesFromImports(m.code + (/\bgraph\s*\(/.test(m.code) ? '\nimport networkx' : ''))
      const out = await aegraphRun(m.code)
      if (typeof out !== 'string') throw new Error('The run did not report a result.')
      if (out.length > MAX_RESULT_CHARS) return post({ type: 'result', id: m.id, result: { value: undefined, logs: [], error: { message: 'The result is too large to show (' + Math.round(out.length / 1048576) + ' MB of JSON): return a summary, or fewer rows or points.' }, ms: { load: 0, run: Math.round(performance.now() - t1), snapshot } } })
      const r = parse(out)
      post({ type: 'result', id: m.id, result: { value: r.value, logs: capLogs(r.logs), error: r.error || undefined, ms: { load: 0, run: Math.round(performance.now() - t1), snapshot } } })
    } catch (e) {
      post({ type: 'error', id: m.id, message: e && e.message ? e.message : String(e) })
    }
  }

  // The first message is the bootstrap's port; after it, this worker listens to nothing else.
  self.onmessage = (ev) => {
    if (port || !ev.data || ev.data.type !== 'port' || !ev.ports || !ev.ports[0]) return
    port = ev.ports[0]
    port.onmessage = onRun
    self.onmessage = null
    for (const m of queue.splice(0)) send(m)
  }
})()
