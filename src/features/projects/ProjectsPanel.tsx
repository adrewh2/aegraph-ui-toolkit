import { ArrowRight, FileUp, FolderOpen, HardDrive, Loader2, Plus, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import type { EntityStore } from '../../core/entity/store'
import { GRAPH_SCENE_TYPES } from '../../core/graph/scene'
import { switchProject } from '../../core/projects/active'
import { useProjects } from '../../core/projects/hooks'
import { isDemoProject, projectCounts, type ProjectEntity } from '../../core/projects/project'
import { formatDate, formatNumber, hashColor } from '../../lib/format'
import { fetchDemoCatalog } from '../datasets/demos'
import { fetchLocalDemos } from '../datasets/localDemos'
import { describeOpenable, openables, type Openable } from './openable'
import { openBundleFile, openBundleUrl } from './projectActions'
import { NewProjectDialog } from './NewProjectDialog'
import { FreshToggle, useBundleOpener } from './useBundleOpener'
import './openProject.css'

/**
 * The Projects dialog's first tab: the person's own projects — every project
 * in the Library that is not a demo — as cards to open with a click, and the
 * ways to add one: a new project, a bundle from a file (dropped anywhere on
 * the tab), and, on a dev server, the bundles this machine serves. The demos
 * are the next tab; an empty list says so and points there.
 */
export function YourProjectsPanel({ onOpened, onDemos }: { onOpened: () => void; onDemos: () => void }) {
  const store = useEntityStore()
  const { activeId, projects } = useProjects()
  const opener = useBundleOpener(onOpened)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [creating, setCreating] = useState(false)
  // The demos' ids, to know a demo opened before it was marked as one; null until the catalogue has answered.
  const [demoIds, setDemoIds] = useState<Set<string> | null>(null)
  const [local, setLocal] = useState<Openable[]>([])

  // Mounted when the tab shows and unmounted when it goes, so this runs once a visit.
  useEffect(() => {
    let cancelled = false
    void Promise.all([fetchDemoCatalog(), fetchLocalDemos()]).then(([catalog, localDemos]) => {
      if (cancelled) return
      setDemoIds(new Set((catalog?.demos ?? []).map((d) => d.id)))
      setLocal(openables([], localDemos).filter((o) => o.where === 'local'))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const mine = useMemo(() => (demoIds ? projects.filter((p) => !isDemoProject(p, demoIds)) : null), [projects, demoIds])
  // Counting walks each project's scope: once per list, not per render. The key is the list as it would be drawn.
  const listKey = mine?.map((p) => `${p.id}@${p.meta.updatedAt}`).join('|') ?? ''
  const cards = useMemo(() => (mine ?? []).map((p) => ({ p, counts: projectCounts(store, p.id), preview: previewOf(store, p.id) })), [listKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const openDemo = demoIds && activeId ? projects.find((p) => p.id === activeId && isDemoProject(p, demoIds)) : undefined

  const openProject = (p: ProjectEntity) => {
    if (p.id !== activeId) switchProject(store, p.id)
    onOpened()
  }
  const openFile = (file: File | undefined) => file && opener.open('file', file.name, () => openBundleFile(store, file))

  return (
    <div
      className="openproj"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        openFile(e.dataTransfer.files?.[0])
      }}
    >
      <div className="openproj__bar">
        <p className="openproj__lead">{mine?.length ? `${mine.length} project${mine.length === 1 ? '' : 's'} in this browser — click one to open it.` : 'The projects you make, or open from a file, live here in this browser.'}</p>
        <button className="btn" disabled={opener.busy !== null} onClick={() => fileRef.current?.click()}>
          {opener.busy === 'file' ? <Loader2 size={14} className="spin" /> : <FileUp size={14} />} Open a file…
        </button>
        <button className="btn btn--primary" onClick={() => setCreating(true)}>
          <Plus size={14} /> New project
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".aeb,.json,.gz,application/json"
        hidden
        onChange={(e) => {
          openFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {opener.error && <p className="openproj__error">{opener.error}</p>}

      {mine === null ? null : cards.length === 0 ? (
        <div className="openproj__empty">
          <span className="openproj__empty-icon">
            <FolderOpen size={26} />
          </span>
          <h3>Your projects will be here</h3>
          <p>A project is a named scope over your Library, with its own data, scenes, layouts and history. Start one, open a bundle someone sent you (or drop it anywhere on this tab), or begin from a demo.</p>
          {openDemo && <p className="openproj__small">The open project, “{displayLabel(openDemo)}”, is a demo: it is on the Demos tab.</p>}
          <div className="openproj__empty-actions">
            <button className="btn btn--primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New project
            </button>
            <button className="btn" onClick={() => fileRef.current?.click()}>
              <FileUp size={14} /> Open a file…
            </button>
            <button className="btn" onClick={onDemos}>
              <Sparkles size={14} /> Browse demos
            </button>
          </div>
        </div>
      ) : (
        <div className="openproj__grid openproj__grid--mine" role="list">
          {cards.map(({ p, counts, preview }) => (
            <button key={p.id} role="listitem" className={`projcard ${p.id === activeId ? 'is-open' : ''}`} onClick={() => openProject(p)} title={p.id === activeId ? `${displayLabel(p)} is open — back to it` : `Open ${displayLabel(p)}`}>
              <span className="projcard__art" style={preview ? undefined : { background: tint(p.id) }}>
                {preview ? <img src={preview} alt="" loading="lazy" /> : <span className="projcard__initial">{initial(displayLabel(p))}</span>}
                {p.id === activeId && <span className="projcard__badge">Open now</span>}
              </span>
              <span className="projcard__body">
                <span className="projcard__title">{displayLabel(p)}</span>
                {p.description && <span className="projcard__desc">{p.description}</span>}
                <span className="projcard__meta">
                  <span>
                    {formatNumber(counts.entities)} entities · {formatNumber(counts.relationships)} links
                  </span>
                  <span>updated {formatDate(p.meta.updatedAt)}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {local.length > 0 && (
        <section className="openproj__local">
          <h4>
            <HardDrive size={13} /> On this machine
          </h4>
          <p className="openproj__small">
            Bundles the dev server serves from the paths in <code>.env.local</code>. Opening one makes it a project here.
          </p>
          <div className="openproj__rows">
            {local.map((o) => (
              <button key={o.id} className="openproj__row" disabled={opener.busy !== null} onClick={() => opener.open(o.id, o.title, () => openBundleUrl(store, o.url))} title={o.url}>
                {opener.busy === o.id ? <Loader2 size={14} className="spin" /> : <HardDrive size={14} />}
                <span className="openproj__row-title">{o.title}</span>
                <span className="openproj__row-meta">{describeOpenable(o)}</span>
                <ArrowRight size={14} className="openproj__row-go" />
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="openproj__foot">
        <FreshToggle fresh={opener.fresh} setFresh={opener.setFresh} />
        <Link to="/projects" className="openproj__manage" onClick={onOpened}>
          Manage projects <ArrowRight size={13} />
        </Link>
      </div>
      {dragging && (
        <div className="openproj__drop">
          <FileUp size={24} />
          <strong>Drop to open it as a project</strong>
          <span>.ae.json or .aeb, gzipped or not</span>
        </div>
      )}
      {opener.confirm}
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

/** The newest graph scene's saved picture in the project, if it has one: the closest thing a project has to a cover. */
function previewOf(store: EntityStore, projectId: string): string | undefined {
  let best: { at: string; src: string } | undefined
  for (const type of GRAPH_SCENE_TYPES) {
    for (const e of store.library.ofType(type)) {
      if (!(e.meta.projects ?? []).includes(projectId)) continue
      const src = (e.data as { preview?: unknown }).preview
      // Only the two shapes a scene's preview is written in (see the spec); anything else in data is not drawn.
      if (typeof src !== 'string' || !/^data:image\/(jpeg|svg\+xml)[;,]/.test(src)) continue
      if (!best || e.meta.updatedAt > best.at) best = { at: e.meta.updatedAt, src }
    }
  }
  return best?.src
}

const initial = (label: string) => (label.trim()[0] ?? '·').toUpperCase()
/** A soft wash of the project's own colour, for a card with no picture. */
const tint = (id: string) => {
  const c = hashColor(id)
  return `linear-gradient(135deg, color-mix(in srgb, ${c} 28%, white), color-mix(in srgb, ${c} 52%, white))`
}
