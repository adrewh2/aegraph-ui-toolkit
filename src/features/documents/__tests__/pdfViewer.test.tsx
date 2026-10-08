import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EntityStoreContext } from '../../../core/entity/hooks'
import { EntityStore } from '../../../core/entity/store'

/**
 * A PDF's address is data — a bundle or a tool call wrote it — and the browser's PDF viewer will not render in a
 * sandboxed frame, so what the frame may load is what is held: the PDF itself, a blob or a file on this origin is
 * framed at once; one on another host is named and waits for a click, and for Third-party services.
 */
const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
const { setUserSettings } = await import('../../account/settings')
const { createDocument, pdfFramesAtOnce, pdfSrc } = await import('../documents')
const { PdfViewer } = await import('../PdfViewer')

function render(data: { dataUrl?: string; sourceUrl?: string }) {
  const store = new EntityStore()
  const doc = createDocument(store, { label: 'Paper', extension: 'pdf', data })
  return renderToString(
    <EntityStoreContext.Provider value={store}>
      <PdfViewer doc={doc} />
    </EntityStoreContext.Provider>,
  )
}

afterEach(() => setUserSettings({ externalServices: true }))

describe('PdfViewer — which PDFs are framed without a question', () => {
  it('frames a PDF carried inline, and one on this origin, at once', () => {
    expect(render({ dataUrl: 'data:application/pdf;base64,JVBERi0=' })).toContain('<iframe')
    expect(render({ sourceUrl: '/demos/paper.pdf' })).toContain('<iframe')
  })

  it('names another host and waits for a click, with no frame and so no request', () => {
    const html = render({ sourceUrl: 'https://evil.example/paper.pdf?d=secrets' })
    expect(html).not.toContain('<iframe')
    expect(html).toContain('evil.example')
    expect(html).toContain('Load from')
    expect(html).toContain('Open in a new tab')
  })

  it('with Third-party services off, offers only the link', () => {
    setUserSettings({ externalServices: false })
    const html = render({ sourceUrl: 'https://papers.example/paper.pdf' })
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('Load from')
    expect(html).toContain('Third-party services is off')
  })
})

describe('pdfFramesAtOnce and pdfSrc', () => {
  it('only data:, this page’s blobs and this origin’s paths frame at once', () => {
    for (const u of ['data:application/pdf;base64,JVBERi0=', '/demos/paper.pdf']) expect(pdfFramesAtOnce(u), u).toBe(true)
    for (const u of ['https://arxiv.org/pdf/1.pdf', 'http://example.com/x', 'blob:https://evil.example/abc']) expect(pdfFramesAtOnce(u), u).toBe(false)
  })

  it('a path the URL parser would read as another host is not a path', () => {
    for (const u of ['/\\evil.example/x.pdf', '/\t/evil.example/x.pdf', '/ /evil.example/x.pdf']) expect(pdfSrc(u), JSON.stringify(u)).toBeUndefined()
  })
})
