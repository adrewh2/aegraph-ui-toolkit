import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../entity/store'
import { isRelationship } from '../../entity/types'
import { chatGptToEntities, detectChatGptFormat, parseChatGpt, parseChatGptExport } from '../chatgpt'

// Synthetic fixtures in the shape of the real files; no real data lives in the repo.
const node = (id: string, parent: string | null, children: string[], message?: Record<string, unknown>) => ({ id, parent, children, message })
const msg = (role: string, parts: unknown[], create_time: number, metadata: Record<string, unknown> = {}) => ({ id: `m-${role}-${create_time}`, author: { role }, create_time, content: { content_type: 'text', parts }, metadata })

const exportFixture = [
  {
    title: 'Planning a garden',
    create_time: 1_700_000_000,
    update_time: 1_700_000_500,
    conversation_id: 'conv-1',
    default_model_slug: 'gpt-4o',
    current_node: 'n4',
    mapping: {
      'client-created-root': node('client-created-root', null, ['n1']),
      n1: node('n1', 'client-created-root', ['n2'], msg('system', [''], 1_700_000_000)),
      n2: node('n2', 'n1', ['n3', 'n3b'], msg('user', ['What should I plant in spring?'], 1_700_000_010)),
      n3: node('n3', 'n2', ['n4'], msg('assistant', ['Peas and lettuce.'], 1_700_000_020, { model_slug: 'gpt-4o' })),
      n3b: node('n3b', 'n2', [], msg('assistant', ['An abandoned branch.'], 1_700_000_021)),
      n4: node('n4', 'n3', [], { ...msg('user', ['Thanks!'], 1_700_000_030), metadata: { is_visually_hidden_from_conversation: true } }),
    },
  },
  {
    title: 'Code help',
    current_node: 'c2',
    mapping: {
      c1: node('c1', null, ['c2'], msg('user', ['Show me a loop'], 1_700_100_000)),
      c2: node('c2', 'c1', [], { id: 'code', author: { role: 'assistant' }, create_time: 1_700_100_005, content: { content_type: 'code', language: 'python', text: 'for i in range(3): pass' } }),
    },
  },
]

const preparedFixture = {
  source_file: 'conversations.json',
  conversation_count: 2,
  completed: true,
  conversations: [
    { id: 1, title: 'Planning a garden', excerpt: 'What should I plant…', message_count: 2, char_length: 44, hash: 'abc', timestamp: 1_700_000_000, metadata: { summary: 'Spring planting advice.', keywords: ['gardening', 'Spring Vegetables'], sentiment: 'positive', topic: 'Gardening' } },
    { id: 2, title: 'Code help', excerpt: 'Show me a loop', message_count: 2, char_length: 40, hash: 'def', timestamp: 1_700_100_000, metadata: { summary: 'A Python loop.', keywords: ['python'], sentiment: 'positive', topic: 'Programming' } },
  ],
}

describe('ChatGPT export parsing', () => {
  it('detects both shapes', () => {
    expect(detectChatGptFormat(exportFixture)).toBe('export')
    expect(detectChatGptFormat(preparedFixture)).toBe('prepared')
    expect(detectChatGptFormat({ foo: 1 })).toBeNull()
  })

  it('walks the active branch, drops system/hidden/empty nodes, keeps order and times', () => {
    const [garden, code] = parseChatGptExport(exportFixture)
    expect(garden.title).toBe('Planning a garden')
    expect(garden.sourceId).toBe('conv-1')
    expect(garden.model).toBe('gpt-4o')
    expect(garden.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'What should I plant in spring?'],
      ['assistant', 'Peas and lettuce.'],
    ])
    expect(garden.messages[0].at).toBe(new Date(1_700_000_010_000).toISOString())
    expect(garden.createdAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(code.messages[1].content).toBe('```python\nfor i in range(3): pass\n```')
  })

  it('reads prepared records into metadata without messages', () => {
    const { format, conversations } = parseChatGpt(preparedFixture)
    expect(format).toBe('prepared')
    expect(conversations[0]).toMatchObject({ title: 'Planning a garden', topic: 'Gardening', keywords: ['gardening', 'Spring Vegetables'], sentiment: 'positive', messageCount: 2, charLength: 44 })
    expect(conversations[0].messages).toEqual([])
  })

  it('maps to entities with stable ids, topics, keyword tags, and title links', () => {
    const store = new EntityStore()
    const { conversations } = parseChatGpt(preparedFixture)
    const { entities, topics, linked } = chatGptToEntities('prepared', conversations, { topics: true, keywordsAsTags: true, linkByTitle: [{ id: 'garden-note', label: 'planning a GARDEN' }] })
    store.upsertMany(entities)
    expect(topics).toBe(2)
    expect(linked).toBe(1)
    const convs = store.ofType('conversation')
    expect(convs.length).toBe(2)
    expect(convs[0].tags).toEqual(['chatgpt', 'gardening', 'spring-vegetables'])
    expect(store.ofType('topic').map((t) => t.label).sort()).toEqual(['Gardening', 'Programming'])
    const rels = store.relationships()
    expect(rels.filter((r) => r.type === 'about').length).toBe(2)
    expect(rels.find((r) => r.type === 'discusses')?.target.id).toBe('garden-note')
    // Re-importing updates in place rather than duplicating.
    store.upsertMany(chatGptToEntities('prepared', conversations, { topics: true }).entities)
    expect(store.ofType('conversation').length).toBe(2)
    expect(store.all().filter((e) => !isRelationship(e) && e.type === 'topic').length).toBe(2)
  })

  it('export conversations carry their messages and counts', () => {
    const { format, conversations } = parseChatGpt(exportFixture)
    const { entities } = chatGptToEntities(format, conversations)
    const garden = entities.find((e) => e.label === 'Planning a garden')!
    expect(garden.data.messageCount).toBe(2)
    expect(garden.data.charLength).toBe('What should I plant in spring?'.length + 'Peas and lettuce.'.length)
    expect(garden.data.source).toBe('chatgpt-export')
  })
})
