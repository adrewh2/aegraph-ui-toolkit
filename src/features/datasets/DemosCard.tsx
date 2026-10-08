import { Boxes } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BrandTile } from '../../components/icons/BrandMark'
import { brandOf } from '../../components/icons/brands'
import { useToast } from '../../components/ui/useToast'
import { useEntityStore } from '../../core/entity/hooks'
import { formatNumber } from '../../lib/format'
import { openBundleUrl } from '../projects/projectActions'
import { fetchDemoCatalog, type DemoEntry } from './demos'

interface Props {
  busy: boolean
  say: (line: string) => void
  onJob: (job: { label: string; done: number; total: number; detail?: string } | null) => void
}

/**
 * The demo projects built into this deployment (see scripts/demos/fetch.mjs):
 * one card per demo with its preview, what it holds and an Open project
 * button. Each is a bundle, so it opens as a project on the screen it was
 * saved from and reloads in place after an update. The whole section stays
 * out when the build has no demos.
 */
export function DemosCard({ busy, say, onJob }: Props) {
  const store = useEntityStore()
  const toast = useToast()
  const [demos, setDemos] = useState<DemoEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchDemoCatalog().then((c) => !cancelled && setDemos(c?.demos ?? []))
    return () => {
      cancelled = true
    }
  }, [])

  if (!demos?.length) return null

  const open = async (d: DemoEntry) => {
    try {
      onJob({ label: `Opening ${d.title}`, done: 0, total: 1 })
      const r = await openBundleUrl(store, d.bundleUrl)
      say(`${d.title}: ${formatNumber(r.created)} new, ${formatNumber(r.updated)} updated, ${formatNumber(r.upToDate)} already there`)
      toast(`${d.title} opened`)
    } catch (err) {
      say(`${d.title}: ${err instanceof Error ? err.message : String(err)}`)
      toast('Could not open that demo — see the activity log')
    } finally {
      onJob(null)
    }
  }

  return (
    <>
      {demos.map((d) => (
        <section key={d.id} className="ds__card ds__card--demo">
          <header>
            {/* A demo that is one service's data wears that service's mark rather than the generic one. */}
            {d.previewUrl ? <img className="ds__preview" src={d.previewUrl} alt="" loading="lazy" /> : brandOf(d.id, d.title, ...(d.tags ?? [])) ? <BrandTile brand={brandOf(d.id, d.title, ...(d.tags ?? []))!} /> : <span className="ds__icon" style={{ background: '#e0e7ff', color: '#3730a3' }}><Boxes size={18} /></span>}
            <div>
              <h2>{d.title}</h2>
              <p>{d.description}</p>
              {d.highlights?.length ? (
                <ul className="ds__highlights">
                  {d.highlights.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </header>
          <div className="ds__actions">
            <button className="btn btn--primary" disabled={busy} onClick={() => void open(d)} title={d.counts ? `${formatNumber(d.counts.entities)} entities · ${formatNumber(d.counts.relationships)} relationships${d.bytes ? ` · ${(d.bytes / 1048576).toFixed(1)} MB` : ''}` : undefined}>
              Open project
            </button>
            {d.readmeUrl && (
              <a className="btn" href={d.readmeUrl} target="_blank" rel="noreferrer">
                About
              </a>
            )}
            {d.counts && (
              <span className="muted ds__counts">
                {formatNumber(d.counts.entities)} entities · {formatNumber(d.counts.relationships)} relationships
              </span>
            )}
          </div>
        </section>
      ))}
    </>
  )
}
