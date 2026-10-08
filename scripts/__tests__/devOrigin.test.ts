import { describe, expect, it } from 'vitest'
import { isLoopbackPeer, localApiRoute, sameDevOrigin } from '../devOrigin.mjs'

const host = '127.0.0.1:5199'

describe('sameDevOrigin', () => {
  it('lets the app itself through', () => {
    expect(sameDevOrigin({ host, origin: 'http://127.0.0.1:5199', 'sec-fetch-site': 'same-origin' })).toBe(true)
    expect(sameDevOrigin({ host, 'sec-fetch-site': 'same-origin' })).toBe(true)
  })

  it('lets a request that no page made through', () => {
    expect(sameDevOrigin({ host })).toBe(true)
    expect(sameDevOrigin({ host, 'sec-fetch-site': 'none' })).toBe(true)
  })

  it('refuses another site, even a blind no-cors post', () => {
    expect(sameDevOrigin({ host, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).toBe(false)
    expect(sameDevOrigin({ host, 'sec-fetch-site': 'cross-site' })).toBe(false)
    expect(sameDevOrigin({ host, origin: 'https://evil.example' })).toBe(false)
  })

  it('refuses another server on the loopback', () => {
    expect(sameDevOrigin({ host, origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-site' })).toBe(false)
    expect(sameDevOrigin({ host, origin: 'http://localhost:5199', 'sec-fetch-site': 'same-site' })).toBe(false)
  })

  it('refuses an origin it cannot read', () => {
    expect(sameDevOrigin({ host, origin: 'null' })).toBe(false)
  })
})

describe('localApiRoute — what the dev server serves ungated, and to whom', () => {
  const page = { host, origin: 'http://127.0.0.1:5199', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }

  it('serves the tab’s own fetch: /api/fetch with its x-fetch-url header, /api/openai/…', () => {
    expect(localApiRoute('/api/fetch', { ...page, 'x-fetch-url': 'https://example.com/' })).toEqual({ module: '/dev/fetch.ts' })
    expect(localApiRoute('/api/openai/v1/audio/speech', page)).toEqual({ module: '/dev/openai.ts' })
    // curl, a test: no page made it.
    expect(localApiRoute('/api/fetch', { host, 'x-fetch-url': 'https://example.com/' })).toEqual({ module: '/dev/fetch.ts' })
  })

  it('refuses an image, a frame or a navigation — what a URL written into data would be', () => {
    for (const dest of ['image', 'iframe', 'document', 'style', 'embed', 'object']) {
      const r = localApiRoute('/api/fetch?url=https://evil.example/?d=secret', { ...page, 'sec-fetch-dest': dest })
      expect(r && 'refused' in r, dest).toBe(true)
    }
    expect(localApiRoute('/api/openai/v1/audio/speech', { ...page, 'sec-fetch-dest': 'audio' })).toMatchObject({ refused: expect.any(String) })
  })

  it('refuses /api/fetch without the header the tab sends: a query string alone is what an image or a link can carry', () => {
    expect(localApiRoute('/api/fetch?url=https://evil.example/', page)).toMatchObject({ refused: expect.stringContaining('x-fetch-url') })
  })

  it('matches the path exactly: another case, an extension or an encoded letter is not the route', () => {
    for (const url of ['/API/FETCH?url=x', '/api/fetch.pdf?url=x', '/api/%66etch?url=x', '/api/fetchx', '/api/openaix', '/x/api/fetch']) expect(localApiRoute(url, { ...page, 'x-fetch-url': 'x' }), url).toBeNull()
  })

  it('still refuses another site', () => {
    expect(localApiRoute('/api/fetch', { host, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty', 'x-fetch-url': 'x' })).toMatchObject({ refused: expect.any(String) })
  })
})

describe('isLoopbackPeer', () => {
  it('answers this machine alone, however the server listens (`vite --host` puts it on the LAN)', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopbackPeer(a), a).toBe(true)
    for (const a of ['192.168.1.50', '10.0.0.2', '::ffff:192.168.1.50', 'fe80::1', '0.0.0.0', '128.0.0.1', '127.0.0.1.evil', '', undefined]) expect(isLoopbackPeer(a), String(a)).toBe(false)
  })
})
