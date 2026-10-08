import { Download, ExternalLink, PenLine, Trash2 } from 'lucide-react'
import { useMemo, useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel, parseTags } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { createAnnotation } from '../../core/resources/annotations'
import { Crop } from './ImagePage'
import { ImagePage } from './ImagePage'
import { ImagesIndex } from './ImagesIndex'
import { allImages, annotateImage, downloadImage, IMAGE_ACCEPT, importImageFile, importImageUrl, isImage, type Box, type ImageEntity } from './images'
import '../documents/DocumentsView.css'
import './images.css'
import { openInItems } from '../../app/openIn'
import { useOpenInTab } from '../workstation/paneContext'
import { httpUrl } from '../../core/resources/types'
import { useExternalServices } from '../account/settings'

/** `/images` is the gallery; `/images/:id` opens the annotator. */
export function ImagesView() {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const navigate = useNavigate()
  const openTab = useOpenInTab()
  const toast = useToast()
  const { id } = useParams()

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<EntityId | null>(null)
  const [urlDialog, setUrlDialog] = useState(false)
  const [pendingBox, setPendingBox] = useState<Box | null>(null)
  const [wholeNote, setWholeNote] = useState(false)
  const [selectId, setSelectId] = useState<EntityId | null>(null)
  const [focusTitle, setFocusTitle] = useState(0)

  // `/images/new`: the gallery with the add dialog already open (the URL goes back to the gallery, so a reload is not a second one).
  useEffect(() => {
    if (id !== 'new') return
    navigate('/images', { replace: true })
    setUrlDialog(true)
  }, [id, navigate])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const images = useMemo(() => allImages(store), [store, version])
  const active = id ? store.get(id) : undefined
  const image: ImageEntity | undefined = isImage(active) ? active : undefined
  const missing = !!id && !image

  const addFiles = async (files: File[]) => {
    let last: ImageEntity | undefined
    let failed = 0
    for (const f of files) {
      try {
        last = await importImageFile(store, f)
      } catch (err) {
        failed++
        toast(err instanceof Error ? err.message : String(err))
      }
    }
    if (last) {
      toast(files.length - failed === 1 ? `Added ${displayLabel(last)}` : `Added ${files.length - failed} images`)
      if (files.length - failed === 1) navigate(`/images/${last.id}`)
    }
  }

  const upload = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = IMAGE_ACCEPT
    input.multiple = true
    input.onchange = () => void addFiles([...(input.files ?? [])])
    input.click()
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    const t = store.get(pendingDelete)
    store.remove(pendingDelete)
    toast(`Deleted ${t ? displayLabel(t) : 'item'}`)
    setPendingDelete(null)
    if (image && image.id === pendingDelete) navigate('/images')
  }

  const contextItems = (img: ImageEntity): MenuItem[] => [
    { kind: 'item', label: 'Open', onSelect: () => navigate(`/images/${img.id}`) },
    { kind: 'item', label: 'Rename', icon: PenLine, onSelect: () => (navigate(`/images/${img.id}`), setFocusTitle((n) => n + 1)) },
    ...(httpUrl(img.data.url) ? [{ kind: 'item' as const, label: 'Open original', icon: ExternalLink, onSelect: () => window.open(httpUrl(img.data.url), '_blank', 'noopener') }] : []),
    { kind: 'item', label: 'Download', icon: Download, onSelect: () => downloadImage(img) },
    ...openInItems(img, navigate, undefined, { store, open: openTab }),
    { kind: 'sep' },
    { kind: 'item', label: 'Delete', icon: Trash2, danger: true, onSelect: () => setPendingDelete(img.id) },
  ]

  let body
  if (missing) {
    body = (
      <div className="di__empty">
        <div className="di__empty-inner">
          <h2>Image not found</h2>
          <p className="muted">It may have been deleted, or the link is from another Library.</p>
          <button className="btn" onClick={() => navigate('/images')}>
            Back to images
          </button>
        </div>
      </div>
    )
  } else if (!image) {
    body = <ImagesIndex images={images} onAddUrl={() => setUrlDialog(true)} onUpload={upload} onDropFiles={(f) => void addFiles(f)} contextItems={contextItems} />
  } else {
    body = (
      <ImagePage
        key={image.id}
        image={image}
        focusTitle={focusTitle}
        selectId={selectId}
        pendingBox={pendingBox}
        onDraw={setPendingBox}
        onAnnotateWhole={() => setWholeNote(true)}
        onMenu={(x, y) => setMenu({ x, y, items: contextItems(image) })}
        onDelete={(aid) => setPendingDelete(aid)}
      />
    )
  }

  return (
    <>
      {body}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {urlDialog && (
        <ImageUrlDialog
          onClose={() => setUrlDialog(false)}
          onSubmit={async (url, label) => {
            try {
              const e = await importImageUrl(store, url, label, { approved: true })
              setUrlDialog(false)
              toast(`Added ${displayLabel(e)}`)
              navigate(`/images/${e.id}`)
            } catch {
              toast('Enter a full image URL including https://')
            }
          }}
        />
      )}

      {image && pendingBox && (
        <RegionDialog
          image={image}
          box={pendingBox}
          onClose={() => setPendingBox(null)}
          onSubmit={(comment, tags) => {
            const a = annotateImage(store, image, pendingBox, comment, tags)
            setPendingBox(null)
            setSelectId(a.id)
            toast('Annotation created')
          }}
        />
      )}

      {image && wholeNote && (
        <RegionDialog
          image={image}
          onClose={() => setWholeNote(false)}
          onSubmit={(comment, tags) => {
            createAnnotation(store, image.id, undefined, { comment, tags, annotationType: 'image', data: { imageUrl: image.data.url } })
            setWholeNote(false)
            toast('Annotation created')
          }}
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete && store.get(pendingDelete)?.type === 'image' ? 'Delete this image?' : 'Delete this annotation?'}
        message={pendingDelete ? `“${displayLabel(store.get(pendingDelete) ?? ({ id: pendingDelete } as AnyEntity))}” and any relationships attached will be removed. This can't be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}

export function ImageUrlDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (url: string, label?: string) => void }) {
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const external = useExternalServices()
  const submit = async () => {
    if (!url.trim()) return
    setBusy(true)
    await onSubmit(url, label.trim() || undefined)
    setBusy(false)
  }
  return (
    <Dialog
      open
      title="Image from URL"
      description="The image stays on its host; only the reference is stored. Some hosts block cross-origin loading, in which case the size can't be read."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={busy || !url.trim()}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Image URL</label>
        <input className="input" autoFocus type="url" placeholder="https://…/picture.png" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <div className="field">
        <label>Title (optional)</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      {url.trim() && /^https?:\/\//.test(url.trim()) && (
        <div className="ig__url-preview">
          {/* The address the user is typing: a preview is their own request, but still a third party's. */}
          {external ? <img src={url.trim()} alt="" referrerPolicy="no-referrer" /> : <span className="muted">No preview: Third-party services is off, so the picture is not loaded. Its address is kept, and it shows once the switch is on.</span>}
        </div>
      )}
    </Dialog>
  )
}

export function RegionDialog({ image, box, onClose, onSubmit }: { image: ImageEntity; box?: Box; onClose: () => void; onSubmit: (comment: string, tags: string[]) => void }) {
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState('')
  const submit = () => onSubmit(comment, parseTags(tags))
  return (
    <Dialog
      open
      title={box ? 'Annotate region' : 'Annotate image'}
      description={box ? 'The outlined region stays on the image while you write. Stored as an annotation linked to the image with a region selector in pixel coordinates.' : 'A note about the whole image, linked without a selector.'}
      onClose={onClose}
      wide
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
      {box && (
        <div className="ig__region-preview">
          <Crop image={image} box={box} size={360} />
          <span className="muted">
            {box.width}×{box.height} at {box.x},{box.y}
          </span>
        </div>
      )}
      <div className="field">
        <label>Comment</label>
        <textarea
          className="input"
          autoFocus
          value={comment}
          placeholder={box ? 'What is in this region?' : 'What do you want to say about this image?'}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
        />
      </div>
      <div className="field">
        <label>Tags (comma separated)</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="logo, defect" />
      </div>
    </Dialog>
  )
}
