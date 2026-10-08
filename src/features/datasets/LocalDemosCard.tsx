import { FolderOpen, HardDrive, Link2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BrandMark } from '../../components/icons/BrandMark'
import { brandOf } from '../../components/icons/brands'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import { formatNumber } from '../../lib/format'
import { openBundleUrl } from '../projects/projectActions'
import { fetchLocalDemos, loadLocalDemos, type LocalDemo } from './localDemos'

interface Props {
  busy: boolean
  /** Replace or merge, as chosen on the page: only a merge joins with what the store already holds. */
  mode: 'merge' | 'replace'
  say: (line: string) => void
  onJob: (job: { label: string; done: number; total: number; detail?: string } | null) => void
}

/**
 * Datasets on this machine that the dev server serves from paths named in
 * `.env.local` (`AEGRAPH_LOCAL_DEMOS`). They load with one click like the
 * built-in demos but are never bundled or committed — the card only appears
 * when the server has something to offer. An atlas (labelled segments,
 * topics, regions…) and a ChatGPT export (the conversations themselves)
 * load separately or together; whenever both are present they are linked:
 * segments point at their conversation, conversations inherit the facets
 * and the links to regions, clusters, topics and the rest. A project
 * bundle (`.ae.json`, `.aeb`) opens as a project — no file picker, and a
 * fresh export of the same bundle updates the project in place.
 */
const isBundle = (d: LocalDemo) => d.kind === 'file' && /\.(ae\.json|aeb|ae)(\.gz)?$/i.test(d.file)

export function LocalDemosCard({ busy, mode, say, onJob }: Props) {
  const store = useEntityStore()
  const toast = useToast()
  const [demos, setDemos] = useState<LocalDemo[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchLocalDemos().then((list) => !cancelled && setDemos(list))
    return () => {
      cancelled = true
    }
  }, [])

  if (!demos?.length) return null

  const run = async (label: string, chosen: LocalDemo[]) => {
    try {
      onJob({ label: `Reading ${label}`, done: 0, total: 1 })
      const { parts, note, readMs, indexMs } = await loadLocalDemos(store, chosen, { mode, onJob: (j) => j && onJob(j) })
      for (const p of parts) say(`${p.note} · read ${readMs.toFixed(0)}ms`)
      if (note) say(`${label}: ${note}`)
      say(`${label}: indexed ${indexMs.toFixed(0)}ms`)
      toast(`${label} loaded`)
    } catch (err) {
      say(`${label} failed: ${err instanceof Error ? err.message : String(err)}`)
      toast('Could not load that dataset — see the activity log')
    } finally {
      onJob(null)
    }
  }

  const openBundle = async (d: LocalDemo) => {
    try {
      onJob({ label: `Opening ${d.label}`, done: 0, total: 1 })
      const r = await openBundleUrl(store, `/__local/demos/${encodeURIComponent(d.id)}`)
      say(`${d.label}: opened “${displayLabel(r.project)}” · ${formatNumber(r.created)} new, ${formatNumber(r.updated)} updated, ${formatNumber(r.upToDate)} already there`)
      toast(`Opened “${displayLabel(r.project)}” · ${formatNumber(r.created)} new, ${formatNumber(r.updated)} updated`)
    } catch (err) {
      say(`${d.label} failed: ${err instanceof Error ? err.message : String(err)}`)
      toast('Could not open that bundle — see the activity log')
    } finally {
      onJob(null)
    }
  }

  const atlas = demos.find((d) => d.kind === 'file' && /atlas/i.test(d.id))
  const exportDir = demos.find((d) => d.kind === 'directory')

  return (
    <section className="ds__card">
      <header>
        <span className="ds__icon" style={{ background: '#e0f2fe', color: '#0369a1' }}>
          <HardDrive size={18} />
        </span>
        <div>
          <h2>On this machine</h2>
          <p>
            Datasets the dev server serves from paths in <code>.env.local</code> (<code>AEGRAPH_LOCAL_DEMOS</code>). A conversation atlas (what the atlas pipeline writes) loads as segments, topics, domains, themes, personas, named entities, clusters and regions with their facet tags; a ChatGPT export directory loads its <code>conversations*.json</code> files as conversations with their messages. Load both and every conversation is linked to its segments, regions, clusters and topics. A project bundle (<code>.ae.json</code>, <code>.aeb</code>) opens as a project, and opening it again after a fresh export updates the project in place. Read here in the browser; never bundled or committed.
          </p>
        </div>
      </header>
      <div className="ds__actions">
        {atlas && exportDir && (
          <button className="btn btn--primary" disabled={busy} title={`${atlas.file} + ${exportDir.files?.length ?? 0} conversation files · ${formatNumber(Math.round((atlas.bytes + exportDir.bytes) / 1048576))} MB`} onClick={() => run('ChatGPT export, linked', [atlas, exportDir])}>
            <BrandMark brand="chatgpt" size={14} /> <Link2 size={13} /> Atlas + conversations, linked
          </button>
        )}
        {demos.map((d) => {
          // The service a dataset came from, wearing its own mark: an archive of ChatGPT conversations, a Claude trail.
          const brand = brandOf(d.id, d.label, d.file)
          const mark = brand ? <BrandMark brand={brand} size={14} /> : isBundle(d) ? <FolderOpen size={13} /> : null
          return isBundle(d) ? (
            <button key={d.id} className="btn" disabled={busy} onClick={() => void openBundle(d)} title={`${d.file} · ${formatNumber(Math.round(d.bytes / 1024))} KB · ${d.modified.slice(0, 16).replace('T', ' ')} · opens as a project; a newer export updates it in place`}>
              {mark} {d.label}
            </button>
          ) : (
            <button key={d.id} className="btn" disabled={busy} onClick={() => run(d.label, [d])} title={`${d.kind === 'directory' ? `${d.files?.length ?? 0} files` : d.file} · ${formatNumber(Math.round(d.bytes / 1024))} KB · ${d.modified.slice(0, 10)}`}>
              {mark} {d.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}
