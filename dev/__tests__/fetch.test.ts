import { describe, expect, it } from 'vitest'
import { handle, sameHost } from '../fetch'

/**
 * The dev server's fetcher refuses before it reaches anything: the method, the scheme, and an address that is this
 * machine or its network (publicFetch, which the headless engine uses too — its lookup is tested with the bridge's
 * in mcp/security.test.mjs). Which requests reach it at all is `scripts/devOrigin.mjs › localApiRoute`'s, tested
 * in scripts/__tests__/devOrigin.test.ts.
 */
const get = (url: string, init?: RequestInit) => new Request('http://127.0.0.1:5199/api/fetch', { ...init, headers: { 'x-fetch-url': url } })

describe('/api/fetch', () => {
  it('reads over GET only', async () => {
    expect((await handle(get('https://example.com/', { method: 'POST', body: 'x' }))).status).toBe(405)
  })

  it('takes its address from the x-fetch-url header only, never the query', async () => {
    const res = await handle(new Request(`http://127.0.0.1:5199/api/fetch?url=${encodeURIComponent('https://example.com/')}`))
    expect(res.status).toBe(400)
  })

  it('fetches http(s) only, and never this machine or its network', async () => {
    expect((await handle(get('file:///etc/passwd'))).status).toBe(400)
    expect((await handle(get('not a url'))).status).toBe(400)
    for (const u of ['http://127.0.0.1:5199/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost/', 'http://10.0.0.1/']) {
      const res = await handle(get(u))
      expect(res.status, u).toBe(502)
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/not a public/)
    }
  })
})

describe('/api/fetch redirects', () => {
  it('follows one on the same host and scheme, never from https down to http', () => {
    expect(sameHost(new URL('https://site.example/a'), new URL('https://site.example/b'))).toBe(true)
    expect(sameHost(new URL('https://site.example/a'), new URL('http://site.example/a'))).toBe(false)
    expect(sameHost(new URL('https://site.example/a'), new URL('https://other.example/a'))).toBe(false)
  })
  it('reads the address from the header', async () => {
    const res = await handle(get('http://127.0.0.1/'))
    // The loopback is refused — which shows the header was read as the address.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await res.text()).not.toMatch(/url must be an absolute/)
  })
})
