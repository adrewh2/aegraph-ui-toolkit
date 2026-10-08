/**
 * The dev server's own routes (`/api/openai`, `/__local/demos`) answer only
 * this page. Vite already refuses a foreign `Host`, which stops DNS
 * rebinding; this refuses a foreign *page*: any site the developer has open
 * can send the loopback a request it cannot read the answer to, and for
 * `/api/openai` that alone spends the key in `.env.local`. Vite's default
 * CORS also lets any other loopback origin read the answer — another dev
 * server, another local app — so "local" is not enough either: the origin
 * must be this server's.
 *
 * A request with neither `Origin` nor `Sec-Fetch-Site` did not come from a
 * page (curl, a test) and is allowed: anything that can open a loopback
 * socket without a browser already runs as the developer.
 *
 * @param {{ host?: string, origin?: string, 'sec-fetch-site'?: string }} headers
 * @returns {boolean}
 */
export function sameDevOrigin(headers) {
  const site = headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === headers.host
  } catch {
    return false
  }
}

/**
 * Whether the socket's other end is this machine. The dev server's own routes assume that a request with no
 * `Origin` came from something already running as the developer — true on the loopback, false once `vite --host`
 * puts the server on the network, where a machine on the LAN would otherwise spend the key in `.env.local`, use
 * this one as a fetch proxy, or read the local demos. So those routes answer the loopback alone, whatever the
 * server listens on.
 *
 * @param {string | undefined} address `req.socket.remoteAddress`
 * @returns {boolean}
 */
export function isLoopbackPeer(address) {
  if (!address) return false
  const a = address.startsWith('::ffff:') ? address.slice(7) : address
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

/**
 * Which of the dev server's own handlers (`dev/`) a request is for, served ungated for this page:
 * `/api/openai/…` (voice, with the key in `.env.local` — `dev/openai.ts`) and `/api/fetch` (the `web_fetch` tool's
 * reader — `dev/fetch.ts`). The path is matched exactly — any case
 * but this one, an extension (`/api/fetch.pdf`), an encoded letter is not the route — so a URL from data that
 * merely looks like it never reaches it. And it answers only a `fetch` from this page: not an image, a frame, a
 * navigation or a stylesheet (`Sec-Fetch-Dest` other than `empty`), which is what a Markdown image or a PDF
 * address written as `/api/fetch?url=…` would be; `/api/fetch` takes its address from the `x-fetch-url` header
 * the tab's own call sends (`features/assistant/webTools.ts`), which no image or frame can carry.
 *
 * Returns `null` when the request is not for one of them (the dev server goes on), the module that serves it, or
 * why it is refused.
 *
 * @param {string | undefined} url the request's URL as the server got it (path and query)
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {null | { module: string } | { refused: string }}
 */
export function localApiRoute(url, headers) {
  const path = (url ?? '/').split(/[?#]/)[0]
  const name = path === '/api/fetch' ? '/api/fetch' : path === '/api/openai' || path.startsWith('/api/openai/') ? '/api/openai' : null
  if (!name) return null
  const module = name === '/api/fetch' ? '/dev/fetch.ts' : '/dev/openai.ts'
  if (!sameDevOrigin(headers)) return { refused: `only this page may use the local ${name}` }
  const dest = headers['sec-fetch-dest']
  if (dest && dest !== 'empty') return { refused: `the local ${name} answers a fetch from this page, not ${/^[a-z]+$/.test(String(dest)) ? `an ${dest}` : 'this'} request` }
  if (name === '/api/fetch' && !headers['x-fetch-url']) return { refused: 'the local /api/fetch takes its address in an x-fetch-url header' }
  return { module }
}
