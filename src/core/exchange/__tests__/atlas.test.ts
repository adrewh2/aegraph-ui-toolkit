import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { isAtlas, parseAtlas } from '../atlas'

const atlas = {
  data: {
    graph: {
      nodes: [
        { id: 'seg::c1#0', type: 'segment', label: 'Graph libraries', tags: ['region:tools', 'kind:segment', 'domain:software', 'topic:graphs', 'year:2024'], userData: { description: 'Which library renders 10k nodes', created: '2024-03-01T10:00:00Z', ended: '2024-03-01T10:20:00Z', facets: { domain: ['software'] }, salience: 4 }, position: { x: 0, y: 0, z: 0 }, color: '#7aa2f7', size: 3 },
        { id: 'topic::graphs', type: 'topic', label: 'graphs', tags: ['topic:graphs', 'kind:topic'], userData: { description: 'topic: graphs', kind: 'topic', segment_count: 1 }, position: { x: 0, y: 0, z: 0 }, color: '#9ece6a', size: 6 },
        { id: 'entity::Sigma', type: 'entity', label: 'Sigma', tags: ['entity:Sigma', 'kind:entity'], userData: {}, position: { x: 1, y: 2, z: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'seg::c1#0', target: 'topic::graphs', type: 'on-topic', label: 'on topic', tags: ['rel:on-topic'], userData: { weight: 1 }, color: '#3b4261' },
        { id: 'e2', source: 'seg::c1#0', target: 'entity::Sigma', type: 'mentions', label: 'mentions', tags: ['rel:mentions'], userData: { weight: 2 } },
        { id: 'dangling', source: 'seg::c1#0', target: 'nope', type: 'mentions' },
      ],
    },
    metadata: { name: 'Conversation Atlas', description: 'test', source: 'aegraph-chatgpt-pipeline' },
    displayConfig: { nodeConfig: { tags: { 'region:tools': { color: '#7aa2f7' }, 'kind:segment': {} }, types: {} } },
  },
}

describe('atlas import', () => {
  it('recognises the shape', () => {
    expect(isAtlas(atlas)).toBe(true)
    expect(isAtlas({ entities: [] })).toBe(false)
    expect(isAtlas([])).toBe(false)
  })

  it('turns nodes, edges, tag colours and vocabulary into entities', () => {
    const p = parseAtlas(atlas, { tag: 'chatgpt-atlas' })
    expect(p.label).toBe('Conversation Atlas')
    expect(p.nodes).toBe(3)
    expect(p.edges).toBe(2) // the dangling edge is dropped
    expect(p.types).toEqual(['named-entity', 'segment', 'topic'])
    const store = new EntityStore()
    store.upsertMany(p.entities)
    for (const t of p.tags) store.setTagInfo(t.tag, t)
    const seg = store.get('seg::c1#0')!
    expect(seg.type).toBe('segment')
    expect(seg.description).toBe('Which library renders 10k nodes')
    expect(seg.tags).toContain('chatgpt-atlas')
    expect(seg.meta.createdAt).toBe('2024-03-01T10:00:00.000Z')
    expect(seg.meta.updatedAt).toBe('2024-03-01T10:20:00.000Z')
    expect(seg.data.color).toBe('#7aa2f7')
    expect(seg.data.position).toBeUndefined() // all-zero positions are noise
    expect(store.get('entity::Sigma')!.type).toBe('named-entity')
    expect(store.get('entity::Sigma')!.data.position).toEqual({ x: 1, y: 2, z: 0 })
    const e = store.get('e1')!
    expect(e.kind).toBe('relationship')
    expect(e.type).toBe('on-topic')
    expect(e.tags).not.toContain('rel:on-topic')
    expect(e.data.weight).toBe(1)
    expect(store.getTagInfo('region:tools')?.color).toBe('#7aa2f7')
    const registry = new TypeRegistry(store)
    expect(registry.get('segment').label).toBe('Segment')
    expect(registry.get('segment').category).toBe('resource')
    expect(registry.get('named-entity').color).toBe('#f7768e')
    expect(registry.get('topic').category).toBe('knowledge')
  })
})

describe('atlas ↔ conversations', () => {
  it('links segments to their conversation, lifts facets and hub links, and annotates the viewer', async () => {
    const { linkAtlasConversations } = await import('../atlas')
    const { chatGptToEntities, conversationIdFor } = await import('../chatgpt')
    const convId = '00000000-0000-4000-8000-000000000001'
    const conv = chatGptToEntities('export', [{ sourceId: convId, title: 'Systems', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }] }]).entities
    expect(conv[0].id).toBe(conversationIdFor(convId))
    const seg = (i: number, region: string, topics: string[]) => ({
      id: `seg::${convId}#${i}`,
      kind: 'entity' as const,
      type: 'segment',
      label: `Segment ${i}`,
      tags: ['kind:segment', `region:${region.toLowerCase()}`, ...topics.map((t) => `topic:${t}`), 'year:2023'],
      data: { conversation_id: convId, segment_index: i, n_messages: 2, region, cluster: 'Power', summary: `s${i}`, facets: { topic: topics, domain: ['software'] } },
      meta: { createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-01T00:00:00Z' },
    })
    const rel = (s: string, type: string, t: string) => ({ id: `${s}:::${type}:::${t}`, kind: 'relationship' as const, type, tags: [], data: {}, meta: { createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-01T00:00:00Z' }, source: { id: s }, target: { id: t }, directed: true })
    const hub = (id: string, type: string) => ({ id, kind: 'entity' as const, type, label: id, tags: [], data: {}, meta: { createdAt: '2023-01-01T00:00:00Z', updatedAt: '2023-01-01T00:00:00Z' } })
    const all = [
      ...conv,
      seg(0, 'Tools', ['system-design']),
      seg(1, 'Tools', ['websockets']),
      hub('region::tools', 'region'),
      hub('topic::system-design', 'topic'),
      hub('topic::websockets', 'topic'),
      rel(`seg::${convId}#0`, 'in-region', 'region::tools'),
      rel(`seg::${convId}#1`, 'in-region', 'region::tools'),
      rel(`seg::${convId}#0`, 'on-topic', 'topic::system-design'),
      rel(`seg::${convId}#1`, 'on-topic', 'topic::websockets'),
      rel(`seg::${convId}#0`, 'next-in-conversation', `seg::${convId}#1`), // not lifted
    ]
    const link = linkAtlasConversations(all)
    expect(link.linked).toBe(1)
    expect(link.segments).toBe(2)
    const types = link.relationships.map((r) => `${r.type}:${r.source.id === conv[0].id ? 'conv' : 'seg'}→${r.target.id}`).sort()
    expect(types).toEqual(['in-region:conv→region::tools', 'on-topic:conv→topic::system-design', 'on-topic:conv→topic::websockets', 'segment-of:seg→' + conv[0].id, 'segment-of:seg→' + conv[0].id].sort())
    const region = link.relationships.find((r) => r.type === 'in-region')!
    expect(region.data.weight).toBe(2)
    const c = link.conversations[0]
    expect(c.tags).toEqual(expect.arrayContaining(['chatgpt', 'region:tools', 'topic:system-design', 'topic:websockets', 'year:2023']))
    expect(c.tags).not.toContain('kind:segment')
    const atlas = c.data.atlas as { segments: { index: number; messages: number; topics: string[] }[]; regions: string[]; clusters: string[] }
    expect(atlas.segments.map((s) => [s.index, s.messages, s.topics[0]])).toEqual([[0, 2, 'system-design'], [1, 2, 'websockets']])
    expect(atlas.regions).toEqual(['Tools'])
    expect(atlas.clusters).toEqual(['Power'])
    // Nothing to link when either half is missing.
    expect(linkAtlasConversations(conv).linked).toBe(0)
  })
})
