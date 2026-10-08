import { Download, ExternalLink, FileUp, Link as LinkIcon, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useToast } from '../../components/ui/useToast'
import { useEntityStore } from '../../core/entity/hooks'
import { pickFile } from '../../lib/download'
import { formatNumber, hostOf } from '../../lib/format'
import { httpUrl } from '../../core/resources/types'
import { useExternalServices } from '../account/settings'
import { downloadDocument, MAX_INLINE_PDF_BYTES, pdfFramesAtOnce, pdfUrl, type DocumentEntity } from './documents'

/**
 * PDF documents are rendered by the browser's built-in viewer in an iframe.
 * Bytes come from `data.dataUrl` (uploaded, inline) or `data.sourceUrl`
 * (remote). The viewer refuses a sandboxed frame, so the frame is held by
 * what it loads instead: a PDF inline, a blob or a file on this origin is
 * framed at once; one on another host is named and waits for a click (and
 * for Third-party services), because the address is data — a bundle or a
 * tool call wrote it — and loading it tells that host, with whatever the URL
 * carries. Remote hosts that forbid framing fall back to an "open in new
 * tab" prompt.
 */
export function PdfViewer({ doc }: { doc: DocumentEntity }) {
  const store = useEntityStore()
  const toast = useToast()
  const url = pdfUrl(doc)
  const inline = typeof doc.data.dataUrl === 'string' && doc.data.dataUrl.length > 0
  const external = useExternalServices()
  // The remote address the reader chose to load here; a new address asks again.
  const [allowed, setAllowed] = useState<string | null>(null)
  const waits = !!url && !pdfFramesAtOnce(url) && allowed !== url
  const [nonce, setNonce] = useState(0)
  const [urlDraft, setUrlDraft] = useState(typeof doc.data.sourceUrl === 'string' ? doc.data.sourceUrl : '')
  // Keyed by the url below, so a new source starts unloaded again.
  const [loaded, setLoaded] = useState<string | null>(null)
  const frameKey = `${url ?? ''}:${nonce}`

  const setSourceUrl = () => {
    let parsed: URL
    try {
      parsed = new URL(urlDraft.trim())
    } catch {
      toast('Enter a full URL including https://')
      return
    }
    const data = { ...doc.data, sourceUrl: parsed.toString() }
    delete data.dataUrl
    store.update(doc.id, { data })
  }

  const upload = async () => {
    const file = await pickFile('.pdf,application/pdf')
    if (!file) return
    if (file.size > MAX_INLINE_PDF_BYTES) {
      toast(`That PDF is ${(file.size / 1024 / 1024).toFixed(1)} MB; inline PDFs are capped at ${MAX_INLINE_PDF_BYTES / 1024 / 1024} MB`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const data = { ...doc.data, dataUrl: String(reader.result) }
      delete data.sourceUrl
      store.update(doc.id, { data })
      toast('PDF stored with the document')
    }
    reader.readAsDataURL(file)
  }

  const approxBytes = inline ? Math.round(((doc.data.dataUrl as string).length * 3) / 4) : undefined

  return (
    <div className="pdf">
      <div className="pdf__bar">
        {url ? (
          <>
            <span className="muted pdf__src" title={inline ? 'Stored inline with the document' : url}>
              {inline ? <>Inline · {formatNumber(approxBytes)}B</> : url}
            </span>
            <span className="spacer" />
            <button className="btn btn--sm" onClick={() => setNonce((n) => n + 1)} title="Reload">
              <RefreshCw size={13} />
            </button>
            <a className="btn btn--sm" href={url} target="_blank" rel="noreferrer noopener" title="Open in a new tab">
              <ExternalLink size={13} /> Open
            </a>
            <button className="btn btn--sm" onClick={() => downloadDocument(doc)}>
              <Download size={13} /> Download
            </button>
            <button className="btn btn--sm" onClick={upload} title="Replace with a file from this computer">
              <FileUp size={13} /> Replace
            </button>
          </>
        ) : (
          <span className="muted">This PDF entity has no bytes yet.</span>
        )}
      </div>
      {url && waits ? (
        <div className="pdf__empty">
          <div className="pdf__empty-card">
            <h3>This PDF is on {hostOf(url) || 'another site'}</h3>
            <p className="muted">
              Loading it here makes a request to {hostOf(url) || 'that site'}, which learns that this document was opened.{' '}
              {external ? 'Load it only if you trust where it came from.' : 'Third-party services is off, so it is not loaded here.'}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              {external && (
                <button className="btn" onClick={() => setAllowed(url)}>
                  Load from {hostOf(url) || 'that site'}
                </button>
              )}
              <a className="btn" href={httpUrl(url)} target="_blank" rel="noreferrer noopener">
                <ExternalLink size={14} /> Open in a new tab
              </a>
            </div>
          </div>
        </div>
      ) : url ? (
        <div className="pdf__frame">
          {loaded !== frameKey && <div className="pdf__loading muted">Loading PDF…</div>}
          <iframe key={frameKey} title={doc.label ?? 'PDF'} src={url} onLoad={() => setLoaded(frameKey)} />
          {!inline && (
            <div className="pdf__fallback muted">
              Not rendering? The host may block embedding —{' '}
              <a href={url} target="_blank" rel="noreferrer noopener">
                open it in a new tab
              </a>
              .
            </div>
          )}
        </div>
      ) : (
        <div className="pdf__empty">
          <div className="pdf__empty-card">
            <h3>Attach the PDF</h3>
            <p className="muted">Either point at a URL, or upload a file — small files are stored inline with the entity so they travel with exports.</p>
            <div className="field">
              <label>PDF URL</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" style={{ flex: 1 }} placeholder="https://example.com/paper.pdf" value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setSourceUrl()} />
                <button className="btn" onClick={setSourceUrl} disabled={!urlDraft.trim()}>
                  <LinkIcon size={14} /> Use URL
                </button>
              </div>
            </div>
            <div className="pdf__or muted">or</div>
            <button className="btn" onClick={upload}>
              <FileUp size={14} /> Upload a PDF (≤ {MAX_INLINE_PDF_BYTES / 1024 / 1024} MB)
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
