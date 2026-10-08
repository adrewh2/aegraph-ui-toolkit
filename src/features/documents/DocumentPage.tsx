import type { Editor } from '@tiptap/react'
import { ChevronRight, Highlighter, Info, ListTree, MoreHorizontal, PanelLeft, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Popover } from '../../components/ui/Menu'
import { TagChip } from '../../components/ui/TagChip'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { formatDate } from '../../lib/format'
import { Inspector } from '../resources/Inspector'
import { TagEditor } from '../resources/TagEditor'
import { AnnotationsPanel } from './AnnotationsPanel'
import { ancestorsOf, annotationsOf, extOf, isFolder, isPdf, isTextDocument, type DocumentEntity, UNTITLED } from './documents'
import { EditorToolbar } from './editor/EditorToolbar'
import { PlainEditor } from './editor/PlainEditor'
import type { OutlineEntry } from './editor/outline'
import { RichEditor } from './editor/RichEditor'
import type { PendingQuote, SaveState } from './editor/types'
import { PdfViewer } from './PdfViewer'
import { scrollBehavior } from '../../lib/motion'

type Panel = 'info' | 'annotations' | null
const PANEL_KEY = 'aegraph:documents:panel'
const RAIL_KEY = 'aegraph:documents:rail'

interface Props {
  doc: DocumentEntity
  onAnnotate: (q: PendingQuote) => void
  onMenu: (x: number, y: number) => void
  /** Bumps when the caller wants the title focused (new doc, rename). */
  focusTitle: number
  /** Set by the caller after an annotation is created, to reveal it. */
  revealAnnotationId: EntityId | null
  onRevealAnnotation: (id: EntityId | null) => void
  onDelete: (id: EntityId) => void
}

export function DocumentPage({ doc, onAnnotate, onMenu, focusTitle, revealAnnotationId, onRevealAnnotation, onDelete }: Props) {
  const store = useEntityStore()
  useStoreVersion(store)
  const navigate = useNavigate()
  const [editor, setEditor] = useState<Editor | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [outline, setOutline] = useState<OutlineEntry[]>([])
  const [panel, setPanelState] = useState<Panel>(() => (read(PANEL_KEY) as Panel) || null)
  const [rail, setRailState] = useState(() => read(RAIL_KEY) !== '0')
  const [inspectId, setInspectId] = useState<EntityId | null>(null)
  const [plainSelection, setPlainSelection] = useState(false)
  const plainAnnotate = useRef<(() => void) | null>(null)

  const setPanel = (p: Panel) => (setPanelState(p), write(PANEL_KEY, p ?? ''))
  const setRail = (v: boolean) => (setRailState(v), write(RAIL_KEY, v ? '1' : '0'))

  const text = isTextDocument(doc)
  const md = extOf(doc) === 'md'
  const annotationCount = annotationsOf(store, doc.id).length
  const crumbs = ancestorsOf(store, doc.id).reverse()
  const inspected = inspectId ? store.get(inspectId) : doc

  const openEntity = useCallback((id: EntityId) => {
    setInspectId(id)
    setPanelState('info')
  }, [])

  const annotateFromEditor = () => {
    if (!editor) return
    const { from, to } = editor.state.selection
    const exact = editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim()
    if (!exact) return
    const src = editor.getMarkdown()
    const at = src.indexOf(exact)
    const span = 32
    onAnnotate(at >= 0 ? { exact, prefix: at > 0 ? src.slice(Math.max(0, at - span), at) : undefined, suffix: src.slice(at + exact.length, at + exact.length + span) || undefined } : { exact })
  }

  const jumpTo = (entry: OutlineEntry) => {
    if (!editor) return
    editor.chain().focus().setTextSelection(entry.pos + 1).run()
    const dom = editor.view.nodeDOM(entry.pos) as HTMLElement | null
    dom?.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
  }

  return (
    <div className="dp">
      <header className="dp__top">
        <nav className="dp__crumbs" aria-label="Breadcrumb">
          <button className="dp__crumb" onClick={() => navigate('/documents')}>
            Documents
          </button>
          {crumbs.map((id) => {
            const f = store.get(id)
            return f ? (
              <span key={id} className="dp__crumb-wrap">
                <ChevronRight size={13} className="faint" />
                <button className="dp__crumb" onClick={() => navigate(`/documents/${id}`)}>
                  {displayLabel(f)}
                </button>
              </span>
            ) : null
          })}
          <span className="dp__crumb-wrap">
            <ChevronRight size={13} className="faint" />
            <span className="dp__crumb dp__crumb--current">{displayLabel(doc)}</span>
          </span>
          <button className="btn btn--sm btn--icon btn--ghost" title="More" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 4)}>
            <MoreHorizontal size={14} />
          </button>
        </nav>
        <div className="dp__top-right">
          <Tags doc={doc} />
          {!isFolder(doc) && (
            <button className={`btn btn--sm ${panel === 'annotations' ? 'is-on' : ''}`} title="Annotations" onClick={() => setPanel(panel === 'annotations' ? null : 'annotations')}>
              <Highlighter size={14} />
              {annotationCount > 0 && <span className="count">{annotationCount}</span>}
            </button>
          )}
          <button className={`btn btn--sm btn--icon ${panel === 'info' ? 'is-on' : ''}`} title="Entity details" onClick={() => setPanel(panel === 'info' ? null : 'info')}>
            <Info size={14} />
          </button>
          <button className="btn btn--sm" title="Open the assistant (⌘J)" onClick={() => window.dispatchEvent(new CustomEvent('aegraph:assistant', { detail: { open: true } }))}>
            <Sparkles size={14} /> Assistant
          </button>
        </div>
      </header>

      <div className="dp__toolbar">
        <button className={`tb__btn ${rail ? 'is-active' : ''}`} title={rail ? 'Hide outline' : 'Show outline'} onClick={() => setRail(!rail)}>
          <PanelLeft size={15} />
        </button>
        <span className="tb__sep" />
        {md && editor && <EditorToolbar editor={editor} onAnnotate={annotateFromEditor} />}
        {extOf(doc) === 'txt' && (
          <div className="tb">
            <span className="muted" style={{ fontSize: 12 }}>
              Plain text
            </span>
            <span className="tb__sep" />
            <button className="btn btn--sm tb__annotate" disabled={!plainSelection} onMouseDown={(e) => e.preventDefault()} onClick={() => plainAnnotate.current?.()}>
              <Highlighter size={13} /> Annotate
            </button>
          </div>
        )}
        {isPdf(doc) && <span className="muted" style={{ fontSize: 12 }}>PDF</span>}
        <span className="spacer" />
        <span className="dp__edited muted" title={new Date(doc.meta.updatedAt).toLocaleString()}>
          {text && saveState !== 'saved' ? (saveState === 'saving' ? 'Saving…' : 'Unsaved changes') : `Edited ${formatDate(doc.meta.updatedAt)}`}
        </span>
      </div>

      <div className="dp__body">
        {rail && (
          <aside className="dp__rail">
            <div className="dp__rail-head">
              <ListTree size={13} className="faint" /> Outline
            </div>
            {md ? (
              outline.length === 0 ? (
                <div className="dp__rail-empty muted">Headings you add will appear here.</div>
              ) : (
                outline.map((h, i) => (
                  <button key={i} className={`dp__rail-item dp__rail-item--${h.level}`} onClick={() => jumpTo(h)} title={h.text}>
                    {h.text || <span className="faint">Untitled heading</span>}
                  </button>
                ))
              )
            ) : (
              <div className="dp__rail-empty muted">{isPdf(doc) ? 'PDF documents have no outline.' : 'Plain-text documents have no outline.'}</div>
            )}
          </aside>
        )}

        <main className="dp__main">
          {isPdf(doc) ? (
            <PdfViewer key={doc.id} doc={doc} />
          ) : (
            <div className="dp__column">
              <Title doc={doc} focus={focusTitle} onEnter={() => (md ? editor?.chain().focus('start').run() : (document.querySelector<HTMLTextAreaElement>('.dp__plain')?.focus()))} />
              {md ? (
                <RichEditor key={doc.id} doc={doc} onReady={setEditor} onSaveStateChange={setSaveState} onOutlineChange={setOutline} onAnnotate={onAnnotate} onOpenEntity={openEntity} revealAnnotationId={revealAnnotationId} />
              ) : (
                <PlainEditor key={doc.id} doc={doc} onSaveStateChange={setSaveState} onAnnotate={onAnnotate} onSelectionChange={setPlainSelection} annotateRef={plainAnnotate} />
              )}
            </div>
          )}
        </main>

        {panel && (
          <aside className="dp__panel">
            {panel === 'info' && inspected ? (
              <Inspector
                entityId={inspected.id}
                collapsedFields={inspected.id === doc.id ? ['data.content'] : undefined}
                onClose={() => (inspectId ? setInspectId(null) : setPanel(null))}
                onOpen={(id) => {
                  const t = store.get(id)
                  if (t && t.type === 'document') navigate(`/documents/${id}`)
                  else if (t) setInspectId(id)
                }}
                onDelete={(ids) => onDelete(ids[0])}
              />
            ) : (
              <AnnotationsPanel
                doc={doc}
                onClose={() => setPanel(null)}
                onReveal={(id) => {
                  onRevealAnnotation(null)
                  requestAnimationFrame(() => onRevealAnnotation(id))
                }}
                onInspect={(id) => (setInspectId(id), setPanel('info'))}
                onDelete={onDelete}
              />
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

function Title({ doc, focus, onEnter }: { doc: DocumentEntity; focus: number; onEnter: () => void }) {
  const store = useEntityStore()
  // A document still called "Untitled" shows an empty field with the name as its placeholder, so typing replaces it.
  const shown = !doc.label || doc.label === UNTITLED ? '' : doc.label
  const [title, setTitle] = useState(shown)
  const [seen, setSeen] = useState(doc.label)
  if (doc.label !== seen) {
    setSeen(doc.label)
    setTitle(shown)
  }
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (focus) {
      ref.current?.focus()
      ref.current?.select()
    }
  }, [focus, doc.id])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [title])
  const commit = () => {
    const next = title.trim()
    if (next && next !== doc.label) store.update(doc.id, { label: next })
    else setTitle(shown)
  }
  return (
    <textarea
      ref={ref}
      className="dp__title"
      rows={1}
      value={title}
      placeholder={UNTITLED}
      onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || (e.key === 'ArrowDown' && e.currentTarget.selectionStart === title.length)) {
          e.preventDefault()
          commit()
          onEnter()
        }
        if (e.key === 'Escape') {
          setTitle(shown)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

function Tags({ doc }: { doc: DocumentEntity }) {
  const store = useEntityStore()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  return (
    <>
      <button className="dp__tags" onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} title="Edit tags">
        {doc.tags.length === 0 && <span className="faint">Add tags</span>}
        {doc.tags.slice(0, 4).map((t) => (
          <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
        ))}
        {doc.tags.length > 4 && <span className="badge">+{doc.tags.length - 4}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={300}>
          <TagEditor value={doc.tags} onChange={(tags) => store.update(doc.id, { tags })} onDone={() => setAnchor(null)} />
        </Popover>
      )}
    </>
  )
}


function read(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* ignore */
  }
}
