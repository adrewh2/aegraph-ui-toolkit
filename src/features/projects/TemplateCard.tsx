import { LayoutTemplate } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import { switchProject } from '../../core/projects/active'
import { createProject } from '../../core/projects/project'
import { applyTemplate, fetchTemplate, TEMPLATE_CATALOG, type TemplateInfo } from '../../core/projects/template'
import { formatNumber } from '../../lib/format'

/**
 * The Projects dialog's Examples tab, project templates: the analytics for a
 * kind of dataset, applied to the open project (or a new one). With the
 * Conversation atlas: run the atlas pipeline (a separate, private tool) over
 * an export, import `conversation-atlas.json` above into a project, then
 * apply the template here — its charts, scripts, scenes and guide appear over your data.
 */
export function TemplateCard({ busy, say }: { busy: boolean; say: (line: string) => void }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const toast = useToast()
  const navigate = useNavigate()
  const [working, setWorking] = useState<string | null>(null)
  const active = store.scope ? store.get(store.scope) : undefined
  const activeLabel = active ? displayLabel(active) : null

  const apply = async (t: TemplateInfo, into: 'active' | 'new') => {
    setWorking(t.id)
    try {
      const doc = await fetchTemplate(t.id)
      let pid = store.scope
      if (into === 'new' || !pid) {
        const p = createProject({ label: t.label, description: t.description, source: `template:${t.id}` })
        store.upsert(p)
        pid = p.id
      }
      // A new project takes the Library's loose data of the template's kind with it — an atlas imported without a project.
      const r = applyTemplate(store, doc, pid!, { adopt: into === 'new' || !active })
      const counts = (type: string) => formatNumber(store.library.ofType(type).filter((e) => (e.meta.projects ?? []).includes(pid!)).length)
      say(`${t.label}: ${formatNumber(r.created)} added, ${formatNumber(r.updated)} updated in “${displayLabel(r.project)}”${r.adopted ? `, ${formatNumber(r.adopted)} entities from the Library taken in` : ''} — ${counts('plot')} charts, ${counts('script')} scripts, ${counts('scene')} scenes${r.missing.length ? `. The project has no ${r.missing.join(' or ')} entities yet: import the atlas output into it and the pictures fill in.` : ''}`)
      toast(r.missing.length ? `${t.label} applied — load the data next` : `${t.label} applied`)
      if (store.scope !== pid) switchProject(store, pid!, { route: r.route })
      else if (r.route) navigate(r.route)
    } catch (err) {
      say(`${t.label}: ${err instanceof Error ? err.message : String(err)}`)
      toast('Could not apply the template — see the activity log')
    } finally {
      setWorking(null)
    }
  }

  return (
    <section className="ds__card">
      <header>
        <span className="ds__icon" style={{ background: '#e0f2f1', color: '#0f766e' }}>
          <LayoutTemplate size={18} />
        </span>
        <div>
          <h2>Project templates</h2>
          <p>
            The analytics for a kind of dataset — charts, scripts, graph scenes, a guide, the pages laid out — with none of the data. Applied to a project that holds that kind of data, they draw over it at once. <strong>Conversation atlas</strong>: run the atlas pipeline (a separate, private tool) over a ChatGPT export, import its <code>conversation-atlas.json</code> with <em>Import</em> above into a project, then apply the template to that project. Applying again after the pipeline is re-run updates the pictures in place.
          </p>
        </div>
      </header>
      {TEMPLATE_CATALOG.map((t) => (
        <div key={t.id} className="ds__actions">
          <span className="ds__template-name">
            <strong>{t.label}</strong> <span className="muted">— {t.hint}</span>
          </span>
          <button className="btn btn--primary" disabled={busy || !!working || !active} title={active ? `Add the ${t.label} analytics to “${activeLabel}”` : 'Open a project first (the sidebar’s picker), or start one from the template'} onClick={() => void apply(t, 'active')}>
            {working === t.id ? 'Applying…' : active ? `Apply to “${activeLabel}”` : 'Apply to the open project'}
          </button>
          <button className="btn" disabled={busy || !!working} title="A new project with the analytics in it, taking the Library's loose data of this kind (imported without a project) along — or empty, to import the data into next" onClick={() => void apply(t, 'new')}>
            New project from it
          </button>
        </div>
      ))}
    </section>
  )
}
