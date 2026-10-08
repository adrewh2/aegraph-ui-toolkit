import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { publicFetch, stopsAt } from '../publicFetch'
import { sameHost } from '../../../dev/fetch'
import { readResponse } from '../../core/net/webResponse'

let server: Server
let port = 0
let hits = 0

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++
    res.end('secret from the loopback')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('publicFetch — the headless engine reaches only public addresses', () => {
  it('refuses the loopback, written as an address or a name', async () => {
    await expect(publicFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/not a public address/)
    await expect(publicFetch(`http://localhost:${port}/`)).rejects.toThrow(/not a public host/)
    await expect(publicFetch(`http://[::1]:${port}/`)).rejects.toThrow(/not a public address/)
  })

  it('refuses a name that resolves to the loopback, at the connection itself', async () => {
    // A trailing dot passes every check on the name; only the connection's own lookup can refuse it.
    await expect(publicFetch(`http://localhost.:${port}/`)).rejects.toThrow(/resolves to .* not a public address/)
    expect(hits).toBe(0)
  })

  it('refuses metadata and private ranges', async () => {
    await expect(publicFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/not a public address/)
    await expect(publicFetch('http://10.0.0.1/')).rejects.toThrow(/not a public address/)
    await expect(publicFetch('http://192.168.1.1/')).rejects.toThrow(/not a public address/)
  })

  it('only reads, only over http(s), never with credentials', async () => {
    await expect(publicFetch('https://example.com/', { method: 'POST' })).rejects.toThrow(/only reads/)
    await expect(publicFetch('file:///etc/passwd')).rejects.toThrow(/only http/)
    await expect(publicFetch('https://user:pw@example.com/')).rejects.toThrow(/credentials/)
  })
})

describe('publicFetch — which redirects it follows', () => {
  const a = new URL('https://a.example/x')
  const b = new URL('https://b.example/y')
  it('follows by default; answers with the redirect under `manual`, or when `follow` says no (the dev server’s /api/fetch: same host only); fails under `error`', () => {
    expect(stopsAt(undefined, {}, a, b)).toBe('follow')
    expect(stopsAt({ redirect: 'manual' }, {}, a, a)).toBe('answer')
    expect(stopsAt({ redirect: 'error' }, {}, a, a)).toBe('error')
    expect(stopsAt(undefined, { follow: sameHost }, a, b)).toBe('answer')
    expect(stopsAt(undefined, { follow: sameHost }, a, new URL('https://A.example/z'))).toBe('follow')
  })

  it('an answered redirect reads as `redirect`, absolute, with nothing else read', async () => {
    const r = await readResponse(new Response('ignored', { status: 302, headers: { location: '/next?d=1', 'content-type': 'text/html' } }), undefined, 'https://a.example/x')
    expect(r).toMatchObject({ status: 302, redirect: 'https://a.example/next?d=1' })
    expect(r.text).toBeUndefined()
  })
})
