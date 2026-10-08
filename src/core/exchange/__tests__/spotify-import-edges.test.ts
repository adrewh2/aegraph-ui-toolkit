import { describe, expect, it } from 'vitest'
import { isRelationship, type AnyEntity } from '../../entity/types'
import { SPOTIFY_RELATIONSHIPS, SPOTIFY_TYPES, genreId, spotifyId, spotifyToBundle, type SpotifyAlbum, type SpotifyArtist, type SpotifyLibrary, type SpotifyTrack } from '../spotify'
import '../../resources/types'

/**
 * The Spotify import where a real library is ragged: a playlist with no
 * tracks or with a null item, a track with no album or no artists, the same
 * artist listed twice, a track on two playlists, ids that collide across
 * kinds, names with emoji and names far too long, release dates of a year, a
 * month and a day, popularity of zero against no popularity at all, a saved
 * album whose album is missing, a listener with no display name, and a
 * thousand tracks for shape and time.
 */
const art = (id: string, name: string, extra: Partial<SpotifyArtist> = {}): SpotifyArtist => ({ id, name, ...extra })
const alb = (id: string, name: string, artists: SpotifyArtist[], extra: Partial<SpotifyAlbum> = {}): SpotifyAlbum => ({ id, name, album_type: 'album', release_date: '2001-02-03', release_date_precision: 'day', total_tracks: 1, artists, ...extra })
const trk = (id: string, name: string, artists: SpotifyArtist[], album: SpotifyAlbum | undefined, extra: Partial<SpotifyTrack> = {}): SpotifyTrack => ({ id, name, type: 'track', duration_ms: 60_000, artists, ...(album ? { album } : {}), ...extra }) as SpotifyTrack
const user = { id: 'me', display_name: 'Me' }
const run = (lib: Partial<SpotifyLibrary>) => spotifyToBundle({ user, ...lib } as SpotifyLibrary, { importedAt: '2026-09-19T00:00:00Z' })
const relsOf = (doc: { entities: AnyEntity[] }, type: string) => doc.entities.filter((e) => isRelationship(e) && e.type === type)
const ent = (doc: { entities: AnyEntity[] }, id: string) => doc.entities.find((e) => e.id === id)

describe('spotify import edges', () => {
  it('an empty library is the listener alone, with the ontology and a project named after them', () => {
    const { doc, counts, projectId } = run({})
    expect(counts).toMatchObject({ playlists: 0, tracks: 0, albums: 0, artists: 0, genres: 0, episodesSkipped: 0, localSkipped: 0 })
    expect(projectId).toBe('spotify:project:me')
    expect(ent(doc, spotifyId('user', 'me'))).toMatchObject({ label: 'Me', type: SPOTIFY_TYPES.listener })
    expect(doc.entities.filter((e) => e.id.startsWith('type:')).length).toBeGreaterThan(5)
    // No display name: the id stands in, in the entity and in the project.
    const anon = spotifyToBundle({ user: { id: 'u42' } } as SpotifyLibrary, {})
    expect(ent(anon.doc, spotifyId('user', 'u42'))?.label).toBe('u42')
    expect(ent(anon.doc, anon.projectId)?.label).toBe('Spotify · u42')
  })

  it('a playlist with no tracks is still a playlist; a null item, an episode and a local file are skipped without moving the others’ positions', () => {
    const t1 = trk('t1', 'One', [art('a1', 'A')], alb('al1', 'Album', [art('a1', 'A')]))
    const t2 = trk('t2', 'Two', [art('a1', 'A')], alb('al1', 'Album', [art('a1', 'A')]))
    const { doc, counts } = run({
      playlists: [
        { playlist: { id: 'empty', name: 'Nothing here', owner: { id: 'me' }, tracks: { total: 0 } }, items: [] },
        {
          playlist: { id: 'ragged', name: 'Ragged', owner: { id: 'me' }, tracks: { total: 5 } },
          items: [{ item: t1 }, { item: null as unknown as SpotifyTrack }, { item: { id: 'e1', name: 'Episode', type: 'episode' } as unknown as SpotifyTrack }, { item: { id: '', name: 'Local', is_local: true } as unknown as SpotifyTrack }, { item: t2 }],
        },
      ],
    })
    expect(counts.playlists).toBe(2)
    expect(counts.tracks).toBe(2)
    expect(counts).toMatchObject({ episodesSkipped: 1, localSkipped: 1 })
    expect(ent(doc, spotifyId('playlist', 'empty'))).toMatchObject({ label: 'Nothing here' })
    expect(ent(doc, spotifyId('playlist', 'empty'))?.data).toMatchObject({ trackCount: 0 })
    const includes = relsOf(doc, SPOTIFY_RELATIONSHIPS.includes)
    expect(includes.map((r) => (r.data as { position: number }).position)).toEqual([1, 5]) // the skipped rows keep their places
    expect(includes.every((r) => (r as { source: { id: string } }).source.id === spotifyId('playlist', 'ragged'))).toBe(true)
  })

  it('a track with no album or no artists still imports; the same artist twice is one entity and one link; one track on two playlists is one entity with two memberships', () => {
    const a = art('a1', 'Twice')
    const bare = trk('bare', 'No album, no artists', [], undefined)
    const dup = trk('dup', 'Same artist twice', [a, a], undefined)
    const shared = trk('sh', 'Shared', [a], alb('al', 'Al', [a]))
    const { doc, counts } = run({
      playlists: [
        { playlist: { id: 'p1', name: 'One', owner: { id: 'me' } }, items: [{ item: bare }, { item: dup }, { item: shared }] },
        { playlist: { id: 'p2', name: 'Two', owner: { id: 'me' } }, items: [{ item: shared }] },
      ],
    })
    expect(counts.tracks).toBe(3)
    expect(counts.artists).toBe(1)
    expect(ent(doc, spotifyId('track', 'bare'))?.data).not.toHaveProperty('album')
    expect(ent(doc, spotifyId('track', 'bare'))?.data).not.toHaveProperty('artists')
    expect(ent(doc, spotifyId('track', 'dup'))?.data).toMatchObject({ artists: 'Twice, Twice' })
    // The duplicate artist is linked once (the second position would be a second link to the same pair).
    expect(relsOf(doc, SPOTIFY_RELATIONSHIPS.performedBy).filter((r) => (r as { source: { id: string } }).source.id === spotifyId('track', 'dup'))).toHaveLength(1)
    expect(doc.entities.filter((e) => e.id === spotifyId('track', 'sh'))).toHaveLength(1)
    const on = relsOf(doc, SPOTIFY_RELATIONSHIPS.includes).filter((r) => (r as { target: { id: string } }).target.id === spotifyId('track', 'sh'))
    expect(on.map((r) => (r as { source: { id: string } }).source.id).sort()).toEqual([spotifyId('playlist', 'p1'), spotifyId('playlist', 'p2')])
    expect(relsOf(doc, SPOTIFY_RELATIONSHIPS.appearsOn)).toHaveLength(1)
  })

  it('the same raw id under two kinds is two entities; emoji and very long names survive; a genre of punctuation still gets a usable id', () => {
    const same = 'ABC123'
    const a = art(same, '🎧 Ártist ✨', { genres: ['j-pop', 'R&B / soul', '🎵 vibes'] })
    const long = 'x'.repeat(500)
    const al = alb(same, long, [a])
    const t = trk(same, '🎶 Track — with emoji 🚀', [a], al)
    const { doc, counts } = run({ playlists: [{ playlist: { id: same, name: '🎉 List', owner: { id: 'me' } }, items: [{ item: t }] }], artistDetails: [a] })
    for (const kind of ['track', 'album', 'artist', 'playlist'] as const) expect(ent(doc, spotifyId(kind, same)), kind).toBeDefined()
    expect(new Set([spotifyId('track', same), spotifyId('album', same), spotifyId('artist', same), spotifyId('playlist', same)]).size).toBe(4)
    expect(ent(doc, spotifyId('artist', same))?.label).toBe('🎧 Ártist ✨')
    expect(ent(doc, spotifyId('album', same))?.label).toHaveLength(500)
    expect(ent(doc, spotifyId('track', same))?.label).toContain('🚀')
    expect(counts.genres).toBe(3)
    expect(genreId('R&B / soul')).toBe('spotify:genre:r-b-soul')
    expect(ent(doc, genreId('R&B / soul'))).toMatchObject({ label: 'R&B / soul', data: { artistCount: 1 } })
    expect(ent(doc, genreId('🎵 vibes'))?.id).toBe('spotify:genre:vibes')
    // The genre tags travel on the artist as written, not slugged.
    expect(ent(doc, spotifyId('artist', same))?.tags).toEqual(['spotify', 'j-pop', 'R&B / soul', '🎵 vibes'])
  })

  it('release dates of a year, a month and a day all give a year; popularity of zero is kept and no popularity is left out; a duration reads as minutes and seconds', () => {
    const a = art('a', 'A')
    const y = alb('y', 'Year only', [a], { release_date: '1994', release_date_precision: 'year' })
    const m = alb('m', 'Year and month', [a], { release_date: '1994-07', release_date_precision: 'month' })
    const d = alb('d', 'Full date', [a], { release_date: '1994-07-21', release_date_precision: 'day' })
    const none = alb('n', 'No date', [a], { release_date: undefined, release_date_precision: undefined })
    const { doc } = run({
      playlists: [
        {
          playlist: { id: 'p', name: 'P', owner: { id: 'me' } },
          items: [
            { item: trk('t1', 'Zero', [a], y, { popularity: 0, duration_ms: 65_000 }) },
            { item: trk('t2', 'None', [a], m, { duration_ms: 3_599_000 }) },
            { item: trk('t3', 'Day', [a], d, { popularity: 100, duration_ms: 1_000 }) },
            { item: trk('t4', 'Undated', [a], none) },
          ],
        },
      ],
    })
    expect(ent(doc, spotifyId('album', 'y'))?.data).toMatchObject({ releaseDate: '1994', releaseYear: 1994, releasePrecision: 'year' })
    expect(ent(doc, spotifyId('album', 'm'))?.data).toMatchObject({ releaseDate: '1994-07', releaseYear: 1994 })
    expect(ent(doc, spotifyId('album', 'd'))?.data).toMatchObject({ releaseDate: '1994-07-21', releaseYear: 1994 })
    expect(ent(doc, spotifyId('album', 'n'))?.data).not.toHaveProperty('releaseYear')
    expect(ent(doc, spotifyId('track', 't1'))?.data).toMatchObject({ popularity: 0, duration: '1:05', durationMs: 65_000 })
    expect(ent(doc, spotifyId('track', 't2'))?.data).not.toHaveProperty('popularity')
    expect(ent(doc, spotifyId('track', 't2'))?.data).toMatchObject({ duration: '59:59' })
    expect(ent(doc, spotifyId('track', 't3'))?.data).toMatchObject({ duration: '0:01', popularity: 100 })
    expect(ent(doc, spotifyId('track', 't4'))?.data).not.toHaveProperty('releaseYear')
  })

  it('a saved album that is missing is skipped, a saved track carries its timestamp, and a playlist with no owner counts as the listener’s own', () => {
    const a = art('a', 'A')
    const al = alb('al', 'Al', [a])
    const t = trk('t', 'T', [a], al)
    const { doc, counts } = run({
      savedTracks: [{ added_at: '2023-01-01T00:00:00Z', track: t }, { added_at: '2023-01-02T00:00:00Z', track: null as unknown as SpotifyTrack }],
      savedAlbums: [{ added_at: '2023-02-02T00:00:00Z', album: null as unknown as SpotifyAlbum }, { added_at: '2023-03-03T00:00:00Z', album: al }],
      playlists: [{ playlist: { id: 'p', name: 'Ownerless' }, items: [] }],
    })
    const saved = relsOf(doc, SPOTIFY_RELATIONSHIPS.saved)
    expect(saved).toHaveLength(2)
    expect(saved.map((r) => (r.data as { addedAt: string }).addedAt).sort()).toEqual(['2023-01-01T00:00:00Z', '2023-03-03T00:00:00Z'])
    expect(counts.tracks).toBe(1)
    expect(counts.albums).toBe(1)
    expect(relsOf(doc, SPOTIFY_RELATIONSHIPS.owns)).toHaveLength(1)
    expect(relsOf(doc, SPOTIFY_RELATIONSHIPS.followsPlaylist)).toHaveLength(0)
  })

  it('a track met simplified on a saved album keeps the full object’s numbers wherever the full one appears', () => {
    const a = art('a', 'A')
    const al = alb('al', 'Al', [a])
    const full = trk('t', 'T', [a], al, { popularity: 99, external_ids: { isrc: 'GBAYE0000001' }, preview_url: 'https://p', duration_ms: 200_000, explicit: true })
    const simplified = { id: 't', name: 'T', artists: [a], track_number: 3 } as SpotifyTrack
    // The saved album is read before the top lists, so the thin copy used to be the one that stuck.
    const { doc } = run({ savedAlbums: [{ added_at: '2023-01-01T00:00:00Z', album: { ...al, tracks: { items: [simplified] } } as SpotifyAlbum }], topTracks: { short_term: [full] } })
    expect(ent(doc, spotifyId('track', 't'))?.data).toMatchObject({ popularity: 99, isrc: 'GBAYE0000001', previewUrl: 'https://p', duration: '3:20', explicit: true, trackNumber: 3 })
    expect(relsOf(doc, SPOTIFY_RELATIONSHIPS.appearsOn)).toHaveLength(1)
    // And the other way round (the full one first) is unchanged.
    const other = run({ topTracks: { short_term: [full] }, savedAlbums: [{ added_at: '2023-01-01T00:00:00Z', album: { ...al, tracks: { items: [simplified] } } as SpotifyAlbum }] })
    expect(ent(other.doc, spotifyId('track', 't'))?.data).toMatchObject({ popularity: 99, isrc: 'GBAYE0000001' })
  })

  it('a thousand tracks over ten playlists: one entity each, every link accounted for, quickly', () => {
    const artists = Array.from({ length: 50 }, (_, i) => art(`a${i}`, `Artist ${i}`, { genres: [`genre-${i % 7}`] }))
    const albums = Array.from({ length: 100 }, (_, i) => alb(`al${i}`, `Album ${i}`, [artists[i % 50]]))
    const tracks = Array.from({ length: 1000 }, (_, i) => trk(`t${i}`, `Track ${i}`, [artists[i % 50]], albums[i % 100]))
    const playlists = Array.from({ length: 10 }, (_, p) => ({ playlist: { id: `p${p}`, name: `List ${p}`, owner: { id: 'me' } }, items: tracks.slice(p * 100, p * 100 + 100).map((t) => ({ item: t })) }))
    const t0 = performance.now()
    const { doc, counts } = run({ playlists, artistDetails: artists })
    const ms = performance.now() - t0
    expect(counts).toMatchObject({ playlists: 10, tracks: 1000, albums: 100, artists: 50, genres: 7 })
    expect(new Set(doc.entities.map((e) => e.id)).size).toBe(doc.entities.length) // no id written twice
    expect(relsOf(doc, SPOTIFY_RELATIONSHIPS.includes)).toHaveLength(1000)
    expect(relsOf(doc, SPOTIFY_RELATIONSHIPS.appearsOn)).toHaveLength(1000)
    expect(relsOf(doc, SPOTIFY_RELATIONSHIPS.performedBy)).toHaveLength(1100) // one per track, one per album
    expect(relsOf(doc, SPOTIFY_RELATIONSHIPS.inGenre)).toHaveLength(50)
    expect(counts.relationships).toBe(doc.entities.filter(isRelationship).length)
    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(4000)
  })
})
