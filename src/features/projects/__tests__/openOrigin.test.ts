import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundleOrigin } from '../projectActions'

/**
 * `/open?url=…` is a link anyone can send. A bundle from this site is what the
 * app's own links and demos point at; one from anywhere else becomes the
 * reader's workspace on someone else's say-so, so the route asks first, and a
 * URL that is not http(s) is refused outright.
 */
afterEach(() => vi.unstubAllGlobals())
const at = (href: string) => vi.stubGlobal('location', { href, origin: new URL(href).origin })

describe('where a bundle URL points', () => {
  it('this site — a path or an absolute URL on this origin — opens without asking', () => {
    at('https://aegraph.dev/open?url=x')
    for (const url of ['/datasets/example.ae.json', 'datasets/example.ae.json', 'https://aegraph.dev/demos/x/bundle.aeb']) {
      expect(bundleOrigin(url), url).toEqual({ kind: 'own' })
    }
  })

  it('another site is named, so the route can ask before it fetches', () => {
    at('https://aegraph.dev/open?url=x')
    expect(bundleOrigin('https://files.example.com/p.ae.json')).toEqual({ kind: 'elsewhere', host: 'files.example.com' })
    // A lookalike host is another site, and so is a different port or scheme on this host.
    expect(bundleOrigin('https://aegraph.dev.evil.com/p.ae.json')).toEqual({ kind: 'elsewhere', host: 'aegraph.dev.evil.com' })
    expect(bundleOrigin('http://aegraph.dev/p.ae.json')).toEqual({ kind: 'elsewhere', host: 'aegraph.dev' })
  })

  it('a dev server treats its own origin as its own, port and all', () => {
    at('http://localhost:5173/open')
    expect(bundleOrigin('http://localhost:5173/datasets/x.ae.json')).toEqual({ kind: 'own' })
    expect(bundleOrigin('http://localhost:4173/datasets/x.ae.json')).toEqual({ kind: 'elsewhere', host: 'localhost:4173' })
  })

  it('refuses anything that is not fetched over http', () => {
    at('https://aegraph.dev/open')
    for (const url of ['javascript:alert(1)', 'data:application/json,{}', 'file:///etc/passwd', 'blob:https://aegraph.dev/abc']) {
      expect(bundleOrigin(url).kind, url).toBe('refused')
    }
    // Anything that is not a URL at all resolves against this origin, which makes it ours — a path that will 404, not a risk.
    expect(bundleOrigin('not a url at all')).toEqual({ kind: 'own' })
  })
})
