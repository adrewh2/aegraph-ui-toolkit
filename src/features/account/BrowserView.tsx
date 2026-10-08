import { useCallback, useEffect, useState } from 'react'
import { Archive, ArchiveRestore, Eraser, Trash2 } from 'lucide-react'
import { PageHeader } from '../../components/Layout/PageHeader'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { requestBrowserReset } from '../../app/reset'
import { deleteStash, listStashes, MAX_STASHES, requestStashRestore, stashBrowser, type Stash } from '../../app/stash'
import { formatDate } from '../../lib/format'
import './browser.css'

/**
 * `/browser` — This browser: everything aegraph keeps is here, in this browser's storage, and this page stashes it,
 * restores a stash and clears it (`app/stash.ts`, `app/reset.ts`), to load the app as a new user would and come back.
 * The settings menu at the foot of the sidebar links here; the `account` tool does the same by name.
 */
export function BrowserView() {
  return (
    <div className="browser">
      <PageHeader title="This browser" subtitle="Your Library, projects, chats and settings live in this browser, and nowhere else. Stash them, restore a stash, or clear the browser to see aegraph as a new user does." />
      <BrowserCard />
    </div>
  )
}

/**
 * This browser: stash what aegraph keeps in it and restore a stash (`app/stash.ts`), and clear it all to load the
 * front page as a first visit (`app/reset.ts`). With "stash first" on — the default — neither clearing nor restoring
 * loses anything: what is here is stashed before it goes.
 */
export function BrowserCard({ reload }: { reload?: () => void } = {}) {
  const toast = useToast()
  const [stashFirst, setStashFirst] = useState(true)
  // Keys stay out of a stash unless asked for: a stash is a plain copy that clearing never deletes.
  const [includeKeys, setIncludeKeys] = useState(false)
  const [asking, setAsking] = useState<null | { kind: 'clear' } | { kind: 'restore'; stash: Stash } | { kind: 'delete'; stash: Stash }>(null)
  const [stashes, setStashes] = useState<Stash[] | null>(null)
  const [name, setName] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    listStashes().then(setStashes, (e) => setError(String((e as Error)?.message ?? e)))
  }, [])
  useEffect(refresh, [refresh])

  /** Stash what is here now, saying how far it has got. */
  const stashNow = async (label: string) => {
    setError(null)
    setWorking('Stashing…')
    try {
      const s = await stashBrowser(label, (p) => setWorking(`Stashing… ${p.db} · ${p.store} · ${p.records.toLocaleString()}`), { includeKeys })
      toast(`Stashed “${s.name}”`)
      return s
    } finally {
      setWorking(null)
      refresh()
    }
  }
  const run = (f: () => Promise<void>) => void f().catch((e) => setError(String((e as Error)?.message ?? e)))

  const act = () => {
    const a = asking
    setAsking(null)
    if (!a) return
    if (a.kind === 'delete')
      return run(async () => {
        await deleteStash(a.stash.id)
        toast(`Deleted the stash “${a.stash.name}”`)
        refresh()
      })
    run(async () => {
      if (stashFirst) await stashNow(a.kind === 'clear' ? 'Before clearing' : `Before restoring “${a.stash.name}”`)
      if (a.kind === 'clear') requestBrowserReset({}, reload)
      else requestStashRestore(a.stash.id, reload)
    })
  }

  const lost = stashFirst ? 'What is here now is stashed first, so it can be restored.' : 'Anything not stashed, exported or published is gone for good.'
  const KEYS = 'your keys (the Claude and OpenAI keys, the Spotify sign-in, the bridge address)'
  const keysOnClear = stashFirst && includeKeys ? `The stash holds ${KEYS} too.` : `${KEYS[0].toUpperCase()}${KEYS.slice(1)} are deleted and are not in any stash taken without “Include keys” — you enter them again.`
  const dialog =
    asking?.kind === 'clear'
      ? { title: 'Clear everything in this browser?', message: `The Library and every project, chats, history and settings kept in this browser are deleted. ${lost} ${keysOnClear} Stashes are kept. The page reloads as a first visit.`, label: stashFirst ? 'Stash, clear and reload' : 'Clear and reload' }
      : asking?.kind === 'restore'
        ? { title: 'Restore this stash?', message: `This browser goes back to “${asking.stash.name}” (${formatDate(asking.stash.createdAt)}): the Library, projects, chats, history and settings as they were then replace what is here. ${asking.stash.keys ? `The keys stashed with it replace ${KEYS}.` : `It holds no keys: ${KEYS} stay as they are.`} ${lost} The page reloads.`, label: stashFirst ? 'Stash, restore and reload' : 'Restore and reload' }
        : asking?.kind === 'delete'
          ? { title: 'Delete this stash?', message: `“${asking.stash.name}” is deleted for good. This browser as it is now is not touched.`, label: 'Delete' }
          : { title: '', message: '', label: '' }

  return (
    <section className="browser__card">
      <h3>Stashes</h3>
      <p className="muted browser__hint">
        A <b>stash</b> is a copy of everything aegraph keeps in this browser — the Library and every project in it, chats, version history, settings, what each page last showed — kept here beside it, to restore later. It leaves out your keys unless you include them; a browser keeps up to {MAX_STASHES}. Stashes stay when the browser is cleared, so you can stash, clear, look at aegraph as a new user sees it, and restore. They are in this browser only, and deleting the site's data in the browser's own settings deletes them too.
      </p>
      <div className="browser__inline">
        <input className="input browser__stash-name" placeholder="Name this stash" value={name} onChange={(e) => setName(e.target.value)} disabled={!!working} />
        <button
          className="btn btn--sm"
          disabled={!!working}
          onClick={() =>
            run(async () => {
              await stashNow(name)
              setName('')
            })
          }
        >
          <Archive size={13} /> Stash now
        </button>
      </div>
      {working && <p className="muted browser__hint">{working}</p>}
      {error && <p className="browser__error">{error}</p>}
      {stashes && stashes.length > 0 && (
        <ul className="browser__rows">
          {stashes.map((s) => (
            <li key={s.id} className="browser__row browser__stash">
              <div className="browser__row-head">
                <span className="browser__name">{s.name}</span>
                <span className="browser__inline">
                  <button className="btn btn--sm" disabled={!!working} onClick={() => setAsking({ kind: 'restore', stash: s })}>
                    <ArchiveRestore size={13} /> Restore…
                  </button>
                  <button className="btn btn--sm btn--icon btn--ghost browser__remove" title="Delete this stash" disabled={!!working} onClick={() => setAsking({ kind: 'delete', stash: s })}>
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
              <span className="muted">
                {formatDate(s.createdAt)} · {s.records.toLocaleString()} records in {s.databases.length} databases · about {formatBytes(s.bytes)}
                {s.keys ? ' · holds keys' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {stashes && !stashes.length && <p className="muted browser__hint">No stashes in this browser yet.</p>}
      <div className="browser__switches">
        <label className="browser__switch">
          <input type="checkbox" checked={stashFirst} onChange={(e) => setStashFirst(e.target.checked)} />
          Stash what is here first
        </label>
        <label className="browser__switch" title="A stash leaves out the Claude and OpenAI keys, the Spotify sign-in and the bridge address unless this is ticked; it is a plain copy kept in this browser, which clearing never deletes.">
          <input type="checkbox" checked={includeKeys} onChange={(e) => setIncludeKeys(e.target.checked)} />
          Include keys in stashes
        </label>
      </div>
      <p className="muted browser__hint">
        <b>Clear</b> deletes everything aegraph keeps in this browser — but the stashes — and loads the app as a new user sees it on their first visit. Other browsers, and anything on the server, are not touched. Close any other aegraph tab first.
      </p>
      <div>
        <button className="btn btn--sm btn--danger" disabled={!!working} onClick={() => setAsking({ kind: 'clear' })}>
          <Eraser size={13} /> Clear this browser…
        </button>
      </div>
      <ConfirmDialog open={asking !== null} title={dialog.title} message={dialog.message} confirmLabel={dialog.label} danger onCancel={() => setAsking(null)} onConfirm={act} />
    </section>
  )
}

const formatBytes = (n: number) => (n < 1024 ** 2 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`)
