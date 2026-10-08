import { readFileSync } from 'node:fs'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { setUserSettings } from '../../features/account/settings'
import { dataImageSrc } from '../../lib/markdown'
import { allowRemoteImage, cssImageUrl, forgetRemoteImages, imageGate, isProviderImage } from '../imageGate'
import { DataImage, RemoteImage } from '../RemoteImage'

/**
 * An image URL from data — an entity's image property in a table or the inspector — is a request someone else chose.
 * Loading it at once would tell that host, with whatever the URL carries, that the page was opened: it waits for a
 * click, as a remote image in Markdown does.
 */
describe('DataImage — an image property value', () => {
  it('a remote URL is a button naming its host until clicked, with no <img> and no request', () => {
    for (const src of ['https://evil.example/p.png?d=secret', '//evil.example/p.png', '/\\evil.example/p.png']) {
      const html = renderToString(<DataImage src={src} className="et__thumb" />)
      expect(html, src).not.toContain('<img')
      expect(html, src).toContain('evil.example')
      expect(html, src).toContain('<button')
    }
  })

  it('a picture carried in the data, or served by this origin, shows at once', () => {
    for (const src of ['data:image/png;base64,AAAA', '/assets/figure.png', 'figure.png']) {
      const html = renderToString(<DataImage src={src} className="et__thumb" />)
      expect(html, src).toContain('<img')
      expect(html, src).toContain('class="et__thumb"')
    }
  })

  it('a script-capable or non-image URL is never a src', () => {
    for (const src of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x']) {
      expect(dataImageSrc(src), src).toBeUndefined()
      expect(renderToString(<DataImage src={src} />), src).not.toContain('<img')
    }
    expect(dataImageSrc(42)).toBeUndefined()
  })

  it('the entity table and the inspector draw image properties through it, never a bare <img>', () => {
    for (const file of ['../../features/resources/EntityTable.tsx', '../../features/resources/Inspector.tsx']) {
      const code = readFileSync(new URL(file, import.meta.url), 'utf8')
      const imageCase = code.slice(code.indexOf("case 'image':"), code.indexOf("case 'image':") + 300)
      expect(imageCase, file).toContain('<DataImage')
      expect(imageCase, file).not.toContain('<img')
    }
  })
})

describe('pictures from data, everywhere the media pages draw them', () => {
  afterEach(() => {
    setUserSettings({ externalServices: true })
    forgetRemoteImages()
  })

  it('a provider’s own thumbnail shows at once with Third-party services on, and only with `providers`', () => {
    for (const src of ['https://i.ytimg.com/vi/abc/mqdefault.jpg', 'https://i.scdn.co/image/ab67', 'https://upload.wikimedia.org/wikipedia/commons/a/a1/X.jpg']) {
      expect(isProviderImage(src), src).toBe(true)
      const html = renderToString(<DataImage src={src} providers />)
      expect(html, src).toContain('<img')
      expect(html, src).toContain('referrerPolicy="no-referrer"')
      expect(renderToString(<DataImage src={src} />), src).not.toContain('<img')
    }
    // Not the provider: another port, credentials, plain http, a look-alike host.
    for (const src of ['https://i.ytimg.com:8443/x.jpg', 'https://u:p@i.ytimg.com/x.jpg', 'http://i.ytimg.com/x.jpg', 'https://i.ytimg.com.evil.example/x.jpg', 'https://evil.example/i.ytimg.com/x.jpg']) {
      expect(isProviderImage(src), src).toBe(false)
      expect(renderToString(<DataImage src={src} providers />), src).not.toContain('<img')
    }
  })

  it('with Third-party services off nothing remote is drawn and nothing offers to load it — Markdown’s remote images included', () => {
    setUserSettings({ externalServices: false })
    for (const src of ['https://i.ytimg.com/vi/abc/mqdefault.jpg', 'https://evil.example/p.png']) {
      const html = renderToString(<DataImage src={src} providers />)
      expect(html, src).not.toContain('<img')
      expect(html, src).not.toContain('<button')
      expect(html, src).toContain('Third-party services is off')
      expect(renderToString(<RemoteImage src={src} />), src).not.toContain('<img')
    }
    // Even one the reader loaded before the switch went off.
    allowRemoteImage('https://evil.example/p.png')
    expect(renderToString(<DataImage src="https://evil.example/p.png" />)).not.toContain('<img')
    expect(renderToString(<DataImage src="data:image/png;base64,AAAA" />)).toContain('<img')
  })

  it('a picture the reader loaded once shows again in this tab without asking', () => {
    expect(imageGate('https://evil.example/p.png', { external: true })).toMatchObject({ status: 'ask' })
    allowRemoteImage('https://evil.example/p.png')
    expect(imageGate('https://evil.example/p.png', { external: true })).toMatchObject({ status: 'show' })
    expect(imageGate('https://evil.example/other.png', { external: true })).toMatchObject({ status: 'ask' })
  })

  it('a CSS url() from data cannot end its own value', () => {
    const css = cssImageUrl('https://x.example/a.png"), url(https://evil.example/leak')
    expect(css.split('"').length - 1, css).toBe(2)
    expect(css.endsWith('")'), css).toBe(true)
    expect(cssImageUrl('data:image/png;base64,AA\\"')).toBe('url("data:image/png;base64,AA%5C%22")')
  })

  it('the media pages draw every picture from data through the gate, never a bare <img src> of entity data', () => {
    // Each file, and what its pictures are made of. A new <img> over entity data in one of them fails here.
    const files = [
      '../../features/images/ImageAnnotator.tsx',
      '../../features/images/ImagesIndex.tsx',
      '../../features/images/Crop.tsx',
      '../../features/videos/VideosIndex.tsx',
      '../../features/videos/VideoWorkbench.tsx',
      '../../features/audio/AudioIndex.tsx',
      '../../features/resources/AnnotationsTab.tsx',
      '../../features/resources/WebpageEmbed.tsx',
      '../../features/maps/GeoCard.tsx',
      '../../features/projects/history/ChangeList.tsx',
    ]
    for (const file of files) {
      const code = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(code, file).toMatch(/DataImage|useImageGate/)
      for (const m of code.matchAll(/<img\b[^>]*\bsrc=\{([^}]*)\}/g)) expect(m[1], `${file}: <img src={${m[1]}}>`).toMatch(/^(gate\.src|still\.dataUrl|url\.trim\(\))$/)
      expect(code, file).not.toMatch(/url\("\$\{/)
    }
  })
})
