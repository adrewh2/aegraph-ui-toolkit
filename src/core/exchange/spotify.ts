import { schemaTypeId } from '../entity/categories'
import { createEntity, createRelationship } from '../entity/entity'
import type { AegraphDocument, AnyEntity, EntityId } from '../entity/types'
import type { TypeCategory } from '../entity/categories'
import type { PropertyDef } from '../entity/schema'
import type { SchemaTypeData, TableLayout } from '../entity/typeRegistry'
import { createProject } from '../projects/project'

/**
 * A Spotify library as a graph. The Web API's objects (the subset below —
 * what the fetchers in features/spotify collect) become an ontology of six
 * entity types and nine relationship types, ids being Spotify URIs
 * (`spotify:track:…`), so a second import updates rather than duplicates
 * and every entity links back to the app. Pure: no fetching here.
 */

// ── The API objects, as far as this reads them ────────────────────────

export interface SpotifyImage {
  url: string
  width?: number | null
  height?: number | null
}
export interface SpotifyUser {
  id: string
  display_name?: string | null
  country?: string
  product?: string
  followers?: { total: number }
  images?: SpotifyImage[]
  external_urls?: { spotify?: string }
}
export interface SpotifyArtist {
  id: string
  name: string
  uri?: string
  genres?: string[]
  popularity?: number
  followers?: { total: number }
  images?: SpotifyImage[]
  external_urls?: { spotify?: string }
}
export interface SpotifyAlbum {
  id: string
  name: string
  uri?: string
  album_type?: string
  release_date?: string
  release_date_precision?: 'year' | 'month' | 'day'
  total_tracks?: number
  label?: string
  genres?: string[]
  popularity?: number
  images?: SpotifyImage[]
  artists?: SpotifyArtist[]
  external_urls?: { spotify?: string }
}
export interface SpotifyTrack {
  id: string
  name: string
  uri?: string
  type?: string
  duration_ms?: number
  explicit?: boolean
  popularity?: number
  track_number?: number
  disc_number?: number
  preview_url?: string | null
  is_local?: boolean
  external_ids?: { isrc?: string }
  external_urls?: { spotify?: string }
  album?: SpotifyAlbum
  artists?: SpotifyArtist[]
}
export interface SpotifyPlaylist {
  id: string
  name: string
  uri?: string
  description?: string | null
  public?: boolean | null
  collaborative?: boolean
  snapshot_id?: string
  owner?: { id: string; display_name?: string | null }
  tracks?: { total?: number }
  followers?: { total: number }
  images?: SpotifyImage[] | null
  external_urls?: { spotify?: string }
}
export interface SpotifyPlaylistItem {
  added_at?: string | null
  added_by?: { id?: string } | null
  is_local?: boolean
  /** The current field; `track` is the older name of the same thing. */
  item?: SpotifyTrack | null
  track?: SpotifyTrack | null
}
export interface SpotifySaved<T> {
  added_at?: string
  track?: T
  album?: T
}

export type TopRange = 'short_term' | 'medium_term' | 'long_term'

/** Everything the fetchers collected; every part optional (the user chooses what to import). */
export interface SpotifyLibrary {
  user: SpotifyUser
  playlists?: { playlist: SpotifyPlaylist; items: SpotifyPlaylistItem[] }[]
  /** Playlists whose tracks Spotify refused to serve (its own editorial ones, for apps made since November 2024). */
  withheldPlaylists?: string[]
  savedTracks?: SpotifySaved<SpotifyTrack>[]
  savedAlbums?: SpotifySaved<SpotifyAlbum>[]
  followedArtists?: SpotifyArtist[]
  topArtists?: Partial<Record<TopRange, SpotifyArtist[]>>
  topTracks?: Partial<Record<TopRange, SpotifyTrack[]>>
  /** Full artist objects (genres, popularity, followers) for artists met only through tracks and albums. */
  artistDetails?: SpotifyArtist[]
  /** Full album objects (label, popularity) for albums met only through tracks. */
  albumDetails?: SpotifyAlbum[]
}

// ── The ontology ──────────────────────────────────────────────────────

export const SPOTIFY_TAG = 'spotify'
export const SPOTIFY_SOURCE = 'import:spotify'
export const SPOTIFY_GREEN = '#1db954'

export const SPOTIFY_TYPES = {
  listener: 'listener',
  playlist: 'playlist',
  track: 'track',
  album: 'album',
  artist: 'artist',
  genre: 'genre',
} as const

export const SPOTIFY_RELATIONSHIPS = {
  /** playlist → track, in order (`position`, `addedAt`, `addedBy`). */
  includes: 'includes',
  /** track → album. */
  appearsOn: 'appears-on',
  /** track → artist, album → artist. */
  performedBy: 'performed-by',
  /** artist → genre. */
  inGenre: 'in-genre',
  /** listener → playlist. */
  owns: 'owns',
  /** listener → playlist (someone else's). */
  followsPlaylist: 'follows-playlist',
  /** listener → artist. */
  follows: 'follows',
  /** listener → track / album (`addedAt`). */
  saved: 'saved',
  /** listener → artist / track (`rank`, `range`). */
  top: 'top',
} as const

const RANGE_LABEL: Record<TopRange, string> = { short_term: 'last 4 weeks', medium_term: 'last 6 months', long_term: 'all time' }

/** Drops the keys with nothing in them, keeping the object's type. */
const strip = <T extends object>(o: T): T => {
  const r = o as Record<string, unknown>
  for (const k of Object.keys(r)) if (r[k] === undefined || r[k] === null || r[k] === '') delete r[k]
  return o
}

type Def = { label?: string; description?: string; category?: TypeCategory; kind?: 'relationship'; color?: string; pluralLabel?: string; properties?: PropertyDef[]; table?: TableLayout }

const def = (name: string, d: Def): AnyEntity =>
  createEntity<SchemaTypeData>({
    id: schemaTypeId(name),
    type: 'schema:type',
    label: d.label ?? name,
    description: d.description,
    tags: [SPOTIFY_TAG],
    data: strip<SchemaTypeData>({ name, category: d.category, kind: d.kind, color: d.color, pluralLabel: d.pluralLabel, properties: d.properties, table: d.table }),
    meta: { source: SPOTIFY_SOURCE },
  })

/** The type definitions: what each thing is, what it carries, how its table reads. */
export function spotifyOntology(): AnyEntity[] {
  return [
    def(SPOTIFY_TYPES.listener, {
      label: 'Listener',
      pluralLabel: 'Listeners',
      category: 'knowledge',
      color: '#111827',
      description: 'A Spotify account whose library was imported. Owns and follows playlists, follows artists, saves tracks and albums, and has top artists and tracks per time range.',
      properties: [
        { key: 'spotifyId', label: 'Spotify ID', kind: 'text' },
        { key: 'country', label: 'Country', kind: 'text' },
        { key: 'product', label: 'Plan', kind: 'text' },
        { key: 'followers', label: 'Followers', kind: 'number' },
        { key: 'image', label: 'Image', kind: 'image' },
        { key: 'url', label: 'Open in Spotify', kind: 'url' },
        { key: 'importedAt', label: 'Imported', kind: 'datetime' },
      ],
    }),
    def(SPOTIFY_TYPES.playlist, {
      label: 'Playlist',
      pluralLabel: 'Playlists',
      category: 'knowledge',
      color: SPOTIFY_GREEN,
      description: 'An ordered list of tracks. `includes` relationships carry each track’s position and when it was added.',
      properties: [
        { key: 'ownerName', label: 'Owner', kind: 'text' },
        { key: 'trackCount', label: 'Tracks', kind: 'number' },
        { key: 'public', label: 'Public', kind: 'boolean' },
        { key: 'collaborative', label: 'Collaborative', kind: 'boolean' },
        { key: 'followers', label: 'Followers', kind: 'number' },
        { key: 'image', label: 'Cover', kind: 'image' },
        { key: 'url', label: 'Open in Spotify', kind: 'url' },
        { key: 'ownerId', label: 'Owner ID', kind: 'text' },
        { key: 'snapshotId', label: 'Snapshot', kind: 'text' },
      ],
      table: { columns: ['label', 'data.ownerName', 'data.trackCount', 'data.public'], hidden: ['data.ownerId', 'data.snapshotId'] },
    }),
    def(SPOTIFY_TYPES.track, {
      label: 'Track',
      pluralLabel: 'Tracks',
      category: 'knowledge',
      color: '#2563eb',
      description: 'A recording. `performed-by` its artists, `appears-on` its album; playlists `include` it, the listener may have `saved` it or have it in a `top` list.',
      properties: [
        { key: 'artists', label: 'Artists', kind: 'text', description: 'The credited artists, comma-separated — the same as the performed-by relationships' },
        { key: 'album', label: 'Album', kind: 'text' },
        { key: 'releaseDate', label: 'Released', kind: 'text', description: 'The album’s release date as Spotify gives it: YYYY, YYYY-MM or YYYY-MM-DD' },
        { key: 'releaseYear', label: 'Year', kind: 'number', description: 'The release year as a number, for charts and filters' },
        { key: 'duration', label: 'Duration', kind: 'text' },
        { key: 'durationMs', label: 'Duration (ms)', kind: 'number' },
        { key: 'popularity', label: 'Popularity', kind: 'number', description: '0–100, Spotify’s measure of recent plays' },
        { key: 'explicit', label: 'Explicit', kind: 'boolean' },
        { key: 'trackNumber', label: 'Track №', kind: 'number' },
        { key: 'discNumber', label: 'Disc', kind: 'number' },
        { key: 'isrc', label: 'ISRC', kind: 'text' },
        { key: 'previewUrl', label: 'Preview', kind: 'url' },
        { key: 'url', label: 'Open in Spotify', kind: 'url' },
      ],
      table: { columns: ['label', 'data.artists', 'data.album', 'data.releaseDate', 'data.duration', 'data.popularity'], hidden: ['data.releaseYear', 'data.durationMs', 'data.discNumber', 'data.isrc', 'data.previewUrl'] },
    }),
    def(SPOTIFY_TYPES.album, {
      label: 'Album',
      pluralLabel: 'Albums',
      category: 'knowledge',
      color: '#ea580c',
      description: 'An album, single or compilation. `performed-by` its artists; tracks `appear-on` it.',
      properties: [
        { key: 'artists', label: 'Artists', kind: 'text' },
        { key: 'albumType', label: 'Kind', kind: 'text', options: ['album', 'single', 'compilation'] },
        { key: 'releaseDate', label: 'Released', kind: 'text', description: 'YYYY, YYYY-MM or YYYY-MM-DD, as precise as Spotify has it' },
        { key: 'releaseYear', label: 'Year', kind: 'number', description: 'The release year as a number, for charts and filters' },
        { key: 'releasePrecision', label: 'Date precision', kind: 'text', options: ['year', 'month', 'day'] },
        { key: 'totalTracks', label: 'Tracks', kind: 'number' },
        { key: 'recordLabel', label: 'Label', kind: 'text' },
        { key: 'popularity', label: 'Popularity', kind: 'number' },
        { key: 'image', label: 'Cover', kind: 'image' },
        { key: 'url', label: 'Open in Spotify', kind: 'url' },
      ],
      table: { columns: ['label', 'data.artists', 'data.albumType', 'data.releaseDate', 'data.totalTracks', 'data.recordLabel'], hidden: ['data.releasePrecision', 'data.releaseYear'] },
    }),
    def(SPOTIFY_TYPES.artist, {
      label: 'Artist',
      pluralLabel: 'Artists',
      category: 'knowledge',
      color: '#7c3aed',
      description: 'A performer. `in-genre` its genres (also its tags); tracks and albums are `performed-by` it.',
      properties: [
        { key: 'genres', label: 'Genres', kind: 'tags' },
        { key: 'popularity', label: 'Popularity', kind: 'number' },
        { key: 'followers', label: 'Followers', kind: 'number' },
        { key: 'image', label: 'Image', kind: 'image' },
        { key: 'url', label: 'Open in Spotify', kind: 'url' },
      ],
      table: { columns: ['label', 'data.genres', 'data.popularity', 'data.followers'] },
    }),
    def(SPOTIFY_TYPES.genre, {
      label: 'Genre',
      pluralLabel: 'Genres',
      category: 'knowledge',
      color: '#6b7280',
      description: 'A genre as Spotify names it on artists. Artists are `in-genre` it.',
      properties: [{ key: 'artistCount', label: 'Artists', kind: 'number', description: 'Artists in this import carrying the genre' }],
      table: { columns: ['label', 'data.artistCount'], sort: { key: 'data.artistCount', dir: 'desc' } },
    }),
    def(SPOTIFY_RELATIONSHIPS.includes, { label: 'includes', kind: 'relationship', color: SPOTIFY_GREEN, description: 'Playlist → track. `position` (from 1), `addedAt`, `addedBy`.', properties: [{ key: 'position', kind: 'number' }, { key: 'addedAt', kind: 'datetime' }, { key: 'addedBy', kind: 'text' }] }),
    def(SPOTIFY_RELATIONSHIPS.appearsOn, { label: 'appears on', kind: 'relationship', color: '#ea580c', description: 'Track → album.' }),
    def(SPOTIFY_RELATIONSHIPS.performedBy, { label: 'performed by', kind: 'relationship', color: '#7c3aed', description: 'Track or album → artist, in credit order (`position`).', properties: [{ key: 'position', kind: 'number' }] }),
    def(SPOTIFY_RELATIONSHIPS.inGenre, { label: 'in genre', kind: 'relationship', color: '#6b7280', description: 'Artist → genre.' }),
    def(SPOTIFY_RELATIONSHIPS.owns, { label: 'owns', kind: 'relationship', color: '#111827', description: 'Listener → a playlist of theirs.' }),
    def(SPOTIFY_RELATIONSHIPS.followsPlaylist, { label: 'follows playlist', kind: 'relationship', color: '#111827', description: 'Listener → a playlist someone else owns that is in their library.' }),
    def(SPOTIFY_RELATIONSHIPS.follows, { label: 'follows', kind: 'relationship', color: '#111827', description: 'Listener → artist.' }),
    def(SPOTIFY_RELATIONSHIPS.saved, { label: 'saved', kind: 'relationship', color: '#111827', description: 'Listener → a track or album in Your Library (`addedAt`).', properties: [{ key: 'addedAt', kind: 'datetime' }] }),
    def(SPOTIFY_RELATIONSHIPS.top, { label: 'top', kind: 'relationship', color: '#f59e0b', description: 'Listener → artist or track in a top list: `rank` (from 1) over `range` (last 4 weeks, last 6 months, all time).', properties: [{ key: 'rank', kind: 'number' }, { key: 'range', kind: 'text', options: ['short_term', 'medium_term', 'long_term'] }, { key: 'rangeLabel', kind: 'text' }] }),
  ]
}

/** How the project opens: the ontology on the left, the whole graph in 2D on the right (the workstation model's preset shape; fixed ids, re-minted on load). */
function spotifyWorkstation() {
  const tab = (id: string, path: string, title?: string) => ({ id, path, title, back: [], forward: [] })
  return {
    root: {
      kind: 'split',
      id: 's-spotify',
      dir: 'row',
      ratio: 0.42,
      children: [
        { kind: 'pane', id: 'p-spotify-ontology', tabs: [tab('t-spotify-ontology', '/ontology', 'Ontology'), tab('t-spotify-playlists', `/entities?type=${SPOTIFY_TYPES.playlist}`, 'Playlists')], active: 0 },
        { kind: 'pane', id: 'p-spotify-graph', tabs: [tab('t-spotify-graph', '/unigraph/2d')], active: 0 },
      ],
    },
    focused: 'p-spotify-ontology',
  }
}

// ── The instances ─────────────────────────────────────────────────────

export const spotifyId = (kind: 'user' | 'playlist' | 'track' | 'album' | 'artist', id: string): EntityId => `spotify:${kind}:${id}`
export const genreId = (genre: string): EntityId => `spotify:genre:${genre.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
export const spotifyProjectId = (userId: string): EntityId => `spotify:project:${userId}`

const largestImage = (images: SpotifyImage[] | null | undefined) => (images?.length ? [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].url : undefined)
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
const year = (d: string | undefined) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : undefined)
const names = (artists: SpotifyArtist[] | undefined) => artists?.map((a) => a.name).join(', ')

export interface SpotifyImportOptions {
  /** When the import happened (ISO; default now): the listener's `importedAt` and the document's `exportedAt`. */
  importedAt?: string
}

export interface SpotifyImportReport {
  doc: AegraphDocument
  projectId: EntityId
  counts: { playlists: number; tracks: number; albums: number; artists: number; genres: number; relationships: number; episodesSkipped: number; localSkipped: number }
}

/**
 * The bundle for a library: definitions, the listener, and everything
 * reached from the chosen parts. A thing met twice (a track on two
 * playlists, an artist on many tracks) is one entity; the fuller object
 * wins where the API gave both a simplified and a full one.
 */
export function spotifyToBundle(lib: SpotifyLibrary, opts: SpotifyImportOptions = {}): SpotifyImportReport {
  const importedAt = opts.importedAt ?? new Date().toISOString()
  const meta = { source: SPOTIFY_SOURCE }
  const entities = new Map<EntityId, AnyEntity>()
  const rels: AnyEntity[] = []
  const put = (e: AnyEntity) => entities.set(e.id, e)
  const relIds = new Set<EntityId>()
  const rel = (type: string, source: EntityId, target: EntityId, data: Record<string, unknown> = {}, suffix = '') => {
    const id = `${source}→${type}→${target}${suffix}`
    if (relIds.has(id)) return
    relIds.add(id)
    rels.push(createRelationship({ id, type, source, target, tags: [SPOTIFY_TAG], data: strip(data), meta }))
  }
  const counts = { episodesSkipped: 0, localSkipped: 0 }

  // Fuller objects first, so a simplified one met later does not overwrite them.
  const fullArtists = new Map<string, SpotifyArtist>()
  const fullAlbums = new Map<string, SpotifyAlbum>()
  const fullTracks = new Map<string, SpotifyTrack>()
  const note = (list: SpotifyArtist[] | undefined) => list?.forEach((a) => a.id && (a.genres || a.popularity !== undefined) && fullArtists.set(a.id, a))
  note(lib.artistDetails)
  note(lib.followedArtists)
  for (const r of Object.values(lib.topArtists ?? {})) note(r)
  lib.albumDetails?.forEach((a) => a.id && fullAlbums.set(a.id, a))
  lib.savedAlbums?.forEach((s) => s.album?.id && fullAlbums.set(s.album.id, s.album))
  // The same for tracks: a saved album lists its tracks simplified (no popularity, ISRC or album), and whichever
  // came first used to win — so a top track that also sits on a saved album arrived stripped of what it was ranked by.
  const noteTrack = (t: SpotifyTrack | null | undefined) => t?.id && (t.popularity !== undefined || t.external_ids || t.album) && fullTracks.set(t.id, t)
  lib.playlists?.forEach(({ items }) => items.forEach((it) => noteTrack(it.item ?? it.track)))
  lib.savedTracks?.forEach((s) => noteTrack(s.track))
  for (const r of Object.values(lib.topTracks ?? {})) r.forEach(noteTrack)

  const genreArtists = new Map<EntityId, { label: string; artists: Set<EntityId> }>()

  const artist = (a: SpotifyArtist): EntityId | undefined => {
    if (!a?.id) return undefined
    const id = spotifyId('artist', a.id)
    if (entities.has(id)) return id
    const full = fullArtists.get(a.id) ?? a
    {
      const genres = full.genres ?? []
      put(
        createEntity({
          id,
          type: SPOTIFY_TYPES.artist,
          label: full.name,
          tags: [SPOTIFY_TAG, ...genres],
          data: strip({ genres: genres.length ? genres : undefined, popularity: full.popularity, followers: full.followers?.total, image: largestImage(full.images), url: full.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}` }),
          meta,
        }),
      )
      for (const g of genres) {
        const gid = genreId(g)
        const entry = genreArtists.get(gid) ?? { label: g, artists: new Set() }
        if (!entry.artists.has(id)) {
          entry.artists.add(id)
          rel(SPOTIFY_RELATIONSHIPS.inGenre, id, gid)
        }
        genreArtists.set(gid, entry)
      }
    }
    return id
  }

  const album = (al: SpotifyAlbum): EntityId | undefined => {
    if (!al?.id) return undefined
    const id = spotifyId('album', al.id)
    if (entities.has(id)) return id
    const full = fullAlbums.get(al.id) ?? al
    {
      put(
        createEntity({
          id,
          type: SPOTIFY_TYPES.album,
          label: full.name,
          tags: [SPOTIFY_TAG],
          data: strip({
            artists: names(full.artists),
            albumType: full.album_type,
            releaseDate: full.release_date,
            releaseYear: year(full.release_date),
            releasePrecision: full.release_date_precision,
            totalTracks: full.total_tracks,
            recordLabel: full.label,
            popularity: full.popularity,
            image: largestImage(full.images),
            url: full.external_urls?.spotify ?? `https://open.spotify.com/album/${al.id}`,
          }),
          meta,
        }),
      )
      ;(full.artists ?? []).forEach((a, i) => {
        const aid = artist(a)
        if (aid) rel(SPOTIFY_RELATIONSHIPS.performedBy, id, aid, { position: i + 1 })
      })
    }
    return id
  }

  const track = (t: SpotifyTrack | null | undefined): EntityId | undefined => {
    if (!t) return undefined
    if (t.type === 'episode') {
      counts.episodesSkipped++
      return undefined
    }
    if (t.is_local || !t.id) {
      counts.localSkipped++
      return undefined
    }
    const id = spotifyId('track', t.id)
    if (entities.has(id)) return id
    const full = fullTracks.get(t.id) ?? t
    const ms = full.duration_ms ?? t.duration_ms
    put(
      createEntity({
        id,
        type: SPOTIFY_TYPES.track,
        label: full.name || t.name,
        tags: [SPOTIFY_TAG],
        data: strip({
          artists: names(full.artists ?? t.artists),
          album: full.album?.name ?? t.album?.name,
          releaseDate: full.album?.release_date ?? t.album?.release_date,
          releaseYear: year(full.album?.release_date ?? t.album?.release_date),
          duration: ms !== undefined ? mmss(ms) : undefined,
          durationMs: ms,
          popularity: full.popularity,
          explicit: full.explicit ?? t.explicit,
          trackNumber: full.track_number ?? t.track_number,
          discNumber: full.disc_number ?? t.disc_number,
          isrc: full.external_ids?.isrc,
          previewUrl: full.preview_url ?? t.preview_url ?? undefined,
          url: full.external_urls?.spotify ?? t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
        }),
        meta,
      }),
    )
    ;(full.artists ?? t.artists ?? []).forEach((a, i) => {
      const aid = artist(a)
      if (aid) rel(SPOTIFY_RELATIONSHIPS.performedBy, id, aid, { position: i + 1 })
    })
    const al = full.album ?? t.album
    if (al) {
      const alid = album(al)
      if (alid) rel(SPOTIFY_RELATIONSHIPS.appearsOn, id, alid)
    }
    return id
  }

  // The listener.
  const u = lib.user
  const me = spotifyId('user', u.id)
  put(
    createEntity({
      id: me,
      type: SPOTIFY_TYPES.listener,
      label: u.display_name || u.id,
      tags: [SPOTIFY_TAG],
      data: strip({ spotifyId: u.id, country: u.country, product: u.product, followers: u.followers?.total, image: largestImage(u.images), url: u.external_urls?.spotify ?? `https://open.spotify.com/user/${u.id}`, importedAt }),
      meta,
    }),
  )

  for (const { playlist: p, items } of lib.playlists ?? []) {
    const pid = spotifyId('playlist', p.id)
    put(
      createEntity({
        id: pid,
        type: SPOTIFY_TYPES.playlist,
        label: p.name,
        description: p.description || undefined,
        tags: [SPOTIFY_TAG],
        data: strip({
          ownerName: p.owner?.display_name || p.owner?.id,
          ownerId: p.owner?.id,
          trackCount: p.tracks?.total ?? items.length,
          public: p.public ?? undefined,
          collaborative: p.collaborative,
          followers: p.followers?.total,
          snapshotId: p.snapshot_id,
          image: largestImage(p.images),
          url: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}`,
        }),
        meta,
      }),
    )
    rel(p.owner?.id === u.id || !p.owner ? SPOTIFY_RELATIONSHIPS.owns : SPOTIFY_RELATIONSHIPS.followsPlaylist, me, pid)
    items.forEach((it, i) => {
      const tid = track(it.item ?? it.track)
      // A playlist can hold one track twice: the position keeps both.
      if (tid) rel(SPOTIFY_RELATIONSHIPS.includes, pid, tid, { position: i + 1, addedAt: it.added_at ?? undefined, addedBy: it.added_by?.id }, `#${i + 1}`)
    })
  }

  for (const s of lib.savedTracks ?? []) {
    const tid = track(s.track)
    if (tid) rel(SPOTIFY_RELATIONSHIPS.saved, me, tid, { addedAt: s.added_at })
  }
  for (const s of lib.savedAlbums ?? []) {
    const alid = s.album && album(s.album)
    if (!alid) continue
    rel(SPOTIFY_RELATIONSHIPS.saved, me, alid, { addedAt: s.added_at })
    // A full album carries its tracks (simplified: no album on them); link them to it.
    const tracks = (s.album as SpotifyAlbum & { tracks?: { items?: SpotifyTrack[] } }).tracks?.items ?? []
    for (const t of tracks) {
      const tid = track({ ...t, album: t.album ?? s.album })
      if (tid) rel(SPOTIFY_RELATIONSHIPS.appearsOn, tid, alid)
    }
  }
  for (const a of lib.followedArtists ?? []) {
    const aid = artist(a)
    if (aid) rel(SPOTIFY_RELATIONSHIPS.follows, me, aid)
  }
  for (const [range, list] of Object.entries(lib.topArtists ?? {}) as [TopRange, SpotifyArtist[]][]) {
    list.forEach((a, i) => {
      const aid = artist(a)
      if (aid) rel(SPOTIFY_RELATIONSHIPS.top, me, aid, { rank: i + 1, range, rangeLabel: RANGE_LABEL[range] }, `#${range}`)
    })
  }
  for (const [range, list] of Object.entries(lib.topTracks ?? {}) as [TopRange, SpotifyTrack[]][]) {
    list.forEach((t, i) => {
      const tid = track(t)
      if (tid) rel(SPOTIFY_RELATIONSHIPS.top, me, tid, { rank: i + 1, range, rangeLabel: RANGE_LABEL[range] }, `#${range}`)
    })
  }

  for (const [gid, { label, artists }] of genreArtists) put(createEntity({ id: gid, type: SPOTIFY_TYPES.genre, label, tags: [SPOTIFY_TAG], data: { artistCount: artists.size }, meta }))

  const byType = (t: string) => [...entities.values()].filter((e) => e.type === t).length
  const projectId = spotifyProjectId(u.id)
  const project = createProject({
    id: projectId,
    label: `Spotify · ${u.display_name || u.id}`,
    description: `${u.display_name || u.id}’s Spotify library: ${byType(SPOTIFY_TYPES.playlist)} playlists, ${byType(SPOTIFY_TYPES.track)} tracks, ${byType(SPOTIFY_TYPES.album)} albums, ${byType(SPOTIFY_TYPES.artist)} artists, ${byType(SPOTIFY_TYPES.genre)} genres.`,
    source: SPOTIFY_SOURCE,
    home: { route: '/workstation' },
  })
  project.tags = [SPOTIFY_TAG]

  const all = [...spotifyOntology(), ...entities.values(), ...rels, project]
  const doc: AegraphDocument = {
    $schema: 'aegraph/v1',
    exportedAt: importedAt,
    tags: [{ tag: SPOTIFY_TAG, color: '#b7f0c9', description: 'Imported from Spotify' }],
    entities: all,
    project: projectId,
    state: { route: '/workstation', ui: { 'aegraph:workstation:v1': JSON.stringify({ ws: spotifyWorkstation(), dirty: false }) } },
  }
  return {
    doc,
    projectId,
    counts: {
      playlists: byType(SPOTIFY_TYPES.playlist),
      tracks: byType(SPOTIFY_TYPES.track),
      albums: byType(SPOTIFY_TYPES.album),
      artists: byType(SPOTIFY_TYPES.artist),
      genres: byType(SPOTIFY_TYPES.genre),
      relationships: rels.length,
      ...counts,
    },
  }
}
