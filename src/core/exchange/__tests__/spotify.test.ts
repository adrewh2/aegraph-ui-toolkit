import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { isRelationship } from '../../entity/types'
import { importBundle } from '../../projects/bundle'
import { SPOTIFY_RELATIONSHIPS, SPOTIFY_TYPES, genreId, spotifyId, spotifyOntology, spotifyToBundle, type SpotifyAlbum, type SpotifyArtist, type SpotifyLibrary, type SpotifyTrack } from '../spotify'
import '../../resources/types'

const artist = (id: string, name: string, full?: Partial<SpotifyArtist>): SpotifyArtist => ({ id, name, ...full })
const album = (id: string, name: string, artists: SpotifyArtist[], extra: Partial<SpotifyAlbum> = {}): SpotifyAlbum => ({ id, name, album_type: 'album', release_date: '1997-06-16', release_date_precision: 'day', total_tracks: 12, artists, images: [{ url: 'https://i/small', width: 64 }, { url: 'https://i/big', width: 640 }], ...extra })
const track = (id: string, name: string, artists: SpotifyArtist[], al: SpotifyAlbum, extra: Partial<SpotifyTrack> = {}): SpotifyTrack => ({ id, name, type: 'track', duration_ms: 245_000, explicit: false, popularity: 70, track_number: 3, disc_number: 1, external_ids: { isrc: 'GBAYE9700123' }, album: al, artists, ...extra })

const radiohead = artist('4Z8W4fKeB5YxbusRsdQVPb', 'Radiohead')
const radioheadFull = artist('4Z8W4fKeB5YxbusRsdQVPb', 'Radiohead', { genres: ['art rock', 'alternative rock'], popularity: 82, followers: { total: 9_000_000 } })
const portishead = artist('6liAMWkVf5LH7YR9yfFy1Y', 'Portishead', { genres: ['trip hop'], popularity: 70 })
const okc = album('6dVIqQ8qmQ5GBnJ9shOYGE', 'OK Computer', [radiohead])
const dummy = album('3539EbNgIdEDGBKkUf4wno', 'Dummy', [portishead], { release_date: '1994', release_date_precision: 'year', label: 'Go! Beat' })
const airbag = track('4rQu2oAhtAyR1ZUR8ZKhSc', 'Airbag', [radiohead], okc)
const karma = track('63OQupATfueTdZMWTxW03A', 'Karma Police', [radiohead], okc, { track_number: 6, explicit: false })
const sourTimes = track('3RQtn4zuVFiSlXPdhHf4At', 'Sour Times', [portishead], dummy, { popularity: 60 })

const lib: SpotifyLibrary = {
  user: { id: 'andrew', display_name: 'Andrew', country: 'US', product: 'premium', followers: { total: 3 } },
  playlists: [
    {
      playlist: { id: 'pl1', name: 'Night drive', description: 'late', public: false, collaborative: false, owner: { id: 'andrew', display_name: 'Andrew' }, tracks: { total: 3 }, snapshot_id: 'snap' },
      items: [
        { added_at: '2024-01-02T00:00:00Z', added_by: { id: 'andrew' }, item: airbag },
        { added_at: '2024-01-03T00:00:00Z', added_by: { id: 'andrew' }, track: sourTimes },
        // A podcast episode and a local file are skipped, the position still counts them.
        { added_at: '2024-01-04T00:00:00Z', item: { id: 'ep1', name: 'An episode', type: 'episode' } },
        { added_at: '2024-01-05T00:00:00Z', item: { id: '', name: 'Local demo', is_local: true } },
        // The same track twice keeps both positions.
        { added_at: '2024-01-06T00:00:00Z', item: airbag },
      ],
    },
    { playlist: { id: 'pl2', name: "Someone else's", owner: { id: 'friend', display_name: 'Friend' }, tracks: { total: 1 } }, items: [{ item: karma }] },
  ],
  savedTracks: [{ added_at: '2023-05-05T00:00:00Z', track: karma }],
  savedAlbums: [{ added_at: '2023-06-06T00:00:00Z', album: { ...dummy, popularity: 66, tracks: { items: [{ id: sourTimes.id, name: sourTimes.name, artists: [portishead], track_number: 3 }] } } as SpotifyAlbum }],
  followedArtists: [radioheadFull],
  topArtists: { short_term: [radioheadFull, portishead], long_term: [portishead] },
  topTracks: { medium_term: [karma, airbag] },
  artistDetails: [],
}

describe('spotifyToBundle', () => {
  const { doc, counts, projectId } = spotifyToBundle(lib, { importedAt: '2026-09-18T00:00:00Z' })
  const byId = new Map(doc.entities.map((e) => [e.id, e]))

  it('is a project bundle with the ontology, one entity per Spotify thing, and Spotify URIs as ids', () => {
    expect(doc.$schema).toBe('aegraph/v1')
    expect(doc.project).toBe(projectId)
    expect(projectId).toBe('spotify:project:andrew')
    expect(doc.state?.route).toBe('/workstation')
    expect(doc.state?.ui?.['aegraph:workstation:v1']).toContain('/ontology')
    expect(doc.entities.filter((e) => e.type === 'schema:type').length).toBe(spotifyOntology().length)
    expect(counts).toMatchObject({ playlists: 2, tracks: 3, albums: 2, artists: 2, genres: 3, episodesSkipped: 1, localSkipped: 1 })
    expect(byId.get(spotifyId('track', airbag.id))?.label).toBe('Airbag')
    expect(byId.get(spotifyId('album', okc.id))?.label).toBe('OK Computer')
    expect(byId.get(genreId('art rock'))?.label).toBe('art rock')
  })

  it('carries the fuller object: genres from followed/top artists, the label from a saved album, the largest image', () => {
    const rh = byId.get(spotifyId('artist', radiohead.id))!
    expect(rh.data.genres).toEqual(['art rock', 'alternative rock'])
    expect(rh.tags).toEqual(['spotify', 'art rock', 'alternative rock'])
    expect(rh.data.followers).toBe(9_000_000)
    const dm = byId.get(spotifyId('album', dummy.id))!
    expect(dm.data).toMatchObject({ recordLabel: 'Go! Beat', popularity: 66, releaseDate: '1994', releaseYear: 1994, releasePrecision: 'year', image: 'https://i/big', artists: 'Portishead' })
    const st = byId.get(spotifyId('track', sourTimes.id))!
    expect(st.data).toMatchObject({ artists: 'Portishead', album: 'Dummy', releaseYear: 1994, duration: '4:05', durationMs: 245_000, isrc: 'GBAYE9700123', url: `https://open.spotify.com/track/${sourTimes.id}` })
  })

  it('links everything: includes in order with positions, performed-by, appears-on, in-genre, owns / follows-playlist, saved, follows, top per range', () => {
    const rels = doc.entities.filter(isRelationship)
    const of = (type: string) => rels.filter((r) => r.type === type)
    const me = spotifyId('user', 'andrew')
    const pl1 = spotifyId('playlist', 'pl1')
    const inc = of(SPOTIFY_RELATIONSHIPS.includes).filter((r) => r.source.id === pl1)
    expect(inc.map((r) => [r.target.id, r.data.position])).toEqual([
      [spotifyId('track', airbag.id), 1],
      [spotifyId('track', sourTimes.id), 2],
      [spotifyId('track', airbag.id), 5],
    ])
    expect(inc[0].data.addedAt).toBe('2024-01-02T00:00:00Z')
    expect(of(SPOTIFY_RELATIONSHIPS.performedBy).map((r) => `${r.source.id}→${r.target.id}`).sort()).toEqual(
      [
        `${spotifyId('track', airbag.id)}→${spotifyId('artist', radiohead.id)}`,
        `${spotifyId('track', sourTimes.id)}→${spotifyId('artist', portishead.id)}`,
        `${spotifyId('track', karma.id)}→${spotifyId('artist', radiohead.id)}`,
        `${spotifyId('album', okc.id)}→${spotifyId('artist', radiohead.id)}`,
        `${spotifyId('album', dummy.id)}→${spotifyId('artist', portishead.id)}`,
      ].sort(),
    )
    expect(of(SPOTIFY_RELATIONSHIPS.appearsOn).length).toBe(3)
    expect(of(SPOTIFY_RELATIONSHIPS.inGenre).map((r) => r.target.id).sort()).toEqual([genreId('alternative rock'), genreId('art rock'), genreId('trip hop')])
    expect(of(SPOTIFY_RELATIONSHIPS.owns).map((r) => r.target.id)).toEqual([pl1])
    expect(of(SPOTIFY_RELATIONSHIPS.followsPlaylist).map((r) => r.target.id)).toEqual([spotifyId('playlist', 'pl2')])
    expect(of(SPOTIFY_RELATIONSHIPS.saved).map((r) => [r.target.id, r.data.addedAt])).toEqual([
      [spotifyId('track', karma.id), '2023-05-05T00:00:00Z'],
      [spotifyId('album', dummy.id), '2023-06-06T00:00:00Z'],
    ])
    expect(of(SPOTIFY_RELATIONSHIPS.follows).map((r) => r.target.id)).toEqual([spotifyId('artist', radiohead.id)])
    const top = of(SPOTIFY_RELATIONSHIPS.top).map((r) => [r.target.id, r.data.range, r.data.rank])
    expect(top).toContainEqual([spotifyId('artist', portishead.id), 'short_term', 2])
    expect(top).toContainEqual([spotifyId('artist', portishead.id), 'long_term', 1])
    expect(top).toContainEqual([spotifyId('track', airbag.id), 'medium_term', 2])
    expect(rels.every((r) => r.source.id === me || byId.has(r.source.id))).toBe(true)
    expect(rels.every((r) => byId.has(r.target.id))).toBe(true)
    // No relationship is minted twice.
    expect(new Set(rels.map((r) => r.id)).size).toBe(rels.length)
    expect(counts.relationships).toBe(rels.length)
  })

  it('imports as a project whose types the registry resolves — relationship vocabulary as such — and re-imports without duplicating', () => {
    const store = new EntityStore()
    const r1 = importBundle(store, doc, { name: 'spotify' })
    expect(r1.project.label).toBe('Spotify · Andrew')
    expect(r1.created).toBe(doc.entities.length)
    const reg = new TypeRegistry(store)
    expect(reg.get(SPOTIFY_TYPES.track).origin).toBe('schema')
    expect(reg.get(SPOTIFY_TYPES.track).color).toBe('#2563eb')
    expect(reg.fieldsFor(SPOTIFY_TYPES.track).map((f) => f.key)).toContain('data.releaseYear')
    expect(reg.get(SPOTIFY_RELATIONSHIPS.top).kind).toBe('relationship')
    expect(reg.relationshipTypes().map((t) => t.type)).toContain(SPOTIFY_RELATIONSHIPS.includes)
    expect(reg.all().filter((t) => t.kind !== 'relationship').map((t) => t.type)).not.toContain(SPOTIFY_RELATIONSHIPS.includes)
    const again = spotifyToBundle(lib, { importedAt: '2026-09-19T00:00:00Z' })
    const r2 = importBundle(store, again.doc, { name: 'spotify' })
    expect(r2.created).toBe(0)
    expect(store.library.all().filter((e) => e.type === SPOTIFY_TYPES.track).length).toBe(3)
  })
})
