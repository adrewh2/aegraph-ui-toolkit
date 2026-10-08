import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spotifyEmbedSrc, SPOTIFY_EMBED_ORIGIN } from '../../audio/spotify'
import { EMBED_SANDBOX, youtubeEmbedSrc, YOUTUBE_EMBED_ORIGIN } from '../youtube'

/**
 * The YouTube and Spotify players are plain frames on the provider's own origin, driven by messages — never the
 * provider's script loaded into the app. A script in the app's origin reads its localStorage (the keys) and its
 * workspace; the Content-Security-Policy refuses one, and must go on refusing it.
 */
beforeEach(() => vi.stubGlobal('location', new URL('https://aegraph.dev/videos/v1')))
afterEach(() => vi.unstubAllGlobals())

describe('media embeds', () => {
  it('a YouTube video is framed from youtube-nocookie.com, by a well-formed id only', () => {
    const src = new URL(youtubeEmbedSrc('M7lc1UVf-VE', 90.4))
    expect(src.origin).toBe(YOUTUBE_EMBED_ORIGIN)
    expect(src.origin).toBe('https://www.youtube-nocookie.com')
    expect(src.pathname).toBe('/embed/M7lc1UVf-VE')
    expect(src.searchParams.get('enablejsapi')).toBe('1')
    expect(src.searchParams.get('origin')).toBe('https://aegraph.dev')
    expect(src.searchParams.get('start')).toBe('90')
    for (const id of ['../../evil', 'abc/def?x=', 'a b', '', 'x'.repeat(40)]) expect(() => youtubeEmbedSrc(id), id).toThrow(/Invalid video id/)
  })

  it('a Spotify item is framed from open.spotify.com/embed, by a well-formed URI only', () => {
    expect(spotifyEmbedSrc('spotify:track:4cOdK2wGLETKBW3PvgPWqT')).toBe(`${SPOTIFY_EMBED_ORIGIN}/embed/track/4cOdK2wGLETKBW3PvgPWqT`)
    expect(spotifyEmbedSrc('spotify:episode:4cOdK2wGLETKBW3PvgPWqT')).toBe('https://open.spotify.com/embed/episode/4cOdK2wGLETKBW3PvgPWqT')
    for (const uri of ['spotify:track:../../x', 'spotify:user:4cOdK2wGLETKBW3PvgPWqT', 'https://evil.example/', '']) expect(() => spotifyEmbedSrc(uri), uri).toThrow()
  })

  it('the frames are sandboxed: their own scripts, no top navigation, no forms', () => {
    const tokens = EMBED_SANDBOX.split(' ')
    expect(tokens).toContain('allow-scripts')
    expect(tokens).not.toContain('allow-top-navigation')
    expect(tokens).not.toContain('allow-top-navigation-by-user-activation')
    expect(tokens).not.toContain('allow-forms')
  })

  it('no player loads a provider script into the page, and script-src never gains the providers', () => {
    for (const file of ['../youtube.ts', '../../audio/spotify.ts']) {
      const code = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(code, file).not.toMatch(/createElement\(['"]script['"]\)/)
      expect(code, file).not.toMatch(/iframe_api|iframe-api\/v1/)
    }
    const vercel = JSON.parse(readFileSync(new URL('../../../../vercel.json', import.meta.url), 'utf8')) as { headers: { headers: { key: string; value: string }[] }[] }
    const csps = vercel.headers.flatMap((h) => h.headers).filter((h) => /^content-security-policy/i.test(h.key)).map((h) => h.value)
    expect(csps.length).toBeGreaterThan(0)
    for (const csp of csps) {
      const directives = csp.split(';').map((d) => d.trim())
      const scriptSrc = directives.filter((d) => /^script-src(-elem)?\s/.test(d))
      // A policy without script-src runs nothing only when it falls back to default-src 'none' (the /demos files).
      if (!scriptSrc.length) {
        expect(directives).toContain("default-src 'none'")
        continue
      }
      for (const d of scriptSrc) {
        expect(d).not.toMatch(/youtube|ytimg|google|spotify|scdn|https:(?!\/\/)|\*/)
        expect(d.split(/\s+/).filter((s) => /^https?:\/\//.test(s))).toEqual([])
      }
    }
    // The dev server takes its headers from vercel.json; its config adds no script source of its own.
    const vite = readFileSync(new URL('../../../../vite.config.ts', import.meta.url), 'utf8')
    expect(vite).not.toMatch(/youtube\.com|spotify\.com/)
  })
})
