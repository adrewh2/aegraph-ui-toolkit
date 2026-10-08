import { FolderOpen, Globe, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/Layout/PageHeader'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { CATEGORIES, CATEGORY_ORDER, type TypeCategory } from '../../core/entity/categories'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { clearStashedUiState, switchProject } from '../../core/projects/active'
import { useProjects } from '../../core/projects/hooks'
import { deleteProject, isProjectEntity, projectCounts, type ProjectEntity } from '../../core/projects/project'
import { formatDate, formatNumber } from '../../lib/format'
import { NewProjectDialog } from './NewProjectDialog'
import { saveBlob } from '../../core/exchange/export'
import { ProjectsDialog } from '../datasets/ProjectsDialog'
import { bundleOrigin, openBundleFile, openBundleUrl, saveProjectBundle } from './projectActions'
import { publishProject } from './publish'
import { SaveAsProjectDialog } from './SaveAsProjectDialog'
import { chooseProjectsFolder, ProjectsFolderRefused, supportsProjectsFolder } from './folder'
import { StorageCard } from './StorageCard'
import { ProjectNav } from './history/ProjectNav'
import { scrollBehavior } from '../../lib/motion'
import { useExternalServices } from '../account/settings'
import './Projects.css'

/** `/projects` — every project in the Library; `/projects/:id` — one project: what is in it and what to do with it. */
export function ProjectsView() {
  const { id } = useParams()
  return id ? <ProjectPage id={id} /> : <ProjectsList />
}

function ProjectsList() {
  const store = useEntityStore()
  const { activeId, projects } = useProjects()
  const navigate = useNavigate()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ProjectEntity | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [opening, setOpening] = useState(false)
  const exclusiveOf = (id: string) => [...store.markedWith(id)].filter((m) => store.projectsOf(m).length === 1).length
  const remove = (p: ProjectEntity, mode: 'keep' | 'exclusive') => {
    const r = deleteProject(store, p.id, { exclusive: mode === 'exclusive' })
    clearStashedUiState(p.id)
    if (activeId === p.id) switchProject(store, null, { route: '/projects' })
    setDeleting(null)
    toast(`Deleted “${displayLabel(p)}” · ${formatNumber(r.unmarked)} kept in the Library${r.deleted ? `, ${formatNumber(r.deleted)} deleted` : ''}`)
  }
  const openFolder = async () => {
    try {
      const f = await chooseProjectsFolder()
      if (!f) return
      toast(`Projects folder: ${f.name}. Its bundles are listed below.`)
      document.getElementById('storage')?.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
    } catch (err) {
      toast(err instanceof ProjectsFolderRefused ? err.message : `Could not use that folder: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const r = await openBundleFile(store, file)
      toast(`Opened “${displayLabel(r.project)}” · ${formatNumber(r.created)} new, ${formatNumber(r.updated)} updated, ${formatNumber(r.upToDate)} already there`)
    } catch (err) {
      toast(`Could not open that bundle: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return (
    <div className="projects">
      <PageHeader
        title="Projects"
        subtitle="Named scopes over the Library. An entity can be in any number of projects; a project's layouts, scenes and workstations are its own."
        actions={
          <>
            <button className="btn" onClick={() => setOpening(true)}>
              <FolderOpen size={14} /> Open project…
            </button>
            {supportsProjectsFolder() && (
              <button className="btn" title="Pick a folder of bundles — a checkout of a demos repo, say — and open them from the list below" onClick={() => void openFolder()}>
                <FolderOpen size={14} /> Open folder…
              </button>
            )}
            <button className="btn btn--primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New project
            </button>
          </>
        }
      />
      <input ref={fileRef} type="file" accept=".aeb,.json,.gz,application/json" hidden onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          onFile(f).catch(() => {})
        }} />
      {opening && <ProjectsDialog tab="projects" onClose={() => setOpening(false)} />}
      {projects.length === 0 ? (
        <p className="projects__empty">
          No projects yet. Everything is in the Library ({formatNumber(store.library.entityCount())} entities). Create one and put things in it, or <button className="linkish" onClick={() => setOpening(true)}>open a project</button> — one of the demos, or a bundle someone sent you.
        </p>
      ) : (
        <div className="projects__list">
          {projects.map((p) => {
            const c = projectCounts(store, p.id)
            return (
              <div key={p.id} className={`projects__row ${p.id === activeId ? 'is-active' : ''}`}>
                <div>
                  <div className="projects__name">
                    <button onClick={() => navigate(`/projects/${encodeURIComponent(p.id)}`)}>
                      {displayLabel(p)}
                    </button>
                    {p.id === activeId && <span className="badge badge--ok" style={{ marginLeft: 8 }}>open</span>}
                  </div>
                  <div className="projects__meta">
                    {p.description ? `${p.description} · ` : ''}updated {formatDate(p.meta.updatedAt)}
                    {p.data.includes?.length ? ` · includes ${p.data.includes.length}` : ''}
                  </div>
                </div>
                <div className="projects__counts">
                  {formatNumber(c.entities)} entities · {formatNumber(c.relationships)} relationships
                </div>
                <div className="projects__actions">
                  {p.id !== activeId && (
                    <button className="btn btn--sm" onClick={() => switchProject(store, p.id)}>
                      Open
                    </button>
                  )}
                  <button className="btn btn--sm" onClick={() => void saveProjectBundle(store, p.id).then((r) => toast(`Saved ${r.filename}${r.where === 'folder' ? ' in your projects folder' : ' to Downloads'}`))}>
                    Save…
                  </button>
                  <button className="btn btn--sm btn--icon btn--ghost" title={`Delete “${displayLabel(p)}”`} onClick={() => setDeleting(p)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <StorageCard />
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
      {deleting && (
        <>
          <ConfirmDialog
            open
            title={`Delete “${displayLabel(deleting)}”?`}
            message={`The project goes away; its entities stay in the Library. ${exclusiveOf(deleting.id) ? `${formatNumber(exclusiveOf(deleting.id))} of them are in no other project — delete those too with the second option.` : ''}`}
            confirmLabel="Delete project only"
            danger
            onConfirm={() => remove(deleting, 'keep')}
            onCancel={() => setDeleting(null)}
          />
          {exclusiveOf(deleting.id) > 0 && (
            <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 1001 }}>
              <button className="btn btn--danger" onClick={() => remove(deleting, 'exclusive')}>
                Delete project and its {formatNumber(exclusiveOf(deleting.id))} exclusive entities
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ProjectPage({ id }: { id: string }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const { activeId } = useProjects()
  const navigate = useNavigate()
  const toast = useToast()
  const [confirm, setConfirm] = useState<'keep' | 'exclusive' | null>(null)
  const [savingAs, setSavingAs] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const publish = async () => {
    setPublishing(true)
    try {
      const r = await publishProject(store, registry, id)
      saveBlob(new Blob([r.html], { type: 'text/html' }), r.filename)
      toast(`Published ${r.filename} · ${formatNumber(r.stats.entities)} entities${r.stats.scenes ? ` · ${r.stats.scenes} graph${r.stats.scenes === 1 ? '' : 's'}` : ''}${r.stats.charts ? ` · ${r.stats.charts} chart${r.stats.charts === 1 ? '' : 's'}` : ''} · ${(r.stats.bytes / 1_000_000).toFixed(1)} MB`)
    } catch (err) {
      toast(`Could not publish: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPublishing(false)
    }
  }
  const e = store.get(id)
  if (!isProjectEntity(e)) return <div className="projects">No such project.</div>
  const p: ProjectEntity = e
  const counts = projectCounts(store, id)
  const byCategory = new Map<TypeCategory, [string, number][]>()
  for (const [type, n] of Object.entries(counts.byType)) {
    const cat = registry.categoryOf(type)
    byCategory.set(cat, [...(byCategory.get(cat) ?? []), [type, n]])
  }
  const relTypes = Object.entries(counts.byRelationshipType).sort((a, b) => b[1] - a[1])
  const exclusive = [...store.markedWith(id)].filter((m) => store.projectsOf(m).length === 1).length
  const remove = (mode: 'keep' | 'exclusive') => {
    const wasActive = activeId === id
    const r = deleteProject(store, id, { exclusive: mode === 'exclusive' })
    clearStashedUiState(id)
    if (wasActive) switchProject(store, null, { route: '/projects' })
    else navigate('/projects')
    toast(`Deleted “${displayLabel(p)}” · ${formatNumber(r.unmarked)} kept in the Library${r.deleted ? `, ${formatNumber(r.deleted)} deleted` : ''}`)
  }
  return (
    <div className="projects">
      <PageHeader
        title={displayLabel(p)}
        subtitle={`${p.description ? `${p.description} · ` : ''}${formatNumber(counts.entities)} entities · ${formatNumber(counts.relationships)} relationships · updated ${formatDate(p.meta.updatedAt)}${p.data.source ? ` · from ${p.data.source}` : ''}`}
        actions={
          <>
            {activeId !== id ? (
              <button className="btn btn--primary" onClick={() => switchProject(store, id, { route: '/' })}>
                Open
              </button>
            ) : (
              <button className="btn" onClick={() => switchProject(store, null)}>
                Back to Library
              </button>
            )}
            <button className="btn" onClick={() => void saveProjectBundle(store, id).then((r) => toast(`Saved ${r.filename} · ${formatNumber(r.count)} entities${r.where === 'folder' ? ' · in your projects folder' : ' · Downloads'}`))}>
              Save project…
            </button>
            <button className="btn" title="aegraph's own compact format: a fraction of the size of .ae.json and quicker to load. Other tools want .ae.json." onClick={() => void saveProjectBundle(store, id, { format: 'pack' }).then((r) => toast(`Saved ${r.filename} · ${formatNumber(r.count)} entities${r.where === 'folder' ? ' · in your projects folder' : ' · Downloads'}`))}>
              Save as .aeb…
            </button>
            <button className="btn" onClick={() => setSavingAs(true)}>
              Save as new project…
            </button>
            <button className="btn" onClick={() => void publish()} disabled={publishing} title="One self-contained, read-only HTML page: the overview, every graph scene and chart as a picture, the findings and claims, the documents, and a searchable table of every entity — for anyone, without the app">
              <Globe size={14} /> {publishing ? 'Publishing…' : 'Publish as web page'}
            </button>
            <button className="btn btn--danger" onClick={() => setConfirm('keep')}>
              Delete…
            </button>
          </>
        }
      />
      <ProjectNav id={id} />
      <div className="project__grid">
        {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((c) => (
          <div key={c} className="project__card">
            <h3>{CATEGORIES[c].pluralLabel}</h3>
            <ul>
              {(byCategory.get(c) ?? [])
                .sort((a, b) => b[1] - a[1])
                .map(([type, n]) => (
                  <li key={type}>
                    <button onClick={() => activeId === id && navigate(`/entities?category=${c}&type=${encodeURIComponent(type)}`)} title={activeId === id ? 'Show in the table' : 'Open the project to browse it'}>
                      {registry.get(type).label}
                    </button>
                    <span className="count">{formatNumber(n)}</span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
        {relTypes.length > 0 && (
          <div className="project__card">
            <h3>Relationships</h3>
            <ul>
              {relTypes.map(([type, n]) => (
                <li key={type}>
                  <span>{type}</span>
                  <span className="count">{formatNumber(n)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="project__card">
          <h3>Structure</h3>
          <ul>
            <li>
              <span>Includes</span>
              <span className="count">{p.data.includes?.length ? p.data.includes.map((i) => displayLabel(store.get(i) ?? ({ id: i } as ProjectEntity))).join(', ') : '—'}</span>
            </li>
            <li>
              <span>Home</span>
              <span className="count">{p.data.home?.route ?? '—'}</span>
            </li>
            <li>
              <span>Only in this project</span>
              <span className="count">{formatNumber(exclusive)}</span>
            </li>
          </ul>
        </div>
      </div>
      <SaveAsProjectDialog open={savingAs} from={id} onClose={() => setSavingAs(false)} />
      <ConfirmDialog
        open={confirm === 'keep'}
        title={`Delete “${displayLabel(p)}”?`}
        message={`The project goes away; its ${formatNumber(counts.entities + counts.relationships)} entities stay in the Library. ${exclusive ? `${formatNumber(exclusive)} of them are in no other project — delete those too with the second option.` : ''}`}
        confirmLabel="Delete project only"
        danger
        onConfirm={() => remove('keep')}
        onCancel={() => setConfirm(null)}
      />
      {exclusive > 0 && confirm === 'keep' && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 1001 }}>
          <button className="btn btn--danger" onClick={() => remove('exclusive')}>
            Delete project and its {formatNumber(exclusive)} exclusive entities
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * `/open?url=…` — fetch a bundle and open it as a project, for links that should just work.
 *
 * A bundle from this site opens straight away: it is what the app's own links
 * and demos point at. One from anywhere else is **asked about first**, naming
 * the host — the link may have been sent by someone, the bundle becomes the
 * reader's workspace, and what is in it is drawn and run as data of their own.
 * Nothing is fetched until they say yes.
 */
export function OpenBundleRoute() {
  const store = useEntityStore()
  const [params] = useSearchParams()
  const toast = useToast()
  const navigate = useNavigate()
  const url = params.get('url')
  const [error, setError] = useState<string | null>(null)
  const [allowed, setAllowed] = useState(false)
  const started = useRef<string | null>(null)
  const where = url ? bundleOrigin(url) : null
  const external = useExternalServices()
  // With Third-party services off another site's bundle is not offered at all: there is nothing to say yes to.
  const offline = where?.kind === 'elsewhere' && !external
  const asks = where?.kind === 'elsewhere' && !allowed
  useEffect(() => {
    if (!url || started.current === url || asks || offline || where?.kind === 'refused') return
    started.current = url
    openBundleUrl(store, url)
      .then((r) => toast(`Opened “${displayLabel(r.project)}” · ${formatNumber(r.created)} new, ${formatNumber(r.updated)} updated`))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [url, store, toast, navigate, asks, offline, where?.kind])
  if (!url) return <div className="projects">Give this route a bundle: /open?url=/demos/china-tour/bundle.ae.json.gz</div>
  if (where?.kind === 'refused') return <div className="projects">Cannot open {url}: {where.why}</div>
  if (offline && where?.kind === 'elsewhere')
    return (
      <div className="projects open-ask">
        <PageHeader title="Not opened" subtitle={`This link would fetch a project from ${where.host}.`} />
        <p className="muted open-ask__body">
          Opening a project from another site needs a third-party service, and <strong>Third-party services</strong> is off in your account settings (the button at the foot of the sidebar). Nothing was fetched.
        </p>
        <p className="muted open-ask__url">{url}</p>
        <div className="open-ask__buttons">
          <button className="btn" onClick={() => navigate('/')}>
            Take me to the dashboard
          </button>
        </div>
      </div>
    )
  if (asks && where.kind === 'elsewhere')
    return (
      <div className="projects open-ask">
        <PageHeader title="Open a project from another site?" subtitle={`This link would fetch a project from ${where.host} and open it as yours.`} />
        <p className="muted open-ask__body">
          A project is data that becomes your workspace: its entities, documents, diagrams and scripts are drawn and run here, and it may replace what a project of the same name holds. Open it only if you know who sent this link.
        </p>
        <p className="muted open-ask__url">{url}</p>
        <div className="open-ask__buttons">
          <button className="btn btn--primary" onClick={() => setAllowed(true)}>
            Open from {where.host}
          </button>
          <button className="btn" onClick={() => navigate('/')}>
            No, take me to the dashboard
          </button>
        </div>
      </div>
    )
  return <div className="projects">{error ? `Could not open ${url}: ${error}` : `Opening ${url}…`}</div>
}
