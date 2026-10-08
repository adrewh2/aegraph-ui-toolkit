import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/graph/types'
import '../../../core/resources/types'
import { createAppTools, type AppHost } from '../tools'

/**
 * The last tools the coverage audit found no test had called: the image
 * and video registrars (the browser's `Image` and YouTube's oEmbed stubbed;
 * capture_video_frame needs a playing tab and is left to the smoke runs),
 * property discovery, and the .ae.json validator on a good and a bad file.
 */

function host(store: EntityStore): AppHost & { navigated: string[] } {
  const navigated: string[] = []
  return { store, navigated, navigate: (to) => navigated.push(to), getContext: () => ({ route: '/images' }), confirm: async () => true }
}
const tool = (tools: ReturnType<typeof createAppTools>, name: string) => {
  const t = tools.find((x) => x.name === name) as BetaRunnableTool | undefined
  if (!t) throw new Error(`no tool ${name}`)
  return async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
}

describe('resource tools', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('registers an image by URL, with its size when the host lets it load, and opens it', async () => {
    const store = new EntityStore()
    const h = host(store)
    const tools = createAppTools(h)
    // A browser Image that loads: the size is read.
    class FakeImage {
      naturalWidth = 640
      naturalHeight = 480
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_v: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', FakeImage)
    const r = await tool(tools, 'create_image')({ url: 'https://example.org/pics/cat.png', title: 'Cat', tags: ['pets'] })
    expect(r).toMatchObject({ type: 'image', label: 'Cat' })
    const e = store.get(r.id)!
    expect(e.data).toMatchObject({ src: 'https://example.org/pics/cat.png', url: 'https://example.org/pics/cat.png', width: 640, height: 480 })
    expect(e.tags).toEqual(['pets'])
    expect(e.meta.source).toBe('import:url')
    expect(h.navigated).toEqual([`/images/${r.id}`])
    // A host that blocks cross-origin loads (or no browser at all): the entity is still made, without a size.
    vi.stubGlobal('Image', undefined)
    const blind = await tool(tools, 'create_image')({ url: 'https://example.org/private.jpg', open: false })
    expect(store.get(blind.id)!.data.width).toBeUndefined()
    expect(store.get(blind.id)!.label).toBeTruthy()
    expect(h.navigated).toHaveLength(1)
    await expect(tool(tools, 'create_image')({ url: 'not a url' })).rejects.toThrow()
  })

  it('shows an annotation\'s selector on get_entity from the annotated side as well as the annotation\'s', async () => {
    const store = new EntityStore()
    const h = host(store)
    const tools = createAppTools(h)
    vi.stubGlobal('Image', undefined)
    const img = await tool(tools, 'create_image')({ url: 'https://example.org/a.png', open: false })
    const box = await tool(tools, 'annotate_image')({ image_id: img.id, x: 1, y: 2, width: 30, height: 40, comment: 'a box' })
    const fromImage = (await tool(tools, 'get_entity')({ id: img.id })).relationships.find((r: { type: string }) => r.type === 'annotates')
    const fromNote = (await tool(tools, 'get_entity')({ id: box.id })).relationships.find((r: { type: string }) => r.type === 'annotates')
    expect(fromImage).toMatchObject({ direction: 'in', selector: { kind: 'region', x: 1, y: 2, width: 30, height: 40 } })
    expect(fromNote).toMatchObject({ direction: 'out', selector: { kind: 'region', x: 1, y: 2, width: 30, height: 40 } })
  })

  it('registers a YouTube video from any link form, with oEmbed metadata, and reuses the entity for the same video', async () => {
    const store = new EntityStore()
    const h = host(store)
    const tools = createAppTools(h)
    const calls: string[] = []
    vi.stubGlobal('fetch', (input: string | URL) => {
      calls.push(String(input))
      return Promise.resolve(new Response(JSON.stringify({ title: 'A talk about graphs', author_name: 'Graph Channel' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    })
    const r = await tool(tools, 'create_video')({ url: 'https://youtu.be/dQw4w9WgXcQ?t=42', tags: ['talk'] })
    expect(r).toMatchObject({ type: 'video', label: 'A talk about graphs', existed: false })
    const e = store.get(r.id)!
    expect(e.data).toMatchObject({ videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', channel: 'Graph Channel' })
    expect(String(e.data.thumbnailUrl)).toContain('dQw4w9WgXcQ')
    expect(e.tags).toEqual(['talk'])
    expect(h.navigated).toEqual([`/videos/${r.id}`])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('youtube.com/oembed')
    // The same video by its watch link: the existing entity, no second lookup, no navigation when asked not to.
    const again = await tool(tools, 'create_video')({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', open: false })
    expect(again).toMatchObject({ id: r.id, existed: true })
    expect(calls).toHaveLength(1)
    expect(h.navigated).toHaveLength(1)
    // oEmbed unavailable: a placeholder title, still registered.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 404 })))
    const bare = await tool(tools, 'create_video')({ url: 'https://www.youtube.com/shorts/abcdefghijk', open: false })
    expect(store.get(bare.id)!.label).toBe('YouTube video abcdefghijk')
    await expect(tool(tools, 'create_video')({ url: 'https://vimeo.com/12345' })).rejects.toThrow(/YouTube video id/)
  })

  it('lists the data properties in use per type, with counts, kinds, samples and whether the schema declares them', async () => {
    const store = new EntityStore()
    store.upsertMany([
      createEntity({ id: 'p1', type: 'paper', label: 'One', data: { year: 2020, doi: '10.1/a', venue: 'ICML' } }),
      createEntity({ id: 'p2', type: 'paper', label: 'Two', data: { year: 2021, doi: '10.1/b' } }),
      createEntity({ id: 'p3', type: 'paper', label: 'Three', data: { year: '2022', abstract: 'x'.repeat(200) } }),
      createEntity({ id: 'a1', type: 'author', label: 'Ada', data: { orcid: '0000' } }),
      createRelationship({ id: 'w', type: 'wrote', source: 'a1', target: 'p1', data: { position: 1 } }),
    ])
    const tools = createAppTools(host(store))
    const one = await tool(tools, 'list_properties')({ type: 'paper' })
    expect(one.types).toHaveLength(1)
    const paper = one.types[0]
    expect(paper).toMatchObject({ type: 'paper', entities: 3 })
    const byKey = Object.fromEntries(paper.properties.map((p: { key: string }) => [p.key, p]))
    expect(paper.properties[0].key).toBe('year')
    expect(byKey.year).toMatchObject({ count: 3, sample: 2020 })
    expect(byKey.year.kinds.sort()).toEqual(['number', 'text'])
    expect(byKey.doi).toMatchObject({ count: 2, kinds: ['text'], declared: 'none' })
    expect(byKey.venue.count).toBe(1)
    expect(byKey.abstract.sample.endsWith('…')).toBe(true)
    expect(byKey.abstract.sample.length).toBe(81)
    // Every type with entities when none is named; relationships are not entities, so `position` never appears.
    const all = await tool(tools, 'list_properties')({ limit: 2 })
    expect(all.types.map((t: { type: string }) => t.type).sort()).toEqual(['author', 'paper'])
    expect(all.types.find((t: { type: string }) => t.type === 'paper').properties).toHaveLength(2)
    expect(all.types.find((t: { type: string }) => t.type === 'author').properties.map((p: { key: string }) => p.key)).toEqual(['orcid'])
    expect(JSON.stringify(all)).not.toContain('position')
    // A declared property is reported as such.
    await tool(tools, 'define_entity_type')({ name: 'paper', properties: [{ key: 'year', kind: 'number' }] })
    const declared = await tool(tools, 'list_properties')({ type: 'paper' })
    expect(declared.types[0].properties.find((p: { key: string }) => p.key === 'year')).toMatchObject({ declared: 'schema', kind: 'number' })
  })

  it('validates an aegraph document: a good one passes with counts, a bad one lists its problems by JSON pointer', async () => {
    const tools = createAppTools(host(new EntityStore()))
    const good = {
      $schema: 'aegraph/v1',
      exportedAt: '2026-09-16T00:00:00.000Z',
      entities: [createEntity({ id: 'a', type: 'note', label: 'A' }), createEntity({ id: 'b', type: 'note', label: 'B' }), createRelationship({ id: 'ab', type: 'links', source: 'a', target: 'b' }), createRelationship({ id: 'ax', type: 'links', source: 'a', target: 'elsewhere' })],
    }
    const ok = await tool(tools, 'validate_ae')({ text: JSON.stringify(good) })
    expect(ok).toMatchObject({ ok: true, issues: [], entities: 2, relationships: 2, unresolved: ['elsewhere'], duplicates: [] })
    expect(ok.schema).toBeTruthy()
    expect(ok.docs).toBe('/docs/spec')

    const bad = { $schema: 'aegraph/v1', entities: [{ id: 'a', type: 'note', label: 'A' }, { id: 'a', kind: 'relationship', type: 'links', source: { id: 'a' } }, 'not an entity'] }
    const r = await tool(tools, 'validate_ae')({ text: JSON.stringify(bad) })
    expect(r.ok).toBe(false)
    expect(r.issues.length).toBeGreaterThan(0)
    for (const i of r.issues) expect(i).toMatchObject({ path: expect.stringMatching(/^(\/|$)/), message: expect.any(String) })
    expect(r.issues.some((i: { path: string }) => i.path.startsWith('/entities/2'))).toBe(true)
    expect(r.duplicates).toEqual(['a'])

    const notJson = await tool(tools, 'validate_ae')({ text: '{ not json' })
    expect(notJson.ok).toBe(false)
    expect(notJson.issues[0].message).toMatch(/^not JSON/)
    const notObject = await tool(tools, 'validate_ae')({ text: '[]' })
    expect(notObject.ok).toBe(false)
    expect(notObject.issues[0]).toMatchObject({ path: '', message: expect.stringContaining('object') })
  })
})
