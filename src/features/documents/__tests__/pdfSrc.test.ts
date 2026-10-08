import { describe, expect, it } from 'vitest'
import { httpUrl } from '../../../core/resources/types'
import { pdfSrc } from '../documents'

describe('pdfSrc — what a PDF frame may load', () => {
  it('takes a PDF inline, a blob, a PDF on this origin, or http(s)', () => {
    for (const u of ['data:application/pdf;base64,JVBERi0=', 'blob:http://127.0.0.1:5199/abc', '/demos/paper.pdf', '/docs/a.PDF#page=2', 'https://arxiv.org/pdf/1.pdf', 'http://example.com/x']) expect(pdfSrc(u), u).toBe(u)
  })
  it('refuses a page dressed as a PDF', () => {
    for (const u of ['data:text/html,<script>alert(1)</script>', 'javascript:alert(1)', '/open?url=https://evil', '//evil.example/x.pdf', 'file:///etc/passwd', 'x.pdf', '', 7]) expect(pdfSrc(u), String(u)).toBeUndefined()
  })
  it('refuses the site’s own functions, which would fetch any address the moment the document opened', () => {
    const origin = globalThis.location?.origin && /^https?:/.test(globalThis.location.origin) ? globalThis.location.origin : 'https://app.invalid'
    for (const u of ['/api/fetch.pdf?url=https://evil.example/', '/API/FETCH.pdf', '/api/x.pdf', '/%61pi/fetch.pdf', `${origin}/api/fetch?url=https://evil.example/`]) expect(pdfSrc(u), u).toBeUndefined()
  })
  it('takes a file read with no type only when it is a PDF, and frames it as one rather than downloading it', () => {
    expect(pdfSrc('data:application/octet-stream;base64,JVBERi0xLjQK')).toBe('data:application/pdf;base64,JVBERi0xLjQK')
    expect(pdfSrc('data:application/octet-stream;name=x.pdf;base64,JVBERi0xLjQK')).toBe('data:application/pdf;base64,JVBERi0xLjQK')
    for (const u of ['data:application/octet-stream;base64,TVqQAAMAAAAEAAAA', 'data:application/octet-stream,%PDF-1.4', 'data:application/x-msdownload;base64,JVBERi0']) expect(pdfSrc(u), u).toBeUndefined()
  })
})

describe('httpUrl — what a link made from data may point at', () => {
  it('http(s) only', () => {
    expect(httpUrl('https://a.b/c')).toBe('https://a.b/c')
    expect(httpUrl(' https://a.b/c')).toBeUndefined()
    expect(httpUrl('HTTP://a.b')).toBe('HTTP://a.b')
    for (const u of ['javascript:alert(1)', 'data:text/html,x', '/local', 'vbscript:x', undefined, 3]) expect(httpUrl(u), String(u)).toBeUndefined()
  })
})
