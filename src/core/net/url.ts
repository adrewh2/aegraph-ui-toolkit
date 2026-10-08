/**
 * Where a URL from data or from a tool call would take a request. A URL a
 * tool is handed — by the model, by a bundle, by a document it read — is
 * not the user's choice, so what may be fetched is decided here, once, for
 * every caller:
 *
 * - `own`: this page's origin — the app's datasets, templates, local demos.
 * - `elsewhere`: someone else's server. The caller asks first and honours
 *   the Third-party services switch.
 * - `refused`: not http(s), or a private address with no page to be on.
 *
 * With no page (the headless engine in Node) there is no same-origin policy
 * and no CORS, so a fetch reaches whatever the machine can: loopback
 * services, the local network, a cloud's metadata endpoint. There a URL
 * whose host is written as a loopback, private, link-local or unique-local
 * address, or `localhost`, is refused. A name that *resolves* to one is caught
 * by the headless server's own `fetch` (`src/headless/publicFetch.ts`), in
 * the connection's lookup, where a rebinding name cannot answer twice.
 */
export type UrlVerdict = { kind: 'own'; url: URL } | { kind: 'elsewhere'; url: URL; host: string } | { kind: 'refused'; why: string }

const pageOrigin = () => (typeof location !== 'undefined' && location.origin && location.origin !== 'null' ? location : undefined)

export function classifyUrl(raw: string, what = 'That'): UrlVerdict {
  const page = pageOrigin()
  let u: URL
  try {
    u = new URL(raw, page?.href ?? undefined)
  } catch {
    return { kind: 'refused', why: `${what} is not a URL: ${JSON.stringify(raw.slice(0, 200))}.` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'refused', why: `${what} is fetched over http or https, not ${u.protocol.replace(':', '')}.` }
  if (u.username || u.password) return { kind: 'refused', why: `${what} carries a user name or password in the URL; that is refused.` }
  if (page && u.origin === page.origin) {
    // The app's own functions are never a handed URL's to call: `/api/fetch` reads any address on the page's behalf
    // (ungated on the dev server), so a URL through it would reach any host with no question asked and the
    // third-party switch off — a way out for whatever a prompt-injected model wanted to send. The app calls its
    // functions itself; a model, a bundle or a page it read does not get to.
    if (/^\/api(\/|$)/i.test(safeDecode(u.pathname))) return { kind: 'refused', why: `${what} is one of this site's own functions (${u.pathname}), which a URL handed to a tool may not call.` }
    return { kind: 'own', url: u }
  }
  if (!page && isPrivateHost(u.hostname)) return { kind: 'refused', why: `${u.host} is this machine or its local network; with no page to be on, that is refused.` }
  return { kind: 'elsewhere', url: u, host: u.host }
}

const safeDecode = (p: string) => {
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}
/** A host written as loopback, private (RFC 1918), link-local (incl. cloud metadata), CGNAT, unique-local or unspecified — or `localhost`. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const v4 = ipv4(h)
  if (v4) return privateV4(v4)
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true
    const mapped = /^::ffff:(.+)$/.exec(h)
    if (mapped) {
      const inner = ipv4(mapped[1]) ?? hexV4(mapped[1])
      return inner ? privateV4(inner) : true
    }
    return /^(fc|fd|fe[89ab])/.test(h)
  }
  return false
}

/** Dotted IPv4, and the forms `new URL` would already have normalised it from; undefined for a name. */
function ipv4(h: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return undefined
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n <= 255) ? parts : undefined
}

function hexV4(h: string): number[] | undefined {
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (!m) return undefined
  const a = parseInt(m[1], 16)
  const b = parseInt(m[2], 16)
  return [a >> 8, a & 255, b >> 8, b & 255]
}

function privateV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}
