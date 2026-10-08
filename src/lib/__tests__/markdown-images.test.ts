import { describe, expect, it } from 'vitest'
import { dataImageSrc, imageKind, isOwnFunction, safeUrl } from '../markdown'

describe('imageKind — what a Markdown image may load without a click', () => {
  it('a picture carried in the text, or on this origin, loads', () => {
    expect(imageKind('data:image/png;base64,AAAA')).toBe('inline')
    expect(imageKind('/assets/figure.png')).toBe('inline')
    expect(imageKind('figure.png')).toBe('inline')
  })
  it('another host waits: loading it would send the URL — and whatever it carries — there', () => {
    expect(imageKind('https://evil.example/p.png?d=secret')).toBe('remote')
    expect(imageKind('http://evil.example/p.png')).toBe('remote')
    expect(imageKind('  HTTPS://evil.example/p.png')).toBe('remote')
  })
  it('another host written without a scheme is still another host: protocol-relative, backslashes, a tab inside', () => {
    for (const src of ['//evil.example/x', '/\\evil.example/x', '\\\\evil', '\\/evil.example/x', '/\t/evil.example/x', ' //evil.example/?d=secret']) {
      expect(imageKind(src), JSON.stringify(src)).toBe('remote')
    }
  })
  it('the page’s own origin written absolutely, and a path with a backslash inside it, stay inline', () => {
    const origin = globalThis.location?.origin && /^https?:/.test(globalThis.location.origin) ? globalThis.location.origin : 'https://app.invalid'
    expect(imageKind(`${origin}/assets/figure.png`)).toBe('inline')
    expect(imageKind('assets\\figure.png')).toBe('inline')
  })
})

describe('safeUrl — a relative URL is only relative when it stays on this origin', () => {
  it('turns a scheme-less URL that names another host into that host’s absolute URL, so it is treated as remote', () => {
    for (const [url, host] of [
      ['//evil.example/x', 'evil.example'],
      ['/\\evil.example/x', 'evil.example'],
      ['\\\\evil/x', 'evil'],
      ['/\t/evil.example/x', 'evil.example'],
    ]) {
      const out = safeUrl(url, { image: true })
      expect(out, JSON.stringify(url)).toMatch(/^https?:\/\//)
      expect(new URL(out!).host).toBe(host)
      expect(imageKind(out!)).toBe('remote')
    }
  })
  it('leaves paths and fragments as they were written', () => {
    for (const ok of ['/docs/x', '#top', '../a?b=1', 'figure.png']) expect(safeUrl(ok)).toBe(ok)
  })
})

describe('the site’s own functions are never a URL from data', () => {
  const origin = globalThis.location?.origin && /^https?:/.test(globalThis.location.origin) ? globalThis.location.origin : 'https://app.invalid'
  const calls = ['/api/fetch?url=https://evil.example/?d=secret', '/API/FETCH?url=https://evil.example/', '/api/fetch.pdf?url=https://evil.example/', '/%61pi/fetch?url=x', '/api%2ffetch?url=x', '/x/../api/fetch?url=x', '/api/openai/v1/audio/speech', '/api', `${origin}/api/fetch?url=https://evil.example/`, 'api/fetch?url=x']

  it('an image, a link or an image property pointing at one is refused, however it is spelled', () => {
    for (const u of calls) {
      expect(safeUrl(u, { image: true }), u).toBeUndefined()
      expect(safeUrl(u), u).toBeUndefined()
      expect(dataImageSrc(u), u).toBeUndefined()
      expect(isOwnFunction(u), u).toBe(true)
      // And nothing that asks treats it as this page's own picture.
      expect(imageKind(u), u).toBe('remote')
    }
  })

  it('a path that only starts like one is a path', () => {
    for (const u of ['/apis/x.png', '/api-docs/x.png', '/docs/api/x.png', '/assets/api.png']) {
      expect(safeUrl(u, { image: true }), u).toBe(u)
      expect(isOwnFunction(u), u).toBe(false)
    }
    expect(isOwnFunction('https://other.example/api/fetch')).toBe(false)
  })
})
