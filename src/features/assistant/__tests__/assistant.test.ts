import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { getCameraControls } from '../../graph/cameraControls'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { overrideClientOptions } from '../../../core/ai/client'
import { overrideEmbed } from '../../search/embedder'
import { setAiSettings } from '../../../core/ai/settings'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/graph/types'
import '../../../core/resources/types'
import { annotationsOf, createDocument, FOLDER } from '../../documents/documents'
import { createImage, regionAnnotationsOf } from '../../images/images'
import { setExplorerHandle, type ExplorerHandle } from '../../graph/explorerHandle'
import { applyFilter, datasetTotals } from '../../../core/graph/filter'
import { place, transform } from '../../../core/graph/placement'
import { describePipeline } from '../../../core/graph/pipeline'
import { isProject, projectBreadcrumb, projectMembers, projectOverlay } from '../../../core/graph/project'
import { resolveSelector } from '../../../core/graph/selector'
import { makeValueContext } from '../../../core/graph/values'
import { shortestPath } from '../../../core/graph/paths'
import { applySelect, selectionOp } from '../../../core/graph/selection'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { timeAnnotationsOf as audioAnnotationsOf } from '../../audio/audio'
import { setAudioPlayback, setAudioPlayerHandle } from '../../audio/playback'
import { setPlayback, setPlayerHandle } from '../../videos/playback'
import { timeAnnotationsOf } from '../../videos/videos'
import { emptyFilter } from '../../../core/graph/filter'
import { computeMetrics, serializeSlice, sliceKey, type MetricsResult } from '../../../core/graph/metrics'
import { DEFAULT_RENDERING } from '../../../core/graph/rendering'
import { AssistantSession } from '../session'
import { createAppTools, type AppHost } from '../tools'

function host(store: EntityStore, overrides: Partial<AppHost> = {}): AppHost & { navigated: string[]; confirmations: string[] } {
  const navigated: string[] = []
  const confirmations: string[] = []
  return {
    store,
    navigated,
    confirmations,
    navigate: (to) => navigated.push(to),
    getContext: () => ({ route: '/documents' }),
    confirm: async (m) => (confirmations.push(m), true),
    ...overrides,
  }
}

const tool = (tools: ReturnType<typeof createAppTools>, name: string) => {
  const t = tools.find((x) => x.name === name) as BetaRunnableTool | undefined
  if (!t) throw new Error(`no tool ${name}`)
  return async (input: unknown) => {
    const r = await t.run(t.parse(input))
    return typeof r === 'string' ? r : JSON.stringify(r)
  }
}

describe('app tools', () => {
  let store: EntityStore
  let h: ReturnType<typeof host>
  let tools: ReturnType<typeof createAppTools>
  beforeEach(() => {
    store = new EntityStore()
    h = host(store)
    tools = createAppTools(h)
  })

  it('exposes every tool with a JSON schema', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'add_area',
        'add_location',
        'add_path',
        'analyze',
        'annotate_document',
        'annotate_image',
        'annotate_audio',
        'annotate_video',
        'capture_video_frame',
        'control_playback',
        'create_document',
        'create_entity',
        'create_image',
        'create_audio',
        'create_relationship',
        'create_video',
        'dataset',
        'delete_entities',
        'delete_entity',
        'display',
        'edit_document',
        'enrich_location',
        'get_app_context',
        'globe',
        'globe_load',
        'gpu_graph',
        'get_entity',
        'graph_filter',
        'graph_export',
        'graph_layout',
        'graph_metrics',
        'import_graph',
        'graph_path',
        'graph_positions',
        'graph_project',
        'graph_query',
        'graph_save',
        'graph_select',
        'graph_selection',
        'graph_selection_action',
        'graph_state',
        'graph_style',
        'graph_viewport',
        'list_documents',
        'list_entity_types',
        'list_properties',
        'list_tags',
        'load_dataset',
        'move_document',
        'open',
        'open_entities',
        'plot',
        'project_add',
        'project_changes',
        'project_commit',
        'project_create',
        'project_delete',
        'project_history',
        'project_list',
        'project_open',
        'project_open_bundle',
        'project_template',
        'project_publish',
        'project_remove',
        'project_restore',
        'project_save',
        'project_update',
        'script',
        'read_document',
        'search_entities',
        'set_properties',
        'slides',
        'text_insights',
        'tag_entities',
        'update_entity',
        'view_image',
        'workstation',
        'write_document',
        'docs',
        'inspect',
        'annotate_webpage',
        'app_diagnostics',
        'constraint',
        'create_diagram',
        'write_diagram',
        'diagram_to_dataset',
        'define_entity_type',
        'table_layout',
        'update_tag',
        'validate_ae',
        'create_map',
        'annotate_map',
        'map_state',
        'map_import',
        'view_diagram',
        'ask_user',
        'voice',
        'memory',
        'chat',
        'account',
        'web_fetch',
      ].sort(),
    )
    for (const t of tools) expect((t as { input_schema: { type: string } }).input_schema.type).toBe('object')
  })

  it('opens what it creates — an entity, a diagram, a map — unless told open: false', async () => {
    const note = JSON.parse(await tool(tools, 'create_entity')({ type: 'note', label: 'Idea', data: { text: 'x' } }))
    expect(h.navigated.at(-1)).toMatch(new RegExp(`sel=${note.id}&tab=app$`))
    const diagram = JSON.parse(await tool(tools, 'create_diagram')({ label: 'Flow', source: 'digraph { a -> b }' }))
    expect(h.navigated.at(-1)).toMatch(new RegExp(`sel=${diagram.id}&tab=app$`))
    const map = JSON.parse(await tool(tools, 'create_map')({ label: 'Places' }))
    expect(h.navigated.at(-1)).toBe(`/maps/${map.id}`)
    expect(h.navigated).toHaveLength(3)
    await tool(tools, 'create_entity')({ type: 'note', label: 'Quiet', open: false })
    await tool(tools, 'create_diagram')({ label: 'Quiet', source: 'digraph { a }', open: false })
    await tool(tools, 'create_map')({ label: 'Quiet', open: false })
    expect(h.navigated).toHaveLength(3)
  })

  it('on the Chats page, what it creates opens in the chat\'s artifacts panel instead of leaving the page', async () => {
    const revealed: string[] = []
    const h2 = host(store, { reveal: (id) => (revealed.push(id), true) })
    const t2 = createAppTools(h2)
    const doc = JSON.parse(await tool(t2, 'create_document')({ title: 'Plan', content: 'x' }))
    const data = JSON.parse(await tool(t2, 'dataset')({ action: 'create', name: 'Random', columns: ['n'], rows: [[1], [2]] }))
    const map = JSON.parse(await tool(t2, 'create_map')({ label: 'Places' }))
    expect(revealed).toEqual([doc.id, data.id, map.id])
    expect(data.opened).toBe('panel')
    expect(h2.navigated).toEqual([])
  })

  it('creates, lists, reads, and navigates to documents', async () => {
    const folder = createDocument(store, { label: 'Research', extension: FOLDER })
    const created = JSON.parse(await tool(tools, 'create_document')({ title: 'Plan', content: '# Plan\n\nStep one.', folder_id: folder.id, tags: ['todo'] }))
    expect(created.extension).toBe('md')
    expect(h.navigated).toEqual([`/documents/${created.id}`])
    const listing = await tool(tools, 'list_documents')({})
    expect(listing).toContain('📁 Research/')
    expect(listing).toContain(`  📄 Plan.md  [${created.id}]  #todo`)
    const read = JSON.parse(await tool(tools, 'read_document')({ id: created.id }))
    expect(read.content).toBe('# Plan\n\nStep one.')
    expect(read.folderPath).toEqual(['Research'])
    await expect(tool(tools, 'create_document')({ title: 'x', folder_id: created.id })).rejects.toThrow('not a folder')
  })

  it('edits documents precisely and refuses ambiguous edits', async () => {
    const d = createDocument(store, { label: 'Doc', content: 'alpha beta alpha' })
    await expect(tool(tools, 'edit_document')({ id: d.id, old_text: 'alpha', new_text: 'gamma' })).rejects.toThrow('occurs 2 times')
    await expect(tool(tools, 'edit_document')({ id: d.id, old_text: 'zzz', new_text: 'gamma' })).rejects.toThrow('not found')
    await tool(tools, 'edit_document')({ id: d.id, old_text: 'beta', new_text: 'delta' })
    expect(store.get(d.id)?.data.content).toBe('alpha delta alpha')
    await tool(tools, 'edit_document')({ id: d.id, old_text: 'alpha', new_text: 'A', replace_all: true })
    expect(store.get(d.id)?.data.content).toBe('A delta A')
    await tool(tools, 'edit_document')({ id: d.id, new_text: 'tail', append: true })
    expect(store.get(d.id)?.data.content).toBe('A delta A\ntail')
    await tool(tools, 'write_document')({ id: d.id, content: 'fresh' })
    expect(store.get(d.id)?.data.content).toBe('fresh')
    const pdf = createDocument(store, { label: 'P', extension: 'pdf' })
    await expect(tool(tools, 'write_document')({ id: pdf.id, content: 'x' })).rejects.toThrow('.pdf')
  })

  it('annotates only verbatim quotes', async () => {
    const d = createDocument(store, { label: 'Doc', content: 'The quick brown fox.' })
    await expect(tool(tools, 'annotate_document')({ document_id: d.id, quote: 'slow fox', comment: 'no' })).rejects.toThrow('not found verbatim')
    const a = JSON.parse(await tool(tools, 'annotate_document')({ document_id: d.id, quote: 'quick brown', comment: 'nice', tags: ['style'] }))
    expect(a.type).toBe('annotation')
    expect(annotationsOf(store, d.id)[0].selector).toMatchObject({ kind: 'text', exact: 'quick brown', prefix: 'The ', suffix: ' fox.' })
  })

  it('says what a passage names, tags and is found in (text_insights)', async () => {
    store.upsertMany([
      createEntity({ id: 'ada', type: 'person', label: 'Ada Lovelace', tags: ['mathematics'] }),
      createEntity({ id: 'eng', type: 'thing', label: 'Analytical Engine' }),
      createEntity({ id: 'src', type: 'document', label: 'Notes', data: { content: 'Ada Lovelace and the Analytical Engine' } }),
    ])
    const r = JSON.parse(await tool(tools, 'text_insights')({ text: 'Ada Lovelace wrote about the Analytical Engine and mathematics.', exclude: ['src'] }))
    expect(r.named.map((m: { id: string }) => m.id)).toEqual(['eng', 'ada'])
    expect(r.tags).toEqual([{ tag: 'mathematics', count: 1, matched: 'mathematics' }])
    expect(r.mentions).toEqual([])
    const short = JSON.parse(await tool(tools, 'text_insights')({ text: 'Analytical Engine' }))
    expect(short.named[0]).toMatchObject({ id: 'eng', how: 'whole' })
    expect(short.mentions.map((m: { id: string }) => m.id)).toEqual(['src'])
    await expect(tool(tools, 'text_insights')({})).rejects.toThrow()
  })

  it('searches, inspects, updates, links, and deletes entities with confirmation', async () => {
    const n = createEntity({ type: 'note', label: 'Graph ideas', tags: ['idea'], data: { text: 'ECS-like model' } })
    const w = createEntity({ type: 'webpage', label: 'W3C', data: { url: 'https://w3.org' } })
    store.upsertMany([n, w])
    const found = JSON.parse(await tool(tools, 'search_entities')({ query: 'ecs' }))
    expect(found.results.map((r: { id: string }) => r.id)).toEqual([n.id])
    const linked = JSON.parse(await tool(tools, 'create_relationship')({ source_id: n.id, target_id: w.id, type: 'references' }))
    expect(linked.kind).toBe('relationship')
    const full = JSON.parse(await tool(tools, 'get_entity')({ id: n.id }))
    expect(full.relationships).toHaveLength(1)
    expect(full.relationships[0]).toMatchObject({ type: 'references', direction: 'out', other: { id: w.id } })
    const updated = JSON.parse(await tool(tools, 'update_entity')({ id: n.id, label: 'Graph notes', add_tags: ['todo'], remove_tags: ['idea'], data: { text: null, priority: 2 } }))
    expect(updated.label).toBe('Graph notes')
    expect(updated.tags).toEqual(['todo'])
    expect(store.get(n.id)?.data).toEqual({ priority: 2 })
    const deleted = JSON.parse(await tool(tools, 'delete_entity')({ id: n.id }))
    expect(h.confirmations).toHaveLength(1)
    expect(deleted.deleted).toEqual([n.id])
    expect(store.relationshipCount()).toBe(0)
  })

  it('navigates away when the open document is deleted', async () => {
    const d = createDocument(store, { label: 'Open' })
    const h2 = host(store, { getContext: () => ({ route: `/documents/${d.id}`, document: { id: d.id, label: 'Open', extension: 'md', folderPath: [] } }) })
    await tool(createAppTools(h2), 'delete_entity')({ id: d.id })
    expect(h2.navigated).toEqual(['/documents'])
  })

  it('does nothing when the user declines a delete', async () => {
    const declining = createAppTools(host(store, { confirm: async () => false }))
    const n = createEntity({ type: 'note', label: 'keep me' })
    store.upsert(n)
    expect(await tool(declining, 'delete_entity')({ id: n.id })).toContain('declined')
    expect(store.has(n.id)).toBe(true)
  })

  it('refuses to create documents through create_entity and validates moves', async () => {
    await expect(tool(tools, 'create_entity')({ type: 'document', label: 'x' })).rejects.toThrow('create_document')
    const f = createDocument(store, { label: 'F', extension: FOLDER })
    const d = createDocument(store, { label: 'D' })
    const moved = JSON.parse(await tool(tools, 'move_document')({ id: d.id, folder_id: f.id }))
    expect(moved.folderPath).toEqual(['F'])
    await expect(tool(tools, 'move_document')({ id: f.id, folder_id: f.id })).rejects.toThrow('refused')
  })

  it('navigates by id or page', async () => {
    const d = createDocument(store, { label: 'D' })
    const n = createEntity({ type: 'note', label: 'n' })
    store.upsert(n)
    await tool(tools, 'open')({ id: d.id })
    await tool(tools, 'open')({ id: n.id })
    await tool(tools, 'open')({ page: 'Entities' })
    await tool(tools, 'open')({ page: 'dashboard' })
    expect(h.navigated).toEqual([`/documents/${d.id}`, `/entities?category=resource&type=note&sel=${n.id}`, '/entities', '/'])
    await expect(tool(tools, 'open')({})).rejects.toThrow()
    h.navigated.length = 0
    const v = createEntity({ type: 'video', label: 'Talk', data: { url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk' } })
    const person = createEntity({ type: 'person', label: 'Ada' })
    store.upsert(v)
    store.upsert(person)
    await tool(tools, 'open')({ id: v.id, time: 95.25 })
    await tool(tools, 'open')({ id: person.id })
    await tool(tools, 'open')({ page: 'graph/3d' })
    expect(h.navigated).toEqual([`/videos/${v.id}?t=95.3`, `/entities?category=knowledge&type=person&sel=${person.id}`, '/graph/3d'])
  })

  it('views images as image blocks and draws boxes in pixel coordinates', async () => {
    const img = createImage(store, { label: 'pic', src: 'data:image/png;base64,iVBORw0KGgo=', width: 200, height: 100 })
    const t = tools.find((x) => x.name === 'view_image') as BetaRunnableTool
    const blocks = (await t.run(t.parse({ id: img.id }))) as { type: string; source?: { type: string; media_type?: string; url?: string } }[]
    expect(blocks[0].type).toBe('text')
    expect(blocks[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } })
    const drawn = JSON.parse(await tool(tools, 'annotate_image')({ image_id: img.id, x: 150, y: 50, width: 100, height: 100, comment: 'corner' }))
    expect(drawn.box).toEqual({ x: 150, y: 50, width: 50, height: 50 })
    expect(regionAnnotationsOf(store, img.id)).toHaveLength(1)
    await expect(tool(tools, 'annotate_image')({ image_id: img.id, x: 500, y: 500, width: 10, height: 10, comment: 'off' })).rejects.toThrow('outside')
    // A remote picture is never handed on by address (handedUrl.test.ts has what happens instead).
    const remote = createImage(store, { src: 'https://x.y/a.png', url: 'https://x.y/a.png' })
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }))
    const rb = (await t.run(t.parse({ id: remote.id }))) as { type: string; source?: { type: string; url?: string } }[]
    vi.unstubAllGlobals()
    expect(rb[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'iVBORw==' })
    const doc = createDocument(store, { label: 'd' })
    await expect(t.run(t.parse({ id: doc.id }))).rejects.toThrow('not an image')
  })

  it('annotates video moments and regions', async () => {
    const v = createEntity({ type: 'video', label: 'Talk', data: { url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk' } })
    store.upsert(v)
    const r = JSON.parse(await tool(tools, 'annotate_video')({ video_id: v.id, start: 95, end: 128, comment: 'four principles' }))
    expect(r.selector).toEqual({ kind: 'time', start: 95, end: 128 })
    const b = JSON.parse(await tool(tools, 'annotate_video')({ video_id: v.id, start: 210, comment: 'diagram', region: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } }))
    expect(b.selector).toEqual({ kind: 'time', start: 210, region: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } })
    expect(timeAnnotationsOf(store, v.id)).toHaveLength(2)
    await expect(tool(tools, 'annotate_video')({ video_id: v.id, start: 1, comment: 'x', region: { x: 2, y: 2, width: 1, height: 1 } })).rejects.toThrow('outside the frame')
    const doc = createDocument(store, { label: 'd' })
    await expect(tool(tools, 'annotate_video')({ video_id: doc.id, start: 1, comment: 'x' })).rejects.toThrow('not a video')
  })

  it('reports the data model and tags', async () => {
    createDocument(store, { label: 'D', tags: ['a', 'b'] })
    store.setTagInfo('a', { color: '#fff' })
    const tags = JSON.parse(await tool(tools, 'list_tags')({}))
    expect(tags).toEqual([
      { tag: 'a', color: '#fff', count: 1 },
      { tag: 'b', count: 1 },
    ])
    const types = JSON.parse(await tool(tools, 'list_entity_types')({}))
    expect(types.types.map((t: { type: string }) => t.type)).toContain('document')

    // The Ontology's tag matrix: keys split from key:value tags, counted per type.
    store.upsertMany([createEntity({ id: 'n1', type: 'note', label: 'N1', tags: ['a', 'tier:core'] }), createEntity({ id: 'n2', type: 'note', label: 'N2', tags: ['tier:edge'] }), createEntity({ id: 'n3', type: 'note', label: 'N3' })])
    const m = JSON.parse(await tool(tools, 'list_tags')({ matrix: true }))
    expect(m.totals).toMatchObject({ entities: 4, tagged: 3 })
    const tier = m.keys.find((k: { key: string }) => k.key === 'tier')
    expect(tier).toMatchObject({ count: 2, faceted: true, values: [{ value: 'core', count: 1 }, { value: 'edge', count: 1 }] })
    const note = m.types.find((t: { type: string }) => t.type === 'note')
    expect(note).toMatchObject({ count: 3, untagged: 1, byKey: { a: 1, tier: 2 }, tags: { 'tier:core': 1, 'tier:edge': 1, a: 1 } })
    expect(m.cooccur).toContainEqual({ keys: ['a', 'tier'], count: 1 })
    expect(JSON.parse(await tool(tools, 'list_tags')({ matrix: true, min_count: 2 })).keys.map((k: { key: string }) => k.key)).toEqual(['a', 'tier'])
  })

  it('registers a PDF by URL as a document for the viewer', async () => {
    const r = JSON.parse(await tool(tools, 'create_document')({ title: 'Paper', extension: 'pdf', url: 'https://example.org/paper.pdf', open: false }))
    const e = store.get(r.id)!
    expect(e.type).toBe('document')
    expect(e.data).toMatchObject({ extension: 'pdf', sourceUrl: 'https://example.org/paper.pdf' })
    expect(e.data.content).toBeUndefined()
    await expect(tool(tools, 'create_document')({ title: 'No url', extension: 'pdf' })).rejects.toThrow(/url/)
    await expect(tool(tools, 'create_document')({ title: 'Bad', extension: 'pdf', url: 'not a url' })).rejects.toThrow(/valid URL/)
  })

  it('registers Spotify links and annotates moments and ranges', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ title: 'Song · Artist', thumbnail_url: 'https://i/x.jpg' }) })))
    try {
      const r = JSON.parse(await tool(tools, 'create_audio')({ url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc', tags: ['jazz'] }))
      expect(r).toMatchObject({ type: 'audio', label: 'Song', existed: false, spotifyType: 'track', timed: true, tags: ['jazz'] })
      expect(h.navigated).toEqual([`/audio/${r.id}`])
      const again = JSON.parse(await tool(tools, 'create_audio')({ url: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', open: false }))
      expect(again).toMatchObject({ id: r.id, existed: true })
      const a = JSON.parse(await tool(tools, 'annotate_audio')({ audio_id: r.id, start: 12.34, end: 40, comment: 'the hook' }))
      expect(a.selector).toEqual({ kind: 'time', start: 12.3, end: 40 })
      const b = JSON.parse(await tool(tools, 'annotate_audio')({ audio_id: r.id, start: 61, comment: 'key change' }))
      expect(b.selector).toEqual({ kind: 'time', start: 61 })
      expect(b.annotations).toBe(2)
      expect(audioAnnotationsOf(store, r.id).map((x) => x.annotation.data.comment)).toEqual(['the hook', 'key change'])
      const album = JSON.parse(await tool(tools, 'create_audio')({ url: 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3', open: false }))
      expect(album.timed).toBe(false)
      await expect(tool(tools, 'annotate_audio')({ audio_id: album.id, start: 1, comment: 'x' })).rejects.toThrow('no single timeline')
      await expect(tool(tools, 'create_audio')({ url: 'https://example.com/nope' })).rejects.toThrow('Spotify link')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('drives whichever player is open', async () => {
    await expect(tool(tools, 'control_playback')({ action: 'play' })).rejects.toThrow('No video or audio')
    const calls: string[] = []
    const v = createEntity({ type: 'video', label: 'Talk', data: { url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk' } })
    store.upsert(v)
    setPlayback({ videoId: v.id, currentTime: 10, playing: false })
    setPlayerHandle({ seek: (t) => calls.push(`seek:${t}`), play: () => calls.push('play'), pause: () => calls.push('pause'), capture: async () => undefined })
    setAudioPlayback({ audioId: 'm', currentTime: 3, playing: true })
    setAudioPlayerHandle({ seek: (t) => calls.push(`mseek:${t}`), play: () => calls.push('mplay'), pause: () => calls.push('mpause') })
    try {
      const r = JSON.parse(await tool(tools, 'control_playback')({ action: 'seek', time: 42, play: true }))
      expect(r).toMatchObject({ media: 'video', videoId: v.id, seekedTo: 42 })
      const m = JSON.parse(await tool(tools, 'control_playback')({ action: 'pause', media: 'audio' }))
      expect(m).toMatchObject({ media: 'audio', audioId: 'm' })
      await expect(tool(tools, 'control_playback')({ action: 'seek' })).rejects.toThrow('time')
      expect(calls).toEqual(['seek:42', 'play', 'mpause'])
    } finally {
      setPlayback(null)
      setPlayerHandle(null)
      setAudioPlayback(null)
      setAudioPlayerHandle(null)
    }
  })

  describe('graph explorer', () => {
    /** A stand-in for the mounted explorer: the same state shape, mutated directly; the slice is computed from the store like the real one. */
    function fakeExplorer(dims: 2 | 3 = 2) {
      const st: ReturnType<ExplorerHandle['getState']> = {
        filter: emptyFilter(),
        filterDirty: false,
        algorithm: 'force',
        params: { spacing: 1, iterations: 300, direction: 'TB', seed: 1 },
        layoutDirty: false,
        positions: {},
        rendering: DEFAULT_RENDERING,
        renderingDirty: false,
        selectedIds: [],
        pinned: [],
        tool: 'pan',
        pathOptions: { directed: false, weighted: false },
        hops: 0,
        labels: 'auto',
        showEdges: true,
        physics: false,
        metricsStale: false,
        metricsRunning: false,
        layoutRunning: false,
        viewBudget: { nodes: 3000, edges: 15000 },
        analysisDirty: false,
        analysisAuto: false,
        analysisOptions: { metrics: ['degree'] },
        showLegend: true,
        slides: { show: true },
        showPlacementOverlay: true,
      }
      const log: string[] = []
      let full = false
      let panel: 'filter' | 'layout' | 'style' | 'stats' | 'selection' | null = null
      let metrics: MetricsResult | undefined
      const VIEWPORT = { minX: 0, minY: 0, maxX: 1000, maxY: 500 }
      const members = () => {
        const p = st.projectId ? store.get(st.projectId) : undefined
        return isProject(p) ? projectMembers(p) : undefined
      }
      const values = () => {
        const p = st.projectId ? store.get(st.projectId) : undefined
        return makeValueContext({ scope: 'view', store, slice: slice(), metrics, selected: new Set(st.selectedIds), pinned: new Set(st.pinned), overlay: isProject(p) ? projectOverlay(p) : undefined })
      }
      const slice = () => {
        const p = st.projectId ? store.get(st.projectId) : undefined
        return applyFilter(store, new TypeRegistry(store), st.filter, { members: members(), values: makeValueContext({ scope: 'dataset', store, overlay: isProject(p) ? projectOverlay(p) : undefined }) })
      }
      const setSel = (ids: string[]) => {
        st.selectedIds = ids
        st.selectedId = ids[ids.length - 1]
      }
      const handle: ExplorerHandle & { st: typeof st; log: string[] } = {
        st,
        log,
        dims,
        getState: () => st,
        getSlice: slice,
        getTotals: () => datasetTotals(store, new TypeRegistry(store), members()),
        getLoad: () => ({ nodes: slice().nodes.length, edges: slice().edges.length }),
        isGated: () => false,
        gateReason: () => undefined,
        acceptLoad: (load) => void ((st.acceptedLoad = load), log.push('acceptLoad')),
        setViewBudget: (budget) => void ((st.viewBudget = budget), log.push('setViewBudget')),
        getDataset: () => {
          const crumbs = projectBreadcrumb(store, st.projectId)
          const m = members()
          return { source: m ? 'project' : 'workspace', label: crumbs[crumbs.length - 1].label, breadcrumb: crumbs, nodes: m ? m.size : store.entityCount(), edges: 0 }
        },
        getPipeline: () => describePipeline({ dataset: { source: 'workspace', label: 'Workspace', nodes: 0, edges: 0, breadcrumb: ['Workspace'] }, filter: st.filter, view: { nodes: slice().nodes.length, edges: slice().edges.length }, layout: { algorithm: st.algorithm, positions: Object.keys(st.positions).length, rule: st.layoutRule, dirty: st.layoutDirty }, rendering: st.rendering, analysis: { metrics, stale: st.metricsStale, running: false, auto: st.analysisAuto } }),
        getValueContext: values,
        resolve: (sel) => resolveSelector(sel, { store, registry: new TypeRegistry(store), slice: slice(), values: values(), selected: new Set(st.selectedIds), members: members() }),
        getViewport: () => VIEWPORT,
        getCamera: () => ({ kind: '2d', x: 0.5, y: 0.5, ratio: 1, angle: 0, center: { x: 500, y: 250 } }),
        setCamera: (_t, ms) => log.push(`setCamera${ms !== undefined ? `:${ms}` : ''}`),
        fitTo: (ids, opts) => log.push(`fitTo:${[...ids].length}${opts?.ms !== undefined ? `:${opts.ms}` : ''}`),
        panBy: (fx, fy) => log.push(`panBy:${fx},${fy}`),
        zoomBy: (f) => log.push(`zoomBy:${f}`),
        orbitBy: (y, p) => log.push(`orbitBy:${y.toFixed(4)},${p.toFixed(4)}`),
        getFrame: () => ({ viewport: VIEWPORT, bbox: VIEWPORT }),
        setPositions: (positions, opts) => {
          st.positions = opts?.merge === false ? { ...positions } : { ...st.positions, ...positions }
          st.layoutDirty = true
          log.push(`setPositions:${Object.keys(positions).length}`)
        },
        place: (selector, spec) => {
          const r = place(resolveSelector(selector, { store, registry: new TypeRegistry(store), slice: slice(), values: values(), selected: new Set(st.selectedIds), members: members() }).nodes, spec, values(), { viewport: VIEWPORT, bbox: VIEWPORT }, st.positions)
          st.positions = { ...st.positions, ...r.positions }
          st.layoutRule = { kind: 'placement', selector, spec }
          st.layoutDirty = true
          log.push('place')
          return r
        },
        transformPositions: (ids, op) => {
          const moved = transform(ids, st.positions, op)
          st.positions = { ...st.positions, ...moved }
          log.push('transform')
          return moved
        },
        rederiveLayout: () => {
          log.push('rederive')
          return st.layoutRule ? handle.place(st.layoutRule.selector, st.layoutRule.spec) : null
        },
        setLayoutRule: (rule) => ((st.layoutRule = rule), log.push('setLayoutRule')),
        setPlacementOverlay: (on) => ((st.showPlacementOverlay = on), log.push(`overlay:${on}`)),
        setAnalysisAuto: (on) => ((st.analysisAuto = on), log.push(`auto:${on}`)),
        loadProject: (id) => ((st.projectId = id), log.push(`project:${id}`)),
        getStyles: () => {
          const sl = slice()
          return { nodes: new Map(sl.nodes.map((n) => [n.id, { color: '#123456', size: 5, shape: 'circle' as const, opacity: 1, visible: true, label: true }])), edges: new Map(sl.edges.map((e) => [e.id, { color: '#654321', width: 1, opacity: 0.6, visible: true, arrow: true }])) }
        },
        getPositions: () => Object.fromEntries(slice().nodes.map((n, i) => [n.id, st.positions[n.id] ?? { x: i * 10, y: (i % 2) * 10 }])),
        snapshot: async () => new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' }),
        getMetrics: () => metrics,
        runMetrics: async (options) => {
          const sl = slice()
          metrics = computeMetrics(serializeSlice(sl, options.weightField), options, {}, sliceKey(sl))
          st.metricsSummary = metrics.summary
          log.push('runMetrics')
          return metrics
        },
        cancelMetrics: () => log.push('cancelMetrics'),
        loadAnalysis: (id, result) => ((metrics = result), (st.analysisId = id), (st.metricsSummary = result.summary), log.push('loadAnalysis')),
        markAnalysisSaved: (id) => ((st.analysisId = id), log.push('markAnalysisSaved')),
        clearMetrics: () => ((metrics = undefined), (st.analysisId = undefined), log.push('clearMetrics')),
        setLegend: (on) => ((st.showLegend = on), log.push(`legend:${on}`)),
        setSlides: (patch) => {
          const next = { ...st.slides, ...patch }
          if ('decks' in patch && patch.decks === undefined) delete next.decks
          if ('focus' in patch && patch.focus === undefined) delete next.focus
          st.slides = next
          log.push(`slides:${JSON.stringify(patch)}`)
        },
        removeOverlap: () => log.push('removeOverlap'),
        setSelection: (ids, mode) => (setSel(applySelect(st.selectedIds, ids, mode)), log.push(`setSelection:${mode ?? 'replace'}`)),
        selectOp: (op) => {
          const ids = selectionOp(st.selectedIds, slice(), op)
          setSel(ids)
          log.push(`selectOp:${op.op}`)
          return ids
        },
        selectEdge: (id) => ((st.selectedEdgeId = id), log.push('selectEdge')),
        setPinned: (ids) => ((st.pinned = ids), log.push('setPinned')),
        setTool: (tool) => ((st.tool = tool), log.push(`tool:${tool}`)),
        setPathOptions: (patch) => ((st.pathOptions = { ...st.pathOptions, ...patch }), log.push('pathOptions')),
        computePath: (from, to) => {
          const r = shortestPath(slice(), from, to, st.pathOptions)
          st.path = r ? { ...r, from, to, directed: !!st.pathOptions.directed, weighted: !!st.pathOptions.weighted } : undefined
          log.push('computePath')
          return st.path ?? null
        },
        clearPath: () => ((st.path = undefined), log.push('clearPath')),
        setHops: (hops) => ((st.hops = hops), log.push(`hops:${hops}`)),
        setFilter: (f) => ((st.filter = f), (st.filterDirty = !!st.filterId), log.push('setFilter')),
        loadFilter: (id, f) => ((st.filter = f), (st.filterId = id), log.push('loadFilter')),
        clearFilter: () => ((st.filter = emptyFilter()), (st.filterId = undefined), log.push('clearFilter')),
        markFilterSaved: (id) => ((st.filterId = id), (st.filterDirty = false), log.push('markFilterSaved')),
        setAlgorithm: (a) => ((st.algorithm = a), log.push(`setAlgorithm:${a}`)),
        patchParams: (p) => ((st.params = { ...st.params, ...p }), log.push('patchParams')),
        loadLayout: (id, positions, a, pinned, rule) => ((st.positions = positions), (st.layoutId = id), a && (st.algorithm = a), pinned && (st.pinned = pinned), (st.layoutRule = rule), log.push('loadLayout')),
        unloadLayout: () => ((st.positions = {}), (st.layoutId = undefined), log.push('unloadLayout')),
        markLayoutSaved: (id) => ((st.layoutId = id), log.push('markLayoutSaved')),
        runLayout: async () => void log.push('runLayout'),
        switchMode: (m) => log.push(`switchMode:${m}`),
        setRendering: (r) => ((st.rendering = r), log.push('setRendering')),
        patchRendering: (p) => ((st.rendering = { ...st.rendering, ...p }), log.push('patchRendering')),
        setRule: (scope, by, key, patch) => log.push(`setRule:${scope}/${by}/${key}:${patch ? JSON.stringify(patch) : 'null'}`),
        loadRendering: (id, r) => ((st.rendering = r), (st.renderingId = id), log.push('loadRendering')),
        clearRendering: () => ((st.rendering = DEFAULT_RENDERING), (st.renderingId = undefined), log.push('clearRendering')),
        markRenderingSaved: (id) => ((st.renderingId = id), log.push('markRenderingSaved')),
        select: (id) => (setSel(id ? [id] : []), log.push(`select:${id}`)),
        setLabels: (l) => ((st.labels = l), log.push(`labels:${l}`)),
        setShowEdges: (on) => ((st.showEdges = on), log.push(`edges:${on}`)),
        setPhysics: (on) => ((st.physics = on), log.push(`physics:${on}`)),
        fit: () => log.push('fit'),
        setFullView: (on) => ((full = on), (panel = on ? null : panel ?? 'filter'), log.push(`full:${on}`)),
        isFullView: () => full,
        setPanel: (p) => ((panel = p), log.push(`panel:${p}`)),
        setScene: (id) => ((st.sceneId = id), log.push(`scene:${id}`)),
        captureView: async () => ({ view: { camera: { kind: '2d', x: 0.5, y: 0.5, ratio: 0.8, angle: 0, center: { x: 10, y: 20 } }, labels: st.labels, showEdges: st.showEdges, selectedIds: st.selectedIds, panel: panel }, preview: 'data:image/jpeg;base64,/9j/', stats: { nodes: 3, edges: 2 } }),
        getPanel: () => panel,
      }
      return handle
    }

    afterEach(() => setExplorerHandle(null))

    it('opens the explorer when none is mounted', async () => {
      const p = tool(tools, 'graph_state')({})
      expect(h.navigated).toEqual(['/unigraph/2d'])
      setExplorerHandle(fakeExplorer())
      const r = JSON.parse(await p)
      expect(r).toMatchObject({ mode: '2d', filter: 'Everything', style: 'Default style', nodes: 0 })
      expect(r.algorithms.map((a: { id: string }) => a.id)).toContain('layered')
    })

    it('says when a view is too big for the tab’s memory, and draws it only when accepted', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      store.upsertMany(Array.from({ length: 60_000 }, (_, i) => createEntity({ id: `m${i}`, type: 'note', label: `M${i}` })))
      const perf = globalThis.performance as Performance & { memory?: unknown }
      const had = Object.getOwnPropertyDescriptor(perf, 'memory')
      // A tab with 4.4 GB to its name and 3.05 GB in use: about 30 MB of room under the ceiling, and these 60,000 nodes want about 54.
      Object.defineProperty(perf, 'memory', { value: { usedJSHeapSize: 3.05e9, jsHeapSizeLimit: 4.4e9 }, configurable: true })
      try {
        let r = JSON.parse(await tool(tools, 'graph_filter')({ clear: true }))
        expect(r).toMatchObject({ nodes: 60_000, gated: true, reason: 'memory' })
        expect(r.note).toMatch(/Too large for this tab's memory/)
        r = JSON.parse(await tool(tools, 'graph_filter')({ accept_large: true }))
        expect(r.gated).toBeUndefined()
        expect(r.warning).toMatch(/may close/)
        expect(x.log).toContain('acceptLoad')
      } finally {
        if (had) Object.defineProperty(perf, 'memory', had)
        else delete (perf as { memory?: unknown }).memory
      }
    })

    it('filters, focuses, and saves filters', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      const a = createEntity({ type: 'person', label: 'Ada', tags: ['x'] })
      const b = createEntity({ type: 'person', label: 'Bob' })
      const c = createEntity({ type: 'note', label: 'N', tags: ['x'] })
      store.upsert(a)
      store.upsert(b)
      store.upsert(c)
      store.upsert(createRelationship({ type: 'related', source: a.id, target: b.id, directed: true }))
      let r = JSON.parse(await tool(tools, 'graph_filter')({ types: ['person'] }))
      expect(r).toMatchObject({ filter: '1 type', nodes: 2 })
      r = JSON.parse(await tool(tools, 'graph_filter')({ tags: ['x'], replace: true }))
      expect(r).toMatchObject({ filter: 'tags: x', nodes: 2 })
      expect(x.st.filter.types).toEqual([])
      r = JSON.parse(await tool(tools, 'graph_select')({ id: a.id, focus: true }))
      expect(r).toMatchObject({ inView: true, filter: 'tags: x · 1 hop from 1' })
      expect(x.st.selectedId).toBe(a.id)
      await expect(tool(tools, 'graph_filter')({})).rejects.toThrow('Nothing to change')
      const saved = JSON.parse(await tool(tools, 'graph_save')({ kind: 'filter', name: 'x people' }))
      expect(saved).toMatchObject({ type: 'filter', label: 'x people', updated: false })
      expect(x.st.filterId).toBe(saved.id)
      expect(store.get(saved.id)?.data.tags).toEqual(['x'])
      r = JSON.parse(await tool(tools, 'graph_filter')({ clear: true }))
      expect(r).toMatchObject({ filter: 'Everything', nodes: 3 })
      // A described set as the roots, and everything one hop around it — without shuttling ids through the reply.
      r = JSON.parse(await tool(tools, 'graph_filter')({ replace: true, roots_match: { types: ['person'], tags: ['x'] }, depth: 1 }))
      expect(r).toMatchObject({ matchedRoots: 1, filter: '1 hop from 1', nodes: 2 })
      expect(x.st.filter.roots).toEqual([a.id])
      await expect(tool(tools, 'graph_filter')({ roots_match: { tags: ['nope'] } })).rejects.toThrow('matched nothing')
      for (let i = 0; i < 12; i++) store.upsert(createEntity({ id: `r${i}`, type: 'note', label: `R${i}`, tags: ['many'] }))
      r = JSON.parse(await tool(tools, 'graph_filter')({ replace: true, roots_match: { tags: ['many'] } }))
      expect(r.matchedRoots).toBe(12)
      expect(r.spec.roots).toHaveLength(6)
      expect(r.spec.roots[5]).toBe('… +7 more (12 in all)')
      r = JSON.parse(await tool(tools, 'graph_filter')({ filter_id: saved.id }))
      expect(r).toMatchObject({ loaded: 'x people', nodes: 1 })
      const state = JSON.parse(await tool(tools, 'graph_state')({}))
      expect(state.saved.filters).toEqual([{ id: saved.id, label: 'x people', updatedAt: expect.any(String) }])
      // The filter panel's "x of y": what is in view beside the project's totals before the filter.
      expect(state.projectNodesByType).toMatchObject({ person: 2, note: 13 })
      expect(Object.values(state.nodesByType as Record<string, number>).reduce((a, n) => a + n, 0)).toBe(1)
      // The brief reply carries the essentials and counts, not the catalogues; `include` adds named sections back.
      const short = JSON.parse(await tool(tools, 'graph_state')({ brief: true }))
      expect(short.filterId).toBe(saved.id)
      expect(short.savedCounts).toMatchObject({ filters: 1 })
      expect(short.saved).toBeUndefined()
      expect(short.palettes).toBeUndefined()
      expect(short.rendering).toBeUndefined()
      expect(JSON.stringify(short).length).toBeLessThan(JSON.stringify(state).length / 3)
      const some = JSON.parse(await tool(tools, 'graph_state')({ brief: true, include: ['saved', 'rendering'] }))
      expect(some.saved.filters).toHaveLength(1)
      expect(some.rendering.precedence).toBeDefined()
      expect(some.palettes).toBeUndefined()
      await expect(tool(tools, 'graph_filter')({ filter_id: a.id })).rejects.toThrow('not a saved filter')
    })

    it('refuses a layout that does not scale past its size limit, and says what does', async () => {
      for (let i = 0; i < 301; i++) store.upsert(createEntity({ id: `big-${i}`, type: 'note', label: `n${i}` }))
      const x = fakeExplorer()
      setExplorerHandle(x)
      await expect(tool(tools, 'graph_layout')({ algorithm: 'layered' })).rejects.toThrow(/lays out at most 300 nodes.*Force \(Unigraph\) or Multilevel/)
      expect(x.log).not.toContain('setAlgorithm:layered')
      // One that scales is fine at any size.
      expect(JSON.parse(await tool(tools, 'graph_layout')({ algorithm: 'multilevel' }))).toMatchObject({ algorithm: 'multilevel' })
    })

    it('changes layouts and saves held positions', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      let r = JSON.parse(await tool(tools, 'graph_layout')({ algorithm: 'grid', spacing: 2 }))
      expect(r).toMatchObject({ algorithm: 'grid', recomputed: true, params: { spacing: 2 } })
      expect(x.log).toEqual(['setAlgorithm:grid', 'patchParams', 'runLayout'])
      await expect(tool(tools, 'graph_layout')({ algorithm: 'sphere' })).rejects.toThrow('3D only')
      // The engine's physics runs over any layout.
      expect(JSON.parse(await tool(tools, 'graph_layout')({ physics: true })).physics).toBe(true)
      x.st.positions = { a: { x: 1, y: 2 } }
      const saved = JSON.parse(await tool(tools, 'graph_save')({ kind: 'layout', name: 'grid one' }))
      expect(saved).toMatchObject({ type: 'layout', positions: 1 })
      expect(store.get(saved.id)?.data).toMatchObject({ algorithm: 'grid', dimensions: 2 })
      x.st.positions = { b: { x: 3, y: 4 } }
      const updated = JSON.parse(await tool(tools, 'graph_save')({ kind: 'layout', update: true }))
      expect(updated).toMatchObject({ id: saved.id, updated: true, positions: 2 })
      await tool(tools, 'graph_layout')({ unload: true })
      r = JSON.parse(await tool(tools, 'graph_layout')({ layout_id: saved.id, fit: false }))
      expect(r).toMatchObject({ loaded: 'grid one', recomputed: false })
      expect(Object.keys(x.st.positions)).toEqual(['a', 'b'])
      await expect(tool(tools, 'graph_save')({ kind: 'style', update: true })).rejects.toThrow('No saved style')
    })

    it('switches renderers in place when an explorer is open, by navigating when none is', async () => {
      const two = fakeExplorer(2)
      setExplorerHandle(two)
      const p = tool(tools, 'graph_layout')({ mode: '3d', algorithm: 'sphere' })
      expect(two.log).toContain('switchMode:3d')
      expect(h.navigated).toEqual([])
      setExplorerHandle(fakeExplorer(3))
      expect(JSON.parse(await p)).toMatchObject({ mode: '3d', algorithm: 'sphere' })
      setExplorerHandle(null)
      const q = tool(tools, 'graph_state')({})
      expect(h.navigated).toEqual(['/unigraph/2d'])
      setExplorerHandle(fakeExplorer(2))
      await q
    })

    it('turns the 3D camera around what it looks at, and says a 2D view has none to turn', async () => {
      const three = fakeExplorer(3)
      setExplorerHandle(three)
      await tool(tools, 'graph_viewport')({ action: 'orbit', yaw: 90, pitch: -45 })
      expect(three.log).toContain(`orbitBy:${(Math.PI / 2).toFixed(4)},${(-Math.PI / 4).toFixed(4)}`)
      await expect(tool(tools, 'graph_viewport')({ action: 'orbit' })).rejects.toThrow('orbit needs yaw')
      setExplorerHandle(fakeExplorer(2))
      await expect(tool(tools, 'graph_viewport')({ action: 'orbit', yaw: 10 })).rejects.toThrow('this view is 2D')
    })

    it('switches the 3D camera between orbit and fly controls, and flies and looks with either on', async () => {
      const three = fakeExplorer(3)
      // A camera at z = 1000 looking at the origin; the graph's positions give its size.
      let cam = { position: { x: 0, y: 0, z: 1000 }, lookAt: { x: 0, y: 0, z: 0 } }
      three.getCamera = () => ({ kind: '3d', ...cam })
      three.setCamera = (t) => void (cam = t as typeof cam)
      three.getPositions = () => ({ a: { x: 0, y: 0, z: 0 }, b: { x: 400, y: 0, z: 0 } })
      setExplorerHandle(three)
      expect(JSON.parse(await tool(tools, 'graph_viewport')({})).controls).toBe('orbit')
      expect(JSON.parse(await tool(tools, 'graph_viewport')({ controls: 'fly' })).controls).toBe('fly')
      expect(getCameraControls()).toBe('fly')
      // Forward by the graph's whole size (400), through the origin and past it; the look-at point moves with it.
      await tool(tools, 'graph_viewport')({ action: 'fly', move: { forward: 1 } })
      expect(cam.position.z).toBeCloseTo(600)
      expect(cam.lookAt.z).toBeCloseTo(-400)
      await tool(tools, 'graph_viewport')({ action: 'fly', move: { forward: 4 } })
      expect(cam.position.z).toBeLessThan(0)
      // Half a turn: the camera stays put and now looks back toward +z.
      const before = { ...cam.position }
      await tool(tools, 'graph_viewport')({ action: 'look', yaw: 180 })
      expect(cam.position).toEqual(before)
      expect(cam.lookAt.z).toBeGreaterThan(cam.position.z)
      await expect(tool(tools, 'graph_viewport')({ action: 'fly' })).rejects.toThrow('fly needs move')
      await expect(tool(tools, 'graph_viewport')({ action: 'look' })).rejects.toThrow('look needs yaw')
      await tool(tools, 'graph_viewport')({ controls: 'orbit' })
      expect(getCameraControls()).toBe('orbit')
      setExplorerHandle(fakeExplorer(2))
      await expect(tool(tools, 'graph_viewport')({ action: 'fly', move: { forward: 1 } })).rejects.toThrow('this view is 2D')
    })

    it('sets, loads, and saves styles', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      const r = JSON.parse(
        await tool(tools, 'graph_style')({
          rules: [
            { scope: 'nodes', by: 'types', key: 'person', color: '#f00', shape: 'diamond' },
            { scope: 'edges', by: 'types', key: 'related', width: 2, arrow: false },
          ],
          precedence: 'tag',
          channels: [{ scope: 'nodes', by: 'all', channel: 'size', mode: 'constant', value: 6 }],
          labels: 'all',
          show_edges: false,
        }),
      )
      expect(r.style).toBe('uniform size · 1 node type rule · 1 edge type rule')
      expect(r.rules.nodes.types.person).toEqual({ color: { mode: 'constant', value: '#f00' }, shape: { mode: 'constant', value: 'diamond' } })
      expect(r.defaults.nodes.size).toEqual({ mode: 'constant', value: 6 })
      expect(x.log).toEqual(['setRule:nodes/types/person:{"color":{"mode":"constant","value":"#f00"},"shape":{"mode":"constant","value":"diamond"}}', 'setRule:edges/types/related:{"width":{"mode":"constant","value":2},"arrow":false}', 'patchRendering', 'labels:all', 'edges:false'])
      await expect(tool(tools, 'graph_style')({ rules: [{ scope: 'nodes', by: 'tags', key: 'x' }] })).rejects.toThrow('sets nothing')
      await expect(tool(tools, 'graph_style')({ channels: [{ scope: 'nodes', by: 'all', channel: 'size', mode: 'ranking', attr: { kind: 'field' } }] })).rejects.toThrow('needs key')
      await expect(tool(tools, 'graph_style')({ channels: [{ scope: 'nodes', by: 'all', channel: 'size', mode: 'ranking', attr: { kind: 'type' } }] })).rejects.toThrow('categorical')
      // A per-type override, then inherit again.
      const over = JSON.parse(await tool(tools, 'graph_style')({ channels: [{ scope: 'nodes', by: 'types', key: 'person', channel: 'opacity', mode: 'ranking', attr: { kind: 'degree', dir: 'in' }, min: 0.3, max: 1 }] }))
      expect(over.rules.nodes.types.person.opacity).toEqual({ mode: 'ranking', attr: { kind: 'degree', dir: 'in' }, min: 0.3, max: 1 })
      const back = JSON.parse(await tool(tools, 'graph_style')({ channels: [{ scope: 'nodes', by: 'types', key: 'person', channel: 'opacity', mode: 'inherit' }] }))
      expect(back.rules.nodes.types.person.opacity).toBeUndefined()
      x.st.rendering = { ...DEFAULT_RENDERING, precedence: 'tag' }
      const saved = JSON.parse(await tool(tools, 'graph_save')({ kind: 'style', name: 'tags first' }))
      expect(store.get(saved.id)?.type).toBe('rendering')
      await tool(tools, 'graph_style')({ reset: true })
      const loaded = JSON.parse(await tool(tools, 'graph_style')({ rendering_id: saved.id, rules: [{ scope: 'nodes', by: 'tags', key: 'x', remove: true }] }))
      expect(loaded).toMatchObject({ loaded: 'tags first', precedence: 'tag' })
      expect(x.log.at(-1)).toBe('setRule:nodes/tags/x:null')
    })

    it('counts the entities into a dataset, charts the dataset, and colours the graph by it', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      for (let i = 0; i < 3; i++) store.upsert(createEntity({ type: 'person', label: `P${i}` }))
      store.upsert(createEntity({ type: 'org', label: 'Acme' }))
      // 1. "a dataset of entities to their counts in this project"
      const counts = JSON.parse(await tool(tools, 'dataset')({ action: 'from_entities', group_by: 'type', name: 'Entity counts', open: false }))
      expect(counts.columns.map((c: { key: string }) => c.key)).toEqual(['type', 'label', 'count'])
      const rows = JSON.parse(await tool(tools, 'dataset')({ action: 'get', id: counts.id, records: true })).rows
      expect(rows).toEqual(expect.arrayContaining([{ type: 'person', label: expect.any(String), count: 3 }, { type: 'org', label: expect.any(String), count: 1 }]))
      // 2. "a chart of entities to their counts using this dataset"
      const chart = JSON.parse(await tool(tools, 'plot')({ action: 'save', name: 'Counts', open: false, spec: { dataset: counts.id, traces: [{ kind: 'bar', x: 'type', y: 'count' }] } }))
      expect(chart.stats.rows).toBe(rows.length)
      expect((store.get(chart.id)?.data as { spec: { dataset?: string } }).spec.dataset).toBe(counts.id)
      // 3. "Unigraph showing entities colour coded by their count"
      const styled = JSON.parse(await tool(tools, 'graph_style')({ channels: [{ scope: 'nodes', by: 'all', channel: 'color', mode: 'ranking', attr: { kind: 'value', ref: `dataset:${counts.id}.count` }, palette: 'viridis' }] }))
      expect(styled.defaults.nodes.color).toEqual({ mode: 'ranking', attr: { kind: 'value', ref: `dataset:${counts.id}.count` }, palette: 'viridis' })
    })

    it('manages the selection and acts on it', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      const a = createEntity({ type: 'person', label: 'Ada', tags: ['x'] })
      const b = createEntity({ type: 'person', label: 'Bob' })
      const c = createEntity({ type: 'note', label: 'N' })
      const d = createEntity({ type: 'note', label: 'Far' })
      store.upsert(a)
      store.upsert(b)
      store.upsert(c)
      store.upsert(d)
      store.upsert(createRelationship({ type: 'related', source: a.id, target: b.id, directed: true }))
      store.upsert(createRelationship({ type: 'related', source: b.id, target: c.id, directed: true }))
      let r = JSON.parse(await tool(tools, 'graph_selection')({ action: 'set', ids: [a.id, 'nope'] }).catch((e: Error) => JSON.stringify({ err: e.message })))
      expect(r.err).toContain('No entity')
      r = JSON.parse(await tool(tools, 'graph_selection')({ action: 'set', ids: [a.id] }))
      expect(r).toMatchObject({ count: 1, primary: a.id })
      r = JSON.parse(await tool(tools, 'graph_selection')({ action: 'neighbours' }))
      expect(r.ids.sort()).toEqual([a.id, b.id].sort())
      r = JSON.parse(await tool(tools, 'graph_selection')({ action: 'by_type' }))
      expect(r.count).toBe(2)
      r = JSON.parse(await tool(tools, 'graph_selection')({ action: 'invert' }))
      expect(r.ids.sort()).toEqual([c.id, d.id].sort())
      r = JSON.parse(await tool(tools, 'graph_selection')({ action: 'toggle', ids: [d.id, a.id] }))
      expect(r.ids.sort()).toEqual([a.id, c.id].sort())
      // Actions
      r = JSON.parse(await tool(tools, 'graph_selection_action')({ action: 'tag', tags: ['seen'] }))
      expect(r).toMatchObject({ affected: 2 })
      expect(store.get(a.id)?.tags).toEqual(['x', 'seen'])
      r = JSON.parse(await tool(tools, 'graph_selection_action')({ action: 'untag', tags: ['seen'], ids: [a.id] }))
      expect(store.get(a.id)?.tags).toEqual(['x'])
      r = JSON.parse(await tool(tools, 'graph_selection_action')({ action: 'pin' }))
      expect(x.st.pinned.sort()).toEqual([a.id, c.id].sort())
      r = JSON.parse(await tool(tools, 'graph_selection_action')({ action: 'hide', ids: [d.id] }))
      expect(x.st.filter.exclude).toEqual([d.id])
      expect(x.getSlice().nodes.map((n) => n.id)).not.toContain(d.id)
      r = JSON.parse(await tool(tools, 'graph_selection_action')({ action: 'unhide' }))
      expect(x.st.filter.exclude).toEqual([])
      r = JSON.parse(await tool(tools, 'graph_selection_action')({ action: 'export', ids: [a.id, b.id] }))
      expect(r.document.entities).toHaveLength(3)
      r = JSON.parse(await tool(tools, 'graph_selection_action')({ action: 'focus', ids: [a.id], depth: 2 }))
      expect(r).toMatchObject({ nodes: 3 })
      h.confirmations.length = 0
      const declined = await tool(tools, 'graph_selection_action')({ action: 'delete', ids: [d.id] })
      expect(h.confirmations).toHaveLength(1)
      expect(declined).toContain('deleted')
      expect(store.get(d.id)).toBeUndefined()
      await tool(tools, 'graph_selection')({ action: 'clear' })
      await expect(tool(tools, 'graph_selection_action')({ action: 'tag', tags: ['x'] })).rejects.toThrow('Nothing is selected')
    })

    it('finds shortest paths in the view', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      const ids = ['a', 'b', 'c', 'd'].map((l) => {
        const e = createEntity({ type: 'person', label: l })
        store.upsert(e)
        return e.id
      })
      store.upsert(createRelationship({ type: 'r', source: ids[0], target: ids[1], directed: true }))
      store.upsert(createRelationship({ type: 'r', source: ids[1], target: ids[2], directed: true }))
      store.upsert(createRelationship({ type: 'r', source: ids[2], target: ids[3], directed: true, data: { weight: 10 } }))
      store.upsert(createRelationship({ type: 'r', source: ids[3], target: ids[0], directed: true, data: { weight: 1 } }))
      let r = JSON.parse(await tool(tools, 'graph_path')({ from: ids[0], to: ids[3] }))
      expect(r).toMatchObject({ found: true, length: 1 })
      r = JSON.parse(await tool(tools, 'graph_path')({ from: ids[0], to: ids[3], directed: true }))
      expect(r).toMatchObject({ found: true, length: 3 })
      r = JSON.parse(await tool(tools, 'graph_path')({ from: ids[0], to: ids[3], directed: true, weighted: true, select: true }))
      expect(r.weight).toBe(12)
      expect(x.st.selectedIds).toHaveLength(4)
      expect(x.st.path?.length).toBe(3)
      const lone = createEntity({ type: 'person', label: 'lone' })
      store.upsert(lone)
      r = JSON.parse(await tool(tools, 'graph_path')({ from: ids[0], to: lone.id }))
      expect(r.found).toBe(false)
    })

    it('applies structural filters and layout extras', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      const ids = ['a', 'b', 'c', 'd'].map((l, i) => {
        const e = createEntity({ type: 'person', label: l, data: { year: 1900 + i * 10 } })
        store.upsert(e)
        return e.id
      })
      store.upsert(createRelationship({ type: 'r', source: ids[0], target: ids[1] }))
      store.upsert(createRelationship({ type: 'r', source: ids[1], target: ids[2] }))
      store.upsert(createRelationship({ type: 'r', source: ids[2], target: ids[0] }))
      let r = JSON.parse(await tool(tools, 'graph_filter')({ k_core: 2 }))
      expect(r).toMatchObject({ filter: '2-core', nodes: 3 })
      r = JSON.parse(await tool(tools, 'graph_filter')({ replace: true, fields: [{ path: 'data.year', op: 'gte', value: 1910 }] }))
      expect(r).toMatchObject({ nodes: 3 })
      expect(r.filter).toBe('data.year ≥ 1910')
      r = JSON.parse(await tool(tools, 'graph_filter')({ replace: true, giant_only: true }))
      expect(r).toMatchObject({ nodes: 3, components: 1 })
      r = JSON.parse(await tool(tools, 'graph_layout')({ algorithm: 'circlepack', pin: [ids[0]], noverlap: true }))
      expect(r).toMatchObject({ algorithm: 'circlepack', pinned: [ids[0]], recomputed: true })
      expect(x.st.params.noverlap).toBe(true)
      r = JSON.parse(await tool(tools, 'graph_layout')({ remove_overlap: true, unpin_all: true, recompute: false }))
      expect(r).toMatchObject({ overlapRemoved: true, pinned: [] })
      expect(x.log.at(-1)).toBe('removeOverlap')
      await expect(tool(tools, 'graph_layout')({ center_id: 'nope' })).rejects.toThrow('No entity')
      const state = JSON.parse(await tool(tools, 'graph_state')({}))
      expect(state.selection).toMatchObject({ count: 0 })
      expect(state.algorithms.map((a: { id: string }) => a.id)).toContain('circlepack')
    })

    it('computes metrics, maps appearance to them, and saves analyses', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      // Two triangles joined by one edge, plus an isolated node.
      const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'z'].map((l) => {
        const e = createEntity({ type: 'person', label: l })
        store.upsert(e)
        return e.id
      })
      const link = (i: number, j: number) => store.upsert(createRelationship({ type: 'r', source: ids[i], target: ids[j], directed: true }))
      link(0, 1), link(1, 2), link(2, 0), link(3, 4), link(4, 5), link(5, 3), link(2, 3)
      await expect(tool(tools, 'graph_style')({ channels: [{ scope: 'nodes', by: 'all', channel: 'color', mode: 'ranking', attr: { kind: 'metric', key: 'pagerank' } }] })).rejects.toThrow('graph_metrics first')
      const r = JSON.parse(await tool(tools, 'graph_metrics')({ metrics: ['degree', 'pagerank', 'betweenness', 'community', 'clustering', 'component'], top_k: 3 }))
      expect(r.summary).toMatchObject({ nodes: 7, edges: 7, componentCount: 2, giantComponentSize: 6, communityCount: 3 })
      expect(r.summary.modularity).toBeGreaterThan(0.2)
      expect(r.metrics.betweenness.top[0].id).toMatch(/^(.*)$/)
      const bridge = new Set([ids[2], ids[3]])
      expect(bridge.has(r.metrics.betweenness.top[0].id)).toBe(true)
      expect(r.metrics.clustering.max).toBe(1)
      expect(r.metrics.community.groups).toBe(3)
      const styled = JSON.parse(
        await tool(tools, 'graph_style')({
          channels: [
            { scope: 'nodes', by: 'all', channel: 'color', mode: 'partition', attr: { kind: 'metric', key: 'community' } },
            { scope: 'nodes', by: 'all', channel: 'size', mode: 'ranking', attr: { kind: 'metric', key: 'pagerank' } },
          ],
          legend: true,
        }),
      )
      expect(styled.defaults.nodes.color).toMatchObject({ mode: 'partition', attr: { kind: 'metric', key: 'community' }, palette: 'tableau10' })
      expect(styled.defaults.nodes.size).toMatchObject({ mode: 'ranking', attr: { kind: 'metric', key: 'pagerank' }, min: 3, max: 14 })
      expect(styled.style).toContain('colour by community')
      const w = JSON.parse(await tool(tools, 'graph_metrics')({ metrics: ['pagerank'], write_to_entities: true, prefix: 'm_', save_as: 'ranks' }))
      expect(w.wrote).toBe(7)
      expect(typeof store.get(ids[0])?.data.m_pagerank).toBe('number')
      expect(store.get(w.saved.id)?.type).toBe('analysis')
      const state = JSON.parse(await tool(tools, 'graph_state')({}))
      expect(state.metrics.columns).toEqual(['pagerank'])
      expect(state.saved.analyses).toHaveLength(1)
      const loaded = JSON.parse(await tool(tools, 'graph_metrics')({ analysis_id: w.saved.id }))
      expect(loaded.loaded).toBe('ranks')
      const saved = JSON.parse(await tool(tools, 'graph_save')({ kind: 'analysis', name: 'again' }))
      expect(saved).toMatchObject({ type: 'analysis', label: 'again' })
      await expect(tool(tools, 'graph_style')({ channels: [{ scope: 'edges', by: 'all', channel: 'size', mode: 'constant', value: 3 }] })).rejects.toThrow('node channel')
      const ec = JSON.parse(
        await tool(tools, 'graph_style')({
          channels: [
            { scope: 'edges', by: 'all', channel: 'width', mode: 'ranking', attr: { kind: 'field', key: 'weight' }, min: 1, max: 5 },
            { scope: 'edges', by: 'all', channel: 'color', mode: 'partition', attr: { kind: 'type' } },
          ],
          edge_labels: true,
          curved_edges: false,
        }),
      )
      expect(ec.defaults.edges.width).toMatchObject({ mode: 'ranking', attr: { kind: 'field', key: 'weight' }, min: 1, max: 5 })
      expect(ec.defaults.edges.color).toMatchObject({ mode: 'partition', attr: { kind: 'type' }, palette: 'tableau10' })
      expect(ec.edgeLabels).toBe(true)
    })

    it('exports the view and imports graphs', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      const a = createEntity({ type: 'person', label: 'Ada', data: { year: 1900 } })
      const b = createEntity({ type: 'person', label: 'Bob' })
      store.upsert(a)
      store.upsert(b)
      store.upsert(createRelationship({ type: 'knows', source: a.id, target: b.id, directed: true }))
      const t = tools.find((z) => z.name === 'graph_export') as BetaRunnableTool
      const png = (await t.run(t.parse({ format: 'png' }))) as { type: string; source?: { data: string } }[]
      expect(png[1].type).toBe('image')
      expect(png[1].source?.data.startsWith('iVBORw')).toBe(true)
      const svg = (await t.run(t.parse({ format: 'svg', labels: 'all' }))) as { type: string; text: string }[]
      expect(svg[1].text).toContain('<svg')
      expect(svg[1].text).toContain('Ada')
      const cy = (await t.run(t.parse({ format: 'cyjs', scope: 'workspace' }))) as { type: string; text: string }[]
      expect(JSON.parse(cy[0].text)).toMatchObject({ scope: 'workspace', nodes: 2, edges: 1, delivered: 'inline' })
      const doc = JSON.parse(cy[1].text.replace(/^--- .* ---\n/, ''))
      expect(doc.elements.nodes).toHaveLength(2)
      await expect(tool(tools, 'graph_export')({ format: 'png', scope: 'workspace' })).rejects.toThrow('view')
      // As a diagram: clusters by type, labelled edges, the entity ids as node ids, and optionally kept as a diagram entity.
      const dot = (await t.run(t.parse({ format: 'dot', scope: 'workspace' }))) as { type: string; text: string }[]
      expect(JSON.parse(dot[0].text)).toMatchObject({ format: 'dot', nodes: 2, edges: 1, files: ['workspace.dot'] })
      expect(dot[1].text).toContain('subgraph cluster_person')
      expect(dot[1].text).toContain(`"${a.id}"`)
      expect(dot[1].text).toMatch(/label=knows|label="knows"/)
      const mmd = (await t.run(t.parse({ format: 'mermaid', scope: 'workspace', save_as: 'People as a diagram' }))) as { type: string; text: string }[]
      const head = JSON.parse(mmd[0].text)
      expect(head.files).toEqual(['workspace.mmd'])
      expect(head.saved.label).toBe('People as a diagram')
      const kept = store.get(head.saved.id)!
      expect(kept.type).toBe('diagram')
      expect(kept.data.format).toBe('mermaid')
      expect(String(kept.data.source)).toContain('Ada')
      store.remove([kept.id])
      // Import a cyjs document: dry run first, then for real, then re-import updates in place.
      const text = JSON.stringify({ elements: { nodes: [{ data: { id: 'n1', name: 'Node one', category: 'Concept' }, position: { x: 1, y: 2 } }, { data: { id: 'n2', name: 'Node two' } }], edges: [{ data: { id: 'e', source: 'n1', target: 'n2', type: 'refers to' } }] } })
      const dry = JSON.parse(await tool(tools, 'import_graph')({ format: 'cyjs', text, name: 'mini', dry_run: true }))
      expect(dry).toMatchObject({ dryRun: true, created: 2, relationships: 1, mapping: { typeAttr: 'category', edgeTypeAttr: 'type' } })
      expect(store.entityCount()).toBe(2)
      const real = JSON.parse(await tool(tools, 'import_graph')({ format: 'cyjs', text, name: 'mini', tags: ['imported'] }))
      expect(real.created).toBe(2)
      expect(real.layout).toBeDefined()
      const imported = store.query({ kind: 'entity', tags: ['imported'] })
      expect(imported.map((e) => e.type).sort()).toEqual(['concept', 'node'])
      const again = JSON.parse(await tool(tools, 'import_graph')({ format: 'cyjs', text, name: 'mini' }))
      expect(again).toMatchObject({ created: 0, updated: 2 })
      await expect(tool(tools, 'import_graph')({ format: 'cyjs', text: 'x'.repeat(2_000_001) })).rejects.toThrow('2 MB')
      // Node-link JSON (d3's Les Misérables shape: nodes named, links by index), named or recognised in plain json.
      const mis = JSON.stringify({ nodes: [{ name: 'Myriel', group: 1 }, { name: 'Napoleon', group: 1 }, { name: 'Valjean', group: 2 }], links: [{ source: 1, target: 0, value: 1 }, { source: 2, target: 0, value: 5 }] })
      const nl = JSON.parse(await tool(tools, 'import_graph')({ format: 'node_link_json', text: mis, name: 'miserables', mapping: { fixed_type: 'character' }, tags: ['lesmis'] }))
      expect(nl).toMatchObject({ created: 3, relationships: 2 })
      const chars = store.query({ kind: 'entity', tags: ['lesmis'] })
      expect(chars.map((e) => e.label).sort()).toEqual(['Myriel', 'Napoleon', 'Valjean'])
      // A numeric `group` is a community to colour by, not a type called "2".
      expect(chars.map((e) => e.type)).toEqual(['character', 'character', 'character'])
      expect(chars.find((e) => e.label === 'Valjean')?.data.group).toBe(2)
      const asJson = JSON.parse(await tool(tools, 'import_graph')({ format: 'json', text: mis, name: 'miserables', mapping: { fixed_type: 'character' } }))
      expect(asJson).toMatchObject({ created: 0, updated: 3 })
    })

    it('queries values, places nodes in the viewport, transforms them, and re-derives', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      const docs = ['d1', 'd2', 'd3'].map((id, i) => {
        const e = createEntity({ id, type: 'document', label: id, data: { year: 2000 + i }, meta: { updatedAt: `202${i}-01-01T00:00:00.000Z` } })
        store.upsert(e)
        return e
      })
      store.upsert(createEntity({ id: 'p', type: 'person', label: 'Ada' }))
      store.upsert(createRelationship({ type: 'cites', source: 'd2', target: 'd1', directed: true }))
      store.upsert(createRelationship({ type: 'cites', source: 'd3', target: 'd1', directed: true }))
      store.upsert(createRelationship({ type: 'references', source: 'd1', target: 'p', directed: true }))
      const q = JSON.parse(await tool(tools, 'graph_query')({ selector: { types: ['document'], sort: 'degree.in:cites', desc: true }, values: ['degree.in:cites', 'meta.updatedAt', 'data.year'] }))
      expect(q.count).toBe(3)
      expect(q.rows[0]).toMatchObject({ id: 'd1', values: { 'degree.in:cites': 2, 'data.year': 2000 } })
      await expect(tool(tools, 'graph_query')({ selector: {}, values: ['nope.x'] })).rejects.toThrow('Unknown value ref')
      const placed = JSON.parse(
        await tool(tools, 'graph_positions')({ action: 'place', selector: { types: ['document'] }, spec: { arrangement: 'scatter', x: 'degree.in:cites', y: 'data.year', bins: { x: 4, y: 4 }, region: { of: 'viewport', anchor: 'top-left', fraction: 0.5 } } }),
      )
      expect(placed).toMatchObject({ placed: 3, unplaced: 0, region: { minX: 0, minY: 250, maxX: 500, maxY: 500 } })
      expect(placed.rule).toContain('scatter')
      expect(x.st.layoutRule?.spec.arrangement).toBe('scatter')
      expect(x.st.positions.d1.x).toBeGreaterThan(x.st.positions.d2.x) // more citations → further right
      expect(x.st.positions.d1.y).toBeLessThan(x.st.positions.d3.y) // older → lower
      const got = JSON.parse(await tool(tools, 'graph_positions')({ action: 'get', ids: ['d1'] }))
      expect(got.positions.d1).toEqual(x.st.positions.d1)
      expect(got.viewport).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 500 })
      const before = { ...x.st.positions.d1 }
      const moved = JSON.parse(await tool(tools, 'graph_positions')({ action: 'transform', selector: { types: ['document'] }, transform: { translate: { dx: 100, dy: 0 } } }))
      expect(moved.moved).toBe(3)
      expect(x.st.positions.d1.x).toBe(before.x + 100)
      const set = JSON.parse(await tool(tools, 'graph_positions')({ action: 'set', positions: { p: { x: 1, y: 2, z: 3 } }, save_as: 'manual' }))
      expect(x.st.positions.p).toEqual({ x: 1, y: 2, z: 3 })
      expect(store.get(set.saved.id)?.type).toBe('layout')
      expect((store.get(set.saved.id)?.data as { rule?: unknown }).rule).toBeDefined()
      // Editing data and re-deriving moves the node.
      store.update('d2', { data: { ...docs[1].data, year: 2050 } })
      const re = JSON.parse(await tool(tools, 'graph_layout')({ rederive: true, recompute: false, fit: false }))
      expect(re.rederived).toEqual({ placed: 3, unplaced: 0 })
      expect(x.st.positions.d2.y).toBeGreaterThan(x.st.positions.d3.y)
      await expect(tool(tools, 'graph_positions')({ action: 'place', selector: { types: ['ghost'] }, spec: { arrangement: 'grid' } })).rejects.toThrow('matched nothing')
      // `ms` is the flight's time, handed to the renderer; omitted, the renderer chooses it and the tool waits out the longest.
      const vp = JSON.parse(await tool(tools, 'graph_viewport')({ action: 'fit', selector: { types: ['document'] }, ms: 0 }))
      expect(vp.fitted).toBe(3)
      expect(x.log).toContain('fitTo:3:0')
      await tool(tools, 'graph_viewport')({ action: 'set', camera: { center: { x: 1, y: 2 } }, ms: 10 })
      expect(x.log).toContain('setCamera:10')
      // The arrow keys' move: a slide by fractions of the view, x right and y up.
      await tool(tools, 'graph_viewport')({ action: 'pan', by: { x: 0.25, y: -0.5 } })
      expect(x.log).toContain('panBy:0.25,-0.5')
      await expect(tool(tools, 'graph_viewport')({ action: 'pan' })).rejects.toThrow('pan needs by')
      // Q and E's move: a zoom about the centre.
      await tool(tools, 'graph_viewport')({ action: 'zoom', factor: 2 })
      expect(x.log).toContain('zoomBy:2')
      // Full view folds the side panel away and the same call brings it back; `get` reports where it stands.
      expect(JSON.parse(await tool(tools, 'graph_viewport')({ full: true })).full).toBe(true)
      expect(x.log).toContain('full:true')
      expect(JSON.parse(await tool(tools, 'graph_viewport')({ full: false })).full).toBe(false)
      // The side panel: open one by name (the toolbar's buttons), "none" closes it; `get` says which is open.
      expect(JSON.parse(await tool(tools, 'graph_viewport')({ panel: 'style' })).panel).toBe('style')
      expect(x.log).toContain('panel:style')
      expect(JSON.parse(await tool(tools, 'graph_viewport')({ panel: 'none' })).panel).toBeNull()
      expect(JSON.parse(await tool(tools, 'graph_viewport')({})).panel).toBeNull()
      const styled = JSON.parse(await tool(tools, 'graph_style')({ channels: [{ scope: 'nodes', by: 'types', key: 'document', channel: 'color', mode: 'ranking', attr: { kind: 'value', ref: 'meta.updatedAt' }, palette: 'viridis' }] }))
      expect(styled.style).toContain('node type rule')
      await expect(tool(tools, 'graph_style')({ channels: [{ scope: 'nodes', by: 'all', channel: 'size', mode: 'ranking', attr: { kind: 'value', ref: 'metric.pagerank' } }] })).rejects.toThrow('graph_metrics first')
      await expect(tool(tools, 'graph_filter')({ fields: [{ path: 'metric.pagerank', op: 'gt', value: 0 }] })).rejects.toThrow('runs before the analysis')
      await expect(tool(tools, 'graph_filter')({ fields: [{ path: 'selected', op: 'eq', value: 1 }] })).rejects.toThrow('cannot be used in a filter')
      const f = JSON.parse(await tool(tools, 'graph_filter')({ fields: [{ path: 'degree.in:cites', op: 'gte', value: 1 }] }))
      expect(f.nodes).toBe(1)
    })

    it('exports projects and iterates on them', async () => {
      const x = fakeExplorer()
      setExplorerHandle(x)
      const ids = ['a', 'b', 'c', 'z'].map((id) => {
        store.upsert(createEntity({ id, type: 'person', label: id }))
        return id
      })
      store.upsert(createRelationship({ type: 'r', source: ids[0], target: ids[1] }))
      store.upsert(createRelationship({ type: 'r', source: ids[1], target: ids[2] }))
      store.upsert(createRelationship({ type: 'r', source: ids[2], target: ids[0] }))
      await tool(tools, 'graph_metrics')({ metrics: ['pagerank', 'degree'] })
      const exported = JSON.parse(await tool(tools, 'graph_project')({ action: 'export', name: 'Ranked' }))
      expect(exported).toMatchObject({ type: 'project', nodes: 4, edges: 3, includedAnalysis: true })
      expect(exported.metrics.sort()).toEqual(['degree', 'pagerank'])
      const loaded = JSON.parse(await tool(tools, 'graph_project')({ action: 'load', id: exported.id }))
      expect(loaded.valueKeys.sort()).toEqual(['data.degree', 'data.pagerank'])
      expect(x.st.projectId).toBe(exported.id)
      const f = JSON.parse(await tool(tools, 'graph_filter')({ replace: true, fields: [{ path: 'data.degree', op: 'gte', value: 2 }] }))
      expect(f.nodes).toBe(3)
      const st = JSON.parse(await tool(tools, 'graph_state')({}))
      expect(st.dataset).toMatchObject({ source: 'project', breadcrumb: ['Library', 'Ranked'] })
      expect(st.pipeline.order).toEqual(['dataset', 'filter', 'layout', 'style', 'analysis', 'export'])
      expect(st.saved.projects).toHaveLength(1)
      const child = JSON.parse(await tool(tools, 'graph_project')({ action: 'export', name: 'Core' }))
      expect(child.nodes).toBe(3)
      expect(JSON.parse(await tool(tools, 'graph_project')({ action: 'get', id: child.id })).parentProjectId).toBe(exported.id)
      await tool(tools, 'graph_project')({ action: 'unload' })
      expect(x.st.projectId).toBeUndefined()
      const scene = JSON.parse(await tool(tools, 'graph_save')({ kind: 'scene', name: 'S1' }))
      // The page's subtype: the mock explorer is the Graph Explorer, so the scene is a Graph Explorer scene — a graph scene
      // (subtype of Scene) that the Scenes page lists, and the view now stands for it.
      expect(store.get(scene.id)?.type).toBe('scene:unigraph')
      expect(x.log).toContain(`scene:${scene.id}`)
      expect(x.st.sceneId).toBe(scene.id)
      // The scene holds the exact renderer, the view (camera, toggles, selection, panels) and a picture, so loading it
      // puts the screen back as it was; the metrics computed earlier ride along as an analysis part of their own.
      const sd = store.get(scene.id)!.data as { mode?: string; view?: { camera?: { center: { x: number } }; labels?: string }; preview?: string; analysisId?: string }
      expect(sd.mode).toBe('2d')
      expect(sd.view?.camera?.center.x).toBe(10)
      expect(sd.view?.labels).toBe(st.labels)
      expect(sd.preview?.startsWith('data:image/jpeg')).toBe(true)
      expect(store.get(sd.analysisId!)?.type).toBe('analysis')
      expect(scene).toMatchObject({ view: true, preview: true })
      expect((store.get(scene.id)?.data as { analysis?: { auto: boolean } }).analysis?.auto).toBe(false)
      // A second scene saved after the filter changed gets its own filter; the first scene keeps the one it had.
      const s1 = store.get(scene.id)!.data as { filterId: string }
      await tool(tools, 'graph_filter')({ types: ['person'] })
      const scene2 = JSON.parse(await tool(tools, 'graph_save')({ kind: 'scene', name: 'S2' }))
      const s2 = store.get(scene2.id)!.data as { filterId: string }
      expect(s2.filterId).not.toBe(s1.filterId)
      expect(store.get(s1.filterId)).toBeTruthy()
      expect((store.get(s2.filterId)!.data as { types: string[] }).types).toEqual(['person'])
      // Save (update: true) writes the view back into the loaded scene under its name; a new scene is not made.
      const updated = JSON.parse(await tool(tools, 'graph_save')({ kind: 'scene', update: true }))
      expect(updated).toMatchObject({ id: scene2.id, updated: true, type: 'scene:unigraph' })
      expect(store.query({ type: ['scene', 'scene:explorer', 'scene:unigraph'] })).toHaveLength(2)
      expect(JSON.parse(await tool(tools, 'graph_state')({})).saved.scenes.map((s: { type: string }) => s.type)).toEqual(['scene:unigraph', 'scene:unigraph'])
    })
  })
})

// ── End-to-end through the SDK's tool runner with a fake API ─────────────

function sse(events: Record<string, unknown>[]): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } })
}

function streamedMessage(blocks: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown })[], stop: string) {
  const events: Record<string, unknown>[] = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 30 } } },
  ]
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      for (const word of b.text.split(/(?<= )/)) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: word } })
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
    }
    events.push({ type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } })
  events.push({ type: 'message_stop' })
  return events
}

describe('AssistantSession', () => {
  it('streams text, runs tools through the runner, and keeps a valid history', async () => {
    setAiSettings({ apiKey: 'test-key', model: 'claude-opus-5', effort: 'low' })
    const store = new EntityStore()
    const doc = createDocument(store, { label: 'Notes', content: 'hello world' })
    const requests: { body: Record<string, unknown> }[] = []
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ body })
      if (requests.length === 1)
        return sse(streamedMessage([{ type: 'text', text: 'Let me fix that. ' }, { type: 'tool_use', id: 'toolu_1', name: 'edit_document', input: { id: doc.id, old_text: 'world', new_text: 'there' } }], 'tool_use'))
      return sse(streamedMessage([{ type: 'text', text: 'Done — replaced one word.' }], 'end_turn'))
    })
    overrideClientOptions({ fetch: fetchMock as unknown as typeof fetch })

    const session = new AssistantSession()
    session.reset()
    const h = host(store)
    session.attach(h)
    await session.send('change world to there')

    const state = session.getState()
    expect(state.busy).toBe(false)
    expect(state.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(state.items[1]).toMatchObject({ kind: 'assistant', text: 'Let me fix that. ', streaming: false })
    expect(state.items[2]).toMatchObject({ kind: 'tool', name: 'edit_document', status: 'done' })
    expect(state.items[3]).toMatchObject({ kind: 'assistant', text: 'Done — replaced one word.' })
    expect(store.get(doc.id)?.data.content).toBe('hello there')
    expect(state.usage).toEqual({ input: 80, output: 24, cacheRead: 60 })

    // Request shape: system prompt cached, tools declared, context block + user text, effort passed through.
    const first = requests[0].body
    expect(first.model).toBe('claude-opus-5')
    expect(first.stream).toBe(true)
    expect((first.system as { cache_control: unknown }[])[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(first.cache_control).toEqual({ type: 'ephemeral' })
    expect((first.tools as { name: string }[]).map((t) => t.name)).toContain('edit_document')
    expect(first.output_config).toEqual({ effort: 'low' })
    const msgs = first.messages as { role: string; content: { type: string; text?: string }[] }[]
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content[0].text).toContain('<app_context>')
    expect(msgs[0].content[1].text).toBe('change world to there')

    // Second request carries the assistant tool_use turn and our tool_result.
    const second = requests[1].body.messages as { role: string; content: { type: string; tool_use_id?: string; content?: string }[] }[]
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(second[1].content.some((b) => b.type === 'tool_use')).toBe(true)
    expect(second[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
    expect(second[2].content[0].content).toContain('"replacements":1')

    // A follow-up turn starts from the full history.
    await session.send('thanks')
    const third = requests[2].body.messages as { role: string }[]
    expect(third.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    overrideClientOptions({})
  })

  it('surfaces API errors without breaking the session', async () => {
    setAiSettings({ apiKey: 'test-key' })
    overrideClientOptions({
      fetch: (async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }), { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
      maxRetries: 0,
    })
    const session = new AssistantSession()
    session.reset()
    session.attach(host(new EntityStore()))
    await session.send('hi')
    const last = session.getState().items.at(-1)
    expect(last).toMatchObject({ kind: 'error' })
    expect((last as { text: string }).text).toContain('API key was rejected')
    expect(session.getState().busy).toBe(false)
    overrideClientOptions({})
  })

  it('sends the web search tool, the memory block, and low effort on a voice turn', async () => {
    setAiSettings({ apiKey: 'test-key', model: 'claude-opus-5', effort: 'high' })
    const requests: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return sse(streamedMessage([{ type: 'text', text: 'Sure.' }], 'end_turn'))
    })
    overrideClientOptions({ fetch: fetchMock as unknown as typeof fetch })
    const session = new AssistantSession()
    session.reset()
    session.attach(host(new EntityStore(), { getContext: () => ({ route: '/graph/2d', voice: true, memory: '- 2026-09-19: Likes short answers' }) }))
    await session.send('hi')
    const body = requests[0] as { tools: { name: string; type?: string }[]; output_config: { effort: string }; messages: { content: { text: string }[] }[]; system: { text: string }[] }
    expect(body.tools.find((t) => t.name === 'web_search')).toMatchObject({ type: 'web_search_20250305' })
    expect(body.tools.find((t) => t.name === 'memory')).toBeTruthy()
    expect(body.output_config.effort).toBe('low')
    expect(body.messages[0].content[0].text).toContain('<assistant_memory>\n- 2026-09-19: Likes short answers\n</assistant_memory>')
    expect(body.system[0].text).toContain('assistant_memory')
    // Without voice the chosen effort stands.
    const quiet = new AssistantSession()
    quiet.reset()
    quiet.attach(host(new EntityStore()))
    await quiet.send('hi')
    expect((requests[1] as { output_config: { effort: string } }).output_config.effort).toBe('high')
    overrideClientOptions({})
  })

  it('refuses to start without an API key', async () => {
    setAiSettings({ apiKey: '' })
    const session = new AssistantSession()
    session.reset()
    session.attach(host(new EntityStore()))
    await session.send('hi')
    expect(session.getState().items.at(-1)).toMatchObject({ kind: 'error', text: expect.stringContaining('API key') })
  })

  it('puts an ask_user question in the transcript, tells listeners, and resolves with the pick', async () => {
    setAiSettings({ apiKey: 'test-key', model: 'claude-opus-5', effort: 'low' })
    const store = new EntityStore()
    const requests: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (requests.length === 1) return sse(streamedMessage([{ type: 'tool_use', id: 'toolu_q', name: 'ask_user', input: { question: 'Which one?', options: ['The map', 'A new note'] } }], 'tool_use'))
      return sse(streamedMessage([{ type: 'text', text: 'The note it is.' }], 'end_turn'))
    })
    overrideClientOptions({ fetch: fetchMock as unknown as typeof fetch })
    const session = new AssistantSession()
    session.reset()
    session.attach(host(store))
    const events: string[] = []
    session.onEvent((ev) => {
      events.push(ev.type)
      if (ev.type === 'question') {
        expect(ev).toMatchObject({ kind: 'choice', message: 'Which one?', options: ['The map', 'A new note'] })
        // Answer from "the UI" once the card is up.
        setTimeout(() => session.answerQuestion(ev.id, 'A new note'), 0)
      }
    })
    await session.send('make it')
    const items = session.getState().items
    expect(items.map((i) => i.kind)).toEqual(['user', 'tool', 'question', 'assistant'])
    expect(items[2]).toMatchObject({ kind: 'question', message: 'Which one?', options: ['The map', 'A new note'], answer: 'A new note' })
    expect(items[1]).toMatchObject({ kind: 'tool', name: 'ask_user', status: 'done', result: JSON.stringify({ answer: 'A new note', question: 'Which one?' }) })
    // Reply events stream the closing text in; the question and its answer bracket the tool call.
    expect(events.filter((e) => e !== 'reply')).toEqual(['question', 'answered', 'turn'])
    expect(events.at(-1)).toBe('turn')
    expect(events).toContain('reply')
    overrideClientOptions({})
  })

  it('names each confirmation’s yes for what it does: Allow to read a site, Delete in red to delete', async () => {
    setAiSettings({ apiKey: 'test-key', model: 'claude-opus-5', effort: 'low' })
    const store = new EntityStore()
    store.upsert(createEntity({ id: 'n1', type: 'note', label: 'Old note', data: {} }))
    let turn = 0
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes('anthropic')) throw new Error(`unexpected fetch ${String(url)}`)
      turn++
      if (turn === 1) return sse(streamedMessage([{ type: 'tool_use', id: 'toolu_w', name: 'web_fetch', input: { url: 'https://example.com/' } }], 'tool_use'))
      if (turn === 2) return sse(streamedMessage([{ type: 'tool_use', id: 'toolu_d', name: 'delete_entity', input: { id: 'n1' } }], 'tool_use'))
      return sse(streamedMessage([{ type: 'text', text: 'Left both alone.' }], 'end_turn'))
    })
    overrideClientOptions({ fetch: fetchMock as unknown as typeof fetch })
    const session = new AssistantSession()
    session.reset()
    session.attach(host(store))
    const asked: { options: string[] }[] = []
    session.onEvent((ev) => {
      if (ev.type !== 'question') return
      asked.push({ options: ev.options })
      setTimeout(() => session.answer(ev.id, false), 0)
    })
    await session.send('read it, then delete the note')
    expect(asked.map((a) => a.options)).toEqual([
      ['Allow', 'Cancel'],
      ['Delete', 'Cancel'],
    ])
    const cards = session.getState().items.filter((i) => i.kind === 'confirm')
    expect(cards).toMatchObject([
      { yes: 'Allow', answer: false },
      { yes: 'Delete', danger: true, answer: false },
    ])
    expect(cards[0]).not.toHaveProperty('danger')
    // Declined: nothing was read, nothing deleted.
    expect(fetchMock.mock.calls.every(([u]) => String(u).includes('anthropic'))).toBe(true)
    expect(store.get('n1')).toBeTruthy()
    overrideClientOptions({})
  })
})

describe('plot tool', () => {
  it('previews, saves, lists and reads plots headlessly', async () => {
    const store = new EntityStore()
    for (let i = 0; i < 6; i++) store.upsert(createEntity({ id: `s${i}`, type: 'segment', label: `s${i}`, data: { chars: 100 * (i + 1) }, meta: { createdAt: `2024-0${(i % 3) + 1}-10T00:00:00Z`, updatedAt: `2024-0${(i % 3) + 1}-10T00:00:00Z`, source: 'test' } }))
    const h = host(store)
    const tools = createAppTools(h)
    const plot = tool(tools, 'plot')
    const preview = JSON.parse(await plot({ action: 'preview', spec: { selector: { types: ['segment'] }, traces: [{ kind: 'bar', x: 'meta.createdAt', bin: 'month' }] } }))
    expect(preview.stats).toEqual({ rows: 6, traces: 1, missing: 0 })
    expect(preview.traces[0].y).toEqual([2, 2, 2])
    expect(preview.summary).toBe('bar · count by created per month')
    const saved = JSON.parse(await plot({ action: 'save', name: 'Segments per month', spec: { traces: [{ kind: 'bar', x: 'meta.createdAt', bin: 'month', group: 'type' }] } }))
    expect(saved.updated).toBe(false)
    expect(store.get(saved.id)?.type).toBe('plot')
    const list = JSON.parse(await plot({ action: 'list' }))
    expect(list.plots).toHaveLength(1)
    expect(list.plots[0].rows).toBe(6)
    const got = JSON.parse(await plot({ action: 'get', id: saved.id }))
    expect(got.spec.traces[0].group).toBe('type')
    expect(got.traces[0].name).toBe('segment')
    const again = JSON.parse(await plot({ action: 'save', id: saved.id, spec: { traces: [{ kind: 'line', x: 'meta.createdAt', bin: 'month', y: 'data.chars', agg: 'mean' }] } }))
    expect(again.updated).toBe(true)
    expect(again.summary).toBe('line · mean of chars by created per month')
    const opened = JSON.parse(await plot({ action: 'open', id: saved.id }))
    expect(opened.opened).toBe(saved.id)
    expect(h.navigated.at(-1)).toBe(`/scenes?plot=${saved.id}`)
    await expect(plot({ action: 'get', id: 'nope' })).rejects.toThrow(/No plot/)
  })
})

describe('project_create from', () => {
  it('saves the open project as a new one, referencing the same entities, and reports the review', async () => {
    const mem: Record<string, string> = {}
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k], clear: () => Object.keys(mem).forEach((k) => delete mem[k]) })
    const store = new EntityStore()
    const h = host(store)
    const tools = createAppTools(h)
    store.upsertMany([createEntity({ id: 'a', type: 'note', label: 'A', tags: ['x'] }), createEntity({ id: 'b', type: 'note', label: 'B' }), createRelationship({ id: 'ab', type: 'references', source: 'a', target: 'b' })])
    const created = JSON.parse(await tool(tools, 'project_create')({ label: 'Src' }))
    store.mark(['a', 'b'], created.created.id)
    const r = JSON.parse(await tool(tools, 'project_create')({ label: 'Src copy', from: 'active', route: '/graph/2d' }))
    expect(r.from).toBe(created.created.id)
    expect(r.marked).toBe(3)
    expect(r.review).toEqual({ entities: 2, relationships: 1, byType: { note: 2 }, byRelationshipType: { references: 1 }, tags: 1 })
    expect(r.created.entities).toBe(2)
    expect(r.created.home).toEqual({ route: '/graph/2d' })
    expect(r.created.source).toBe(`fork:${created.created.id}`)
    expect(store.scope).toBe(r.created.id)
    expect(store.projectsOf('a').length).toBe(2)
    const lib = JSON.parse(await tool(tools, 'project_create')({ label: 'Everything', from: 'library', open: false }))
    expect(lib.marked).toBe(3)
    expect(store.scope).toBe(r.created.id)
    await expect(tool(tools, 'project_create')({ label: 'x', from: 'active', includes: ['nope'] })).rejects.toThrow(/includes/)
    vi.unstubAllGlobals()
  })
})

describe('open_entities', () => {
  it('opens the Entities table on a titled pick: ids, matches, neighbours and the links among them', async () => {
    const mem: Record<string, string> = {}
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
    const store = new EntityStore()
    const h = host(store)
    const tools = createAppTools(h)
    store.upsertMany([
      createEntity({ id: 'svc', type: 'service', label: 'Orders', tags: ['topology'] }),
      createEntity({ id: 'db', type: 'datastore', label: 'Postgres', tags: ['topology'] }),
      createEntity({ id: 'inc', type: 'incident', label: 'Outage', description: 'architecture review follow-up' }),
      createEntity({ id: 'p', type: 'person', label: 'Ada' }),
      createRelationship({ id: 'r1', type: 'reads-writes', source: 'svc', target: 'db' }),
      createRelationship({ id: 'r2', type: 'affected', source: 'inc', target: 'svc' }),
      createRelationship({ id: 'r3', type: 'responded-to', source: 'p', target: 'inc' }),
    ])
    const r = JSON.parse(await tool(tools, 'open_entities')({ title: 'Architecture', match: { types: ['service', 'datastore'] } }))
    expect(r.entities).toBe(2)
    expect(r.relationships).toBe(1)
    expect(r.byType).toEqual({ service: 1, datastore: 1 })
    expect(r.opened).toMatch(/^\/entities\?category=all&pick=/)
    const key = /pick=([^&]+)/.exec(r.opened)![1]
    expect(JSON.parse(mem[`aegraph:pick:${key}`])).toEqual({ ids: ['svc', 'db', 'r1'], label: 'Architecture' })
    expect(h.navigated.at(-1)).toBe(r.opened)
    const t = JSON.parse(await tool(tools, 'open_entities')({ title: 'Around the outage', matches: [{ text: 'architecture' }, { tags: ['topology'], types: ['datastore'] }], related_to: ['inc'], category: 'knowledge' }))
    expect(t.entities).toBe(4)
    expect(t.relationships).toBe(3)
    expect(t.opened).toMatch(/^\/entities\?category=knowledge&pick=/)
    await expect(tool(tools, 'open_entities')({ title: 'x', match: { types: ['nope'] } })).rejects.toThrow(/Nothing matched/)
    vi.unstubAllGlobals()
  })

  it('turns a phrase into types, tags and terms by meaning, falling back to word overlap without a key', async () => {
    const mem: Record<string, string> = {}
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
    const store = new EntityStore()
    const h = host(store)
    const tools = createAppTools(h)
    store.upsertMany([
      createEntity({ id: 'svc', type: 'service', label: 'Orders', tags: ['topology'] }),
      createEntity({ id: 'db', type: 'datastore', label: 'Postgres', tags: ['topology'] }),
      createEntity({ id: 'doc', type: 'document', label: 'Q3 review', description: 'Notes on the system architecture' }),
      createEntity({ id: 'p', type: 'person', label: 'Ada' }),
      createRelationship({ id: 'r1', type: 'reads-writes', source: 'svc', target: 'db' }),
    ])
    // With a key: the model reads the vocabulary and answers with scores.
    setAiSettings({ apiKey: 'test-key' })
    let prompt = ''
    overrideClientOptions({
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        prompt = String(init?.body ?? '')
        const reply = { types: [{ name: 'service', score: 0.9, why: 'runs the system' }, { name: 'datastore', score: 0.8 }, { name: 'person', score: 0.1 }, { name: 'ghost', score: 1 }], tags: [{ tag: 'topology', score: 0.95 }], terms: ['architecture'] }
        return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: '```json\n' + JSON.stringify(reply) + '\n```' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
      maxRetries: 0,
    })
    const r = JSON.parse(await tool(tools, 'open_entities')({ title: 'Architecture', query: 'everything about architecture' }))
    expect(prompt).toContain('type service · knowledge · 1 · Service; e.g. Orders; tagged topology; linked by reads writes')
    expect(prompt).toContain('tag topology · 2')
    expect(r.method).toBe('semantic')
    expect(r.chosen).toEqual({ types: ['service', 'datastore'], tags: ['topology'], terms: ['architecture'] })
    expect(r.ranking.types.map((t: { key: string }) => t.key)).toEqual(['service', 'datastore', 'person'])
    expect(r.entities).toBe(3)
    expect(r.byType).toEqual({ service: 1, datastore: 1, document: 1 })
    expect(r.relationships).toBe(1)
    const dry = JSON.parse(await tool(tools, 'open_entities')({ title: 'x', query: 'architecture', dry_run: true, threshold: 0.85 }))
    expect(dry.chosen.types).toEqual(['service'])
    expect(dry.opened).toBeUndefined()
    overrideClientOptions({})
    // Without a key the app asks once before downloading the local model; declined → word overlap, and the reply says so.
    setAiSettings({ apiKey: '' })
    const declining = createAppTools(host(store, { confirm: async () => false }))
    const lex = JSON.parse(await tool(declining, 'open_entities')({ title: 'Services', query: 'services', dry_run: true }))
    expect(lex.method).toBe('lexical')
    expect(lex.note).toMatch(/download was declined/)
    expect(lex.chosen.types).toEqual(['service'])
    // Local embeddings: the vocabulary (with examples, tags and links) and the entities themselves are compared by similarity.
    const vec = (text: string) => {
      const v = new Float32Array(3)
      const t = text.toLowerCase()
      v[0] = /architecture|topology|service|datastore|postgres|orders/.test(t) ? 1 : 0
      v[1] = /person|ada/.test(t) ? 1 : 0
      v[2] = /review/.test(t) ? 0.5 : 0
      const n = Math.hypot(v[0], v[1], v[2]) || 1
      return v.map((x) => x / n) as Float32Array
    }
    overrideEmbed(async (texts) => texts.map(vec))
    const loc = JSON.parse(await tool(tools, 'open_entities')({ title: 'Architecture', query: 'everything about architecture', dry_run: true }))
    expect(loc.method).toBe('embedding')
    expect(loc.threshold).toBeCloseTo(0.65)
    expect(loc.chosen.types).toEqual(['service', 'datastore'])
    expect(loc.chosen.tags).toEqual(['topology'])
    expect(loc.chosen.entities).toBe(3)
    expect(loc.byType).toEqual({ service: 1, datastore: 1, document: 1 })
    expect(loc.ranking.types.at(-1).key).toBe('person')
    overrideEmbed(null)
    vi.unstubAllGlobals()
  })
})

describe('workstation tool', () => {
  it('opens, retitles and closes tabs in a host that is not on screen, through its stored arrangement', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
    const s = new EntityStore()
    const h = host(s)
    const tools = createAppTools(h)
    const plot = createEntity({ type: 'plot', label: 'Growth', data: {} })
    s.upsert(plot)
    const opened = JSON.parse(await tool(tools, 'workstation')({ action: 'open_tab', entity: plot.id }))
    expect(opened.host).toBe('charts')
    expect(opened.tab.path).toBe(`/analytics/charts?plot=${plot.id}`)
    expect(opened.tab.title).toBe('Growth')
    expect(opened.live).toBe(false)
    expect(h.navigated.at(-1)).toBe('/analytics/charts')
    const state = JSON.parse(await tool(tools, 'workstation')({ action: 'state' }))
    // The section's list stays at the front; the chart opened beside it.
    const shape = (tabs: { path: string; list?: boolean }[]) => tabs.map((t) => `${t.list ? '*' : ''}${t.path}`)
    expect(shape(state.charts.panes[0].tabs)).toEqual(['*/analytics/charts', `/analytics/charts?plot=${plot.id}`])
    // Opening it again finds the tab already open; opening the list's address brings the list forward, no new tab.
    expect(JSON.parse(await tool(tools, 'workstation')({ action: 'open_tab', entity: plot.id })).tab.id).toBe(opened.tab.id)
    expect(JSON.parse(await tool(tools, 'workstation')({ action: 'open_tab', path: '/analytics/charts' })).tabs[0].tabs).toHaveLength(2)
    // Scripts are a section of their own.
    expect(JSON.parse(await tool(tools, 'workstation')({ action: 'open_tab', path: '/analytics/scripts?script=s1', go: false })).host).toBe('scripts')
    // A list cannot be closed.
    const list = JSON.parse(await tool(tools, 'workstation')({ action: 'state' })).charts.panes[0].tabs[0]
    await tool(tools, 'workstation')({ action: 'close_tab', host: 'charts', tab: list.id })
    expect(JSON.parse(await tool(tools, 'workstation')({ action: 'state' })).charts.panes[0].tabs).toHaveLength(2)
    await tool(tools, 'workstation')({ action: 'retitle', host: 'charts', tab: opened.tab.id, title: 'Growth by month' })
    await tool(tools, 'workstation')({ action: 'close_tab', host: 'charts', tab: opened.tab.id })
    const after = JSON.parse(await tool(tools, 'workstation')({ action: 'state' }))
    expect(shape(after.charts.panes[0].tabs)).toEqual(['*/analytics/charts'])
    // A document goes to the Documents section, beside its list.
    const doc = JSON.parse(await tool(tools, 'workstation')({ action: 'open_tab', path: '/documents/d1', go: false }))
    expect(doc.host).toBe('documents')
    expect(doc.tabs[0].tabs.map((t: { path: string; list?: boolean }) => `${t.list ? '*' : ''}${t.path}`)).toEqual(['*/documents', '/documents/d1'])
    await expect(tool(tools, 'workstation')({ action: 'open_tab', host: 'charts', path: '/documents' })).rejects.toThrow(/charts host/)
    vi.unstubAllGlobals()
  })
})
