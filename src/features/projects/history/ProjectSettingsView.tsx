import { useEffect, useState } from 'react'
import { PageHeader } from '../../../components/Layout/PageHeader'
import { ConfirmDialog } from '../../../components/ui/Dialog'
import { useToast } from '../../../components/ui/useToast'
import { displayLabel } from '../../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../../core/entity/hooks'
import type { EntityId } from '../../../core/entity/types'
import { isProjectEntity, type ProjectEntity } from '../../../core/projects/project'
import { DEFAULT_VERSIONING, versioningOf } from '../../../core/projects/versioning'
import { formatNumber } from '../../../lib/format'
import { ProjectNav } from './ProjectNav'
import { useCommits, useProjectHistory } from './useHistory'
import '../Projects.css'
import './history.css'

/**
 * `/projects/:id/settings` — the project's name, description and home, and
 * how its history is kept: autosave (commit on its own a little after the
 * last change) or commits by hand from the Changes tab.
 */
export function ProjectSettingsView({ id }: { id: EntityId }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const history = useProjectHistory()
  const toast = useToast()
  const commits = useCommits(id)
  const project = store.get(id)
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [home, setHome] = useState('')
  const [forgetting, setForgetting] = useState(false)
  useEffect(() => {
    if (!isProjectEntity(project)) return
    setLabel(project.label ?? '')
    setDescription(project.description ?? '')
    setHome(project.data.home?.route ?? '')
    // Only when the project changes identity; typing must not be overwritten by the store's echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  if (!isProjectEntity(project)) return <div className="projects">No such project.</div>
  const settings = versioningOf(project)
  const patchVersioning = (patch: Partial<typeof settings>) => {
    store.update<ProjectEntity>(id, { data: { ...project.data, versioning: { ...settings, ...patch } } })
  }
  const saveText = () => {
    const next = { ...project.data, home: home.trim() ? { ...project.data.home, route: home.trim() } : project.data.home?.workstationId ? { workstationId: project.data.home.workstationId } : undefined }
    if (!next.home) delete next.home
    if ((project.label ?? '') === label && (project.description ?? '') === description && (project.data.home?.route ?? '') === home.trim()) return
    store.update<ProjectEntity>(id, { label: label.trim() || project.label, description: description.trim() || undefined, data: next })
    toast('Saved')
  }
  const forget = async () => {
    setForgetting(false)
    const n = await history.forget(id)
    toast(`Forgot ${formatNumber(n)} commit${n === 1 ? '' : 's'}. The project's entities are untouched.`)
  }
  return (
    <div className="projects vh-page">
      <PageHeader title={displayLabel(project)} subtitle="Name, home and how the project's history is kept." />
      <ProjectNav id={id} />
      <div className="vh-settings">
        <section className="project__card vh-settings__card">
          <h3>About</h3>
          <div className="field">
            <label>Name</label>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={saveText} onKeyDown={(e) => e.key === 'Enter' && saveText()} />
          </div>
          <div className="field">
            <label>Description</label>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} onBlur={saveText} onKeyDown={(e) => e.key === 'Enter' && saveText()} placeholder="Optional" />
          </div>
          <div className="field">
            <label>Opens on</label>
            <input className="input" value={home} onChange={(e) => setHome(e.target.value)} onBlur={saveText} onKeyDown={(e) => e.key === 'Enter' && saveText()} placeholder="/workstation, /unigraph/2d?scene=… — blank stays where you are" />
          </div>
        </section>

        <section className="project__card vh-settings__card">
          <h3>Saving</h3>
          <p className="vh-settings__lead">
            Every edit is kept in the Library the moment it is made; nothing is lost by closing the tab. <strong>Saving to the project</strong> means committing: recording a named point in its history you can compare with and go back to. The <em>Changes</em> tab shows what has changed since the last commit.
          </p>
          <label className="vh-choice">
            <input type="radio" name="autosave" checked={settings.autosave} onChange={() => patchVersioning({ autosave: true })} />
            <span>
              <strong>Autosave</strong>
              <br />
              <span className="vh-settings__hint">Commit on its own once the project has been quiet for a while, and when you leave the page. Commits are labelled “Autosave”; you can still commit by hand with a message.</span>
            </span>
          </label>
          {settings.autosave && (
            <div className="field vh-settings__delay">
              <label>Quiet time before an autosave</label>
              <div className="vh-inline">
                <input className="input" type="number" min={1} max={3600} step={1} value={settings.autosaveDelay} onChange={(e) => patchVersioning({ autosaveDelay: Math.max(1, Math.min(3600, Number(e.target.value) || DEFAULT_VERSIONING.autosaveDelay)) })} style={{ width: 90 }} />
                <span>seconds</span>
              </div>
            </div>
          )}
          <label className="vh-choice">
            <input type="radio" name="autosave" checked={!settings.autosave} onChange={() => patchVersioning({ autosave: false })} />
            <span>
              <strong>Commit by hand</strong>
              <br />
              <span className="vh-settings__hint">Changes accumulate as unsaved until you commit them from the Changes tab (or with the <code>project_commit</code> tool) with a message of your own.</span>
            </span>
          </label>
        </section>

        <section className="project__card vh-settings__card">
          <h3>History</h3>
          <ul>
            <li>
              <span>Commits</span>
              <span className="count">{formatNumber(commits.length)}</span>
            </li>
            <li>
              <span>Kept in</span>
              <span className="count">this browser (IndexedDB “aegraph-history”)</span>
            </li>
          </ul>
          <p className="vh-settings__hint">History stays on this device: a bundle carries the project, not its commits. Forgetting the history deletes every commit and its content; the project itself is untouched.</p>
          <button className="btn btn--danger" disabled={!commits.length} onClick={() => setForgetting(true)}>
            Forget history…
          </button>
        </section>
      </div>
      <ConfirmDialog open={forgetting} title="Forget this project's history?" message={`${formatNumber(commits.length)} commit${commits.length === 1 ? '' : 's'} and their content are deleted. The project and its entities stay as they are; the next commit starts a fresh history.`} confirmLabel="Forget history" danger onConfirm={() => void forget()} onCancel={() => setForgetting(false)} />
    </div>
  )
}
