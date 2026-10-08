import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '../../components/ui/Dialog'
import { cancelSpotifyImport, describeSpotifyResult, dismissSpotifyImport, useSpotifyImport } from './importer'
import './spotify.css'

const elapsed = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/**
 * The Spotify import, front and centre wherever the user is: what it is
 * fetching now, the phases done, the time, a Stop button; then the
 * result or the error. Blocking on purpose — leaving the page mid-run
 * would lose the run. Mounted once, in App.
 */
export function SpotifyImportDialog() {
  const run = useSpotifyImport()
  const navigate = useNavigate()
  // The clock, once a second while running.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (run?.status !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [run?.status])
  if (!run) return null
  const running = run.status === 'running'
  const pct = run.total > 1 ? Math.min(100, (run.done / run.total) * 100) : running ? undefined : 100
  const title = running ? 'Importing your Spotify library' : run.status === 'done' ? 'Spotify library imported' : run.status === 'cancelled' ? 'Spotify import stopped' : 'Spotify import failed'
  const close = () => {
    if (!running) dismissSpotifyImport()
  }
  return (
    <Dialog
      open
      title={title}
      description={running ? 'Stay on this tab — the project is written when everything has arrived. Stop keeps nothing.' : undefined}
      onClose={close}
      className="spotify-import"
      footer={
        running ? (
          <button className="btn" onClick={cancelSpotifyImport}>
            Stop
          </button>
        ) : (
          <>
            {run.status === 'done' && (
              <button className="btn btn--primary" onClick={() => (dismissSpotifyImport(), navigate('/workstation'))}>
                Open the project
              </button>
            )}
            <button className="btn" onClick={close}>
              Close
            </button>
          </>
        )
      }
    >
      <div className="spotify-import__now">
        <span>{run.label.replace(/^Spotify: /, '')}</span>
        <span className="muted">{[run.detail ?? (run.total > 1 ? `${run.done.toLocaleString()} / ${run.total.toLocaleString()}` : ''), elapsed((run.endedAt ?? now) - run.startedAt)].filter(Boolean).join(' · ')}</span>
      </div>
      <div className={`spotify-import__bar${pct === undefined ? ' spotify-import__bar--busy' : ''}`}>
        <div className="spotify-import__fill" style={{ width: `${pct ?? 30}%` }} />
      </div>
      {run.waiting && (
        <p className="spotify-import__wait">
          Spotify asked for a pause (429 Too Many Requests) — waiting {run.waiting.seconds}s before retry {run.waiting.attempt}. Development-mode apps have a small quota; the import slows itself down after this.
        </p>
      )}
      {run.steps.length > 0 && (
        <ul className="spotify-import__steps">
          {run.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      {run.status === 'done' && run.result && (
        <p className="spotify-import__result">
          <strong>Spotify · {run.result.user}</strong> is open: {describeSpotifyResult(run.result)}.
          {run.result.withheld.length > 0 && (
            <>
              {' '}
              Spotify withheld the tracks of {run.result.withheld.length} playlist{run.result.withheld.length === 1 ? '' : 's'} (its own editorial ones are closed to newer apps): {run.result.withheld.slice(0, 8).join(', ')}
              {run.result.withheld.length > 8 ? ', …' : ''}.
            </>
          )}
        </p>
      )}
      {run.status === 'failed' && <p className="error-text">{run.error}</p>}
      {run.status === 'cancelled' && <p className="muted">Nothing was written.</p>}
    </Dialog>
  )
}
