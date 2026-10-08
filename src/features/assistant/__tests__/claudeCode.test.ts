import { describe, expect, it } from 'vitest'
import { frame } from '../../../../mcp/frame.mjs'
import { artifactRefsOf } from '../../chats/artifacts'
import { bareToolName, ClaudeCodeTurn } from '../claudeCode'
import type { TranscriptItem } from '../session'

/** A sink that keeps the transcript the way the session does. */
function sink() {
  const items: TranscriptItem[] = []
  let n = 0
  const turn = new ClaudeCodeTurn({
    push: (item) => items.push(item),
    patch: (id, patch) => {
      const i = items.findIndex((it) => it.id === id)
      if (i >= 0) items[i] = { ...items[i], ...patch } as TranscriptItem
    },
    uid: () => `i${++n}`,
  })
  return { items, turn }
}

describe('ClaudeCodeTurn', () => {
  it('streams text into one assistant bubble and closes it with the complete message', () => {
    const { items, turn } = sink()
    turn.handle({ type: 'system', subtype: 'init', session_id: 'sess-1' })
    turn.handle({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    turn.handle({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } })
    expect(items).toEqual([{ kind: 'assistant', id: 'i1', text: 'Hel', streaming: true }])
    turn.handle({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } } })
    turn.handle({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } })
    expect(items).toEqual([{ kind: 'assistant', id: 'i1', text: 'Hello', streaming: false }])
    turn.handle({ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'Hello', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 100 } })
    // The result text is the message already shown, not a second bubble.
    expect(items).toHaveLength(1)
    expect(turn.sessionId).toBe('sess-1')
    expect(turn.usage).toEqual({ input: 10, output: 3, cacheRead: 100 })
    expect(turn.error).toBeUndefined()
  })

  it('shows tool calls as running cards and fills them from the tool results', () => {
    const { items, turn } = sink()
    turn.handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__aegraph__search_entities', input: { query: 'ada' } }] } })
    expect(items).toEqual([{ kind: 'tool', id: 'i1', name: 'search_entities', input: { query: 'ada' }, status: 'running', startedAt: expect.any(Number) }])
    turn.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '3 hits' }] }] } })
    expect(items[0]).toMatchObject({ status: 'done', result: '3 hits' })
    turn.handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } }] } })
    turn.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'denied', is_error: true }] } })
    expect(items[1]).toMatchObject({ name: 'Bash', status: 'error', result: 'denied' })
  })

  it('puts a tool card up as its input starts streaming, names it, counts the writing, and fills it when complete', () => {
    const { items, turn } = sink()
    const ev = (event: object) => turn.handle({ type: 'stream_event', event })
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu9', name: 'mcp__aegraph__create_document', input: {} } })
    // Up at once — nothing of the input yet, but the card says a document is being made.
    expect(items).toEqual([{ kind: 'tool', id: 'i1', name: 'create_document', input: {}, status: 'running', startedAt: expect.any(Number), writing: 0 }])
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"title":"Sn' } })
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'akes","content":"# Snakes\\n\\nSnakes are' } })
    expect(items[0]).toMatchObject({ input: { title: 'Snakes' } })
    const body = ' long legless reptiles.'.repeat(200)
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: body } })
    expect((items[0] as { writing?: number }).writing).toBeGreaterThan(body.length)
    ev({ type: 'content_block_stop', index: 1 })
    // The complete message fills the same card — no second one — and the writing count goes.
    turn.handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu9', name: 'mcp__aegraph__create_document', input: { title: 'Snakes', content: '# Snakes' } }] } })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ input: { title: 'Snakes', content: '# Snakes' }, status: 'running', writing: undefined })
    turn.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu9', content: '{"id":"d1"}' }] } })
    expect(items[0]).toMatchObject({ status: 'done', result: '{"id":"d1"}', ms: expect.any(Number) })
  })

  it('keeps a tool result as the tool wrote it — the bridge’s envelope is for the model — and when each call ran', () => {
    // What a real turn looks like: prefixed names, every text block enveloped by the bridge (mcp/frame.mjs).
    const { items, turn } = sink()
    turn.handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__aegraph__create_map', input: { label: 'Trip' } }] } })
    turn.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: frame('create_map', '{"id":"map-1","center":{"lat":20,"lng":0}}') }] }] } })
    expect(items[0]).toMatchObject({ name: 'create_map', status: 'done', result: '{"id":"map-1","center":{"lat":20,"lng":0}}', startedAt: expect.any(Number), ms: expect.any(Number) })
    // So the chat's artifacts are read from it: the map is one, from its result alone.
    const first = artifactRefsOf(items)
    expect(first.map((r) => r.id)).toEqual(['map-1'])
    // A later call puts a place on it: the map is touched again (its latest touch moves on), still one artifact.
    const before = new Map(first.map((r) => [r.id, r.at]))
    const later = Date.now() + 5
    while (Date.now() < later) {
      /* a later millisecond, as a real next call would be */
    }
    turn.handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__aegraph__add_location', input: { map_id: 'map-1', label: 'Oslo', where: 'Oslo' } }] } })
    turn.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: frame('add_location', '{"id":"place-1","onMap":"map-1"}') }] } })
    const after = artifactRefsOf(items)
    expect(after.map((r) => r.id)).toEqual(['map-1'])
    expect(after[0].tool).toBe('add_location')
    expect(after[0].at).not.toBe(before.get('map-1'))
  })

  it('a turn with only a result shows the result; a failed turn reports the error; an interrupted one leaves nothing spinning', () => {
    const a = sink()
    a.turn.handle({ type: 'result', subtype: 'success', result: 'Just this.' })
    expect(a.items).toEqual([{ kind: 'assistant', id: 'i1', text: 'Just this.', streaming: false }])

    const b = sink()
    b.turn.handle({ type: 'result', subtype: 'error_max_turns', is_error: true })
    expect(b.items).toEqual([])
    expect(b.turn.error).toBe('Claude Code ended the turn: error max turns.')

    const c = sink()
    c.turn.handle({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } })
    c.turn.handle({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu9', name: 'mcp__aegraph__open', input: {} }] } })
    c.turn.finish()
    expect(c.items[0]).toMatchObject({ kind: 'assistant', text: 'partial', streaming: false })
    // Not a failure: the call was sent and may have run — the card says the outcome is unknown.
    expect(c.items[1]).toMatchObject({ kind: 'tool', status: 'unknown', result: expect.stringContaining('may have run') })
  })

  it('a call cut off while its input was still arriving keeps what had arrived, not an empty {}', () => {
    const { items, turn } = sink()
    const ev = (event: object) => turn.handle({ type: 'stream_event', event })
    ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu3', name: 'mcp__aegraph__move_document', input: {} } })
    ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"id":"ee14a581-4641' } })
    turn.finish()
    expect(items[0]).toMatchObject({ name: 'move_document', input: {}, partial: '{"id":"ee14a581-4641', status: 'unknown' })
  })

  it('strips the MCP prefix from the app tools only', () => {
    expect(bareToolName('mcp__aegraph__graph_filter')).toBe('graph_filter')
    expect(bareToolName('Read')).toBe('Read')
  })
})
