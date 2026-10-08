import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpotifyParts, Progress } from '../client'

/**
 * Collecting a library, with the Web API replaced by a table of canned
 * pages — no network, no account: paging that follows `next` to the end,
 * a page with nothing in it, a `next` that points back at itself, one
 * playlist Spotify refuses (the old endpoint tried, then the playlist
 * kept and named as withheld) against a failure that must sink the run,
 * a stop part-way, progress that only moves forward, the parts actually
 * asked for, the cursor paging of followed artists, and the batching of
 * artist and album details.
 */
const fetchMock = vi.fn()
vi.mock('../auth', () => ({ spotifyFetch: (path: string, signal?: AbortSignal) => fetchMock(path, signal) }))

const page = (items: unknown[], next: string | null = null, total?: number) => ({ items, next, total })
const track = (id: string, artistId = 'a1', albumId = 'al1') => ({ id, name: id, type: 'track', artists: [{ id: artistId, name: artistId }], album: { id: albumId, name: albumId, artists: [{ id: artistId, name: artistId }] } })
const NONE: SpotifyParts = { playlists: false, savedTracks: false, savedAlbums: false, followedArtists: false, top: false, artistDetails: false, albumDetails: false }

/** Answer by the first route whose pattern matches; an unmatched path is a test bug, not a silent empty page. */
function routes(table: [RegExp, unknown | ((path: string) => unknown)][], opts: { cap?: number } = {}) {
  let calls = 0
  const seen: string[] = []
  fetchMock.mockImplementation(async (path: string, signal?: AbortSignal) => {
    if (signal?.aborted) throw Object.assign(new Error('The import was stopped'), { name: 'AbortError' })
    seen.push(path)
    if (++calls > (opts.cap ?? 60)) throw new Error(`runaway: ${calls} calls, last ${path}`)
    for (const [re, answer] of table) if (re.test(path)) return typeof answer === 'function' ? (answer as (p: string) => unknown)(path) : answer
    throw new Error(`404 no route for ${path}`)
  })
  return { seen, calls: () => calls }
}
const load = async () => (await import('../client')).fetchSpotifyLibrary

beforeEach(() => {
  vi.resetModules()
  fetchMock.mockReset()
})

describe('spotify client edges', () => {
  it('asks for nothing but the listener when no part is wanted', async () => {
    const r = routes([[/^\/me$/, { id: 'me', display_name: 'Me' }]])
    const lib = await (await load())(NONE, () => {})
    expect(lib).toEqual({ user: { id: 'me', display_name: 'Me' } })
    expect(r.seen).toEqual(['/me'])
  })

  it('follows next to the end, takes a page with no items in its stride, and reports progress that only moves forward', async () => {
    const progress: Progress[] = []
    const r = routes([
      [/^\/me$/, { id: 'me' }],
      [/^\/me\/tracks/, (p: string) => (p.includes('offset=2') ? page([{ added_at: 'x', track: track('t3') }]) : p.includes('offset=1') ? page([], '/me/tracks?offset=2', 3) : page([{ added_at: 'x', track: track('t1') }, { added_at: 'x', track: track('t2') }], '/me/tracks?offset=1', 3))],
    ])
    const lib = await (await load())({ ...NONE, savedTracks: true }, (p) => progress.push(p))
    expect(lib.savedTracks?.map((s) => s.track?.id)).toEqual(['t1', 't2', 't3'])
    expect(r.seen).toEqual(['/me', '/me/tracks?limit=50', '/me/tracks?offset=1', '/me/tracks?offset=2'])
    const saved = progress.filter((p) => p.label === 'Spotify: saved tracks')
    expect(saved.map((p) => p.done)).toEqual([0, 2, 2, 3])
    for (let i = 1; i < saved.length; i++) expect(saved[i].done).toBeGreaterThanOrEqual(saved[i - 1].done)
    expect(saved.at(-1)?.total).toBe(3)
  })

  it('stops when next points back at the page it came from, instead of paging for ever', async () => {
    routes([
      [/^\/me$/, { id: 'me' }],
      [/^\/me\/albums/, page([{ added_at: 'x', album: { id: 'al1', name: 'Al', artists: [] } }], '/me/albums?limit=50')], // next === the page itself
    ])
    const lib = await (await load())({ ...NONE, savedAlbums: true }, () => {})
    expect(lib.savedAlbums).toHaveLength(1)
  })

  it('a playlist Spotify refuses is kept and named as withheld; the older endpoint is tried first; a real failure sinks the run', async () => {
    const r = routes([
      [/^\/me$/, { id: 'me' }],
      [/^\/me\/playlists/, page([{ id: 'ok', name: 'Mine' }, { id: 'editorial', name: 'Discover Weekly' }])],
      [/^\/playlists\/ok\/items/, page([{ added_at: 'x', item: track('t1') }])],
      [/^\/playlists\/editorial\/items/, () => { throw new Error('404 Not Found on /playlists/editorial/items') }],
      [/^\/playlists\/editorial\/tracks/, () => { throw new Error('403 Forbidden on /playlists/editorial/tracks') }],
    ])
    const lib = await (await load())({ ...NONE, playlists: true }, () => {})
    expect(lib.playlists?.map((p) => [p.playlist.name, p.items.length])).toEqual([['Mine', 1], ['Discover Weekly', 0]])
    expect(lib.withheldPlaylists).toEqual(['Discover Weekly'])
    expect(r.seen).toContain('/playlists/editorial/tracks?limit=50&additional_types=track,episode')
    // A 500, or anything that is not a refusal, is not swallowed: a half-read library is worse than a clear failure.
    routes([
      [/^\/me$/, { id: 'me' }],
      [/^\/me\/playlists/, page([{ id: 'boom', name: 'Boom' }])],
      [/^\/playlists\/boom/, () => { throw new Error('500 Internal Server Error on /playlists/boom/items') }],
    ])
    await expect((await load())({ ...NONE, playlists: true }, () => {})).rejects.toThrow(/500/)
  })

  it('a stop part-way comes back as the stop it was, not as a failure, and nothing is asked for afterwards', async () => {
    const ac = new AbortController()
    const r = routes([
      [/^\/me$/, { id: 'me' }],
      [/^\/me\/playlists/, page([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }])],
      [/^\/playlists\/p1/, () => { ac.abort(); return page([{ item: track('t1') }]) }],
      [/^\/playlists\/p2/, page([{ item: track('t2') }])],
    ])
    await expect((await load())({ ...NONE, playlists: true }, () => {}, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(r.seen.some((p) => p.startsWith('/playlists/p2'))).toBe(false)
  })

  it('follows the cursor of followed artists and stops when there is no more, then batches artist and album details 50 and 20 at a time, skipping what it already has', async () => {
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
    const trackIds = many(60, 'a') // 60 distinct artists over 60 tracks, each on its own album
    const r = routes([
      [/^\/me$/, { id: 'me' }],
      [/^\/me\/tracks/, page(trackIds.map((a, i) => ({ added_at: 'x', track: track(`t${i}`, a, `al${i}`) })))],
      [/^\/me\/following.*after=cur1/, { artists: { items: [{ id: 'f2', name: 'F2', genres: ['jazz'] }], next: null, cursors: { after: null }, total: 2 } }],
      [/^\/me\/following/, { artists: { items: [{ id: 'f1', name: 'F1', genres: ['rock'] }], next: '/me/following?after=cur1', cursors: { after: 'cur1' }, total: 2 } }],
      [/^\/artists\?ids=/, (p: string) => ({ artists: p.split('ids=')[1].split(',').map((id, i) => (i === 0 ? null : { id, name: id, genres: ['pop'] })) })],
      [/^\/albums\?ids=/, (p: string) => ({ albums: p.split('ids=')[1].split(',').map((id) => ({ id, name: id, artists: [] })) })],
    ], { cap: 40 })
    const lib = await (await load())({ ...NONE, savedTracks: true, followedArtists: true, artistDetails: true, albumDetails: true }, () => {})
    expect(lib.followedArtists?.map((a) => a.id)).toEqual(['f1', 'f2'])
    // Two batches of artists (60 wanted, 50 a call) and three of albums (60 wanted, 20 a call); the nulls are dropped.
    const artistCalls = r.seen.filter((p) => p.startsWith('/artists?ids='))
    const albumCalls = r.seen.filter((p) => p.startsWith('/albums?ids='))
    expect(artistCalls).toHaveLength(2)
    expect(artistCalls[0].split('ids=')[1].split(',')).toHaveLength(50)
    expect(albumCalls).toHaveLength(3)
    expect(lib.artistDetails).toHaveLength(58) // one null per batch
    expect(lib.albumDetails).toHaveLength(60)
    // The artists already known with their genres (the followed ones) are not asked for again.
    expect(artistCalls.join(',')).not.toContain('f1')
  })

  it('asks only for the parts wanted, and the top lists for every range', async () => {
    const r = routes([
      [/^\/me$/, { id: 'me' }],
      [/^\/me\/top\/artists/, page([{ id: 'a1', name: 'A' }])],
      [/^\/me\/top\/tracks/, page([track('t1')])],
    ])
    const lib = await (await load())({ ...NONE, top: true }, () => {})
    expect(Object.keys(lib.topArtists ?? {})).toEqual(['short_term', 'medium_term', 'long_term'])
    expect(Object.keys(lib.topTracks ?? {})).toEqual(['short_term', 'medium_term', 'long_term'])
    expect(r.seen.filter((p) => p.includes('/me/top/'))).toHaveLength(6)
    expect(r.seen.some((p) => p.startsWith('/me/playlists'))).toBe(false)
    expect(lib.savedTracks).toBeUndefined()
    expect(lib.artistDetails).toBeUndefined()
  })
})
