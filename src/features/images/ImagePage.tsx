import { ChevronRight, Highlighter, Info, Maximize2, Minus, MousePointer2, MoreHorizontal, Plus, Sparkles, SquareDashed, Trash2, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Popover } from '../../components/ui/Menu'
import { TagChip } from '../../components/ui/TagChip'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { updateAnnotationSelector } from '../../core/resources/annotations'
import { formatDate, formatNumber } from '../../lib/format'
import { Inspector } from '../resources/Inspector'
import { TagEditor } from '../resources/TagEditor'
import { Crop } from './Crop'
export { Crop } from './Crop'
import { ImageAnnotator, type Tool } from './ImageAnnotator'
import { otherAnnotationsOf, regionAnnotationsOf, type Box, type ImageAnnotation, type ImageEntity } from './images'

type Panel = 'annotations' | 'info' | null
const PANEL_KEY = 'aegraph:images:panel'
const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]

interface Props {
  image: ImageEntity
  onDraw: (box: Box) => void
  onAnnotateWhole: () => void
  onMenu: (x: number, y: number) => void
  onDelete: (id: EntityId) => void
  focusTitle: number
  /** Select this annotation's box (set after one is created). */
  selectId: EntityId | null
  /** Box drawn and awaiting its annotation; stays outlined meanwhile. */
  pendingBox?: Box | null
}

export function ImagePage({ image, onDraw, onAnnotateWhole, onMenu, onDelete, focusTitle, selectId, pendingBox }: Props) {
  const store = useEntityStore()
  useStoreVersion(store)
  const navigate = useNavigate()
  const [tool, setTool] = useState<Tool>('draw')
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [scale, setScale] = useState(1)
  const [panel, setPanelState] = useState<Panel>(() => {
    const v = read(PANEL_KEY)
    return v === 'info' ? 'info' : v === 'none' ? null : 'annotations'
  })
  const [selected, setSelected] = useState<EntityId | null>(null)
  const [inspectId, setInspectId] = useState<EntityId | null>(null)
  const setPanel = (p: Panel) => (setPanelState(p), write(PANEL_KEY, p ?? 'none'))

  // A newly created annotation becomes the selection (derived during render, no effect needed).
  const [seenSelectId, setSeenSelectId] = useState(selectId)
  if (selectId !== seenSelectId) {
    setSeenSelectId(selectId)
    if (selectId) setSelected(selectId)
  }

  const regions = regionAnnotationsOf(store, image.id)
  const others = otherAnnotationsOf(store, image.id)
  const inspected = inspectId ? store.get(inspectId) : image
  const colorOf = useCallback((a: ImageAnnotation) => a.annotation.tags.map((t) => store.getTagInfo(t).color).find(Boolean), [store])

  const zoomTo = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > scale + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < scale - 0.001)
    if (next) setZoom(next)
  }

  const dims = image.data.width && image.data.height ? `${formatNumber(image.data.width)}×${formatNumber(image.data.height)}` : ''

  return (
    <div className="dp ip">
      <header className="dp__top">
        <nav className="dp__crumbs" aria-label="Breadcrumb">
          <button className="dp__crumb" onClick={() => navigate('/images')}>
            Images
          </button>
          <span className="dp__crumb-wrap">
            <ChevronRight size={13} className="faint" />
            <TitleInput image={image} focus={focusTitle} />
          </span>
          <button className="btn btn--sm btn--icon btn--ghost" title="More" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect().left, e.currentTarget.getBoundingClientRect().bottom + 4)}>
            <MoreHorizontal size={14} />
          </button>
        </nav>
        <div className="dp__top-right">
          <Tags image={image} />
          <button className={`btn btn--sm ${panel === 'annotations' ? 'is-on' : ''}`} title="Annotations" onClick={() => setPanel(panel === 'annotations' ? null : 'annotations')}>
            <Highlighter size={14} />
            {regions.length + others.length > 0 && <span className="count">{regions.length + others.length}</span>}
          </button>
          <button className={`btn btn--sm btn--icon ${panel === 'info' ? 'is-on' : ''}`} title="Entity details" onClick={() => setPanel(panel === 'info' ? null : 'info')}>
            <Info size={14} />
          </button>
          <button className="btn btn--sm" title="Open the assistant (⌘J)" onClick={() => window.dispatchEvent(new CustomEvent('aegraph:assistant', { detail: { open: true } }))}>
            <Sparkles size={14} /> Assistant
          </button>
        </div>
      </header>

      <div className="dp__toolbar">
        <div className="tb" role="toolbar" aria-label="Tools">
          <button className={`tb__btn ip__tool ${tool === 'select' ? 'is-active' : ''}`} title="Select and move boxes (V)" onClick={() => setTool('select')}>
            <MousePointer2 size={15} /> Select
          </button>
          <button className={`tb__btn ip__tool ${tool === 'draw' ? 'is-active' : ''}`} title="Draw a box to annotate (B)" onClick={() => setTool('draw')}>
            <SquareDashed size={15} /> Draw box
          </button>
          <span className="tb__sep" />
          <button className="tb__btn" title="Zoom out" onClick={() => zoomTo(-1)}>
            <Minus size={15} />
          </button>
          <button className="tb__btn ip__zoom" title="Reset to 100%" onClick={() => setZoom(1)}>
            {Math.round(scale * 100)}%
          </button>
          <button className="tb__btn" title="Zoom in" onClick={() => zoomTo(1)}>
            <Plus size={15} />
          </button>
          <button className={`tb__btn ${zoom === 'fit' ? 'is-active' : ''}`} title="Fit to view" onClick={() => setZoom('fit')}>
            <Maximize2 size={14} />
          </button>
        </div>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {dims}
          {image.data.mimeType ? ` · ${image.data.mimeType.replace('image/', '')}` : ''}
          {tool === 'draw' ? ' · drag on the image to add a box' : ' · drag boxes to move, corners to resize'}
        </span>
        <span className="dp__edited muted" title={new Date(image.meta.updatedAt).toLocaleString()}>
          Edited {formatDate(image.meta.updatedAt)}
        </span>
      </div>

      <div className="dp__body">
        <main className="dp__main ip__main">
          <ImageAnnotator
            image={image}
            annotations={regions}
            tool={tool}
            zoom={zoom}
            selectedId={selected}
            onSelect={setSelected}
            onDraw={onDraw}
            onChange={(id, box) => {
              const a = regions.find((r) => r.annotation.id === id)
              if (a) updateAnnotationSelector(store, a.relationshipId, { kind: 'region', ...box })
            }}
            onDelete={onDelete}
            onScale={setScale}
            onLoaded={(size) => {
              if (image.data.width !== size.width || image.data.height !== size.height) store.update(image.id, { data: { ...image.data, ...size } })
            }}
            colorOf={colorOf}
            pending={pendingBox}
            onZoom={setZoom}
          />
        </main>

        {panel && (
          <aside className="dp__panel">
            {panel === 'info' && inspected ? (
              <Inspector
                entityId={inspected.id}
                onClose={() => (inspectId ? setInspectId(null) : setPanel(null))}
                onOpen={(id) => {
                  const t = store.get(id)
                  if (t?.type === 'image') navigate(`/images/${id}`)
                  else if (t) setInspectId(id)
                }}
                onDelete={(ids) => onDelete(ids[0])}
              />
            ) : (
              <RegionPanel
                image={image}
                regions={regions}
                others={others}
                selected={selected}
                onSelect={(id) => {
                  setSelected(id)
                  setTool('select')
                }}
                onInspect={(id) => (setInspectId(id), setPanel('info'))}
                onDelete={onDelete}
                onAnnotateWhole={onAnnotateWhole}
                onClose={() => setPanel(null)}
                colorOf={colorOf}
              />
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

function RegionPanel({
  image,
  regions,
  others,
  selected,
  onSelect,
  onInspect,
  onDelete,
  onAnnotateWhole,
  onClose,
  colorOf,
}: {
  image: ImageEntity
  regions: ImageAnnotation[]
  others: ReturnType<typeof otherAnnotationsOf>
  selected: EntityId | null
  onSelect: (id: EntityId) => void
  onInspect: (id: EntityId) => void
  onDelete: (id: EntityId) => void
  onAnnotateWhole: () => void
  onClose: () => void
  colorOf: (a: ImageAnnotation) => string | undefined
}) {
  const store = useEntityStore()
  return (
    <div className="anns">
      <div className="anns__head">
        <Highlighter size={15} />
        <h3>Annotations</h3>
        <span className="count">{regions.length + others.length}</span>
        <span className="spacer" />
        <button className="btn btn--sm btn--ghost" onClick={onAnnotateWhole} title="Annotate the whole image">
          <Plus size={13} /> Note
        </button>
        <button className="btn btn--sm btn--icon btn--ghost" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>
      <div className="anns__body">
        {regions.length === 0 && others.length === 0 && (
          <div className="anns__empty muted">
            Choose <strong>Draw box</strong> and drag over part of the image to annotate it. Each box is an annotation entity linked to the image with a <code>region</code> selector in pixel coordinates.
          </div>
        )}
        {regions.map((a, i) => {
          const color = colorOf(a) ?? '#f59e0b'
          const isSel = selected === a.annotation.id
          return (
            <div key={a.annotation.id} className={`ann ip__ann ${isSel ? 'is-selected' : ''}`} style={{ borderLeftColor: color }} onClick={() => onSelect(a.annotation.id)}>
              <div className="ip__ann-row">
                <span className="ip__ann-num" style={{ background: color }}>
                  {i + 1}
                </span>
                <Crop image={image} box={a.region} />
                <div className="ip__ann-text">
                  {a.annotation.data.comment ? <div className="ann__comment">{String(a.annotation.data.comment)}</div> : <div className="faint">No comment</div>}
                  <div className="muted ip__ann-geom">
                    {a.region.width}×{a.region.height} at {a.region.x},{a.region.y}
                  </div>
                </div>
              </div>
              <div className="ann__meta">
                {a.annotation.tags.map((t) => (
                  <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
                ))}
                <span className="muted" title={new Date(a.annotation.meta.createdAt).toLocaleString()}>
                  {formatDate(a.annotation.meta.createdAt)}
                </span>
                <span className="spacer" />
                <button className="btn btn--sm btn--ghost" onClick={(e) => (e.stopPropagation(), onInspect(a.annotation.id))}>
                  Details
                </button>
                <button className="btn btn--sm btn--icon btn--ghost btn--danger" onClick={(e) => (e.stopPropagation(), onDelete(a.annotation.id))} title="Delete annotation">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          )
        })}
        {others.length > 0 && <div className="ip__ann-section muted">Whole image</div>}
        {others.map((a) => (
          <div key={a.annotation.id} className="ann" style={{ borderLeftColor: a.annotation.tags.map((t) => store.getTagInfo(t).color).find(Boolean) }}>
            {a.annotation.data.comment && <div className="ann__comment">{String(a.annotation.data.comment)}</div>}
            <div className="ann__meta">
              {a.annotation.tags.map((t) => (
                <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
              ))}
              <span className="muted">{formatDate(a.annotation.meta.createdAt)}</span>
              <span className="spacer" />
              <button className="btn btn--sm btn--ghost" onClick={() => onInspect(a.annotation.id)}>
                Details
              </button>
              <button className="btn btn--sm btn--icon btn--ghost btn--danger" onClick={() => onDelete(a.annotation.id)} title="Delete annotation">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The image's name, editable in place; saved on blur or Enter. */
function TitleInput({ image, focus }: { image: ImageEntity; focus: number }) {
  const store = useEntityStore()
  const [title, setTitle] = useState(image.label ?? '')
  const [seen, setSeen] = useState(image.label)
  if (image.label !== seen) {
    setSeen(image.label)
    setTitle(image.label ?? '')
  }
  const commit = () => {
    const next = title.trim()
    if (next && next !== image.label) store.update(image.id, { label: next })
    else setTitle(image.label ?? '')
  }
  return (
    <input
      className="ip__title"
      value={title}
      placeholder="Untitled image"
      size={Math.max(8, Math.min(60, title.length + 2))}
      autoFocus={focus > 0}
      onFocus={(e) => focus > 0 && e.currentTarget.select()}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setTitle(image.label ?? '')
          e.currentTarget.blur()
        }
      }}
      title="Rename"
    />
  )
}

function Tags({ image }: { image: ImageEntity }) {
  const store = useEntityStore()
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  return (
    <>
      <button className="dp__tags" onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} title="Edit tags">
        {image.tags.length === 0 && <span className="faint">Add tags</span>}
        {image.tags.slice(0, 4).map((t) => (
          <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
        ))}
        {image.tags.length > 4 && <span className="badge">+{image.tags.length - 4}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={300}>
          <TagEditor value={image.tags} onChange={(tags) => store.update(image.id, { tags })} onDone={() => setAnchor(null)} />
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

