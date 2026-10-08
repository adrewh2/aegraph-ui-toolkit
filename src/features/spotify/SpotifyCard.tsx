import { BrandTile } from '../../components/icons/BrandMark'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useToast } from '../../components/ui/useToast'
import { useEntityStore } from '../../core/entity/hooks'
import { beginSpotifyLogin, getClientId, getSpotifyAuth, onSpotifyAuthChange, setClientId, signOutSpotify, spotifyRedirectUri } from './auth'
import { DEFAULT_PARTS, type SpotifyParts } from './client'
import { startSpotifyImport, useSpotifyImport } from './importer'

interface Props {
  busy: boolean
  say: (line: string) => void
}

const PART_LABELS: { key: keyof SpotifyParts; label: string; title: string }[] = [
  { key: 'playlists', label: 'playlists', title: 'Every playlist in your library, with its tracks in order' },
  { key: 'savedTracks', label: 'liked songs', title: 'Your Library › Liked Songs' },
  { key: 'savedAlbums', label: 'saved albums', title: 'Your Library › Albums, with their tracks' },
  { key: 'followedArtists', label: 'followed artists', title: 'Artists you follow' },
  { key: 'top', label: 'top artists & tracks', title: 'Your top 50 artists and tracks over 4 weeks, 6 months and all time' },
  { key: 'artistDetails', label: 'artist genres', title: 'One extra call per 50 artists: genres, popularity, followers for artists met on tracks' },
  { key: 'albumDetails', label: 'album labels', title: 'One extra call per 20 albums: record label and popularity for albums met on tracks' },
]

/**
 * Spotify → a project. Sign in with your own Spotify app's Client ID
 * (PKCE, nothing leaves the browser but the calls to Spotify), pick what
 * to bring, and the library becomes an ontology of listener, playlists,
 * tracks, albums, artists and genres with the relationships among them.
 * A second import updates the same entities (ids are Spotify URIs).
 */
export function SpotifyCard({ busy, say }: Props) {
  const store = useEntityStore()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const auth = useSyncExternalStore(onSpotifyAuthChange, getSpotifyAuth, () => null)
  const [clientId, setClient] = useState(getClientId)
  const [parts, setParts] = useState<SpotifyParts>(DEFAULT_PARTS)
  // The run itself lives in the importer and shows in the app-level dialog (SpotifyImportDialog), so leaving this page does not lose it.
  const working = useSpotifyImport()?.status === 'running'

  // Back from the callback page: say how it went, once.
  useEffect(() => {
    const s = params.get('spotify')
    if (!s) return
    if (s === 'connected') toast('Spotify connected')
    else if (s.startsWith('error:')) {
      say(`Spotify sign-in: ${s.slice(6)}`)
      toast('Spotify sign-in failed — see the activity log')
    }
    params.delete('spotify')
    setParams(params, { replace: true })
  }, [params, setParams, say, toast])

  const signIn = () => {
    setClientId(clientId)
    beginSpotifyLogin(clientId).catch((err) => {
      say(`Spotify: ${err instanceof Error ? err.message : String(err)}`)
      toast('Could not start the Spotify sign-in')
    })
  }

  const redirect = spotifyRedirectUri()
  const loopbackWarning = /^http:\/\/localhost/.test(redirect)

  return (
    <section className="ds__card">
      <header>
        <BrandTile brand="spotify" />
        <div>
          <h2>Spotify</h2>
          <p>
            Your library as a graph: playlists and the tracks in them, in order; the artists and albums behind every track, with release dates, labels, popularity; the genres Spotify gives your artists; what you follow, saved and play most. Six entity types, nine relationship types, an ontology you can open on the Ontology page and draw in the Graph Explorer. Calls go from this browser to Spotify and nowhere else.
          </p>
        </div>
      </header>
      {!auth ? (
        <div className="ds__actions">
          <input className="input" style={{ flex: '1 1 220px', minWidth: 180 }} placeholder="Spotify app Client ID" value={clientId} disabled={busy} onChange={(e) => setClient(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && clientId.trim() && signIn()} spellCheck={false} />
          <button className="btn btn--primary" disabled={busy || !clientId.trim()} onClick={signIn}>
            Connect Spotify
          </button>
          <p className="muted" style={{ flexBasis: '100%', margin: 0, fontSize: 12, lineHeight: 1.5 }}>
            Create an app at <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">developer.spotify.com</a> (Web API), add <code style={{ wordBreak: 'break-all' }}>{redirect}</code> as a redirect URI, and paste its Client ID here.{' '}
            {loopbackWarning ? (
              <>
                Spotify refuses <code>localhost</code> — open this page at <code style={{ wordBreak: 'break-all' }}>{redirect.replace('localhost', '127.0.0.1')}</code> instead.
              </>
            ) : null}
          </p>
        </div>
      ) : (
        <div className="ds__actions">
          <button className="btn btn--primary" disabled={busy || working} onClick={() => startSpotifyImport(store, parts)}>
            Import library
          </button>
          {PART_LABELS.map((p) => (
            <label key={p.key} className="ds__inline" title={p.title}>
              <input type="checkbox" checked={parts[p.key]} disabled={busy} onChange={(e) => setParts({ ...parts, [p.key]: e.target.checked })} /> {p.label}
            </label>
          ))}
          <span className="spacer" />
          <button className="btn btn--sm" disabled={working} onClick={() => (signOutSpotify(), say('Spotify: signed out (tokens forgotten)'))} title="Forget the Spotify tokens kept in this browser">
            Sign out
          </button>
        </div>
      )}
    </section>
  )
}
