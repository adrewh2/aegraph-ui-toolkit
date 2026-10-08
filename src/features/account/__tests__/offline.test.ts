import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Offline mode, from the outside: with **Third-party services** off, the
 * features that would call someone else make no request at all. Each case
 * fails the test if `fetch` is reached, rather than trusting the switch.
 */
const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })

const { setUserSettings } = await import('../settings')
const { geocode, reverseGeocode } = await import('../../maps/maps')
const { fetchWikiGallery } = await import('../../maps/placeCard')
const { createYouTubeFrame } = await import('../../videos/youtube')
const { createSpotifyFrame } = await import('../../audio/spotify')
const { fetchOEmbed, importYouTube } = await import('../../videos/videos')
const { fetchSpotifyOEmbed, importSpotify } = await import('../../audio/audio')
const { beginSpotifyLogin, spotifyFetch } = await import('../../spotify/auth')
const { imageGate } = await import('../../../components/imageGate')
const { EntityStore } = await import('../../../core/entity/store')
const { openBundleUrl } = await import('../../projects/projectActions')
const { fetchHandedUrl } = await import('../../assistant/toolkit')
const { createWebTools } = await import('../../assistant/webTools')

const fetchSpy = vi.fn<typeof fetch>(async () => Response.json({}))

beforeEach(() => {
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
  setUserSettings({ externalServices: true })
})

const preview = { title: 'Kyoto', url: 'https://en.wikipedia.org/wiki/Kyoto', source: 'wikipedia' as const, lang: 'en', fetchedAt: '2026-09-23T00:00:00Z' }

describe('with third-party services off', () => {
  beforeEach(() => setUserSettings({ externalServices: false }))

  it('place search refuses instead of calling out, and the gallery comes back empty as it does for any failure', async () => {
    await expect(geocode('Kyoto')).rejects.toThrow(/Third-party services is off/)
    expect(await fetchWikiGallery(preview)).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reverse geocoding simply has no answer — it is a label, not an action the user asked for', async () => {
    expect(await reverseGeocode({ lat: 35, lng: 135 })).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the media players refuse before they make their frame', () => {
    // They throw before touching the document (there is none here to make a frame in).
    expect(() => createYouTubeFrame('M7lc1UVf-VE')).toThrow(/The YouTube player needs a third-party service/)
    expect(() => createSpotifyFrame('spotify:track:4cOdK2wGLETKBW3PvgPWqT', 152)).toThrow(/The Spotify player needs a third-party service/)
  })

  it('adding a YouTube video or a Spotify link asks neither for its title: the entity is made from the link alone', async () => {
    expect(await fetchOEmbed('M7lc1UVf-VE')).toBeUndefined()
    expect(await fetchSpotifyOEmbed('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBeUndefined()
    const store = new EntityStore()
    const v = await importYouTube(store, 'https://www.youtube.com/watch?v=M7lc1UVf-VE')
    expect(v).toMatchObject({ existed: false, metadata: false })
    const a = await importSpotify(store, 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')
    expect(a).toMatchObject({ existed: false, metadata: false })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('Spotify sign-in and the library import reach neither accounts.spotify.com nor api.spotify.com', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...new URL('http://127.0.0.1:5199/datasets'), assign })
    await expect(beginSpotifyLogin('client-id')).rejects.toThrow(/Signing in to Spotify needs a third-party service/)
    expect(assign).not.toHaveBeenCalled()
    mem['aegraph:spotify:auth'] = JSON.stringify({ clientId: 'c', accessToken: 'secret-token', expiresAt: Date.now() + 3_600_000 })
    await expect(spotifyFetch('/me')).rejects.toThrow(/The Spotify import needs a third-party service/)
    delete mem['aegraph:spotify:auth']
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('/open?url= for another site’s bundle fetches nothing; this site’s own still opens', async () => {
    vi.stubGlobal('location', new URL('http://127.0.0.1:5199/open'))
    await expect(openBundleUrl(new EntityStore(), 'https://elsewhere.example/p.ae.json')).rejects.toThrow(/Opening a project from another site needs a third-party service/)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockResolvedValueOnce(new Response('{"$schema":"aegraph/v1","entities":[]}'))
    await openBundleUrl(new EntityStore(), '/datasets/own.ae.json').catch(() => {})
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('/datasets/own.ae.json')
  })

  it('no picture from data on another host is loaded — not even a provider’s thumbnail, and not on a click', () => {
    for (const src of ['https://i.ytimg.com/vi/M7lc1UVf-VE/mqdefault.jpg', 'https://i.scdn.co/image/ab67616d0000b273', 'https://upload.wikimedia.org/x.jpg', 'https://evil.example/p.png?d=1'])
      expect(imageGate(src, { external: false, providers: true }), src).toMatchObject({ status: 'off' })
    // What the data carries itself still shows.
    expect(imageGate('data:image/png;base64,AAAA', { external: false, providers: true })).toMatchObject({ status: 'show' })
  })

  it('a URL a tool was handed (import_graph, map_import, project_open_bundle) is refused before the user is even asked', async () => {
    vi.stubGlobal('location', new URL('http://127.0.0.1:5199/'))
    const confirm = vi.fn(async () => true)
    await expect(fetchHandedUrl({ confirm }, 'https://data.example/g.graphml', 'Importing a graph')).rejects.toThrow(/Importing a graph needs a third-party service/)
    expect(confirm).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('Python scripts do not fetch their runtime from jsDelivr when the app does not serve it', async () => {
    const { PythonEngine } = await import('../../../scripting/python/engine')
    const { requireExternalServices } = await import('../settings')
    vi.stubGlobal('location', new URL('http://127.0.0.1:5199/analytics/scripts'))
    // The app's own manifest is missing (a build without `npm run pyodide`): the only other source is the CDN.
    fetchSpy.mockImplementationOnce(async () => new Response('', { status: 404 }))
    const engine = new PythonEngine({ beforeCdn: requireExternalServices })
    await expect(engine.boot()).rejects.toThrow(/Third-party services is off/)
    expect(engine.getStatus()).toMatchObject({ stage: 'failed' })
    // Only this origin was asked; nothing went to cdn.jsdelivr.net or PyPI.
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(['http://127.0.0.1:5199/pyodide/manifest.json'])
  })

  it('web_fetch reads nothing from another site, and asks nothing', async () => {
    const confirm = vi.fn(async () => true)
    const [tool] = createWebTools({ confirm })
    await expect(tool.run(tool.parse({ url: 'https://example.com/' }))).rejects.toThrow(/Reading web pages needs a third-party service/)
    expect(confirm).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('with third-party services on (the default)', () => {
  beforeEach(() => setUserSettings({ externalServices: true }))

  it('a page’s `next` link is followed only on api.spotify.com: the bearer token goes to no other host', async () => {
    mem['aegraph:spotify:auth'] = JSON.stringify({ clientId: 'c', accessToken: 'secret-token', expiresAt: Date.now() + 3_600_000 })
    for (const next of ['https://evil.example/v1/me', 'http://api.spotify.com/v1/me', 'https://api.spotify.com.evil.example/v1/me', 'https://api.spotify.com/v2/me', 'https://user:pw@api.spotify.com/v1/me', '//evil.example/v1/me', 'me'])
      await expect(spotifyFetch(next), next).rejects.toThrow(/Not a Spotify Web API address/)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockResolvedValueOnce(Response.json({ id: 'u' }))
    expect(await spotifyFetch('https://api.spotify.com/v1/me/playlists?offset=50')).toEqual({ id: 'u' })
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://api.spotify.com/v1/me/playlists?offset=50')
    delete mem['aegraph:spotify:auth']
  })

  it('a provider’s thumbnail loads at once; any other host’s picture waits for a click', () => {
    expect(imageGate('https://i.ytimg.com/vi/M7lc1UVf-VE/mqdefault.jpg', { external: true, providers: true })).toMatchObject({ status: 'show' })
    expect(imageGate('https://i.ytimg.com/vi/M7lc1UVf-VE/mqdefault.jpg', { external: true })).toMatchObject({ status: 'ask' })
    expect(imageGate('https://evil.example/p.png', { external: true, providers: true })).toMatchObject({ status: 'ask', host: 'evil.example' })
    expect(imageGate('http://i.ytimg.com/x.jpg', { external: true, providers: true })).toMatchObject({ status: 'ask' })
  })

  it('place search asks the geocoder, as it always did', async () => {
    fetchSpy.mockResolvedValueOnce(Response.json([{ display_name: 'Kyoto, Japan', lat: '35.01', lon: '135.76', type: 'city' }]))
    expect(await geocode('Kyoto')).toEqual([{ label: 'Kyoto, Japan', lat: 35.01, lng: 135.76, kind: 'city' }])
    expect(String(fetchSpy.mock.calls[0][0])).toContain('nominatim.openstreetmap.org')
  })

})
