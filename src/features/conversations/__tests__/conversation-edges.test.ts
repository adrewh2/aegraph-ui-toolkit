import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { conversationIdFor } from '../../../core/exchange/chatgpt'
import { CONVERSATION_TYPE, isConversation, roleLabel, transcriptMarkdown, type ConversationEntity, type ConversationMessage } from '../conversation'
import { withAtlasLinks } from '../linkAtlas'

/**
 * Conversations at their edges: what counts as one, what a transcript
 * makes of a chat with no messages, a message with no text, a role
 * nobody named, times that are equal, missing or not times at all,
 * markdown inside a message, a very long one, a thousand for time — and
 * the atlas join when the segments arrive before the conversations, when
 * they arrive after, and when there is nothing to join.
 */
const conv = (messages: ConversationMessage[], over: Partial<{ id: string; label: string }> = {}) =>
  createEntity({ id: over.id ?? 'c1', type: CONVERSATION_TYPE, label: over.label, data: { source: 'chatgpt-export', messages, messageCount: messages.length, charLength: messages.reduce((n, m) => n + m.content.length, 0) } }) as ConversationEntity

describe('isConversation', () => {
  it('wants the type and messages it can walk, and nothing else passes', () => {
    expect(isConversation(conv([{ role: 'user', content: 'hi' }]))).toBe(true)
    expect(isConversation(conv([]))).toBe(true) // a chat with nothing said is still a chat
    expect(isConversation(undefined)).toBe(false)
    expect(isConversation(createEntity({ id: 'n', type: 'note' }))).toBe(false)
    expect(isConversation(createEntity({ id: 'c', type: CONVERSATION_TYPE }))).toBe(false) // the type alone: no messages to read
    expect(isConversation(createEntity({ id: 'c', type: CONVERSATION_TYPE, data: { messages: 'lots' } }))).toBe(false)
    expect(isConversation(createRelationship({ id: 'r', type: CONVERSATION_TYPE, source: 'a', target: 'b', data: { messages: [] } }))).toBe(false)
  })
})

describe('roleLabel', () => {
  it('names the roles the app knows and capitalises the ones it does not', () => {
    expect(['user', 'assistant', 'system', 'tool'].map(roleLabel)).toEqual(['You', 'Assistant', 'System', 'Tool'])
    expect(roleLabel('function')).toBe('Function')
    expect(roleLabel('ORACLE')).toBe('ORACLE')
    expect(roleLabel('')).toBe('') // nothing to name, and nothing thrown
  })
})

describe('transcriptMarkdown', () => {
  it('writes a heading and nothing else for a conversation with no messages, and names an unlabelled one', () => {
    expect(transcriptMarkdown(conv([], { label: 'Planning' }))).toBe('# Planning\n')
    expect(transcriptMarkdown(conv([]))).toBe('# Conversation\n')
  })

  it('keeps a message with no text as its heading, and a role it does not know as itself', () => {
    const md = transcriptMarkdown(conv([{ role: 'user', content: '' }, { role: 'oracle', content: 'Soon.' }]))
    expect(md).toBe('# Conversation\n\n## You\n\n\n\n## Oracle\n\nSoon.\n')
  })

  it('leaves what a message said exactly as it was said, markdown and code and all', () => {
    const body = '## Not a speaker\n\n```ts\nconst a = 1 // ## nor this\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    const md = transcriptMarkdown(conv([{ role: 'assistant', content: body }]))
    expect(md).toContain(body) // a transcript is Markdown, so a message's own Markdown is its own
    expect(md.startsWith('# Conversation\n\n## Assistant\n\n')).toBe(true)
  })

  it('keeps the order it was given, whatever the times say, and prints no time when there is none', () => {
    const md = transcriptMarkdown(
      conv([
        { role: 'user', content: 'third by the clock', at: '2024-03-01T00:00:00.000Z' },
        { role: 'assistant', content: 'first by the clock', at: '2024-01-01T00:00:00.000Z' },
        { role: 'user', content: 'no clock at all' },
      ]),
    )
    const said = [...md.matchAll(/^(third|first|no) .*/gm)].map((m) => m[0])
    expect(said).toEqual(['third by the clock', 'first by the clock', 'no clock at all']) // the array is the order; nothing is sorted
    expect(md).toMatch(/## You · .+\n\nthird by the clock/)
    expect(md).toContain('## You\n\nno clock at all')
  })

  it('says nothing about a time it cannot read', () => {
    const md = transcriptMarkdown(conv([{ role: 'user', content: 'when?', at: 'not a time' }]))
    expect(md).not.toContain('Invalid Date')
    expect(md).toContain('## You\n\nwhen?')
  })

  it('carries a very long message whole, and a thousand messages quickly', () => {
    const long = 'x'.repeat(200_000)
    expect(transcriptMarkdown(conv([{ role: 'user', content: long }]))).toContain(long)
    const many = Array.from({ length: 1000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i} `.repeat(20), at: '2024-01-01T00:00:00.000Z' }))
    const t0 = performance.now()
    const md = transcriptMarkdown(conv(many))
    const ms = performance.now() - t0
    expect(md.match(/^## /gm)).toHaveLength(1000)
    expect(ms).toBeLessThan(400) // generous: one pass, single-digit milliseconds unloaded
  })
})

describe('withAtlasLinks', () => {
  const segment = (id: string, index: number, conversationId: string) =>
    createEntity({ id, type: 'segment', label: id, data: { conversation_id: conversationId, segment_index: index, facets: { topic: ['planning'] } } })
  const conversation = (sourceId: string) => createEntity({ id: conversationIdFor(sourceId), type: CONVERSATION_TYPE, label: sourceId, data: { source: 'chatgpt-export', messages: [], messageCount: 0, charLength: 0 } })

  it('joins a batch of segments to the conversations already in the store', () => {
    const store = new EntityStore()
    store.upsert(conversation('C-1'))
    const out = withAtlasLinks(store, [segment('s1', 0, 'C-1'), segment('s2', 1, 'C-1')])
    expect(out.note).toContain('linked 1 conversations')
    expect(out.entities.filter((e) => e.kind === 'relationship').map((r) => r.type)).toEqual(['segment-of', 'segment-of'])
    // The conversation was not in the batch, so it comes along carrying the atlas it has just been given.
    const c = out.entities.find((e) => e.id === conversationIdFor('C-1'))!
    expect((c.data.atlas as { segments: { id: string }[] }).segments.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('joins the other way round too: conversations arriving to segments already held', () => {
    const store = new EntityStore()
    store.upsertMany([segment('s1', 0, 'C-1')])
    const batch = [conversation('C-1')]
    const out = withAtlasLinks(store, batch)
    expect(out.note).toContain('linked 1 conversations')
    const c = out.entities.find((e) => e.id === conversationIdFor('C-1'))!
    expect(c).not.toBe(batch[0]) // the batch's own row is replaced by the one carrying the atlas
    expect((c.data.atlas as { segments: unknown[] }).segments).toHaveLength(1)
  })

  it('hands the batch back untouched when there is nothing on the other side', () => {
    const store = new EntityStore()
    const batch = [conversation('C-1')]
    expect(withAtlasLinks(store, batch)).toEqual({ entities: batch })
    const orphan = withAtlasLinks(store, [segment('s1', 0, 'C-9')])
    expect(orphan.note).toBeUndefined()
    expect(orphan.entities).toHaveLength(1)
    expect(withAtlasLinks(store, [])).toEqual({ entities: [] })
  })
})
