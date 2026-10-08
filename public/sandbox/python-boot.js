/**
 * The Python sandbox's bootstrap, as a file rather than inline script.
 *
 * Loaded by `<script src>` from this origin into the sandboxed frame
 * (`engine.ts`), for the same reason as the Visual one: the frame inherits the
 * app's Content-Security-Policy and cannot widen it, so an inline bootstrap
 * stops running as soon as the app enforces a `script-src`. The worker's source
 * was baked into that inline script; it is posted in now.
 *
 * Vite emits this as an asset (`?url`): plain ES2020, no imports, no
 * TypeScript.
 *
 * The conversation with the parent:
 *   → boot-ready            this file has run and wants the worker's source
 *   ← init { source }
 *   ← reset                 throw the worker away and start another
 *   ↔ everything else is relayed between the parent and the worker
 *
 * With the worker, everything goes over a MessageChannel whose far end is the
 * worker's first message: a script runs in the worker's realm and can call its
 * `postMessage`, so what arrives on the worker's own channel is not relayed —
 * only what the worker's code sends on the port it keeps out of the script's
 * reach.
 */
;(() => {
  const post = (m) => parent.postMessage(m, '*')
  const fail = (message) => post({ type: 'status', stage: 'failed', message })
  let worker = null
  let channel = null
  let source = null

  window.onerror = (m) => fail('sandbox: ' + m)

  const start = () => {
    if (source === null) return fail('the sandbox was asked to start before it had the runtime')
    try {
      worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
    } catch (e) {
      return fail('cannot start a worker in the sandbox: ' + ((e && e.message) || e))
    }
    channel = new MessageChannel()
    const mine = channel
    channel.port1.onmessage = (e) => {
      if (channel === mine) post(e.data)
    }
    worker.postMessage({ type: 'port' }, [channel.port2])
    // The worker's own channel is the script's to write to: nothing on it is relayed.
    worker.onmessage = null
    worker.onerror = (e) => fail((e && e.message) || 'worker error')
  }

  window.addEventListener('message', (e) => {
    if (e.source !== parent) return
    const m = e.data
    if (!m) return
    if (m.type === 'init') {
      source = m.source
      start()
      return
    }
    if (m.type === 'reset') {
      if (worker) worker.terminate()
      if (channel) channel.port1.close()
      channel = null
      start()
      post({ type: 'reset-done' })
      return
    }
    if (channel) channel.port1.postMessage(m)
  })

  post({ type: 'boot-ready' })
})()
