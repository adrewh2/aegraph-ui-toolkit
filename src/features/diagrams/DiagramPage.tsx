import { ChevronDown, ChevronRight, CopyPlus, Download, Info, MoreHorizontal, Save, Sparkles, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Menu, Popover } from '../../components/ui/Menu'
import { TagChip } from '../../components/ui/TagChip'
import type { ParsedDiagram } from '../../core/diagrams'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { Inspector } from '../resources/Inspector'
import { TagEditor } from '../resources/TagEditor'
import type { DiagramEntity } from './diagrams'
import { DiagramWorkbench, SaveAsDialog, useDiagramEditor } from './DiagramWorkbench'

type Panel = 'info' | null

interface Props {
  diagram: DiagramEntity
  onExport: (parsed: ParsedDiagram, engine: string) => void
  onMenu: (x: number, y: number) => void
  onDelete: (id: EntityId) => void
  focusTitle: number
  autoOpenExport?: boolean
}

export function DiagramPage({ diagram, onExport, onMenu, onDelete, focusTitle, autoOpenExport }: Props) {
  const store = useEntityStore()
  useStoreVersion(store)
  const navigate = useNavigate()
  const [panel, setPanel] = useState<Panel>(null)
  const [saveMenu, setSaveMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  const [saveAs, setSaveAs] = useState<string | null>(null)
  const editor = useDiagramEditor(diagram)
  const { parsed } = editor

  useEffect(() => {
    if (autoOpenExport && parsed.nodes.length) onExport(parsed, editor.engine)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenExport])

  return (
    <div className="dp dgp">
      <header className="dp__top">
        <nav className="dp__crumbs" aria-label="Breadcrumb">
          <button className="dp__crumb" onClick={() => navigate('/diagrams')}>
            Diagrams
          </button>
          <span className="dp__crumb-wrap">
            <ChevronRight size={13} className="faint" />
            <TitleInput diagram={diagram} focus={focusTitle} />
          </span>
          <button className="btn btn--sm btn--icon btn--ghost" title="More" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 4)}>
            <MoreHorizontal size={14} />
          </button>
        </nav>
        <div className="dp__top-right">
          <Tags diagram={diagram} />
          <span className="dp__save">
            <button className={`btn btn--sm ${editor.dirty ? 'btn--primary' : ''}`} onClick={editor.saveNow} disabled={!editor.dirty} title={editor.dirty ? 'Save the diagram entity now (changes save on their own after a pause)' : 'The diagram entity is saved'}>
              <Save size={14} /> {editor.dirty ? 'Save' : 'Saved'}
            </button>
            <button className={`btn btn--sm btn--icon ${editor.dirty ? 'btn--primary' : ''}`} title="Save as, download, export" onClick={(e) => setSaveMenu(saveMenu ? null : { x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget })}>
              <ChevronDown size={14} />
            </button>
          </span>
          {saveMenu && (
            <Menu
              x={saveMenu.x - 240}
              y={saveMenu.y}
              anchor={saveMenu.anchor}
              onClose={() => setSaveMenu(null)}
              items={[
                { kind: 'item', label: editor.dirty ? 'Save now' : 'Saved', icon: Save, disabled: !editor.dirty, onSelect: editor.saveNow },
                { kind: 'item', label: 'Save as new diagram…', icon: CopyPlus, onSelect: () => setSaveAs(`${diagram.label ?? 'Diagram'} copy`) },
                { kind: 'sep' },
                { kind: 'label', label: 'Download' },
                { kind: 'item', label: `Source (.${editor.format === 'dot' ? 'dot' : editor.format === 'mermaid' ? 'mmd' : 'excalidraw'})`, icon: Download, onSelect: () => void editor.download('source') },
                { kind: 'item', label: 'SVG', icon: Download, onSelect: () => void editor.download('svg') },
                { kind: 'item', label: 'PNG', icon: Download, onSelect: () => void editor.download('png') },
                { kind: 'sep' },
                { kind: 'item', label: 'Export to dataset…', icon: Upload, disabled: parsed.nodes.length === 0, onSelect: () => onExport(parsed, editor.engine) },
              ]}
            />
          )}
          <SaveAsDialog editor={editor} diagram={diagram} name={saveAs} onName={setSaveAs} onClose={() => setSaveAs(null)} />
          <button className={`btn btn--sm btn--icon ${panel === 'info' ? 'is-on' : ''}`} title="Entity details" onClick={() => setPanel(panel === 'info' ? null : 'info')}>
            <Info size={14} />
          </button>
          <button className="btn btn--sm" title="Open the assistant (⌘J)" onClick={() => window.dispatchEvent(new CustomEvent('aegraph:assistant', { detail: { open: true } }))}>
            <Sparkles size={14} /> Assistant
          </button>
        </div>
      </header>

      <div className="dp__body">
        <main className="dp__main dgp__main">
          <DiagramWorkbench diagram={diagram} editor={editor} />
        </main>

        {panel === 'info' && (
          <aside className="dp__panel">
            <Inspector entityId={diagram.id} onClose={() => setPanel(null)} onOpen={(id) => navigate(`/entities?sel=${id}`)} onDelete={(ids) => onDelete(ids[0])} />
          </aside>
        )}
      </div>
    </div>
  )
}

function TitleInput({ diagram, focus }: { diagram: DiagramEntity; focus: number }) {
  const store = useEntityStore()
  const [title, setTitle] = useState(diagram.label ?? '')
  const [seen, setSeen] = useState(diagram.label)
  if (diagram.label !== seen) {
    setSeen(diagram.label)
    setTitle(diagram.label ?? '')
  }
  const commit = () => {
    const next = title.trim()
    if (next && next !== diagram.label) store.update(diagram.id, { label: next })
    else setTitle(diagram.label ?? '')
  }
  return (
    <input
      className="ip__title"
      value={title}
      placeholder="Untitled diagram"
      size={Math.max(8, Math.min(70, title.length + 2))}
      autoFocus={focus > 0}
      onFocus={(e) => focus > 0 && e.currentTarget.select()}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setTitle(diagram.label ?? '')
          e.currentTarget.blur()
        }
      }}
      title="Rename"
    />
  )
}

function Tags({ diagram }: { diagram: DiagramEntity }) {
  const store = useEntityStore()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  return (
    <>
      <button className="dp__tags" onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} title="Edit tags">
        {diagram.tags.length === 0 && <span className="faint">Add tags</span>}
        {diagram.tags.slice(0, 4).map((t) => (
          <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
        ))}
        {diagram.tags.length > 4 && <span className="badge">+{diagram.tags.length - 4}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={300}>
          <TagEditor value={diagram.tags} onChange={(tags) => store.update(diagram.id, { tags })} onDone={() => setAnchor(null)} />
        </Popover>
      )}
    </>
  )
}
