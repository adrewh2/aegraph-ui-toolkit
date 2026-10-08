import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { catalogEntry, checkNames, fromPublished, isPicture } from '../demos/catalog.mjs'

/**
 * The demos catalog comes from another repository, and what `scripts/demos/fetch.mjs` writes from it is served from
 * this origin, where `script-src 'self'` would run any script among it. These are the checks between the two.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const demo = (over: Record<string, unknown>) => ({ id: 'bahamas', bundle: 'bundle.ae.json', preview: 'preview.png', ...over })

describe('the demos catalog', () => {
  it('takes a demo whose names are a plain id, a bundle and a picture', () => {
    for (const d of [
      demo({}),
      demo({ bundle: 'bundle.ae.json.gz', preview: 'preview.jpg' }),
      demo({ bundle: 'bundle.aeb', preview: 'card.jpeg' }),
      demo({ preview: 'preview.webp' }),
      demo({ preview: undefined }),
    ]) {
      expect(() => checkNames(d), JSON.stringify(d)).not.toThrow()
    }
  })

  it('refuses a preview that is not a picture: a page or a script would be served from this origin', () => {
    for (const preview of ['index.html', 'p.js', 'p.mjs', 'preview.svg', 'preview.png.html', 'README.md', 'preview']) {
      expect(() => checkNames(demo({ preview })), preview).toThrow(/preview/)
    }
  })

  it('refuses a bundle that is not a bundle', () => {
    for (const bundle of ['bundle.js', 'index.html', 'bundle.json', 'bundle.ae.json.html']) {
      expect(() => checkNames(demo({ bundle })), bundle).toThrow(/bundle/)
    }
  })

  it('refuses a name that would reach outside the demo’s folder', () => {
    for (const d of [demo({ id: '../x' }), demo({ id: '.hidden' }), demo({ bundle: '../../bundle.ae.json' }), demo({ preview: 'a/b.png' }), demo({ id: 3 })]) {
      expect(() => checkNames(d), JSON.stringify(d)).toThrow(/not a plain name/)
    }
  })

  it('believes a preview’s bytes, not its name', () => {
    expect(isPicture('preview.png', PNG)).toBe(true)
    expect(isPicture('preview.jpg', JPEG)).toBe(true)
    expect(isPicture('preview.jpeg', JPEG)).toBe(true)
    expect(isPicture('preview.webp', WEBP)).toBe(true)
    expect(isPicture('preview.png', Buffer.from('<script>alert(1)</script>'))).toBe(false)
    expect(isPicture('preview.png', JPEG)).toBe(false)
    expect(isPicture('preview.jpg', Buffer.from('<html>'))).toBe(false)
    expect(isPicture('preview.webp', Buffer.from('RIFF'))).toBe(false)
    expect(isPicture('preview.js', PNG)).toBe(false)
  })

  it('builds each entry from the fields the app reads, never a copy of what the catalog says', () => {
    const urls = { bundleUrl: '/demos/bahamas/bundle.ae.json.gz', previewUrl: '/demos/bahamas/preview.png', readmeUrl: undefined }
    const e = catalogEntry(
      demo({
        title: 'Bahamas',
        description: 'A tour',
        tags: ['travel', 7],
        home: '/maps',
        counts: { entities: 3, relationships: 2, byType: { place: 3, odd: 'x' } },
        bytes: 1200,
        // What the app must not take from another repository: URLs of its choosing, and anything it does not declare.
        bundleUrl: 'https://evil.example/b.ae.json',
        previewUrl: 'javascript:alert(1)',
        readmeUrl: '/demos/other/README.md',
        script: 'alert(1)',
      }),
      urls,
    )
    expect(e).toMatchObject({ id: 'bahamas', title: 'Bahamas', description: 'A tour', tags: ['travel'], home: '/maps', bytes: 1200, ...urls })
    expect(e.counts).toEqual({ entities: 3, relationships: 2, byType: { place: 3 } })
    expect(Object.keys(e)).not.toContain('script')
    expect(Object.keys(e)).not.toContain('bundle')
    // A home that is not a route here is dropped.
    expect(catalogEntry(demo({ home: '//evil.example' }), urls).home).toBeUndefined()
    expect(catalogEntry(demo({ home: 'https://evil.example' }), urls).home).toBeUndefined()
    // Missing text is filled, not left for the app to trip on.
    expect(catalogEntry(demo({}), urls)).toMatchObject({ title: 'bahamas', description: '' })
  })

  it('fetch.mjs uses these checks and copies no catalog field by spreading it', () => {
    const src = readFileSync(resolve(root, 'scripts/demos/fetch.mjs'), 'utf8')
    expect(src).toContain("from './catalog.mjs'")
    expect(src).toMatch(/checkNames\(d\)/)
    expect(src).toMatch(/isPicture\(/)
    expect(src).toMatch(/catalogEntry\(d,/)
    expect(src).not.toMatch(/\.\.\.d\b|\.\.\.catalog\b/)
  })

  it('/demos/ is served sandboxed, so a file there cannot run as this origin even if one got through', () => {
    const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] }
    const rule = config.headers.find((h) => h.source === '/demos/(.*)')
    const csp = rule?.headers.find((h) => h.key.toLowerCase() === 'content-security-policy')?.value ?? ''
    expect(csp).toMatch(/(^|;)\s*sandbox\s*(;|$)/)
    expect(csp).toContain("default-src 'none'")
    // The rule comes after the site-wide one, so it is the policy those paths are sent (scripts/headers.mjs reads it so).
    expect(config.headers.findIndex((h) => h.source === '/demos/(.*)')).toBeGreaterThan(config.headers.findIndex((h) => h.source === '/(.*)'))
  })

  it('reads a site’s published catalog back into the repo’s names, and only from /demos/<id>/<file>', () => {
    const published = { id: 'bahamas', title: 'Bahamas', bundleUrl: '/demos/bahamas/bundle.ae.json.gz', previewUrl: '/demos/bahamas/preview.jpg', readmeUrl: '/demos/bahamas/README.md' }
    expect(fromPublished(published)).toMatchObject({ id: 'bahamas', bundle: 'bundle.ae.json.gz', preview: 'preview.jpg' })
    expect(fromPublished({ ...published, previewUrl: undefined }).preview).toBeUndefined()
    for (const bundleUrl of ['https://elsewhere.example/demos/bahamas/bundle.ae.json.gz', '/demos/other/bundle.ae.json.gz', '/demos/bahamas/../x/bundle.aeb', '/x/bahamas/bundle.aeb', '/demos/bahamas/bundle.js', undefined, 42]) {
      expect(() => fromPublished({ ...published, bundleUrl }), String(bundleUrl)).toThrow()
    }
    expect(() => fromPublished({ ...published, previewUrl: '/demos/bahamas/index.html' })).toThrow(/preview/)
  })

  it('refuses an id named like a file beside the catalog, which would take catalog.json’s place', () => {
    for (const id of ['catalog.json', 'x.JSON']) expect(() => checkNames(demo({ id })), id).toThrow(/named like a file/)
    expect(() => checkNames(demo({ id: 'v1.2-demo' }))).not.toThrow()
  })
})
