import { useSyncExternalStore } from 'react'
import type { EntityStore } from '../../core/entity/store'
import { spotifyToBundle, type SpotifyImportReport } from '../../core/exchange/spotify'
import { openBundleText } from '../projects/projectActions'
import { setSpotifyWaitListener } from './auth'
import { fetchSpotifyLibrary, type SpotifyParts } from './client'

/**
 * One Spotify import at a time, run outside any page so it survives
 * navigation and shows in a dialog wherever the user is. The dialog reads
 * this state; the card only starts it.
 */

export interface SpotifyImportRun {
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  endedAt?: number
  /** What is happening now. */
  label: string
  done: number
  total: number
  detail?: string
  /** Spotify said 429: the pause being waited out, and which retry this is. */
  waiting?: { seconds: number; attempt: number }
  /** Phases finished so far, one line each. */
  steps: string[]
  error?: string
  result?: { user: string; counts: SpotifyImportReport['counts']; created: number; updated: number; withheld: string[] }
}

let run: SpotifyImportRun | null = null
let controller: AbortController | null = null
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}
const set = (patch: Partial<SpotifyImportRun>) => {
  if (!run) return
  run = { ...run, ...patch }
  emit()
}

export const getSpotifyImport = () => run
export const subscribeSpotifyImport = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
export const useSpotifyImport = () => useSyncExternalStore(subscribeSpotifyImport, getSpotifyImport, () => null)

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

/** Starts the import; a no-op while one is running. */
export function startSpotifyImport(store: EntityStore, parts: SpotifyParts) {
  if (run?.status === 'running') return
  controller = new AbortController()
  run = { status: 'running', startedAt: Date.now(), label: 'Starting', done: 0, total: 1, steps: [] }
  emit()
  const signal = controller.signal
  let current: { label: string; done: number; total: number } | null = null
  // A phase that gave way to the next one finished whole; one cut short by an error shows how far it got.
  const closeStep = (finished = true) => {
    if (!current || !run) return
    const done = finished ? Math.max(current.done, current.total) : current.done
    const n = done > 1 ? ` — ${done.toLocaleString()}${current.total > done ? ` of ${current.total.toLocaleString()}` : ''}` : ''
    run = { ...run, steps: [...run.steps, `${current.label.replace(/^Spotify: /, '')}${n}`] }
  }
  setSpotifyWaitListener((seconds, attempt) => set({ waiting: seconds > 0 ? { seconds, attempt } : undefined }))
  ;(async () => {
    try {
      const lib = await fetchSpotifyLibrary(
        parts,
        (p) => {
          if (current && current.label !== p.label) closeStep()
          current = { label: p.label, done: p.done, total: p.total }
          set({ label: p.label, done: p.done, total: p.total, detail: p.detail })
        },
        signal,
      )
      closeStep()
      current = null
      set({ label: 'Building the graph', done: 0, total: 1, detail: undefined })
      const { doc, counts } = spotifyToBundle(lib)
      set({ label: 'Writing the project', done: 0, total: 1 })
      const r = await openBundleText(store, JSON.stringify(doc), `spotify-${lib.user.id}`, 'spotify')
      set({
        status: 'done',
        endedAt: Date.now(),
        label: 'Done',
        done: 1,
        total: 1,
        result: { user: lib.user.display_name || lib.user.id, counts, created: r.created, updated: r.updated, withheld: lib.withheldPlaylists ?? [] },
      })
    } catch (err) {
      closeStep(false)
      const msg = err instanceof Error ? err.message : String(err)
      set(signal.aborted ? { status: 'cancelled', endedAt: Date.now(), label: 'Stopped' } : { status: 'failed', endedAt: Date.now(), label: 'Failed', error: msg })
    } finally {
      controller = null
      setSpotifyWaitListener(null)
      set({ waiting: undefined })
    }
  })()
}

export function cancelSpotifyImport() {
  controller?.abort()
}

/** Closes a finished run's dialog. */
export function dismissSpotifyImport() {
  if (run && run.status !== 'running') {
    run = null
    emit()
  }
}

export function describeSpotifyResult(r: NonNullable<SpotifyImportRun['result']>): string {
  const c = r.counts
  return `${plural(c.playlists, 'playlist')}, ${plural(c.tracks, 'track')}, ${plural(c.albums, 'album')}, ${plural(c.artists, 'artist')}, ${plural(c.genres, 'genre')}, ${plural(c.relationships, 'relationship')} · ${r.created.toLocaleString()} new, ${r.updated.toLocaleString()} updated`
}
