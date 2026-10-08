import { Camera, ExternalLink, MousePointer2, Square, StickyNote } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { DataImage } from '../../components/RemoteImage'
import { Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { parseTags } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { Entity } from '../../core/entity/types'
import { annotationsOf, createAnnotation } from '../../core/resources/annotations'
import { httpUrl, type WebpageData } from '../../core/resources/types'
import { attachStill, captureSupported, FrameCapturer, type Still } from '../videos/capture'
import { setWebpageHandle } from './webpageHandle'
import './WebpageEmbed.css'
import { useExternalServices } from '../account/settings'

type Box = { x: number; y: number; width: number; height: number }
type Pending = { still?: Still; region?: Box; kind: 'region' | 'note' | 'still'; /** The box as drawn, in frame pixels, to keep outlined while the dialog is open. */ box?: Box }

/**
 * A saved page in a frame, annotatable the way videos are: the frame is
 * cross-origin, so a region is recorded by capturing the tab (one share
 * prompt per session) and storing the still with the annotation, with the
 * region in still pixels.
 */
export default function WebpageEmbed({ page }: { page: Entity<WebpageData> }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const toast = useToast()
  const url = page.data.url
  /**
   * The frame keeps its own origin (`allow-same-origin`), which a real site needs for its own storage — so the URL
   * must be someone else's site. A page on this origin would share ours: the localStorage with the API key in it,
   * the Spotify session, the workspace. A URL is data (it arrives in a bundle, an import, from the model), so it is
   * checked here rather than trusted, and anything but http(s) elsewhere is shown as a link instead of framed.
   */
  const framable = (() => {
    if (!url) return false
    try {
      const u = new URL(url, location.href)
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== location.origin
    } catch {
      return false
    }
  })()
  const frame = useRef<HTMLDivElement>(null)
  const capturer = useRef<FrameCapturer | null>(null)
  const external = useExternalServices()
  const [tool, setTool] = useState<'browse' | 'draw'>('browse')
  const [draft, setDraft] = useState<{ start: { x: number; y: number }; box: Box } | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const count = annotationsOf(store, page.id).length
  // The tab capture outlives a capture call on purpose (one share prompt per session), not the page: stop it with the view.
  useEffect(() => () => capturer.current?.stop(), [])

  const capture = async (): Promise<Still | undefined> => {
    if (!frame.current) return undefined
    setCapturing(true)
    try {
      capturer.current ??= new FrameCapturer()
      return await capturer.current.capture(frame.current)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
      return undefined
    } finally {
      setCapturing(false)
    }
  }

  const local = (e: { clientX: number; clientY: number }) => {
    const r = frame.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)) }
  }
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = local(e)
    setDraft({ start: p, box: { x: p.x, y: p.y, width: 0, height: 0 } })
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draft) return
    const p = local(e)
    setDraft({ ...draft, box: { x: Math.min(p.x, draft.start.x), y: Math.min(p.y, draft.start.y), width: Math.abs(p.x - draft.start.x), height: Math.abs(p.y - draft.start.y) } })
  }
  const onUp = async () => {
    if (!draft) return
    const box = draft.box
    setDraft(null)
    if (box.width < 6 || box.height < 6) return
    const still = await capture()
    if (!still) return
    // Region in still pixels — the still is a capture of exactly the frame's box.
    const r = frame.current!.getBoundingClientRect()
    const kx = still.width / r.width
    const ky = still.height / r.height
    setPending({ kind: 'region', still, box, region: { x: Math.round(box.x * kx), y: Math.round(box.y * ky), width: Math.round(box.width * kx), height: Math.round(box.height * ky) } })
  }

  // Let tools (assistant, MCP) capture this page too.
  useEffect(() => {
    setWebpageHandle({ pageId: page.id, capture })
    return () => setWebpageHandle(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id])

  const snap = async () => {
    const still = await capture()
    if (!still) return
    setPending({ kind: 'still', still })
  }

  const commit = (comment: string, tags: string[]) => {
    if (!pending) return
    const selector = pending.region ? ({ kind: 'region', ...pending.region } as const) : undefined
    const a = createAnnotation(store, page.id, selector, { comment, tags: pending.kind === 'still' && !tags.includes('still') ? [...tags, 'still'] : tags, annotationType: pending.still ? 'image' : 'note', data: { pageUrl: url } })
    if (pending.still) attachStill(store, a.id, pending.still)
    setPending(null)
    setTool('browse')
    toast(pending.kind === 'still' ? 'Saved a capture of the page' : 'Annotation created')
  }

  // Draft/pending outline shown over the frame, in frame pixels.
  const outline = draft?.box ?? pending?.box ?? null

  return (
    <div className="we">
      <div className="we__bar">
        <span className="mono muted we__url" title={url}>
          {url}
        </span>
        <a className="btn btn--sm btn--icon" href={httpUrl(url)} target="_blank" rel="noreferrer noopener" title="Open in a new tab">
          <ExternalLink size={13} />
        </a>
      </div>
      <div className="we__tools">
        <button className={`btn btn--sm btn--icon ${tool === 'browse' ? 'is-on' : ''}`} title="Browse the page" onClick={() => setTool('browse')}>
          <MousePointer2 size={13} />
        </button>
        <button className={`btn btn--sm ${tool === 'draw' ? 'is-on' : ''}`} title="Draw a box on the page to annotate it (captures this tab; asks to share it the first time)" disabled={!captureSupported()} onClick={() => setTool(tool === 'draw' ? 'browse' : 'draw')}>
          <Square size={13} /> Draw box
        </button>
        <button className="btn btn--sm" title="A note about the whole page" onClick={() => setPending({ kind: 'note' })}>
          <StickyNote size={13} /> Note
        </button>
        <button className="btn btn--sm" title="Save a capture of what's on screen" disabled={!captureSupported() || capturing} onClick={snap}>
          <Camera size={13} /> {capturing ? 'Capturing…' : 'Capture'}
        </button>
        <span className="spacer" />
        <span className="muted">{count ? `${count} annotation${count === 1 ? '' : 's'}` : captureSupported() ? 'Draw a box to annotate part of the page' : 'Screen capture is not available in this browser'}</span>
      </div>
      <div ref={frame} className={`we__frame ${tool === 'draw' ? 'is-drawing' : ''} ${capturing ? 'is-capturing' : ''}`}>
        {page.data.screenshotUrl && !url ? (
          <DataImage src={page.data.screenshotUrl} providers alt="" />
        ) : !framable ? (
          // Not another site's page over http(s): never framed, because a frame on this origin would be inside the app.
          <p className="we__offline muted">
            This is not a page that can be shown here: an embedded page is another site's, over http or https. Its address is <span className="we__url">{url || '(none)'}</span>, and your annotations are still here.
          </p>
        ) : external ? (
          <iframe className="we__iframe" src={url} title={url} sandbox="allow-scripts allow-same-origin allow-popups allow-forms" referrerPolicy="no-referrer" />
        ) : (
          // Offline mode: the page is someone else's site, so it is not loaded — the address and the annotations are still here.
          <p className="we__offline muted">
            This page is not loaded: <strong>Third-party services</strong> is off in your account settings. Its address and your annotations are still here — <a href={httpUrl(url)} target="_blank" rel="noreferrer noopener">open it in a tab</a> to read it.
          </p>
        )}
        {tool === 'draw' && <div className="we__overlay" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDraft(null)} />}
        {outline && <div className={`we__box ${draft ? 'is-draft' : 'is-pending'}`} style={{ left: outline.x, top: outline.y, width: outline.width, height: outline.height }} />}
      </div>

      {pending && (
        <AnnotateDialog
          pending={pending}
          onClose={() => setPending(null)}
          onSubmit={commit}
        />
      )}
    </div>
  )
}


function AnnotateDialog({ pending, onClose, onSubmit }: { pending: Pending; onClose: () => void; onSubmit: (comment: string, tags: string[]) => void }) {
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState('')
  const submit = () => onSubmit(comment, parseTags(tags))
  const { still, region } = pending
  const title = pending.kind === 'region' ? 'Annotate region of page' : pending.kind === 'still' ? 'Save capture' : 'Annotate page'
  return (
    <Dialog
      open
      wide
      title={title}
      description={pending.kind === 'region' ? 'The outlined region stays on the page while you write. Stored with a capture of the page and the region in capture pixels.' : pending.kind === 'still' ? 'A capture of the page as it is on screen now, saved as an annotation.' : 'A note about the whole page, linked without a selector.'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit}>
            {pending.kind === 'still' ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      {still && (
        <div className="we__preview">
          <span className="we__preview-img">
            <img src={still.dataUrl} alt="" />
            {region && <span className="we__preview-frame" style={{ left: `${(region.x / still.width) * 100}%`, top: `${(region.y / still.height) * 100}%`, width: `${(region.width / still.width) * 100}%`, height: `${(region.height / still.height) * 100}%` }} />}
          </span>
          <span className="muted">
            {region ? `${region.width}×${region.height} at ${region.x},${region.y} · ` : ''}capture {still.width}×{still.height}
          </span>
        </div>
      )}
      <div className="field">
        <label>Comment</label>
        <textarea
          className="input"
          autoFocus
          value={comment}
          placeholder={pending.kind === 'region' ? 'What is in this part of the page?' : 'What do you want to say about this page?'}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
        />
      </div>
      <div className="field">
        <label>Tags (comma separated)</label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="reference, quote" />
      </div>
    </Dialog>
  )
}
