import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { isPublicAddress, publicLookup } from '../../mcp/publicUrl.mjs'

/**
 * The headless engine's `fetch`: public addresses only.
 *
 * In a tab, a URL a tool was handed is fetched by the browser, which keeps a
 * page off the loopback and the office network. In Node nothing does: a
 * bundle that names `http://169.254.169.254/…` or `http://intranet/…` would be
 * fetched from the developer's machine and its answer read back into the
 * workspace. `core/net/url.ts` refuses such a URL when it is written as an
 * address; a *name* that resolves to one needs the lookup, and the lookup has
 * to be the connection's own — checked separately, a name can answer one way
 * for the check and another for the connect (DNS rebinding).
 *
 * So `installPublicFetch` replaces `globalThis.fetch` in the engine's process
 * with one that connects only through `publicLookup` (every address a name
 * resolves to must be public — `mcp/publicUrl.mjs`),
 * follows redirects by hand with every hop checked, caps the body and times
 * out. GET and HEAD only: nothing the engine does posts anywhere.
 *
 * The dev server's `/api/fetch` (`dev/fetch.ts`, the `web_fetch` tool's way to a page the browser may not read) is the same function with
 * three options: `truncate` keeps the first `maxBytes` rather than failing, `readBody` leaves the body of what it
 * would not read (a binary file) unread, and `headers` names the client.
 */
export const MAX_FETCH_BYTES = 256 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 5

function problem(u: URL): string | null {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `only http(s) is fetched, not ${u.protocol}`
  if (u.username || u.password) return 'a URL with credentials is not fetched'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host) && !isPublicAddress(host)) return `${host} is not a public address`
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) return `${host} is not a public host`
  return null
}

interface Hop {
  status: number
  headers: Headers
  body?: Buffer
  redirect?: string
  truncated?: boolean
}

export interface PublicFetchOptions {
  maxBytes?: number
  timeoutMs?: number
  /** Past `maxBytes`, stop reading and answer with what was read (the response carries `x-aegraph-truncated: 1`). */
  truncate?: boolean
  /** Whether to read the body at all, given the content type; unread, the response has none. */
  readBody?: (contentType: string) => boolean
  /** Request headers (the client's name, what it accepts). */
  headers?: Record<string, string>
  /**
   * Whether to follow a redirect from one address to the next (default: yes). Not followed, the redirect is the
   * answer: its status, with `location` absolute. `/api/fetch` follows a redirect on the same host only, so a host
   * the user never agreed to is not reached behind their back — the tab asks about it first.
   */
  follow?: (from: URL, to: URL) => boolean
}

/** Whether a redirect ends the fetch: `redirect: 'manual'` (as a browser's fetch would, but readable), `'error'`, or `follow` saying no. */
export function stopsAt(init: RequestInit | undefined, opts: PublicFetchOptions, from: URL, to: URL): 'follow' | 'answer' | 'error' {
  if (init?.redirect === 'error') return 'error'
  if (init?.redirect === 'manual') return 'answer'
  return opts.follow && !opts.follow(from, to) ? 'answer' : 'follow'
}

function once(u: URL, method: string, signal: AbortSignal, maxBytes: number, opts: PublicFetchOptions = {}): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const get = u.protocol === 'https:' ? https.request : http.request
    const req = get(u, { method, lookup: publicLookup, signal, headers: opts.headers }, (res) => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v)
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        return resolve({ status, headers, redirect: new URL(res.headers.location, u).href })
      }
      if (opts.readBody && !opts.readBody(String(res.headers['content-type'] ?? ''))) {
        res.destroy()
        return resolve({ status, headers })
      }
      if (!opts.truncate && Number(res.headers['content-length']) > maxBytes) {
        res.destroy()
        return reject(new Error(`${u.host}: larger than ${maxBytes} bytes`))
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size <= maxBytes) return void chunks.push(c)
        res.destroy()
        if (!opts.truncate) return reject(new Error(`${u.host}: larger than ${maxBytes} bytes`))
        chunks.push(c.subarray(0, c.length - (size - maxBytes)))
        resolve({ status, headers, body: Buffer.concat(chunks), truncated: true })
      })
      res.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

/** A `fetch` that reaches only public addresses (see above). */
export async function publicFetch(input: string | URL | Request, init?: RequestInit, opts: PublicFetchOptions = {}): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') throw new TypeError(`the headless engine only reads from the network (${method} refused)`)
  const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS)
  let at = new URL(input instanceof Request ? input.url : String(input))
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const why = problem(at)
    if (why) throw new TypeError(`Not fetched: ${why}.`)
    const r = await once(at, method, signal, opts.maxBytes ?? MAX_FETCH_BYTES, opts)
    if (r.redirect) {
      const next = new URL(r.redirect)
      const stop = stopsAt(init, opts, at, next)
      if (stop === 'error') throw new TypeError(`Not fetched: ${at.href} redirects to ${next.href}.`)
      if (stop === 'answer') {
        r.headers.set('location', next.href)
        const res = new Response(null, { status: r.status, headers: r.headers })
        Object.defineProperty(res, 'url', { value: at.href })
        return res
      }
      at = next
      continue
    }
    if (r.truncated) r.headers.set('x-aegraph-truncated', '1')
    const res = new Response(method === 'HEAD' || r.status === 204 || r.status === 304 || !r.body ? null : new Uint8Array(r.body), { status: r.status, headers: r.headers })
    Object.defineProperty(res, 'url', { value: at.href })
    return res
  }
  throw new TypeError(`Not fetched: more than ${MAX_REDIRECTS} redirects.`)
}

/** Make `publicFetch` the process's `fetch`. The headless server calls this before any tool can run. */
export function installPublicFetch(): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => publicFetch(input, init)) as typeof fetch
}
