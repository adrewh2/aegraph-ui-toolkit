import { Check, ChevronDown, Copy, Database, FolderOpen, GitCommitHorizontal, HardDrive, History, Library, Plus, Settings } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import { switchProject } from '../../core/projects/active'
import { useProjects } from '../../core/projects/hooks'
import { projectCounts } from '../../core/projects/project'
import { formatNumber } from '../../lib/format'
import { ProjectsDialog } from '../datasets/ProjectsDialog'
import { openBundleFile, saveProjectBundle } from './projectActions'
import { NewProjectDialog } from './NewProjectDialog'
import { SaveAsProjectDialog } from './SaveAsProjectDialog'
import { useChangeCount } from './history/useHistory'
import './Projects.css'

/**
 * The sidebar's project control: what you are looking at, and the menu to
 * change it. Choosing a project scopes every page to it and restores its
 * own explorer/workstation state; Library shows everything.
 */
export function ProjectSwitcher() {
  const store = useEntityStore()
  const { activeId, active, projects } = useProjects()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  const [creating, setCreating] = useState(false)
  const [savingAs, setSavingAs] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [opening, setOpening] = useState<false | 'projects' | 'import'>(false)
  // Unsaved (uncommitted) changes in the open project, for the badge and the menu.
  const unsaved = useChangeCount(activeId)

  const open = (id: string | null) => {
    setMenu(null)
    switchProject(store, id)
  }
  const save = async (format: 'json' | 'pack' = 'json') => {
    if (!activeId) return
    const r = await saveProjectBundle(store, activeId, { route: location.pathname + location.search, format })
    toast(`Saved ${r.filename} · ${formatNumber(r.count)} entities${r.where === 'folder' ? ' · in your projects folder' : ' · Downloads'}`)
  }
  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const report = await openBundleFile(store, file)
      toast(`Opened “${displayLabel(report.project)}” · ${formatNumber(report.created)} new, ${formatNumber(report.updated)} updated`)
    } catch (err) {
      toast(`Could not open that bundle: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Counting every project's scope walks the whole Library; it happens when the menu opens, not on every render of the sidebar.
  const counts = useMemo(() => (menu ? new Map(projects.map((p) => [p.id, projectCounts(store, p.id).entities])) : null), [menu, projects, store])
  const items: MenuItem[] = [
    { kind: 'label', label: 'Projects' },
    ...(projects.length
      ? projects.map<MenuItem>((p) => ({ kind: 'item', label: `${displayLabel(p)}  ·  ${formatNumber(counts?.get(p.id) ?? 0)}`, icon: p.id === activeId ? Check : undefined, onSelect: () => open(p.id) }))
      : [{ kind: 'item' as const, label: 'No projects yet', disabled: true, onSelect: () => {} }]),
    { kind: 'sep' },
    { kind: 'item', label: `Library (everything)  ·  ${formatNumber(store.library.entityCount())}`, icon: activeId ? Library : Check, onSelect: () => open(null) },
    { kind: 'sep' },
    { kind: 'item', label: 'New project…', icon: Plus, onSelect: () => (setMenu(null), setCreating(true)) },
    { kind: 'item', label: 'Open project…', icon: FolderOpen, onSelect: () => (setMenu(null), setOpening('projects')) },
    { kind: 'item', label: 'Import, examples, export…', icon: Database, onSelect: () => (setMenu(null), setOpening('import')) },
    { kind: 'item', label: 'Save project…', disabled: !activeId, onSelect: () => (setMenu(null), void save()) },
    // The pack: aegraph's own bytes — a fraction of the size, quicker to load; .ae.json stays the file other tools read.
    { kind: 'item', label: 'Save project as .aeb (compact)…', disabled: !activeId, onSelect: () => (setMenu(null), void save('pack')) },
    { kind: 'item', label: activeId ? 'Save as new project…' : 'Save Library as new project…', icon: Copy, onSelect: () => (setMenu(null), setSavingAs(true)) },
    ...(activeId
      ? [
          { kind: 'sep' as const },
          { kind: 'item' as const, label: unsaved ? `Unsaved changes  ·  ${formatNumber(unsaved)}` : 'Changes (all committed)', icon: GitCommitHorizontal, onSelect: () => (setMenu(null), navigate(`/projects/${encodeURIComponent(activeId)}/changes`)) },
          { kind: 'item' as const, label: 'History', icon: History, onSelect: () => (setMenu(null), navigate(`/projects/${encodeURIComponent(activeId)}/history`)) },
          { kind: 'item' as const, label: 'Project settings', icon: Settings, onSelect: () => (setMenu(null), navigate(`/projects/${encodeURIComponent(activeId)}/settings`)) },
        ]
      : []),
    { kind: 'sep' },
    { kind: 'item', label: 'Manage projects', onSelect: () => (setMenu(null), navigate('/projects')) },
    { kind: 'item', label: 'Where projects are stored…', icon: HardDrive, onSelect: () => (setMenu(null), navigate('/projects#storage')) },
  ]

  return (
    <>
      <button className={`sb-select ${active ? 'sb-select--project' : ''}`} title={active ? `Project · ${displayLabel(active)}` : 'The Library: everything, no project'} onClick={(e) => setMenu(menu ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget })}>
        <Library size={15} className="sb-select__icon" />
        <span className="sb-select__label">{active ? displayLabel(active) : 'Library'}</span>
        {unsaved ? (
          <span className="sb-select__unsaved" title={`${formatNumber(unsaved)} unsaved change${unsaved === 1 ? '' : 's'} — open the project menu to review or commit`}>
            {unsaved > 999 ? '999+' : unsaved}
          </span>
        ) : null}
        <ChevronDown size={16} className="sb-select__chevron" />
      </button>
      {menu && <Menu x={menu.x} y={menu.y} items={items} anchor={menu.anchor} onClose={() => setMenu(null)} />}
      <input ref={fileRef} type="file" accept=".aeb,.json,.gz,application/json" hidden onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          onFile(f).catch(() => {})
        }} />
      {opening && <ProjectsDialog tab={opening} onClose={() => setOpening(false)} />}
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
      <SaveAsProjectDialog open={savingAs} from={activeId} onClose={() => setSavingAs(false)} />
    </>
  )
}
