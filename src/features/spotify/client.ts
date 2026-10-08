import type { SpotifyAlbum, SpotifyArtist, SpotifyLibrary, SpotifyPlaylist, SpotifyPlaylistItem, SpotifySaved, SpotifyTrack, SpotifyUser, TopRange } from '../../core/exchange/spotify'
import { spotifyFetch } from './auth'

/**
 * Collecting a library from the Web API, page by page, into the shape the
 * importer reads. Every part is optional; progress is reported as pages
 * land so a big library (hundreds of playlists, tens of thousands of
 * tracks) shows movement.
 */

export interface SpotifyParts {
  playlists: boolean
  savedTracks: boolean
  savedAlbums: boolean
  followedArtists: boolean
  top: boolean
  /** Fetch full artist objects (genres, popularity, followers) for artists met only on tracks and albums. */
  artistDetails: boolean
  /** Fetch full album objects (record label, popularity) for albums met only on tracks. */
  albumDetails: boolean
}

export const DEFAULT_PARTS: SpotifyParts = { playlists: true, savedTracks: true, savedAlbums: true, followedArtists: true, top: true, artistDetails: true, albumDetails: true }

export interface Progress {
  label: string
  done: number
  total: number
  detail?: string
}

interface Page<T> {
  items: T[]
  next: string | null
  total?: number
}

const TOP_RANGES: TopRange[] = ['short_term', 'medium_term', 'long_term']

/**
 * Every item of a paged endpoint, following `next` — and never the same page twice: a `next` that points back at a
 * page already read (a mirror, a proxy, an offset that does not advance) would otherwise page for ever, collecting
 * the same rows until the tab gives out.
 */
async function* pages<T>(first: string, signal?: AbortSignal): AsyncGenerator<Page<T>> {
  let url: string | null = first
  const seen = new Set<string>()
  while (url && !seen.has(url)) {
    seen.add(url)
    const page: Page<T> = await spotifyFetch<Page<T>>(url, signal)
    yield page
    url = page.next
  }
}

async function all<T>(first: string, signal: AbortSignal | undefined, onPage?: (n: number, total?: number) => void): Promise<T[]> {
  const out: T[] = []
  for await (const p of pages<T>(first, signal)) {
    out.push(...(p.items ?? []))
    onPage?.(out.length, p.total)
  }
  return out
}

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/**
 * A playlist's rows: `items` is the current endpoint (`item` in each row), `tracks`/`track` the older one — both are
 * read. Null when Spotify refuses both (403/404): a playlist of Spotify's own, withheld from newer apps.
 */
async function playlistItems(id: string, signal?: AbortSignal): Promise<SpotifyPlaylistItem[] | null> {
  const refused = (err: unknown) => err instanceof Error && /^(403|404) /.test(err.message)
  try {
    return await all<SpotifyPlaylistItem>(`/playlists/${id}/items?limit=50&additional_types=track,episode`, signal)
  } catch (err) {
    if (!refused(err)) throw err
  }
  try {
    return await all<SpotifyPlaylistItem>(`/playlists/${id}/tracks?limit=50&additional_types=track,episode`, signal)
  } catch (err) {
    if (!refused(err)) throw err
    return null
  }
}

export async function fetchSpotifyLibrary(parts: SpotifyParts, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<SpotifyLibrary> {
  onProgress({ label: 'Spotify: who you are', done: 0, total: 1 })
  const user = await spotifyFetch<SpotifyUser>('/me', signal)
  const lib: SpotifyLibrary = { user }

  if (parts.playlists) {
    onProgress({ label: 'Spotify: your playlists', done: 0, total: 1 })
    const list = await all<SpotifyPlaylist>('/me/playlists?limit=50', signal, (n, total) => onProgress({ label: 'Spotify: your playlists', done: n, total: total ?? n }))
    lib.playlists = []
    lib.withheldPlaylists = []
    let i = 0
    for (const playlist of list) {
      i++
      onProgress({ label: 'Spotify: playlist tracks', done: i, total: list.length, detail: playlist.name })
      const items = await playlistItems(playlist.id, signal)
      if (items) lib.playlists.push({ playlist, items })
      else {
        // Spotify-owned and editorial playlists (Daily Mix, Discover Weekly, This Is …) are refused to apps made
        // since November 2024: the playlist itself is kept, its tracks are not to be had.
        lib.playlists.push({ playlist, items: [] })
        lib.withheldPlaylists.push(playlist.name)
      }
    }
  }
  if (parts.savedTracks) {
    onProgress({ label: 'Spotify: saved tracks', done: 0, total: 1 })
    lib.savedTracks = await all<SpotifySaved<SpotifyTrack>>('/me/tracks?limit=50', signal, (n, total) => onProgress({ label: 'Spotify: saved tracks', done: n, total: total ?? n }))
  }
  if (parts.savedAlbums) {
    onProgress({ label: 'Spotify: saved albums', done: 0, total: 1 })
    lib.savedAlbums = await all<SpotifySaved<SpotifyAlbum>>('/me/albums?limit=50', signal, (n, total) => onProgress({ label: 'Spotify: saved albums', done: n, total: total ?? n }))
  }
  if (parts.followedArtists) {
    onProgress({ label: 'Spotify: followed artists', done: 0, total: 1 })
    lib.followedArtists = []
    let after: string | undefined
    for (;;) {
      const r = await spotifyFetch<{ artists: Page<SpotifyArtist> & { cursors?: { after?: string | null } } }>(`/me/following?type=artist&limit=50${after ? `&after=${after}` : ''}`, signal)
      lib.followedArtists.push(...(r.artists.items ?? []))
      onProgress({ label: 'Spotify: followed artists', done: lib.followedArtists.length, total: r.artists.total ?? lib.followedArtists.length })
      after = r.artists.cursors?.after ?? undefined
      if (!after || !r.artists.next) break
    }
  }
  if (parts.top) {
    lib.topArtists = {}
    lib.topTracks = {}
    let i = 0
    for (const range of TOP_RANGES) {
      onProgress({ label: 'Spotify: top artists and tracks', done: i++, total: TOP_RANGES.length, detail: range.replace('_', ' ') })
      lib.topArtists[range] = await all<SpotifyArtist>(`/me/top/artists?time_range=${range}&limit=50`, signal)
      lib.topTracks[range] = await all<SpotifyTrack>(`/me/top/tracks?time_range=${range}&limit=50`, signal)
    }
  }

  // Simplified artists (on tracks and albums) carry only a name; the full object has the genres. One batch call per 50.
  if (parts.artistDetails) {
    const known = new Set<string>()
    const note = (a?: SpotifyArtist[]) => a?.forEach((x) => x.genres && known.add(x.id))
    note(lib.followedArtists)
    for (const r of Object.values(lib.topArtists ?? {})) note(r)
    const wanted = new Set<string>()
    const see = (a?: SpotifyArtist[]) => a?.forEach((x) => x.id && !known.has(x.id) && wanted.add(x.id))
    const seeTrack = (t?: SpotifyTrack | null) => {
      if (!t) return
      see(t.artists)
      see(t.album?.artists)
    }
    for (const p of lib.playlists ?? []) for (const it of p.items) seeTrack(it.item ?? it.track)
    for (const s of lib.savedTracks ?? []) seeTrack(s.track)
    for (const s of lib.savedAlbums ?? []) see(s.album?.artists)
    for (const r of Object.values(lib.topTracks ?? {})) for (const t of r) seeTrack(t)
    const ids = [...wanted]
    lib.artistDetails = []
    const batches = chunks(ids, 50)
    for (let i = 0; i < batches.length; i++) {
      onProgress({ label: 'Spotify: artist genres', done: i * 50, total: ids.length })
      const r = await spotifyFetch<{ artists: (SpotifyArtist | null)[] }>(`/artists?ids=${batches[i].join(',')}`, signal)
      lib.artistDetails.push(...r.artists.filter((a): a is SpotifyArtist => !!a))
    }
  }
  // Albums on tracks are simplified too (no label, no popularity). One batch call per 20.
  if (parts.albumDetails) {
    const known = new Set((lib.savedAlbums ?? []).map((s) => s.album?.id).filter(Boolean))
    const wanted = new Set<string>()
    const seeTrack = (t?: SpotifyTrack | null) => t?.album?.id && !known.has(t.album.id) && wanted.add(t.album.id)
    for (const p of lib.playlists ?? []) for (const it of p.items) seeTrack(it.item ?? it.track)
    for (const s of lib.savedTracks ?? []) seeTrack(s.track)
    for (const r of Object.values(lib.topTracks ?? {})) for (const t of r) seeTrack(t)
    const ids = [...wanted]
    lib.albumDetails = []
    const batches = chunks(ids, 20)
    for (let i = 0; i < batches.length; i++) {
      onProgress({ label: 'Spotify: album details', done: i * 20, total: ids.length })
      const r = await spotifyFetch<{ albums: (SpotifyAlbum | null)[] }>(`/albums?ids=${batches[i].join(',')}`, signal)
      lib.albumDetails.push(...r.albums.filter((a): a is SpotifyAlbum => !!a))
    }
  }
  return lib
}
