import { AlertTriangle, Check, Loader2, Package } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useEntityStore } from '../../core/entity/hooks'
import { useProjects } from '../../core/projects/hooks'
import { isDemoProject } from '../../core/projects/project'
import { hashColor } from '../../lib/format'
import { fetchDemoCatalog } from '../datasets/demos'
import { heavyWarning } from './heavy'
import { describeOpenable, openables, type Openable } from './openable'
import { openBundleUrl } from './projectActions'
import { FreshToggle, useBundleOpener } from './useBundleOpener'
import './openProject.css'

/**
 * The Projects dialog's Demos tab: the projects the deployment ships — the
 * demos repo's bundles, fetched into the build — as large cards with
 * their pictures, each opened with a click. A demo opens as a project of its
 * own; one already in the Library says so, and opening its card again reads
 * the demo afresh and updates that project in place.
 */
export function DemosPanel({ onOpened }: { onOpened: () => void }) {
  const store = useEntityStore()
  const { projects } = useProjects()
  const opener = useBundleOpener(onOpened)
  const [list, setList] = useState<Openable[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchDemoCatalog().then((catalog) => !cancelled && setList(openables(catalog?.demos ?? []).filter((o) => o.where !== 'local')))
    return () => {
      cancelled = true
    }
  }, [])

  // Which demos are already here: by the bundle they were opened from, or (opened before that was written) by their project's id.
  const here = useMemo(() => {
    const ids = new Set((list ?? []).map((o) => o.id))
    const set = new Set<string>()
    for (const p of projects) {
      if (!isDemoProject(p, ids)) continue
      const byUrl = list?.find((o) => o.url === p.data.demo)
      if (byUrl) set.add(byUrl.id)
      else if (p.id.startsWith('project:')) set.add(p.id.slice('project:'.length))
      else if (p.data.source?.startsWith('demo:')) set.add(p.data.source.slice('demo:'.length))
    }
    return set
  }, [projects, list])

  return (
    <div className="openproj">
      <div className="openproj__bar">
        <p className="openproj__lead">Ready-made projects to explore. Each opens as a project of its own, beside yours.</p>
      </div>
      {opener.error && <p className="openproj__error">{opener.error}</p>}
      {list === null && <p className="openproj__small">Looking for demos…</p>}
      {list?.length === 0 && <p className="openproj__small">This build ships no demos: they come from the aegraph-ui-demos repository when the app is built.</p>}
      <div className="openproj__grid openproj__grid--demos" role="list">
        {list?.map((o) => (
          <button key={o.id} role="listitem" className={`democard ${opener.busy === o.id ? 'is-busy' : ''}`} disabled={opener.busy !== null} onClick={() => opener.open(o.id, o.title, () => openBundleUrl(store, o.url))}>
            <span className="democard__art" style={o.previewUrl ? undefined : { background: wash(o.id) }}>
              {o.previewUrl ? <img src={o.previewUrl} alt={`${o.title} — preview`} loading="lazy" /> : <Package size={34} />}
              {here.has(o.id) && (
                <span className="democard__badge" title="Opening it again reads the demo afresh and updates that project in place">
                  <Check size={12} /> In your Library
                </span>
              )}
              {heavyWarning(o) && (
                <span className="democard__heavy" title={heavyWarning(o)!.detail}>
                  <AlertTriangle size={12} /> Heavy
                </span>
              )}
              {opener.busy === o.id && (
                <span className="democard__busy">
                  <Loader2 size={22} className="spin" /> Opening…
                </span>
              )}
            </span>
            <span className="democard__body">
              <span className="democard__title">{o.title}</span>
              {o.description && <span className="democard__desc">{o.description}</span>}
              {heavyWarning(o) && (
                <span className="democard__warn" role="note">
                  <AlertTriangle size={13} aria-hidden />
                  <span>
                    <strong>{heavyWarning(o)!.label}.</strong> {heavyWarning(o)!.detail}
                  </span>
                </span>
              )}
              {o.highlights?.length ? (
                <ul className="democard__highlights">
                  {o.highlights.slice(0, 2).map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              ) : null}
              <span className="democard__foot">
                {describeOpenable(o) && <span className="democard__meta">{describeOpenable(o)}</span>}
                {o.tags?.map((t) => (
                  <span key={t} className="democard__tag">
                    {t}
                  </span>
                ))}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="openproj__foot">
        <FreshToggle fresh={opener.fresh} setFresh={opener.setFresh} />
      </div>
      {opener.confirm}
    </div>
  )
}

/** A card with no picture gets its own colour rather than a blank. */
const wash = (id: string) => {
  const c = hashColor(id)
  return `linear-gradient(135deg, color-mix(in srgb, ${c} 22%, var(--surface)), color-mix(in srgb, ${c} 48%, var(--surface)))`
}
