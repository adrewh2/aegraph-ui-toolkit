import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { completeSpotifyLogin } from './auth'

/**
 * Where Spotify sends the browser back after consent (`/spotify/callback`):
 * the code in the URL becomes tokens, then it is the Projects dialog again
 * with a word on how it went.
 */
export function SpotifyCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    completeSpotifyLogin(new URLSearchParams(location.search))
      .then(({ back }) => navigate(`${back}${back.includes('?') ? '&' : '?'}spotify=connected`, { replace: true }))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        navigate(`/datasets?spotify=error:${encodeURIComponent(msg)}`, { replace: true })
      })
  }, [navigate])
  return <div className="page-loading">{error ? `Spotify sign-in failed: ${error}` : 'Finishing the Spotify sign-in…'}</div>
}
