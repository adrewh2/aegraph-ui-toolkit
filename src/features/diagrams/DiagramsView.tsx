import { ChevronDown, GitFork, MoreHorizontal, PenLine, Plus, Search, Trash2, Upload, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { MarqueeOverlay, SelectionToolbar } from '../../components/ListSelection/ListSelection'
import { useListSelection } from '../../components/ListSelection/useListSelection'
import { TagChip } from '../../components/ui/TagChip'
import { useToast } from '../../components/ui/useToast'
import { detectDiagramFormat, type DiagramFormat, type ParsedDiagram } from '../../core/diagrams'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { pickFile } from '../../lib/download'
import { formatDate } from '../../lib/format'
import { DiagramPage } from './DiagramPage'
import { allDiagrams, createDiagram, DIAGRAM_ACCEPT, importDiagramFile, isDiagram, safeParse, TEMPLATES, type DiagramEntity } from './diagrams'
import { DiagramThumb } from './DiagramThumb'
import { ImportWizard } from './ImportWizard'
import '../documents/DocumentsView.css'
import '../images/images.css'
import '../videos/videos.css'
import '../graph/GraphExplorer.css'
import './diagrams.css'
import { openInItems } from '../../app/openIn'
import { useOpenInTab } from '../workstation/paneContext'
import { Select } from '../../components/ui/Select'

/** `/diagrams` lists Graphviz/Mermaid diagrams; `/diagrams/:id` edits one live. `?export=1` opens the mapping wizard. */
export function DiagramsView() {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const navigate = useNavigate()
  const openTab = useOpenInTab()
  const toast = useToast()
  const { id } = useParams()
  const [params, setParams] = useSearchParams()

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<EntityId | null>(null)
  const [addDialog, setAddDialog] = useState(false)
  const [wizard, setWizard] = useState<{ parsed: ParsedDiagram; engine: string } | null>(null)
  const [focusTitle, setFocusTitle] = useState(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => allDiagrams(store), [store, version])
  const active = id ? store.get(id) : undefined
  const diagram: DiagramEntity | undefined = isDiagram(active) ? active : undefined
  const missing = !!id && !diagram
  const autoExport = params.get('export') === '1'

  const confirmDelete = () => {
    if (!pendingDelete) return
    const t = store.get(pendingDelete)
    store.remove(pendingDelete)
    toast(`Deleted ${t ? displayLabel(t) : 'item'}`)
    setPendingDelete(null)
    if (diagram && diagram.id === pendingDelete) navigate('/diagrams')
  }

  const contextItems = (d: DiagramEntity): MenuItem[] => [
    { kind: 'item', label: 'Open', onSelect: () => navigate(`/diagrams/${d.id}`) },
    { kind: 'item', label: 'Rename', icon: PenLine, onSelect: () => (navigate(`/diagrams/${d.id}`), setFocusTitle((n) => n + 1)) },
    { kind: 'item', label: 'Export to dataset…', icon: Upload, onSelect: () => navigate(`/diagrams/${d.id}?export=1`) },
    ...openInItems(d, navigate, undefined, { store, open: openTab }),
    { kind: 'sep' },
    { kind: 'item', label: 'Delete', icon: Trash2, danger: true, onSelect: () => setPendingDelete(d.id) },
  ]

  const importFile = async () => {
    const file = await pickFile(DIAGRAM_ACCEPT)
    if (!file) return
    const e = await importDiagramFile(store, file)
    toast(`Added ${displayLabel(e)}`)
    navigate(`/diagrams/${e.id}`)
  }

  let body
  if (missing) {
    body = (
      <div className="di__empty">
        <div className="di__empty-inner">
          <h2>Diagram not found</h2>
          <button className="btn" onClick={() => navigate('/diagrams')}>
            Back to diagrams
          </button>
        </div>
      </div>
    )
  } else if (!diagram) {
    body = <DiagramsIndex items={items} onAdd={() => setAddDialog(true)} onImport={importFile} contextItems={contextItems} />
  } else {
    body = (
      <DiagramPage
        key={diagram.id}
        diagram={diagram}
        focusTitle={focusTitle}
        autoOpenExport={autoExport}
        onExport={(parsed, engine) => {
          if (autoExport) setParams({}, { replace: true })
          setWizard({ parsed, engine })
        }}
        onMenu={(x, y) => setMenu({ x, y, items: contextItems(diagram) })}
        onDelete={(did) => setPendingDelete(did)}
      />
    )
  }

  return (
    <>
      {body}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {addDialog && (
        <DiagramNewDialog
          onClose={() => setAddDialog(false)}
          onSubmit={(label, source, format) => {
            const e = createDiagram(store, { label, source, format })
            setAddDialog(false)
            navigate(`/diagrams/${e.id}`)
          }}
        />
      )}
      {diagram && wizard && <ImportWizard diagram={diagram} parsed={wizard.parsed} engine={wizard.engine} onClose={() => setWizard(null)} />}
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this diagram?"
        message={pendingDelete ? `“${displayLabel(store.get(pendingDelete) ?? ({ id: pendingDelete } as AnyEntity))}” will be removed. Entities exported from it stay in the dataset.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}

export function DiagramNewDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (label: string, source: string, format: DiagramFormat) => void }) {
  const [label, setLabel] = useState('')
  const [template, setTemplate] = useState(TEMPLATES[0].id)
  const [paste, setPaste] = useState('')
  const t = TEMPLATES.find((x) => x.id === template)!
  const submit = () => {
    const src = paste.trim() || t.source
    onSubmit(label.trim() || (paste.trim() ? 'Pasted diagram' : t.label), src, paste.trim() ? detectDiagramFormat(src) : t.format)
  }
  return (
    <Dialog
      open
      title="New diagram"
      description="Start from a template, or paste Graphviz DOT, Mermaid, or Excalidraw JSON. The format is detected from the text."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit}>
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input className="input" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Untitled diagram" onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <div className="field">
        <label>Template</label>
        <Select className="input" value={template} onChange={(e) => setTemplate(e.target.value)} disabled={!!paste.trim()}>
          {TEMPLATES.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="field">
        <label>…or paste source</label>
        <textarea className="input mono" rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'digraph { a -> b }\nflowchart TD\n  a --> b'} />
      </div>
    </Dialog>
  )
}

function DiagramsIndex({ items, onAdd, onImport, contextItems }: { items: DiagramEntity[]; onAdd: () => void; onImport: () => void; contextItems: (d: DiagramEntity) => MenuItem[] }) {
  const store = useEntityStore()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [format, setFormat] = useState<DiagramFormat | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const q = search.trim().toLowerCase()
  const list = useMemo(
    () =>
      items
        .filter((d) => (!q || displayLabel(d).toLowerCase().includes(q) || d.tags.some((t) => t.includes(q))) && (!format || d.data.format === format))
        .sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt)),
    [items, q, format],
  )
  const [bulkDelete, setBulkDelete] = useState<EntityId[] | null>(null)
  const ids = useMemo(() => list.map((d) => d.id), [list])
  const { rootRef, sel } = useListSelection(ids, setBulkDelete)
  return (
    <div ref={rootRef} data-sel-root="" onMouseDown={sel.onMouseDown} className="di">
      <header className="di__head">
        <div className="di__head-left">
          <h1 className="page-title">Diagrams</h1>
          <p className="page-subtitle">Graphviz and Mermaid, rendered live. Export a diagram's structure into the dataset, or turn part of the dataset into a diagram.</p>
        </div>
        <div className="di__head-actions">
          <button className="btn" onClick={onImport}>
            <Upload size={14} /> Import .dot / .mmd
          </button>
          <button className="btn btn--primary" onClick={onAdd}>
            <Plus size={14} /> New diagram
          </button>
        </div>
      </header>
      <div className="di__filters">
        <button className={`di__chip ${format ? 'is-active' : ''}`} onClick={(e) => setMenu({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, items: [{ kind: 'item', label: 'Graphviz', onSelect: () => setFormat('dot') }, { kind: 'item', label: 'Mermaid', onSelect: () => setFormat('mermaid') }, { kind: 'item', label: 'Excalidraw', onSelect: () => setFormat('excalidraw') }, { kind: 'item', label: 'All', onSelect: () => setFormat(null) }] })}>
          {format === 'dot' ? 'Graphviz' : format === 'mermaid' ? 'Mermaid' : format === 'excalidraw' ? 'Excalidraw' : 'Format'}
          {format ? (
            <span className="di__chip-x" role="button" aria-label="Clear" onClick={(e) => (e.stopPropagation(), setFormat(null))}>
              <X size={11} />
            </span>
          ) : (
            <ChevronDown size={12} className="faint" />
          )}
        </button>
        <span className="spacer" />
        <label className="di__search">
          <Search size={14} className="faint" />
          <input placeholder="Search diagrams" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>
      {list.length === 0 ? (
        <div className="di__empty">
          <div className="di__empty-inner">
            <GitFork size={28} strokeWidth={1.5} className="faint" />
            <h2>{q || format ? 'Nothing matches' : 'No diagrams yet'}</h2>
            <p className="muted">{q || format ? 'Try a different search.' : 'Create one from a template, paste DOT or Mermaid, or import a file.'}</p>
            {!q && !format && (
              <div className="di__empty-actions">
                <button className="btn btn--primary" onClick={onAdd}>
                  <Plus size={14} /> New diagram
                </button>
                <button className="btn" onClick={onImport}>
                  <Upload size={14} /> Import
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="ig__grid dgi__grid">
          {list.map((d, i) => {
            const parsed = safeParse(d.data.source, d.data.format)
            return (
              <div key={d.id} className={`ig__card ${sel.isSelected(d.id) ? 'is-selected' : ''}`} data-id={d.id} role="button" tabIndex={0} onClick={(e) => sel.click(e, d.id, i) || navigate(`/diagrams/${d.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/diagrams/${d.id}`)} onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, items: contextItems(d) }))}>
                <div className="ig__thumb dgi__thumb">
                  <DiagramThumb source={d.data.source} format={d.data.format} />
                  <span className="mg__kind">{d.data.format === 'dot' ? 'graphviz' : d.data.format === 'excalidraw' ? 'excalidraw' : 'mermaid'}</span>
                  {d.data.lastImport && (
                    <span className="ig__count" title={`Exported ${d.data.lastImport.entities} entities ${formatDate(d.data.lastImport.at)}`}>
                      <Upload size={11} /> {d.data.lastImport.entities}
                    </span>
                  )}
                </div>
                <div className="di__card-foot">
                  <div className="di__card-name">
                    <span className="di__card-title">{displayLabel(d)}</span>
                    <button className="btn btn--sm btn--icon btn--ghost di__card-more" aria-label="More" onClick={(e) => (e.stopPropagation(), setMenu({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, items: contextItems(d) }))}>
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                  <div className="di__card-meta">
                    <span className="muted">
                      {parsed ? `${parsed.kind} · ${parsed.nodes.length} nodes · ${parsed.edges.length} edges` : d.data.format}
                    </span>
                    <span className="muted">{formatDate(d.meta.updatedAt)}</span>
                    {d.tags.slice(0, 2).map((t) => (
                      <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <MarqueeOverlay sel={sel} />
      <SelectionToolbar sel={sel} noun="diagram" deleteMany={(ids) => store.remove(ids)} confirmDeleteIds={bulkDelete} onConfirmHandled={() => setBulkDelete(null)} />
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

