import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { listEntityTypes } from '../../entity/schema'
import type { AnyEntity } from '../../entity/types'
import { isAudio, parseSpotify, spotifyUri } from '../../../features/audio/audio'
import { isImage, labelFromUrl } from '../../../features/images/images'
import { extractStartTime, extractYouTubeId, isVideo } from '../../../features/videos/videos'
import { documentType, externalHref, imageType, RESOURCE_TYPES, selectorForAnnotation, type AnnotationData } from '../types'
import '../types'

/**
 * The resource types where the data is ragged: a resource with no url at
 * all, a data: URL, a revoked blob:, a name with no extension or an odd
 * one, an http link where https was meant, a mime type carrying
 * parameters, an image with no dimensions, a video whose id is missing, an
 * audio link in every shape Spotify writes; and the definitions
 * themselves — every one labelled, plural, categorised and coloured, no
 * two claiming the same name.
 */
const ent = (type: string, data: Record<string, unknown>): AnyEntity => createEntity({ id: `e-${type}`, type, data })

describe('what counts as one', () => {
  it('an image is one when it has something to draw — a url, a data: URL, even a blob: that may be dead — and not otherwise', () => {
    expect(isImage(ent('image', { src: 'https://x/y.png' }))).toBe(true)
    expect(isImage(ent('image', { src: 'data:image/png;base64,iVBORw0KGgo=' }))).toBe(true)
    // A blob: URL from a session that has ended still reads as an image; only the fetch of it fails, and the viewer shows that.
    expect(isImage(ent('image', { src: 'blob:http://localhost:5199/8f0e-revoked' }))).toBe(true)
    // An empty src still reads as an image entity — the guard asks what kind of thing this is, not whether it is
    // fit to draw. That is the validator's job (below), and it matters: an image with a broken source must still
    // open in the viewer to be repaired rather than vanish from the gallery.
    expect(isImage(ent('image', { src: '' }))).toBe(true)
    expect(imageType.validate?.(ent('image', { src: '' }))?.[0]).toMatchObject({ field: 'data.src', severity: 'error' })
    expect(isImage(ent('image', { url: 'https://x/y.png' }))).toBe(false) // a url is where it came from; src is what is drawn
    expect(isImage(ent('image', { src: 123 as unknown as string }))).toBe(false)
    expect(isImage(ent('note', { src: 'https://x/y.png' }))).toBe(false)
    expect(isImage(undefined)).toBe(false)
    // The definition says the same, as a validation error rather than a guess.
    expect(imageType.validate?.(ent('image', { src: 'https://x/y.png' }))).toEqual([])
    expect(imageType.validate?.(ent('image', {}))?.[0]).toMatchObject({ field: 'data.src', severity: 'error' })
  })

  it('a video needs its id and an audio its Spotify id, whatever else is missing', () => {
    expect(isVideo(ent('video', { videoId: 'dQw4w9WgXcQ' }))).toBe(true)
    expect(isVideo(ent('video', { url: 'https://youtu.be/dQw4w9WgXcQ', thumbnailUrl: 'https://i.ytimg.com/x.jpg' }))).toBe(false) // a poster and no source is not a video
    expect(isAudio(ent('audio', { spotifyId: '4cOdK2wGLETKBW3PvgPWqT' }))).toBe(true)
    expect(isAudio(ent('audio', { url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT' }))).toBe(false)
  })
})

describe('the links a resource carries', () => {
  it('offers an external link only for http(s), and reads the page url when there is no url', () => {
    expect(externalHref(ent('webpage', { url: 'https://example.com/a' }))).toBe('https://example.com/a')
    expect(externalHref(ent('webpage', { url: 'http://example.com/a' }))).toBe('http://example.com/a') // http is honoured as written, not upgraded behind the user's back
    expect(externalHref(ent('annotation', { pageUrl: 'https://example.com/p' }))).toBe('https://example.com/p')
    expect(externalHref(ent('image', { src: 'data:image/png;base64,AAA' }))).toBeUndefined()
    expect(externalHref(ent('document', { sourceUrl: 'https://example.com/a.pdf' }))).toBeUndefined() // sourceUrl is not the link "open" follows
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'blob:http://x/y', 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', '', '  https://example.com  ', 42])
      expect(externalHref(ent('webpage', { url })), String(url)).toBeUndefined()
  })

  it('names an image after its file, whatever the url looks like', () => {
    expect(labelFromUrl('https://example.com/photos/Sunset%20over%20Ré.jpg')).toBe('Sunset over Ré')
    expect(labelFromUrl('https://example.com/a/b/no-extension')).toBe('no-extension')
    expect(labelFromUrl('https://example.com/')).toBe('')
    expect(labelFromUrl('data:image/png;base64,AAA')).toBe('')
    expect(labelFromUrl('not a url at all')).toBe('')
    expect(labelFromUrl('https://example.com/x.unknownext')).toBe('x.unknownext') // only a plausible extension is dropped
    expect(labelFromUrl(`https://example.com/${'long'.repeat(80)}.png`)).toHaveLength(320)
  })
})

describe('the shapes their links come in', () => {
  it('reads a Spotify link however it is written, and nothing else', () => {
    const id = '4cOdK2wGLETKBW3PvgPWqT'
    for (const s of [`spotify:track:${id}`, `https://open.spotify.com/track/${id}`, `https://open.spotify.com/intl-de/track/${id}?si=abc`, `https://open.spotify.com/embed/track/${id}`, `  https://open.spotify.com/track/${id}  `])
      expect(parseSpotify(s), s).toEqual({ kind: 'track', id })
    expect(parseSpotify(`https://open.spotify.com/episode/${id}`)).toEqual({ kind: 'episode', id })
    for (const s of ['', 'https://open.spotify.com/track/tooshort', 'https://example.com/track/' + id, `spotify:song:${id}`, `https://open.spotify.com/${id}`, 'https://notspotify.com/track/' + id])
      expect(parseSpotify(s), s).toBeUndefined()
    expect(spotifyUri('track', id)).toBe(`spotify:track:${id}`)
  })

  it('reads a YouTube id and a start time from the forms people paste', () => {
    for (const s of ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'])
      expect(extractYouTubeId(s), s).toBe('dQw4w9WgXcQ')
    for (const s of ['', 'https://vimeo.com/12345', 'https://www.youtube.com/watch?v=short', 'not an id']) expect(extractYouTubeId(s), s).toBeUndefined()
    expect(extractStartTime('https://youtu.be/dQw4w9WgXcQ?t=90')).toBe(90)
    expect(extractStartTime('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')).toBe(90)
    expect(extractStartTime('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s')).toBe(3723)
    expect(extractStartTime('https://youtu.be/dQw4w9WgXcQ')).toBeUndefined()
    expect(extractStartTime('https://youtu.be/dQw4w9WgXcQ?t=abc')).toBeUndefined()
  })
})

describe('a document’s format, and an annotation’s selector', () => {
  it('warns about a format it does not know, and says nothing about the ones it does', () => {
    for (const ext of ['md', 'txt', 'pdf', 'folder']) expect(documentType.validate?.(ent('document', { extension: ext })), ext).toEqual([])
    const odd = documentType.validate?.(ent('document', { extension: 'docx' }))
    expect(odd?.[0]).toMatchObject({ field: 'data.extension', severity: 'warning' })
    expect(odd?.[0].message).toContain('docx')
    // No extension at all is the same warning, not a crash.
    expect(documentType.validate?.(ent('document', {}))?.[0]?.severity).toBe('warning')
    expect(documentType.validate?.(ent('document', { extension: 'MD' }))?.[0]?.severity).toBe('warning') // the format is lower-case as written
  })

  it('turns a quoted passage into a text selector, and nothing into nothing', () => {
    expect(selectorForAnnotation({ comment: 'c', annotationType: 'text', selectedText: 'the passage' } as AnnotationData)).toEqual({ kind: 'text', exact: 'the passage' })
    expect(selectorForAnnotation({ comment: 'c', annotationType: 'note' } as AnnotationData)).toBeUndefined()
    expect(selectorForAnnotation({ comment: 'c', annotationType: 'text', selectedText: '' } as AnnotationData)).toBeUndefined()
  })
})

describe('the definitions themselves', () => {
  it('every resource type is labelled, plural, categorised and coloured, and no two claim a name', () => {
    const defs = listEntityTypes().filter((t) => Object.values(RESOURCE_TYPES).includes(t.type as never))
    expect(defs.map((d) => d.type).sort()).toEqual([...Object.values(RESOURCE_TYPES)].sort())
    for (const d of defs) {
      expect(d.label, d.type).toMatch(/\S/)
      expect(d.pluralLabel, d.type).toMatch(/\S/)
      expect(d.category, d.type).toBe('resource')
      expect(d.color, d.type).toMatch(/^#[0-9a-f]{6}$/i)
      expect(d.description, d.type).toMatch(/\S/)
      expect(d.icon, d.type).toBeDefined()
      // Every field addresses data or a base field, is labelled, and has a kind.
      for (const f of d.fields) {
        expect(f.key, `${d.type} ${f.key}`).toMatch(/^(data\.|label$|description$|tags$|meta\.)/)
        expect(f.label, `${d.type} ${f.key}`).toMatch(/\S/)
        expect(f.kind, `${d.type} ${f.key}`).toMatch(/\S/)
      }
      expect(new Set(d.fields.map((f) => f.key)).size, `${d.type} duplicate field`).toBe(d.fields.length)
    }
    const all = listEntityTypes()
    expect(new Set(all.map((t) => t.type)).size).toBe(all.length)
  })
})
