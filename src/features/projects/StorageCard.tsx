import { FolderOpen, HardDrive, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import { formatDate, formatNumber } from '../../lib/format'
import { allowProjectsFolder, chooseProjectsFolder, forgetProjectsFolder, getProjectsFolder, listBundlesInFolder, onProjectsFolderChange, ProjectsFolderRefused, readBundleFromFolder, requestPersistentStorage, storageInfo, supportsProjectsFolder, type BundleFile, type ProjectsFolder, type StorageInfo } from './folder'
import { openBundleFile } from './projectActions'
import './StorageCard.css'

const formatBytes = (n: number | undefined) => (n === undefined ? '?' : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`)

/**
 * “Where are my projects?” answered on the Projects page: the workspace is
 * in the browser's own storage (with the path where that lives, for the
 * curious), and projects become files in a folder of the user's choosing,
 * where Save project writes them and from which they open.
 */
export function StorageCard() {
  const store = useEntityStore()
  const toast = useToast()
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [folder, setFolder] = useState<ProjectsFolder | null>(null)
  const [files, setFiles] = useState<BundleFile[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setInfo(await storageInfo())
    const f = await getProjectsFolder()
    setFolder(f)
    setFiles(f?.permission === 'granted' ? await listBundlesInFolder() : [])
  }, [])
  useEffect(() => {
    void refresh()
    // `/projects#storage` (the sidebar menu) lands here.
    if (location.hash === '#storage') document.getElementById('storage')?.scrollIntoView({ block: 'start' })
    return onProjectsFolderChange(() => void refresh())
  }, [refresh])

  const choose = async () => {
    try {
      const f = await chooseProjectsFolder()
      if (f) toast(`Projects folder: ${f.name}. Save project… writes there now.`)
    } catch (err) {
      // A source checkout is refused outright: nothing was remembered, nothing written.
      toast(err instanceof ProjectsFolderRefused ? err.message : `Could not use that folder: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const open = async (path: string) => {
    setBusy(path)
    try {
      const file = await readBundleFromFolder(path)
      if (!file) return
      const r = await openBundleFile(store, file)
      toast(`Opened “${displayLabel(r.project)}” · ${formatNumber(r.created)} new, ${formatNumber(r.updated)} updated`)
    } catch (err) {
      toast(`Could not open ${path}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="storage" id="storage">
      <h2 className="storage__title">
        <HardDrive size={15} /> Where your projects live
      </h2>
      <div className="storage__grid">
        <div className="storage__col">
          <h3>In this browser</h3>
          <p>
            The workspace — every project and the Library — is in this browser's storage for <code>{info?.origin ?? location.origin}</code> (IndexedDB database <code>{info?.database ?? 'aegraph'}</code>). It is saved as you work; nothing is on the network, and there is no copy anywhere else — save a project as a bundle to keep it.
          </p>
          <dl className="storage__facts">
            <dt>Entities</dt>
            <dd>{formatNumber(store.library.entityCount())}</dd>
            <dt>Used</dt>
            <dd>
              {formatBytes(info?.usedBytes)}
              {info?.quotaBytes ? <span className="muted"> of {formatBytes(info.quotaBytes)} available</span> : null}
            </dd>
            <dt>Kept</dt>
            <dd>
              {!info ? '…' : info.persisted === undefined ? 'This browser does not say' : info.persisted ? 'Persistent — the browser will not evict it under storage pressure' : 'Best effort — the browser may clear it when space runs short'}
              {info?.persisted === false && (
                <button className="btn btn--sm storage__inline" onClick={() => void requestPersistentStorage().then((ok) => (toast(ok ? 'Storage marked persistent' : 'The browser declined; it keeps data best-effort'), refresh()))}>
                  Keep it
                </button>
              )}
            </dd>
            <dt>On disk</dt>
            <dd>
              <code className="storage__path">{info?.onDisk ?? '…'}</code>
              <div className="muted">The browser's own files: not something to open or copy. For a file you can see, save the project into a folder →</div>
            </dd>
          </dl>
        </div>
        <div className="storage__col">
          <h3>As files</h3>
          {supportsProjectsFolder() ? (
            <>
              <p>
                Pick a folder and <strong>Save project…</strong> writes <code>&lt;name&gt;.ae.json</code> there instead of Downloads; the bundles in it are listed here to open. Bundles are ordinary files — back them up, sync them, send them, put them in git.
              </p>
              {folder ? (
                <div className="storage__folder">
                  <FolderOpen size={14} />
                  <strong>{folder.name}</strong>
                  {folder.permission !== 'granted' ? (
                    <button className="btn btn--sm btn--primary" onClick={() => void allowProjectsFolder().then(refresh)}>
                      Allow access
                    </button>
                  ) : (
                    <button className="btn btn--sm btn--icon btn--ghost" title="Refresh the list" onClick={() => void refresh()}>
                      <RefreshCw size={13} />
                    </button>
                  )}
                  <span className="spacer" />
                  <button className="btn btn--sm" onClick={() => void choose()}>
                    Change…
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={() => void forgetProjectsFolder().then(() => toast('Forgot the projects folder; saves go to Downloads again'))}>
                    Forget
                  </button>
                </div>
              ) : (
                <button className="btn btn--primary" onClick={() => void choose()}>
                  <FolderOpen size={14} /> Choose a projects folder…
                </button>
              )}
              {folder?.permission === 'granted' && (
                <ul className="storage__files">
                  {files.length === 0 && <li className="muted">No bundles here yet (this folder and its subfolders). Save project… puts one here.</li>}
                  {files.map((f) => (
                    <li key={f.path}>
                      <span className="storage__file-name" title={f.description ? `${f.path}\n${f.description}` : f.path}>
                        {f.title}
                        {f.path !== f.name && <small className="storage__file-path">{f.path}</small>}
                      </span>
                      <span className="muted">
                        {formatBytes(f.bytes)} · {formatDate(f.modifiedAt)}
                      </span>
                      <button className="btn btn--sm" disabled={busy === f.path} onClick={() => void open(f.path)}>
                        {busy === f.path ? 'Opening…' : 'Open'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p>
              <strong>Save project…</strong> downloads <code>&lt;name&gt;.ae.json</code> to this browser's Downloads folder; <strong>Open bundle…</strong> loads one back. (Choosing a projects folder needs a browser with the File System Access API — Chrome or Edge.)
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
