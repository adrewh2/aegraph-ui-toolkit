import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Spotify sign-in at its edges, with storage, location and fetch stubbed
 * — no network call, no real credential: the redirect uri on an origin with a
 * port and without, a client id with spaces or empty, the PKCE verifier and
 * challenge (length, alphabet, no padding) and the scopes actually asked for,
 * a callback carrying an error, no code, no pending login (a reload), a state
 * that does not match, a token endpoint that refuses; then a token that is
 * fresh, one about to expire, one with no refresh token, a refresh refused
 * (the stored tokens must go, not linger), two callers sharing one refresh,
 * and a browser whose storage throws.
 */
type Store = Record<string, string>
const store = (init: Store = {}) => {
  const m = new Map(Object.entries(init))
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}
const CLIENT_KEY = 'aegraph:spotify:client-id'
const AUTH_KEY = 'aegraph:spotify:auth'
const PKCE_KEY = 'aegraph:spotify:pkce'
const g = globalThis as Record<string, unknown>

let local: ReturnType<typeof store>
let session: ReturnType<typeof store>
let assigned: string[]
let fetchMock: ReturnType<typeof vi.fn>

/** A fresh module over fresh stubs: the module keeps a parsed-auth cache and an in-flight refresh. */
async function load(opts: { origin?: string; path?: string; auth?: unknown; pkce?: unknown } = {}) {
  vi.resetModules()
  local = store()
  session = store()
  assigned = []
  if (opts.auth !== undefined) local.setItem(AUTH_KEY, JSON.stringify(opts.auth))
  if (opts.pkce !== undefined) session.setItem(PKCE_KEY, JSON.stringify(opts.pkce))
  g.localStorage = local
  g.sessionStorage = session
  g.location = { origin: opts.origin ?? 'http://127.0.0.1:5199', pathname: opts.path ?? '/datasets', search: '', assign: (u: string) => void assigned.push(u) }
  fetchMock = vi.fn()
  g.fetch = fetchMock
  return await import('../auth')
}
const tokenReply = (body: Record<string, unknown>, ok = true, status = 200) => ({ ok, status, statusText: ok ? 'OK' : 'Bad Request', json: async () => body })

beforeEach(() => {
  vi.useRealTimers()
})
afterEach(() => {
  delete g.localStorage
  delete g.sessionStorage
  delete g.location
  delete g.fetch
})

describe('spotify sign-in edges', () => {
  it('builds the redirect uri from the origin as it is — port or no port — and that is what the app registers', async () => {
    let m = await load({ origin: 'http://127.0.0.1:5199' })
    expect(m.spotifyRedirectUri()).toBe('http://127.0.0.1:5199/spotify/callback')
    m = await load({ origin: 'https://aegraph.dev' })
    expect(m.spotifyRedirectUri()).toBe('https://aegraph.dev/spotify/callback')
    m = await load({ origin: 'http://localhost:5199' })
    expect(m.spotifyRedirectUri()).toBe('http://localhost:5199/spotify/callback') // Spotify refuses this one; the app does not pretend otherwise
    expect(m.CALLBACK_PATH).toBe('/spotify/callback')
  })

  it('keeps a client id trimmed, forgets an empty one, and reads nothing as an empty string', async () => {
    const m = await load()
    expect(m.getClientId()).toBe('')
    m.setClientId('  abc123  ')
    expect(local.getItem(CLIENT_KEY)).toBe('abc123')
    expect(m.getClientId()).toBe('abc123')
    m.setClientId('   ')
    expect(local.getItem(CLIENT_KEY)).toBeNull()
    expect(m.getClientId()).toBe('')
  })

  it('a login: a 64-character verifier of unreserved characters, a padding-free base64url challenge, every scope, and the state and the way back remembered', async () => {
    const m = await load({ path: '/datasets' })
    await expect(m.beginSpotifyLogin('   ')).rejects.toThrow(/Client ID is needed/)
    expect(assigned).toEqual([])
    await m.beginSpotifyLogin('  my-client  ')
    expect(m.getClientId()).toBe('my-client')
    const pending = JSON.parse(session.getItem(PKCE_KEY)!) as { verifier: string; state: string; clientId: string; back: string }
    expect(pending.verifier).toHaveLength(64)
    expect(pending.verifier).toMatch(/^[A-Za-z0-9\-._~]{64}$/)
    expect(pending.state).toMatch(/^[A-Za-z0-9\-._~]{16}$/)
    expect(pending.clientId).toBe('my-client')
    expect(pending.back).toBe('/datasets')
    expect(assigned).toHaveLength(1)
    const url = new URL(assigned[0])
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('my-client')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5199/spotify/callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(pending.state)
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(m.SCOPES)
    const challenge = url.searchParams.get('code_challenge')!
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/) // SHA-256, base64url, no padding
    expect(challenge).not.toContain('=')
    // Two logins never reuse a verifier.
    await m.beginSpotifyLogin('my-client')
    expect((JSON.parse(session.getItem(PKCE_KEY)!) as { verifier: string }).verifier).not.toBe(pending.verifier)
  })

  it('a callback that refuses, carries no code, finds no login in progress, or whose state moved: no tokens are stored', async () => {
    const pkce = { verifier: 'v', state: 's', clientId: 'c', back: '/datasets' }
    for (const [params, message] of [
      ['error=access_denied', /access was declined/],
      ['error=server_error', /Spotify: server_error/],
      ['state=s', /No code came back/],
    ] as const) {
      const m = await load({ pkce })
      await expect(m.completeSpotifyLogin(new URLSearchParams(params))).rejects.toThrow(message)
      expect(local.getItem(AUTH_KEY)).toBeNull()
      expect(session.getItem(PKCE_KEY)).toBeNull() // the pending login is spent either way: a retry starts over
    }
    let m = await load() // a reload of the callback: nothing pending
    await expect(m.completeSpotifyLogin(new URLSearchParams('code=abc&state=s'))).rejects.toThrow(/No sign-in was in progress/)
    m = await load({ pkce })
    await expect(m.completeSpotifyLogin(new URLSearchParams('code=abc&state=other'))).rejects.toThrow(/state did not match/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(local.getItem(AUTH_KEY)).toBeNull()
  })

  it('a good callback stores the tokens and says where to go back to; the callback itself is never the way back; a refusal from the token endpoint is reported as Spotify put it', async () => {
    const m = await load({ pkce: { verifier: 'ver', state: 's', clientId: 'cid', back: '/resources/audio' } })
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'user-library-read' }))
    const r = await m.completeSpotifyLogin(new URLSearchParams('code=abc&state=s'))
    expect(r).toEqual({ back: '/resources/audio' })
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: URLSearchParams }]
    expect(url).toBe('https://accounts.spotify.com/api/token')
    expect(Object.fromEntries(init.body)).toEqual({ grant_type: 'authorization_code', code: 'abc', redirect_uri: 'http://127.0.0.1:5199/spotify/callback', client_id: 'cid', code_verifier: 'ver' })
    const saved = JSON.parse(local.getItem(AUTH_KEY)!) as { clientId: string; accessToken: string; refreshToken: string; expiresAt: number; scope: string }
    expect(saved).toMatchObject({ clientId: 'cid', accessToken: 'at', refreshToken: 'rt', scope: 'user-library-read' })
    expect(saved.expiresAt).toBeGreaterThan(Date.now() + 3_500_000)
    expect(m.getSpotifyAuth()?.accessToken).toBe('at')
    // Landing on the callback again must not send the user back to the callback.
    const m2 = await load({ pkce: { verifier: 'v', state: 's', clientId: 'c', back: '/spotify/callback?code=x' } })
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'at2', expires_in: 10 }))
    expect(await m2.completeSpotifyLogin(new URLSearchParams('code=abc&state=s'))).toEqual({ back: '/datasets' })
    const m3 = await load({ pkce: { verifier: 'v', state: 's', clientId: 'c' } })
    fetchMock.mockResolvedValueOnce(tokenReply({ error: 'invalid_grant', error_description: 'Invalid authorization code' }, false, 400))
    await expect(m3.completeSpotifyLogin(new URLSearchParams('code=abc&state=s'))).rejects.toThrow('Invalid authorization code')
    expect(local.getItem(AUTH_KEY)).toBeNull()
  })

  it('a token with a minute left is used as it is; one about to expire is refreshed and the refresh token kept when none comes back', async () => {
    const m = await load({ auth: { clientId: 'c', accessToken: 'fresh', refreshToken: 'rt', expiresAt: Date.now() + 120_000 } })
    expect(await m.spotifyAccessToken()).toBe('fresh')
    expect(fetchMock).not.toHaveBeenCalled()
    const m2 = await load({ auth: { clientId: 'c', accessToken: 'stale', refreshToken: 'rt', expiresAt: Date.now() + 30_000 } })
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'new', expires_in: 3600 }))
    expect(await m2.spotifyAccessToken()).toBe('new')
    const body = Object.fromEntries((fetchMock.mock.calls[0] as [string, { body: URLSearchParams }])[1].body)
    expect(body).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'c' })
    const saved = JSON.parse(local.getItem(AUTH_KEY)!) as { refreshToken: string; accessToken: string }
    expect(saved.accessToken).toBe('new')
    expect(saved.refreshToken).toBe('rt') // Spotify does not always send a new one; the old one must survive
  })

  it('no refresh token, or a refresh Spotify refuses: the stored sign-in is cleared rather than left to fail again, and listeners hear it', async () => {
    const m = await load({ auth: { clientId: 'c', accessToken: 'old', expiresAt: Date.now() - 1 } })
    const heard: number[] = []
    const off = m.onSpotifyAuthChange(() => heard.push(1))
    await expect(m.spotifyAccessToken()).rejects.toThrow(/session expired/)
    expect(local.getItem(AUTH_KEY)).toBeNull()
    expect(m.getSpotifyAuth()).toBeNull()
    expect(heard).toHaveLength(1)
    off()
    const m2 = await load({ auth: { clientId: 'c', accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() - 1 } })
    fetchMock.mockResolvedValueOnce(tokenReply({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, false, 400))
    await expect(m2.spotifyAccessToken()).rejects.toThrow('Refresh token revoked')
    expect(local.getItem(AUTH_KEY)).toBeNull()
    // And it can be tried again afterwards without the previous failure sticking.
    await expect(m2.spotifyAccessToken()).rejects.toThrow(/Not signed in/)
  })

  it('two callers at once share one refresh, and signing out clears everything but the client id', async () => {
    const m = await load({ auth: { clientId: 'c', accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() } })
    m.setClientId('c')
    let resolve: (v: unknown) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const both = Promise.all([m.spotifyAccessToken(), m.spotifyAccessToken()])
    resolve(tokenReply({ access_token: 'shared', expires_in: 3600 }))
    expect(await both).toEqual(['shared', 'shared'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    m.signOutSpotify()
    expect(m.getSpotifyAuth()).toBeNull()
    expect(m.getClientId()).toBe('c') // the id is the app's, not the session's: it stays for the next sign-in
  })

  it('a browser whose storage throws (a private window) reads as signed out rather than crashing the page', async () => {
    const m = await load()
    const throwing = { getItem: () => { throw new DOMException('denied', 'SecurityError') }, setItem: () => { throw new DOMException('denied', 'SecurityError') }, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 }
    g.localStorage = throwing
    expect(m.getSpotifyAuth()).toBeNull()
    await expect(m.spotifyAccessToken()).rejects.toThrow(/Not signed in/)
    expect(m.getClientId()).toBe('')
    expect(() => m.setClientId('x')).not.toThrow()
    // A login cannot even start without somewhere to keep the verifier, and says so plainly.
    g.sessionStorage = throwing
    await expect(m.beginSpotifyLogin('cid')).rejects.toThrow(/not storing anything for the page/)
    expect(assigned).toEqual([])
    g.sessionStorage = session
    // Nonsense in storage reads as signed out too.
    g.localStorage = store({ [AUTH_KEY]: 'not json' })
    expect(m.getSpotifyAuth()).toBeNull()
    g.localStorage = store({ [AUTH_KEY]: JSON.stringify({ clientId: 'c', expiresAt: 1 }) })
    expect(m.getSpotifyAuth()).toBeNull() // no access token: not a sign-in
  })
})
