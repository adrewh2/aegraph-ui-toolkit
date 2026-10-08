import { describe, expect, it } from 'vitest'
import { AssistantSession } from '../session'
import { transcriptFilename, transcriptJson, transcriptMarkdown, transcriptTitle } from '../transcript'

/**
 * A chat as a file: the Markdown carries every turn and tool call with
 * input, result (pretty when JSON, cut when huge) and timing, a table of
 * the tools used and the token counts; the JSON carries the same and the
 * API history; the file is named after the chat.
 */
function seeded() {
  const s = new AssistantSession('c1', Date.UTC(2026, 8, 21, 10, 0, 0))
  s.seed(
    [
      { kind: 'user', id: 'u1', text: 'Colour the graph by community' },
      { kind: 'tool', id: 't1', name: 'graph_metrics', input: { metrics: ['community'] }, status: 'done', result: JSON.stringify({ computed: ['community'], nodes: 12 }), startedAt: Date.UTC(2026, 8, 21, 10, 0, 1), ms: 340 },
      { kind: 'tool', id: 't2', name: 'graph_style', input: { channels: [] }, status: 'error', result: 'channel: scope must be "nodes" or "edges"', startedAt: Date.UTC(2026, 8, 21, 10, 0, 2), ms: 5 },
      { kind: 'tool', id: 't3', name: 'graph_style', input: { channels: [{ scope: 'nodes', by: 'all', channel: 'color', mode: 'partition', attr: { kind: 'metric', key: 'community' } }] }, status: 'done', result: 'x'.repeat(70_000), startedAt: Date.UTC(2026, 8, 21, 10, 0, 3), ms: 120 },
      { kind: 'confirm', id: 'q1', message: 'Delete 3 entities?', answer: false },
      { kind: 'question', id: 'q2', message: 'Which palette?', options: ['tableau10', 'viridis'], answer: 'viridis' },
      { kind: 'assistant', id: 'a1', text: 'Done — coloured by community with the viridis palette.', streaming: false },
    ],
    [
      { role: 'user', content: 'Colour the graph by community' },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ],
  )
  return s
}

describe('chat transcript export', () => {
  it('the Markdown has the summary, the tool table, every turn and tool call with input, result and timing', () => {
    const md = transcriptMarkdown(seeded())
    expect(md.startsWith('# Colour the graph by community\n')).toBe(true)
    expect(md).toContain('Chat `c1` · started 2026-09-21T10:00:00.000Z')
    expect(md).toContain('1 user turn · 3 tool calls (1 failed) · 0.5 s in tools')
    expect(md).toContain('| `graph_style` | 2 | 1 | 0.13 s |')
    expect(md).toContain('| `graph_metrics` | 1 |  | 0.34 s |')
    expect(md).toContain('## 1. User\n\nColour the graph by community')
    expect(md).toContain('### 🔧 `graph_metrics` — done in 340 ms · 2026-09-21T10:00:01.000Z')
    // Inputs and JSON results are pretty-printed in fences.
    expect(md).toContain('Input:\n\n```json\n{\n  "metrics": [\n    "community"\n  ]\n}\n```')
    expect(md).toContain('Result:\n\n```json\n{\n  "computed": [\n    "community"\n  ],\n  "nodes": 12\n}\n```')
    expect(md).toContain('### 🔧 `graph_style` — failed in 5 ms')
    expect(md).toContain('Error:\n\n```\nchannel: scope must be "nodes" or "edges"\n```')
    // A huge result is cut, and says so.
    expect(md).toContain('… [cut: 70,000 characters in all; the JSON export has it whole]')
    expect(md).toContain('### ❓ Confirmation\n\n> Delete 3 entities?\n\nAnswer: no')
    expect(md).toContain('### ❓ Question\n\n> Which palette?\n\nOptions: `tableau10`, `viridis`\n\nAnswer: viridis')
    expect(md).toContain('### Assistant\n\nDone — coloured by community with the viridis palette.')
  })

  it('the JSON carries the summary, the items whole and the API history', () => {
    const j = JSON.parse(transcriptJson(seeded()))
    expect(j.$schema).toBe('aegraph/transcript/v1')
    expect(j).toMatchObject({ title: 'Colour the graph by community', chatId: 'c1', turns: 1, toolCalls: 3, toolErrors: 1, toolMs: 465 })
    expect(j.tools).toEqual([
      { name: 'graph_style', calls: 2, errors: 1, ms: 125 },
      { name: 'graph_metrics', calls: 1, errors: 0, ms: 340 },
    ])
    expect(j.items.length).toBe(7)
    expect(j.items[3].result.length).toBe(70_000)
    expect(j.history).toEqual([
      { role: 'user', content: 'Colour the graph by community' },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ])
  })

  it('is named after the chat, the day and the format; a named chat uses its name', () => {
    const s = seeded()
    expect(transcriptTitle(s)).toBe('Colour the graph by community')
    expect(transcriptFilename(s, 'markdown')).toMatch(/^chat-colour-the-graph-by-community-\d{4}-\d{2}-\d{2}\.md$/)
    expect(transcriptFilename(s, 'json')).toMatch(/\.json$/)
    s.rename('Community colours')
    expect(transcriptTitle(s)).toBe('Community colours')
    expect(transcriptFilename(s, 'markdown')).toMatch(/^chat-community-colours-/)
    // An empty chat still exports something sensible.
    const empty = new AssistantSession('c2')
    expect(transcriptMarkdown(empty)).toContain('# Chat\n')
    expect(transcriptFilename(empty, 'markdown')).toMatch(/^chat-chat-/)
  })
})
