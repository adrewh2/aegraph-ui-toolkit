import { useState, type ReactNode } from 'react'
import { usePersistence } from '../../app/providers'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import type { BundleReport } from '../../core/projects/bundle'
import { formatNumber } from '../../lib/format'

/**
 * Opening a bundle from the Projects dialog, whichever tab it is on: one open
 * at a time, its error said where it happened, and the one choice about what
 * is already here — *start fresh* empties this browser first, and is asked
 * about once more before anything is removed.
 */
export function useBundleOpener(onOpened: () => void): {
  busy: string | null
  error: string | null
  fresh: boolean
  setFresh: (on: boolean) => void
  open: (key: string, name: string, go: () => Promise<BundleReport>) => void
  /** The confirmation, rendered wherever the panel puts it. */
  confirm: ReactNode
} {
  const store = useEntityStore()
  const persistence = usePersistence()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fresh, setFresh] = useState(false)
  const [confirming, setConfirming] = useState<{ name: string; go: () => void } | null>(null)

  const run = async (key: string, name: string, go: () => Promise<BundleReport>) => {
    setError(null)
    setBusy(key)
    try {
      if (fresh) {
        store.clear()
        await persistence.wipe().catch(() => {})
      }
      const r = await go()
      toast(`Opened “${displayLabel(r.project)}” · ${formatNumber(r.created)} new, ${formatNumber(r.updated)} updated`)
      onOpened()
    } catch (err) {
      setError(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }
  const open = (key: string, name: string, go: () => Promise<BundleReport>) => {
    if (busy) return
    if (fresh && store.size() > 0) setConfirming({ name, go: () => void run(key, name, go) })
    else void run(key, name, go)
  }

  const confirm = (
    <ConfirmDialog
      open={confirming !== null}
      title="Start fresh?"
      message={`Everything in this browser — ${formatNumber(store.size())} entities, every project included — is removed before “${confirming?.name ?? ''}” opens. Save or export first if you want to keep it.`}
      confirmLabel="Remove everything and open"
      danger
      onConfirm={() => {
        const go = confirming?.go
        setConfirming(null)
        go?.()
      }}
      onCancel={() => setConfirming(null)}
    />
  )
  return { busy, error, fresh, setFresh, open, confirm }
}

/** The start-fresh choice, as a line at the foot of a tab: off by default, since it removes everything. */
export function FreshToggle({ fresh, setFresh }: { fresh: boolean; setFresh: (on: boolean) => void }) {
  return (
    <label className={`openproj__fresh ${fresh ? 'is-on' : ''}`} title="Off: what you open is added to your Library, and a project opened again is updated in place. On: this browser is emptied — every project included — before it opens; you are asked once more first.">
      <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
      <span>Start fresh</span>
      <em>{fresh ? 'this browser is emptied before the project opens' : 'what you open is added beside what is here'}</em>
    </label>
  )
}
