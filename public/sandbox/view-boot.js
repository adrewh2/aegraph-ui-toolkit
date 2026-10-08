/**
 * The Visual sandbox's bootstrap, as a file rather than inline script.
 *
 * It is loaded by `<script src>` from this origin into the sandboxed frame
 * (`engine.ts`). That is not a style choice: the frame inherits the app's
 * Content-Security-Policy and cannot widen it, so an inline bootstrap is
 * refused the moment the app enforces a `script-src` — and so is the user's
 * code if it goes in as inline text. Both become `blob:` scripts here, which
 * the policy does allow.
 *
 * Vite emits this file as an asset (`?url`), so it is never bundled or
 * transformed: plain ES2020, no imports, no TypeScript.
 *
 * The conversation with the parent:
 *   → ready                     this file has run
 *   ← run { json, prelude, code, state, libs }
 *   → log | error | result | state | done
 */
;(() => {
  // Channels the frame's Content-Security-Policy does not govern, taken away before any script of the user's runs:
  // a peer connection's STUN/TURN traffic goes to whatever server it names, and DNS hints resolve whatever host they
  // name. Defence in depth, not a wall — a frame the script creates has its own constructors — which is why a Visual
  // script never runs unless its owner presses Run (features/scripts/consent.ts).
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport', 'RTCCertificate']) {
    try {
      Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false })
    } catch {
      /* not defined here */
    }
  }
  // A <link> that is not a stylesheet (dns-prefetch, preconnect, prefetch, prerender) is removed as it arrives.
  try {
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) {
          const links = n.nodeType === 1 ? (n.tagName === 'LINK' ? [n] : n.querySelectorAll ? [...n.querySelectorAll('link')] : []) : []
          for (const l of links) if (!/^\s*stylesheet\s*$/i.test(l.getAttribute('rel') || '')) l.remove()
        }
    }).observe(document.documentElement, { childList: true, subtree: true })
  } catch {
    /* no observer */
  }
  const post = (m) => parent.postMessage(m, '*')
  const fmt = (a) => {
    if (typeof a === 'string') return a
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  }
  for (const k of ['log', 'info', 'warn', 'error']) {
    const orig = console[k].bind(console)
    console[k] = (...a) => {
      post({ type: 'log', line: a.map(fmt).join(' ') })
      orig(...a)
    }
  }
  window.addEventListener('error', (e) => post({ type: 'error', message: e.message, stack: e.error && e.error.stack }))
  window.addEventListener('unhandledrejection', (e) => post({ type: 'error', message: (e.reason && e.reason.message) || String(e.reason), stack: e.reason && e.reason.stack }))

  /**
   * A script element from a blob URL: the only way to add script under an inherited policy that forbids inline.
   * `what` names the step, because a module that fails to load reports nothing else — an import of a library
   * that is not there, or is served without CORS to this opaque origin, arrives here as a bare load error.
   */
  const addScript = (source, type, what) =>
    new Promise((resolve, reject) => {
      const s = document.createElement('script')
      if (type) s.type = type
      s.src = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      s.onload = () => resolve()
      s.onerror = () => reject(new Error(`${what} could not be loaded. If it imports a library, check that it is served from this origin and reachable.`))
      document.body.appendChild(s)
    })

  let libs = {}
  const loaded = {}
  let state = {}
  let stateTimer = 0
  const flush = () => {
    clearTimeout(stateTimer)
    stateTimer = 0
    post({ type: 'state', state })
  }
  window.__aegraphFlush = () => {
    if (stateTimer) flush()
  }
  window.aegraph = {
    result: (v) => post({ type: 'result', value: v }),
    width: () => innerWidth,
    height: () => innerHeight,
    recall: (key, fallback) => (key in state ? state[key] : fallback),
    remember: (key, value) => {
      state[key] = value
      if (!stateTimer) stateTimer = setTimeout(flush, 250)
    },
    // d3 and Plotly are classic scripts from this origin, which the policy allows by URL.
    load: (name) =>
      (loaded[name] ??= new Promise((res, rej) => {
        const url = libs[name]
        if (!url) return rej(new Error('unknown library ' + name))
        const s = document.createElement('script')
        s.src = url
        s.onload = () => res(name === 'd3' ? window.d3 : window.Plotly)
        s.onerror = () => rej(new Error('could not load ' + name))
        document.head.appendChild(s)
      })),
  }

  window.addEventListener('message', (e) => {
    if (e.source !== parent) return
    const m = e.data
    if (!m || m.type !== 'run') return
    libs = m.libs || {}
    globalThis.ds = JSON.parse(m.json)
    state = m.state && typeof m.state === 'object' ? m.state : {}
    // The prelude is a classic script so its top-level bindings become globals the module can see;
    // the code is a module. Both from blobs, in that order.
    addScript(m.prelude, '', 'the prelude')
      .then(() => addScript(m.code + '\n;window.__aegraphFlush(); parent.postMessage({ type: "done" }, "*");', 'module', 'the script'))
      .catch((err) => post({ type: 'error', message: (err && err.message) || String(err) }))
  })

  post({ type: 'ready' })
})()
