import { describe, expect, it } from 'vitest'
import { isRelationship } from '../../entity/types'
import { isAtlas, linkAtlasConversations, parseAtlas, type AtlasFile } from '../atlas'
import { chatGptToEntities, conversationIdFor, detectChatGptFormat, parseChatGpt, parseChatGptExport, parseChatGptPrepared, parseExportConversation } from '../chatgpt'

/**
 * The ChatGPT importer and the legacy atlas converter at their edges, on
 * synthetic fixtures only: an export with no messages, a leaf pointer to
 * nothing, a parent chain that breaks or loops, duplicate ids, parts that
 * are not text, whitespace titles, seconds vs milliseconds vs ISO, a
 * message of a megabyte; an atlas with edges to nowhere and duplicate
 * edges, nodes without a layout or at the origin, the origin-only
 * timestamps, an empty graph; and the segment ↔ conversation join with
 * segments whose conversation is missing, hubs that are not there, and
 * links of types that do not lift.
 */
const node = (id: string, parent: string | null, children: string[], message?: Record<string, unknown>) => ({ id, parent, children, message })
const msg = (role: string, content: unknown, create_time?: number, metadata: Record<string, unknown> = {}) => ({ id: `m-${role}`, author: { role }, create_time, content, metadata })
const text = (role: string, parts: unknown[], t?: number, metadata?: Record<string, unknown>) => msg(role, { content_type: 'text', parts }, t, metadata)

describe('chatgpt export edges', () => {
  it('an export with no messages: an empty array is an export of nothing; an empty mapping is a conversation with no messages, its times from the record', () => {
    expect(detectChatGptFormat([])).toBe('export')
    expect(parseChatGpt([])).toEqual({ format: 'export', conversations: [] })
    expect(detectChatGptFormat([{}])).toBeNull()
    expect(detectChatGptFormat([{ title: 'x' }, { mapping: {} }])).toBe('export')
    const [c] = parseChatGptExport([{ title: 'Empty', mapping: {}, conversation_id: 'e1', create_time: 1_700_000_000 }])
    expect(c).toMatchObject({ sourceId: 'e1', title: 'Empty', messages: [], createdAt: '2023-11-14T22:13:20.000Z', updatedAt: undefined, model: undefined })
    const { entities } = chatGptToEntities('export', [c])
    expect(entities).toHaveLength(1)
    expect(entities[0].data).toMatchObject({ messages: [], messageCount: 0, charLength: 0, startedAt: '2023-11-14T22:13:20.000Z' })
    expect(entities[0].data).not.toHaveProperty('endedAt')
    expect(entities[0].meta.updatedAt).toBe('2023-11-14T22:13:20.000Z')
  })

  it('a leaf pointer to a node that is not there falls back to the deepest first-child path; a parent chain that breaks keeps what it reached; one that loops ends', () => {
    const mapping = {
      r: node('r', null, ['a']),
      a: node('a', 'r', ['b'], text('user', ['one'], 1)),
      b: node('b', 'a', [], text('assistant', ['two'], 2)),
    }
    expect(parseExportConversation({ title: 'stale', current_node: 'gone', mapping }).messages.map((m) => m.content)).toEqual(['one', 'two'])
    expect(parseExportConversation({ title: 'none', mapping }).messages.map((m) => m.content)).toEqual(['one', 'two'])
    const broken = { b: node('b', 'missing', [], text('assistant', ['two'], 2)), c: node('c', 'b', [], text('user', ['three'], 3)) }
    expect(parseExportConversation({ title: 'broken', current_node: 'c', mapping: broken }).messages.map((m) => m.content)).toEqual(['two', 'three'])
    const loop = { a: node('a', 'b', ['b'], text('user', ['a'], 1)), b: node('b', 'a', ['a'], text('assistant', ['b'], 2)) }
    expect(parseExportConversation({ title: 'loop', current_node: 'b', mapping: loop }).messages.map((m) => m.content)).toEqual(['a', 'b'])
    // No current node and no root either (every node has a parent): nothing to walk, and no crash.
    expect(parseExportConversation({ title: 'orphans', mapping: { a: node('a', 'zz', [], text('user', ['x'], 1)) } }).messages).toEqual([])
  })

  it('parts that are not text are dropped, code and execution output are fenced, a string content is taken as is, a tool role stays, a system message goes', () => {
    const mapping = {
      a: node('a', null, ['b'], text('user', ['look', { content_type: 'image_asset_pointer', asset_pointer: 'file-service://x' }, { text: 'and this' }, 42, null], 1)),
      b: node('b', 'a', ['c'], msg('assistant', { content_type: 'code', language: 'ts', text: 'let x = 1' }, 2, { model_slug: 'gpt-4o' })),
      c: node('c', 'b', ['d'], msg('tool', { content_type: 'execution_output', text: 'ok' }, 3)),
      d: node('d', 'c', ['e'], msg('assistant', 'plain string content', 4)),
      e: node('e', 'd', ['f'], msg('assistant', { content_type: 'tether_browsing_display', result: 'a page' }, 5)),
      f: node('f', 'e', ['g'], msg('system', { content_type: 'text', parts: ['you are'] }, 6)),
      g: node('g', 'f', ['h'], msg('assistant', { content_type: 'text', text: 'text field only' }, 7)),
      h: node('h', 'g', [], text('user', ['   '], 8)),
    }
    const c = parseExportConversation({ title: ' \n\t', current_node: 'h', mapping })
    expect(c.title).toBe('Untitled conversation')
    expect(c.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'look\nand this'],
      ['assistant', '```ts\nlet x = 1\n```'],
      ['tool', '```\nok\n```'],
      ['assistant', 'plain string content'],
      ['assistant', 'text field only'],
    ])
    expect(c.messages[1].model).toBe('gpt-4o')
    expect(c.messages[0]).not.toHaveProperty('model')
    expect(c.model).toBe('gpt-4o')
    expect(parseExportConversation({ title: null, mapping: {} }).title).toBe('Untitled conversation')
  })

  it('reads seconds, fractional seconds, milliseconds and ISO strings as the same instant, and nothing from junk', () => {
    const at = (t: unknown) => parseExportConversation({ title: 't', create_time: t, current_node: 'a', mapping: { a: node('a', null, [], text('user', ['x'], 1_700_000_000.5)) } })
    expect(at(1_700_000_000).createdAt).toBe('2023-11-14T22:13:20.000Z')
    expect(at(1_700_000_000.25).createdAt).toBe('2023-11-14T22:13:20.250Z')
    expect(at(1_700_000_000_000).createdAt).toBe('2023-11-14T22:13:20.000Z')
    expect(at('2023-11-14T22:13:20Z').createdAt).toBe('2023-11-14T22:13:20.000Z')
    expect(at(1_700_000_000).messages[0].at).toBe('2023-11-14T22:13:20.500Z')
    // Junk falls back to the first message's time; a message without a time has none.
    for (const junk of [null, 'yesterday', NaN, Infinity, '', {}]) expect(at(junk).createdAt, String(junk)).toBe('2023-11-14T22:13:20.500Z')
    expect(parseExportConversation({ title: 't', current_node: 'a', mapping: { a: node('a', null, [], text('user', ['x'])) } })).toMatchObject({ createdAt: undefined, updatedAt: undefined })
  })

  it('a message of a megabyte is kept whole and counted; duplicate source ids give the same entity id, title-only conversations get an index', () => {
    const big = 'x'.repeat(1_000_000)
    const c = parseExportConversation({ title: 'big', conversation_id: 'B', current_node: 'a', mapping: { a: node('a', null, [], text('user', [big], 1)) } })
    expect(c.messages[0].content.length).toBe(1_000_000)
    const { entities } = chatGptToEntities('export', [c, c, { ...c, sourceId: undefined }, { ...c, sourceId: undefined }])
    expect(entities.map((e) => e.id)).toEqual(['chatgpt-b', 'chatgpt-b', 'chatgpt-big-2', 'chatgpt-big-3'])
    expect(entities[0].data.charLength).toBe(1_000_000)
    expect(conversationIdFor('A-b_c d/e', 'x')).toBe('x-a-b-c-d-e')
    expect(conversationIdFor('!!!')).toBe('chatgpt-')
    expect(conversationIdFor('a'.repeat(100)).length).toBe('chatgpt-'.length + 60)
  })

  it('prepared records: a numeric id becomes text, a hash stands in, missing metadata is no metadata, keywords are coerced; the format needs one record with metadata', () => {
    expect(detectChatGptFormat({ conversations: [{ id: 1 }] })).toBeNull()
    expect(detectChatGptFormat({ conversations: [{ id: 1 }, { id: 2, metadata: {} }] })).toBe('prepared')
    const rows = parseChatGptPrepared({ conversations: [{ id: 0, title: '  ', metadata: { keywords: [1, 'Two', null] } }, { hash: 'h', title: 'T', timestamp: 1_700_000_000 }, null, 'junk'] })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ sourceId: '0', title: 'Untitled conversation', keywords: ['1', 'Two', 'null'], messages: [] })
    expect(rows[0].summary).toBeUndefined()
    expect(rows[1]).toMatchObject({ sourceId: 'h', title: 'T', createdAt: '2023-11-14T22:13:20.000Z' })
    expect(rows[1].keywords).toBeUndefined()
    const { entities, topics } = chatGptToEntities('prepared', rows, { keywordsAsTags: true, topics: true })
    expect(entities[0].tags).toEqual(['chatgpt', '1', 'two', 'null'])
    expect(topics).toBe(0)
    expect(() => parseChatGpt({ conversations: [] })).toThrow(/Not a ChatGPT export/)
  })
})

const file = (nodes: AtlasFile['data']['graph']['nodes'], edges: AtlasFile['data']['graph']['edges'], rest: Partial<AtlasFile['data']> = {}): AtlasFile => ({ data: { graph: { nodes, edges }, ...rest } })

describe('atlas edges', () => {
  it('an empty graph is an atlas of nothing; a graph without the arrays is not an atlas', () => {
    expect(isAtlas(file([], []))).toBe(true)
    expect(isAtlas({ data: { graph: { nodes: [] } } })).toBe(false)
    expect(isAtlas({ data: { graph: { nodes: {}, edges: [] } } })).toBe(false)
    expect(isAtlas(null)).toBe(false)
    expect(parseAtlas(file([], []))).toEqual({ label: 'Atlas', description: undefined, entities: [], tags: [], nodes: 0, edges: 0, types: [] })
  })

  it('edges to unknown nodes, duplicate edges, an edge whose id is a node id, nodes without an id or with a repeated one — all skipped and not counted', () => {
    const parsed = parseAtlas(
      file(
        [{ id: 'a', type: 'topic' }, { id: 'b', type: 'topic' }, { id: 'a', type: 'segment', label: 'again' }, { id: '', type: 'topic' }, { id: 'c' }],
        [
          { source: 'a', target: 'zz', type: 'on-topic' },
          { source: 'zz', target: 'a' },
          { source: 'a', target: 'b' },
          { source: 'a', target: 'b' },
          { id: 'a', source: 'a', target: 'b', type: 'x' },
          { id: 'e', source: 'b', target: 'a', type: 'on-topic', label: 'on-topic', tags: ['rel:on-topic', 'keep:me'] },
          { id: 'e', source: 'b', target: 'c' },
        ],
      ),
    )
    expect(parsed.nodes).toBe(3)
    expect(parsed.edges).toBe(2)
    expect(parsed.types).toEqual(['entity', 'topic'])
    const rels = parsed.entities.filter(isRelationship)
    expect(rels.map((r) => [r.id, r.type, r.label, r.tags])).toEqual([
      ['a:::related:::b', 'related', undefined, []],
      ['e', 'on-topic', undefined, ['keep:me']],
    ])
    // A node named `a` twice keeps the first; a node with no type is `entity`; only known types get definitions.
    const a = parsed.entities.find((e) => e.id === 'a')!
    expect([a.type, a.label]).toEqual(['topic', 'a'])
    expect(parsed.entities.filter((e) => e.type === 'schema:type').map((e) => e.id)).toEqual(['type:topic'])
  })

  it('no layout is no position; the origin counts as no position too; type `entity` is renamed; timestamps in seconds, ms, ISO or junk; a description equal to the label is dropped', () => {
    const parsed = parseAtlas(
      file([
        { id: 'n1', type: 'entity', label: 'L', userData: { description: 'L', created: 1_700_000_000, ended: 'junk' } },
        { id: 'n2', type: 'segment', label: 'S', userData: { description: 'more', created_ts: 1_700_000_000_000, updated: '2024-01-01T00:00:00Z' }, position: { x: 0, y: 0, z: 0 } },
        { id: 'n3', type: 'cluster', position: { x: 0, y: 0, z: 1 }, color: '#123', size: 2 },
        { id: 'n4', type: 'region', userData: { created: 'not a date' } },
      ], []),
      { tag: 'mark', source: 'import:test' },
    )
    const [n1, n2, n3, n4] = parsed.entities
    expect(n1.type).toBe('named-entity')
    expect(n1.description).toBeUndefined()
    expect(n1.meta).toEqual({ createdAt: '2023-11-14T22:13:20.000Z', updatedAt: '2023-11-14T22:13:20.000Z', source: 'import:test' })
    expect(n1.data).not.toHaveProperty('position')
    expect(n2.description).toBe('more')
    expect(n2.meta.createdAt).toBe('2023-11-14T22:13:20.000Z')
    expect(n2.meta.updatedAt).toBe('2024-01-01T00:00:00.000Z')
    expect(n2.data).not.toHaveProperty('position')
    expect(n3.data).toEqual({ color: '#123', size: 2, position: { x: 0, y: 0, z: 1 } })
    expect(n3.label).toBe('n3')
    expect(n4.meta.createdAt).toMatch(/^\d{4}-/) // now
    expect(parsed.entities.every((e) => e.tags.includes('mark'))).toBe(true)
    expect(parsed.types).toEqual(['cluster', 'named-entity', 'region', 'segment'])
    expect(parsed.tags).toEqual([{ tag: 'mark', color: '#10a37f', description: 'Loaded from Atlas' }])
  })

  it('joins segments to conversations: a segment whose conversation is missing is skipped, hubs that are not there and links of other types do not lift, weights count segments, facet tags move up, order is by index', () => {
    const conv = { id: conversationIdFor('C-1'), kind: 'entity' as const, type: 'conversation', label: 'C', tags: ['chatgpt'], data: {}, meta: { createdAt: 'x', updatedAt: 'x' } }
    const seg = (id: string, index: number, conversation_id: string, tags: string[] = []) => ({ id, kind: 'entity' as const, type: 'segment', label: id, tags, data: { conversation_id, segment_index: index, facets: { topic: ['t'], domain: 'not-a-list' } }, meta: { createdAt: 'x', updatedAt: 'x' } })
    const hub = (id: string, type: string) => ({ id, kind: 'entity' as const, type, label: id, tags: [], data: {}, meta: { createdAt: 'x', updatedAt: 'x' } })
    const rel = (id: string, type: string, source: string, target: string) => ({ id, kind: 'relationship' as const, type, label: undefined, tags: [], data: {}, meta: { createdAt: 'x', updatedAt: 'x' }, source: { id: source }, target: { id: target }, directed: true })
    const all = [
      conv,
      seg('s2', 2, 'C-1', ['topic:t', 'kind:segment', 'plain']),
      seg('s1', 1, 'C-1', ['region:r']),
      seg('lost', 0, 'C-2'),
      { ...seg('notseg', 0, 'C-1'), data: { segment_index: 0 } },
      hub('topic::t', 'topic'),
      rel('r1', 'on-topic', 's1', 'topic::t'),
      rel('r2', 'on-topic', 's2', 'topic::t'),
      rel('r3', 'on-topic', 's2', 'topic::missing'),
      rel('r4', 'similar-to', 's2', 'topic::t'),
      rel('r5', 'on-topic', 'lost', 'topic::t'),
    ]
    const out = linkAtlasConversations(all)
    expect([out.segments, out.linked]).toEqual([3, 1])
    expect(out.relationships.map((r) => [r.id, r.type, r.data.weight])).toEqual([
      ['s1:::segment-of:::chatgpt-c-1', 'segment-of', undefined],
      ['s2:::segment-of:::chatgpt-c-1', 'segment-of', undefined],
      ['chatgpt-c-1:::on-topic:::topic::t', 'on-topic', 2],
    ])
    const c = out.conversations[0]
    expect(c.tags).toEqual(['chatgpt', 'region:r', 'topic:t'])
    const atlas = c.data.atlas as { segments: { id: string; index: number; topics: string[]; domains: string[] }[]; regions: string[]; clusters: string[] }
    expect(atlas.segments.map((s) => [s.id, s.index, s.topics, s.domains])).toEqual([['s1', 1, ['t'], []], ['s2', 2, ['t'], []]])
    expect([atlas.regions, atlas.clusters]).toEqual([[], []])
    // No segments, or no conversations: nothing to do.
    expect(linkAtlasConversations([conv])).toEqual({ relationships: [], conversations: [], segments: 0, linked: 0 })
    expect(linkAtlasConversations([seg('s', 0, 'C-1')]).segments).toBe(1)
  })
})
