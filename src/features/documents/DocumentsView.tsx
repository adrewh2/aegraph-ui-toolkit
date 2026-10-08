import { FilePlus, Folder, FolderPlus, PenLine, Trash2, Upload } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import { type AnyEntity, type EntityId } from '../../core/entity/types'
import { pickFile } from '../../lib/download'
import { AnnotateDialog, MoveDialog } from './dialogs'
import {
  allDocuments,
  ancestorsOf,
  annotateDocument,
  createDocument,
  deleteDocument,
  descendantsOf,
  downloadDocument,
  duplicateDocument,
  extOf,
  FOLDER,
  IMPORT_ACCEPT,
  importFile,
  isDocument,
  isFolder,
  isPdf,
  moveDocument,
  type DocumentEntity,
} from './documents'
import { DocumentsIndex } from './DocumentsIndex'
import type { PendingQuote } from './editor/types'
import './DocumentsView.css'
import { openInItems } from '../../app/openIn'
import { useOpenInTab } from '../workstation/paneContext'

const DocumentPage = lazy(() => import('./DocumentPage').then((m) => ({ default: m.DocumentPage })))

/**
 * `/documents` shows the top-level index; `/documents/:id` shows a folder's
 * index or opens a document full-page. This component owns the flows both
 * share: create, import, move, duplicate, delete, annotate.
 */
export function DocumentsView() {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const navigate = useNavigate()
  const openTab = useOpenInTab()
  const toast = useToast()
  const { id: activeId } = useParams()

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<EntityId | null>(null)
  const [moving, setMoving] = useState<EntityId | null>(null)
  const [quote, setQuote] = useState<PendingQuote | null>(null)
  const [reveal, setReveal] = useState<EntityId | null>(null)
  const [focusTitle, setFocusTitle] = useState(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const docs = useMemo(() => allDocuments(store), [store, version])
  const active = activeId ? store.get(activeId) : undefined
  const doc: DocumentEntity | undefined = isDocument(active) ? active : undefined
  const missing = !!activeId && !doc

  const open = useCallback((id: EntityId) => navigate(`/documents/${id}`), [navigate])

  /**
   * `/documents/new` makes one and opens it — the tab's own way in, as a URL. Once, however many times the
   * effect runs before the address changes: React runs it twice in development, and a store change can render
   * the route again before the navigation lands, which is three empty documents for one visit.
   */
  const madeOne = useRef(false)
  useEffect(() => {
    if (activeId !== 'new') {
      madeOne.current = false
      return
    }
    if (madeOne.current) return
    madeOne.current = true
    const e = createDocument(store, { extension: 'md' })
    navigate(`/documents/${e.id}`, { replace: true })
    setFocusTitle((n) => n + 1)
  }, [activeId, store, navigate])

  const create = (extension: string, parentId?: EntityId) => {
    const e = createDocument(store, { extension, parentId })
    open(e.id)
    setFocusTitle((n) => n + 1)
  }

  const doImport = async (parentId?: EntityId) => {
    const file = await pickFile(IMPORT_ACCEPT)
    if (!file) return
    try {
      const e = await importFile(store, file, parentId)
      toast(`Imported ${displayLabel(e)}`)
      open(e.id)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    const target = store.get(pendingDelete)
    const wasOpen = !!doc && (doc.id === pendingDelete || ancestorsOf(store, doc.id).includes(pendingDelete))
    const parent = isDocument(target) ? target.data.parentId : undefined
    const removed = isDocument(target) ? deleteDocument(store, pendingDelete) : (store.remove(pendingDelete), [pendingDelete])
    toast(`Deleted ${removed.length === 1 ? displayLabel(target ?? ({ id: pendingDelete } as AnyEntity)) : `${removed.length} items`}`)
    setPendingDelete(null)
    if (wasOpen) navigate(parent && store.has(parent) ? `/documents/${parent}` : '/documents')
  }

  const contextItems = (e: DocumentEntity): MenuItem[] => {
    const folder = isFolder(e)
    const items: MenuItem[] = [{ kind: 'item', label: 'Open', onSelect: () => open(e.id) }]
    if (folder) {
      items.push({ kind: 'item', label: 'New document here', icon: FilePlus, onSelect: () => create('md', e.id) })
      items.push({ kind: 'item', label: 'New folder here', icon: FolderPlus, onSelect: () => create(FOLDER, e.id) })
      items.push({ kind: 'item', label: 'Import file here…', icon: Upload, onSelect: () => doImport(e.id) })
    }
    items.push({ kind: 'sep' })
    items.push({ kind: 'item', label: 'Rename', icon: PenLine, onSelect: () => (open(e.id), setFocusTitle((n) => n + 1)) })
    items.push({ kind: 'item', label: 'Duplicate', onSelect: () => open(duplicateDocument(store, e).id) })
    items.push({ kind: 'item', label: 'Move to…', icon: Folder, onSelect: () => setMoving(e.id) })
    if (!folder) items.push({ kind: 'item', label: 'Download', onSelect: () => downloadDocument(e), disabled: isPdf(e) && !e.data.dataUrl && !e.data.sourceUrl })
    if (!folder && !isPdf(e)) items.push({ kind: 'item', label: `Convert to .${extOf(e) === 'md' ? 'txt' : 'md'}`, onSelect: () => store.update(e.id, { data: { ...e.data, extension: extOf(e) === 'md' ? 'txt' : 'md' } }) })
    items.push({ kind: 'sep' }, ...openInItems(e, navigate, undefined, { store, open: openTab }))
    items.push({ kind: 'sep' })
    items.push({ kind: 'item', label: 'Delete', icon: Trash2, danger: true, onSelect: () => setPendingDelete(e.id) })
    return items
  }

  const onMove = (id: EntityId, parentId: EntityId | undefined) => {
    if (!moveDocument(store, id, parentId)) toast("Can't move a folder into itself")
  }

  let body
  if (missing) {
    body = (
      <div className="di__empty">
        <div className="di__empty-inner">
          <h2>Document not found</h2>
          <p className="muted">It may have been deleted, or the link is from another Library.</p>
          <button className="btn" onClick={() => navigate('/documents')}>
            Back to documents
          </button>
        </div>
      </div>
    )
  } else if (!doc || isFolder(doc)) {
    body = <DocumentsIndex folder={doc} docs={docs} onCreate={create} onImport={doImport} contextItems={contextItems} focusTitle={focusTitle} />
  } else {
    body = (
      <Suspense fallback={<div className="dp dp--loading muted">Loading editor…</div>}>
      <DocumentPage
        key={doc.id}
        doc={doc}
        focusTitle={focusTitle}
        onAnnotate={setQuote}
        onMenu={(x, y) => setMenu({ x, y, items: contextItems(doc) })}
        revealAnnotationId={reveal}
        onRevealAnnotation={setReveal}
        onDelete={(id) => setPendingDelete(id)}
      />
      </Suspense>
    )
  }

  return (
    <>
      {body}

      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {quote && doc && (
        <AnnotateDialog
          quote={quote}
          onClose={() => setQuote(null)}
          onSubmit={(comment, tags) => {
            const a = annotateDocument(store, doc, quote, comment, tags)
            setQuote(null)
            toast('Annotation created')
            setReveal(null)
            requestAnimationFrame(() => setReveal(a.id))
          }}
        />
      )}

      {moving && <MoveDialog id={moving} docs={docs} onClose={() => setMoving(null)} onMove={(parent) => (onMove(moving, parent), setMoving(null))} />}

      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete && isFolder(store.get(pendingDelete) ?? ({ data: {} } as AnyEntity)) ? 'Delete this folder and everything in it?' : 'Delete this item?'}
        message={(() => {
          if (!pendingDelete) return ''
          const t = store.get(pendingDelete)
          if (!t) return ''
          const n = isDocument(t) ? descendantsOf(store, t.id).length : 0
          return `“${displayLabel(t)}”${n ? ` and ${n} nested item${n === 1 ? '' : 's'}` : ''} and any relationships attached will be removed. This can't be undone.`
        })()}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}
