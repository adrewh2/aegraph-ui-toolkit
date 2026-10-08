import { ChevronDown, ChevronRight, FileText, Folder, FolderPlus, LayoutGrid, List as ListIcon, MoreHorizontal, Plus, Search, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { MarqueeOverlay, SelectionToolbar } from '../../components/ListSelection/ListSelection'
import { useListSelection } from '../../components/ListSelection/useListSelection'
import { TagChip } from '../../components/ui/TagChip'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { formatDate } from '../../lib/format'
import { ancestorsOf, compareDocs, contentOf, deleteDocument, descendantsOf, extOf, FOLDER, isFolder, parentOf, type DocumentEntity } from './documents'

type TypeFilter = 'all' | 'md' | 'txt' | 'pdf' | 'folder'
type Sort = 'updated' | 'created' | 'title'
type Layout = 'grid' | 'list'

const TYPE_LABELS: Record<TypeFilter, string> = { all: 'Type', md: 'Markdown', txt: 'Plain text', pdf: 'PDF', folder: 'Folders' }
const SORT_LABELS: Record<Sort, string> = { updated: 'Last edited', created: 'Created', title: 'Title' }
const LAYOUT_KEY = 'aegraph:documents:layout'

interface Props {
  /** Folder being browsed; undefined for the top level. */
  folder?: DocumentEntity
  docs: DocumentEntity[]
  onCreate: (extension: string, parentId?: string) => void
  onImport: (parentId?: string) => void
  contextItems: (d: DocumentEntity) => MenuItem[]
  /** Bumps when the folder heading should be focused for renaming. */
  focusTitle?: number
}

export function DocumentsIndex({ folder, docs, onCreate, onImport, contextItems, focusTitle = 0 }: Props) {
  const store = useEntityStore()
  useStoreVersion(store)
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [type, setType] = useState<TypeFilter>('all')
  const [tag, setTag] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('updated')
  const [layout, setLayoutState] = useState<Layout>(() => (read(LAYOUT_KEY) === 'list' ? 'list' : 'grid'))
  const [menu, setMenuState] = useState<{ x: number; y: number; items: MenuItem[]; anchor?: Element } | null>(null)
  /** Opening a menu from the button that already owns the open one closes it instead. */
  const setMenu = (next: { x: number; y: number; items: MenuItem[]; anchor?: Element } | null) => setMenuState((cur) => (next && cur && next.anchor && cur.anchor === next.anchor ? null : next))
  const setLayout = (l: Layout) => (setLayoutState(l), write(LAYOUT_KEY, l))

  const parentId = folder?.id
  const q = search.trim().toLowerCase()
  const searching = q.length > 0

  const items = useMemo(() => {
    // Searching looks through every document; browsing shows one folder's children.
    let list = searching ? docs : docs.filter((d) => parentOf(d) === parentId)
    if (searching) list = list.filter((d) => displayLabel(d).toLowerCase().includes(q) || d.tags.some((t) => t.toLowerCase().includes(q)) || contentOf(d).toLowerCase().includes(q))
    if (type !== 'all') list = list.filter((d) => (type === 'folder' ? isFolder(d) : extOf(d) === type))
    if (tag) list = list.filter((d) => d.tags.includes(tag))
    const byTime = (k: 'updatedAt' | 'createdAt') => (a: DocumentEntity, b: DocumentEntity) => b.meta[k].localeCompare(a.meta[k])
    const cmp = sort === 'title' ? compareDocs : sort === 'created' ? byTime('createdAt') : byTime('updatedAt')
    // Folders first unless sorting by time while searching.
    return [...list].sort((a, b) => (isFolder(a) === isFolder(b) ? cmp(a, b) : isFolder(a) ? -1 : 1))
  }, [docs, parentId, searching, q, type, tag, sort])

  const tags = useMemo(() => [...new Set(docs.flatMap((d) => d.tags))].sort(), [docs])
  const [bulkDelete, setBulkDelete] = useState<EntityId[] | null>(null)
  const ids = useMemo(() => items.map((d) => d.id), [items])
  const { rootRef, sel } = useListSelection(ids, setBulkDelete)
  const crumbs = folder ? ancestorsOf(store, folder.id).reverse() : []

  const chip = (label: string, active: boolean, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, onClear?: () => void) => (
    <button className={`di__chip ${active ? 'is-active' : ''}`} onClick={onClick}>
      {label}
      {active && onClear ? (
        <span
          className="di__chip-x"
          role="button"
          aria-label="Clear"
          onClick={(e) => {
            e.stopPropagation()
            onClear()
          }}
        >
          <X size={11} />
        </span>
      ) : (
        <ChevronDown size={12} className="faint" />
      )}
    </button>
  )
  const at = (e: React.MouseEvent<HTMLButtonElement>) => ({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget as Element })

  const newItems: MenuItem[] = [
    { kind: 'item', label: 'Markdown document', icon: FileText, onSelect: () => onCreate('md', parentId) },
    { kind: 'item', label: 'Plain text', icon: FileText, onSelect: () => onCreate('txt', parentId) },
    { kind: 'item', label: 'PDF (by URL or upload)', icon: FileText, onSelect: () => onCreate('pdf', parentId) },
    { kind: 'sep' },
    { kind: 'item', label: 'Import .md / .txt / .pdf…', icon: Upload, onSelect: () => onImport(parentId) },
  ]

  return (
    <div ref={rootRef} data-sel-root="" onMouseDown={sel.onMouseDown} className="di">
      <header className="di__head">
        <div className="di__head-left">
          {folder ? <FolderTitle folder={folder} focus={focusTitle} /> : <h1 className="page-title">Documents</h1>}
          <nav className="di__crumbs">
            <button className="di__crumb" onClick={() => navigate('/documents')}>
              Documents
            </button>
            {crumbs.map((id) => {
              const f = store.get(id)
              return f ? (
                <span key={id} className="di__crumb-wrap">
                  <ChevronRight size={12} className="faint" />
                  <button className="di__crumb" onClick={() => navigate(`/documents/${id}`)}>
                    {displayLabel(f)}
                  </button>
                </span>
              ) : null
            })}
            {folder && (
              <span className="di__crumb-wrap">
                <ChevronRight size={12} className="faint" />
                <span className="di__crumb di__crumb--current">{displayLabel(folder)}</span>
              </span>
            )}
          </nav>
        </div>
        <div className="di__head-actions">
          <button className="btn" onClick={() => onCreate(FOLDER, parentId)}>
            <FolderPlus size={14} /> New folder
          </button>
          <span className="di__split">
            <button className="btn btn--primary" onClick={() => onCreate('md', parentId)}>
              <Plus size={14} /> New document
            </button>
            <button className="btn btn--primary btn--icon" aria-label="More document types" onClick={(e) => setMenu({ ...at(e), items: newItems })}>
              <ChevronDown size={14} />
            </button>
          </span>
        </div>
      </header>

      <div className="di__filters">
        {chip(TYPE_LABELS[type], type !== 'all', (e) => setMenu({ ...at(e), items: (Object.keys(TYPE_LABELS) as TypeFilter[]).map((t) => ({ kind: 'item', label: t === 'all' ? 'All types' : TYPE_LABELS[t], onSelect: () => setType(t) })) }), () => setType('all'))}
        {chip(tag ?? 'Tag', !!tag, (e) => setMenu({ ...at(e), items: tags.length ? tags.map((t) => ({ kind: 'item', label: t, onSelect: () => setTag(t) })) : [{ kind: 'label', label: 'No tags yet' }] }), () => setTag(null))}
        {chip(`Sort: ${SORT_LABELS[sort]}`, false, (e) => setMenu({ ...at(e), items: (Object.keys(SORT_LABELS) as Sort[]).map((s) => ({ kind: 'item', label: SORT_LABELS[s], onSelect: () => setSort(s) })) }))}
        <span className="spacer" />
        <div className="di__layout" role="radiogroup" aria-label="Layout">
          <button className={`di__layout-btn ${layout === 'grid' ? 'is-active' : ''}`} onClick={() => setLayout('grid')} title="Grid">
            <LayoutGrid size={14} />
          </button>
          <button className={`di__layout-btn ${layout === 'list' ? 'is-active' : ''}`} onClick={() => setLayout('list')} title="List">
            <ListIcon size={14} />
          </button>
        </div>
        <label className="di__search">
          <Search size={14} className="faint" />
          <input placeholder="Search documents" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <button className="btn btn--sm btn--icon btn--ghost" onClick={() => setSearch('')} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </label>
      </div>

      {items.length === 0 ? (
        <div className="di__empty">
          <div className="di__empty-inner">
            <h2>{searching || type !== 'all' || tag ? 'Nothing matches' : folder ? 'This folder is empty' : 'No documents yet'}</h2>
            <p className="muted">{searching || type !== 'all' || tag ? 'Try a different search or clear the filters.' : 'Write in Markdown or plain text, or bring in a PDF.'}</p>
            {!searching && type === 'all' && !tag && (
              <div className="di__empty-actions">
                <button className="btn btn--primary" onClick={() => onCreate('md', parentId)}>
                  <Plus size={14} /> New document
                </button>
                <button className="btn" onClick={() => onImport(parentId)}>
                  <Upload size={14} /> Import
                </button>
              </div>
            )}
          </div>
        </div>
      ) : layout === 'grid' ? (
        <div className="di__grid">
          {items.map((d, i) => (
            <Card key={d.id} doc={d} selected={sel.isSelected(d.id)} showPath={searching} onOpen={(e) => (e && sel.click(e, d.id, i)) || navigate(`/documents/${d.id}`)} onMenu={(x, y) => setMenu({ x, y, items: contextItems(d) })} />
          ))}
        </div>
      ) : (
        <div className="di__list">
          <div className="di__row di__row--head muted">
            <span>Name</span>
            <span>Tags</span>
            <span>Edited</span>
            <span />
          </div>
          {items.map((d, i) => (
            <Row key={d.id} doc={d} selected={sel.isSelected(d.id)} showPath={searching} onOpen={(e) => (e && sel.click(e, d.id, i)) || navigate(`/documents/${d.id}`)} onMenu={(x, y) => setMenu({ x, y, items: contextItems(d) })} />
          ))}
        </div>
      )}

      <MarqueeOverlay sel={sel} />
      <SelectionToolbar
        sel={sel}
        noun="document"
        deleteMany={(ids) => store.transaction(() => ids.forEach((id) => store.has(id) && deleteDocument(store, id)))}
        confirmDeleteIds={bulkDelete}
        onConfirmHandled={() => setBulkDelete(null)}
      />
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** The folder's name, editable in place. */
function FolderTitle({ folder, focus }: { folder: DocumentEntity; focus: number }) {
  const store = useEntityStore()
  const [title, setTitle] = useState(folder.label ?? '')
  const [seen, setSeen] = useState(folder.label)
  if (folder.label !== seen) {
    setSeen(folder.label)
    setTitle(folder.label ?? '')
  }
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focus) {
      ref.current?.focus()
      ref.current?.select()
    }
  }, [focus, folder.id])
  const commit = () => {
    const next = title.trim()
    if (next && next !== folder.label) store.update(folder.id, { label: next })
    else setTitle(folder.label ?? '')
  }
  return (
    <input
      ref={ref}
      className="page-title di__folder-title"
      value={title}
      placeholder="Untitled folder"
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setTitle(folder.label ?? '')
          e.currentTarget.blur()
        }
      }}
      title="Rename folder"
    />
  )
}

/** First few lines of a document, with the Markdown syntax knocked off. */
function snippet(d: DocumentEntity): string[] {
  if (isFolder(d)) return []
  if (extOf(d) === 'pdf') return [typeof d.data.sourceUrl === 'string' ? d.data.sourceUrl : d.data.dataUrl ? 'Uploaded PDF' : 'No file attached yet']
  return contentOf(d)
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ x]\]\s+)?/, '').replace(/[*_`~]/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').trim())
    .filter(Boolean)
    .slice(0, 4)
}

function PathHint({ doc }: { doc: DocumentEntity }) {
  const store = useEntityStore()
  const path = ancestorsOf(store, doc.id)
    .reverse()
    .map((a) => displayLabel(store.get(a) ?? ({ id: a } as DocumentEntity)))
  if (!path.length) return null
  return <span className="di__path muted">{path.join(' / ')}</span>
}

function Card({ doc, selected, showPath, onOpen, onMenu }: { doc: DocumentEntity; selected: boolean; showPath: boolean; onOpen: (e?: React.MouseEvent) => void; onMenu: (x: number, y: number) => void }) {
  const store = useEntityStore()
  const folder = isFolder(doc)
  const lines = snippet(doc)
  const count = folder ? descendantsOf(store, doc.id).length : 0
  return (
    <div
      className={`di__card ${folder ? 'di__card--folder' : ''} ${selected ? 'is-selected' : ''}`}
      data-id={doc.id}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <div className="di__preview">
        {folder ? (
          <div className="di__preview-folder">
            <Folder size={28} strokeWidth={1.5} />
            <span className="muted">
              {count} item{count === 1 ? '' : 's'}
            </span>
          </div>
        ) : (
          <>
            <div className="di__preview-title">{displayLabel(doc)}</div>
            {lines.map((l, i) => (
              <div key={i} className="di__preview-line">
                {l}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="di__card-foot">
        <div className="di__card-name">
          {folder ? <Folder size={15} className="di__ico-folder" /> : <FileText size={15} className="di__ico-doc" />}
          <span className="di__card-title">{displayLabel(doc)}</span>
          <button
            className="btn btn--sm btn--icon btn--ghost di__card-more"
            aria-label="More"
            onClick={(e) => {
              e.stopPropagation()
              onMenu(e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 4)
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
        <div className="di__card-meta">
          {!folder && <span className="badge">.{extOf(doc)}</span>}
          <span className="muted" title={new Date(doc.meta.updatedAt).toLocaleString()}>
            {formatDate(doc.meta.updatedAt)}
          </span>
          {doc.tags.slice(0, 2).map((t) => (
            <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
          ))}
          {doc.tags.length > 2 && <span className="badge">+{doc.tags.length - 2}</span>}
          {showPath && <PathHint doc={doc} />}
        </div>
      </div>
    </div>
  )
}

function Row({ doc, selected, showPath, onOpen, onMenu }: { doc: DocumentEntity; selected: boolean; showPath: boolean; onOpen: (e?: React.MouseEvent) => void; onMenu: (x: number, y: number) => void }) {
  const store = useEntityStore()
  const folder = isFolder(doc)
  return (
    <div
      className={`di__row ${selected ? 'is-selected' : ''}`}
      data-id={doc.id}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <span className="di__row-name">
        {folder ? <Folder size={15} className="di__ico-folder" /> : <FileText size={15} className="di__ico-doc" />}
        <span className="di__card-title">{displayLabel(doc)}</span>
        {!folder && <span className="badge">.{extOf(doc)}</span>}
        {showPath && <PathHint doc={doc} />}
      </span>
      <span className="di__row-tags">
        {doc.tags.slice(0, 3).map((t) => (
          <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
        ))}
      </span>
      <span className="muted">{formatDate(doc.meta.updatedAt)}</span>
      <button
        className="btn btn--sm btn--icon btn--ghost"
        aria-label="More"
        onClick={(e) => {
          e.stopPropagation()
          onMenu(e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 4)
        }}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
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
