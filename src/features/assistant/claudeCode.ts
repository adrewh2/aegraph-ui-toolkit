import { unframe } from '../../../mcp/frame.mjs'
import type { ClaudeEvent } from '../bridge/bridge'
import { CUT_OFF, type TranscriptItem } from './session'

/**
 * A chat turn answered by Claude Code (over the bridge, on the user's
 * subscription) arrives as the events of `claude -p --output-format
 * stream-json --include-partial-messages`. This turns them into the same
 * transcript items the API path produces: assistant text as it streams,
 * tool calls with their results, and the turn's usage at the end.
 */

export interface TurnSink {
  push: (item: TranscriptItem) => void
  patch: (id: string, patch: Partial<TranscriptItem>) => void
  uid: () => string
}

export interface TurnUsage {
  input: number
  output: number
  cacheRead: number
}

/** Tool names come prefixed by the MCP server (`mcp__aegraph__read_document`); the panel knows them bare. */
export const bareToolName = (name: string) => name.replace(/^mcp__aegraph__/, '')

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }

export class ClaudeCodeTurn {
  sessionId?: string
  usage: TurnUsage = { input: 0, output: 0, cacheRead: 0 }
  /** The turn's final text (the `result` event), for a turn that produced no message events. */
  resultText = ''
  error?: string
  /** The assistant item taking the streamed text, until the complete message closes it. */
  private current: { id: string; text: string } | null = null
  private toolItems = new Map<string, string>() // tool_use id → transcript item id
  /** When each tool card started (epoch ms): the transcript's timings, and what tells a chat's artifacts apart by their latest touch. */
  private readonly started = new Map<string, number>()
  private textSeen = false
  /**
   * Tool calls whose input is still streaming, by content-block index: the card goes up when the call starts and
   * counts what has arrived — a document the model is writing into create_document is most of a turn's time, and
   * the card is the only sign it is happening.
   */
  private streaming = new Map<number, { toolUseId: string; itemId: string; chars: number; head: string; named: boolean }>()
  private sink: TurnSink

  constructor(sink: TurnSink) {
    this.sink = sink
  }

  handle(ev: ClaudeEvent) {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && typeof ev.session_id === 'string') this.sessionId = ev.session_id
        return
      case 'stream_event':
        this.streamEvent(ev.event as { type: string; content_block?: Block; delta?: { type: string; text?: string } } | undefined)
        return
      case 'assistant':
        this.assistant(blocksOf(ev))
        return
      case 'user':
        this.toolResults(blocksOf(ev))
        return
      case 'result':
        this.result(ev)
        return
    }
  }

  /** Whatever is still open when the process ends (killed, crashed): nothing is left spinning. */
  finish() {
    if (this.current) {
      this.sink.patch(this.current.id, { streaming: false })
      this.current = null
    }
    for (const id of this.toolItems.values()) this.sink.patch(id, { status: 'unknown', result: CUT_OFF })
    this.toolItems.clear()
  }

  private streamEvent(e: { type: string; index?: number; content_block?: Block; delta?: { type: string; text?: string; partial_json?: string } } | undefined) {
    if (!e) return
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use' && e.content_block.id && typeof e.index === 'number') {
      const b = e.content_block
      const itemId = this.sink.uid()
      this.toolItems.set(b.id!, itemId)
      this.started.set(itemId, Date.now())
      this.streaming.set(e.index, { toolUseId: b.id!, itemId, chars: 0, head: '', named: false })
      // What the call is about shows as soon as its input names it; the full input replaces this when it is complete.
      this.sink.push({ kind: 'tool', id: itemId, name: bareToolName(b.name ?? 'tool'), input: {}, status: 'running', startedAt: Date.now(), writing: 0 })
      return
    }
    if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && typeof e.index === 'number') {
      const s = this.streaming.get(e.index)
      if (!s || !e.delta.partial_json) return
      s.chars += e.delta.partial_json.length
      // The name of what is being made usually comes first in the input: the card says what, not just how much.
      if (!s.named && s.head.length < 600) {
        s.head += e.delta.partial_json
        const m = /"(title|label|name)"\s*:\s*"((?:[^"\\]|\\.){1,120})"/.exec(s.head)
        if (m) {
          s.named = true
          this.sink.patch(s.itemId, { input: { [m[1]]: m[2] }, writing: s.chars, partial: s.head })
          return
        }
        // Until the whole input is here, its start is kept on the card: a call cut off mid-write still says what it was about.
        this.sink.patch(s.itemId, { writing: s.chars, partial: s.head })
        return
      }
      this.sink.patch(s.itemId, { writing: s.chars })
      return
    }
    if (e.type === 'content_block_stop' && typeof e.index === 'number') {
      this.streaming.delete(e.index)
      return
    }
    if (e.type === 'content_block_start' && e.content_block?.type === 'text') this.open(e.content_block.text ?? '')
    else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
      if (!this.current) this.open('')
      this.current!.text += e.delta.text
      this.sink.patch(this.current!.id, { text: this.current!.text })
    }
  }

  private open(text: string) {
    // A second text block in one message continues the same bubble.
    if (this.current) {
      if (this.current.text && text) this.current.text += '\n\n'
      this.current.text += text
      this.sink.patch(this.current.id, { text: this.current.text })
      return
    }
    const id = this.sink.uid()
    this.current = { id, text }
    this.textSeen = true
    this.sink.push({ kind: 'assistant', id, text, streaming: true })
  }

  /** The complete message: its text closes the streaming bubble (or makes one), its tool uses become running cards. */
  private assistant(blocks: Block[]) {
    const text = blocks
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n\n')
    if (text) {
      this.textSeen = true
      if (this.current) this.sink.patch(this.current.id, { text, streaming: false })
      else this.sink.push({ kind: 'assistant', id: this.sink.uid(), text, streaming: false })
      this.current = null
    }
    for (const b of blocks) {
      if (b.type !== 'tool_use' || !b.id) continue
      // Its card went up while the input streamed: the complete input fills it.
      const early = this.toolItems.get(b.id)
      if (early) {
        this.sink.patch(early, { input: b.input, writing: undefined, partial: undefined })
        continue
      }
      const id = this.sink.uid()
      this.toolItems.set(b.id, id)
      this.sink.push({ kind: 'tool', id, name: bareToolName(b.name ?? 'tool'), input: b.input, status: 'running', startedAt: Date.now() })
      this.started.set(id, Date.now())
    }
  }

  private toolResults(blocks: Block[]) {
    for (const b of blocks) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue
      const id = this.toolItems.get(b.tool_use_id)
      if (!id) continue
      this.toolItems.delete(b.tool_use_id)
      const t0 = this.started.get(id)
      this.started.delete(id)
      this.sink.patch(id, { status: b.is_error ? 'error' : 'done', result: resultText(b.content), ...(t0 ? { ms: Date.now() - t0 } : {}) })
    }
  }

  private result(ev: ClaudeEvent) {
    if (typeof ev.session_id === 'string') this.sessionId = ev.session_id
    const u = ev.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined
    if (u) this.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 }
    if (typeof ev.result === 'string') this.resultText = ev.result
    if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) this.error = typeof ev.result === 'string' && ev.result ? ev.result : `Claude Code ended the turn: ${String(ev.subtype ?? 'error').replace(/_/g, ' ')}.`
    // A turn whose only output is the result text (a resumed session's short answer) still shows it.
    if (this.resultText && !this.error && !this.textSeen) this.sink.push({ kind: 'assistant', id: this.sink.uid(), text: this.resultText, streaming: false })
    this.finish()
  }
}

function blocksOf(ev: ClaudeEvent): Block[] {
  const m = ev.message as { content?: unknown } | undefined
  return Array.isArray(m?.content) ? (m!.content as Block[]) : []
}

/** A tool result's content — a string, or text blocks — as one string for the card. */
function resultText(content: unknown): string {
  return rawResultText(content)
}

/**
 * The bridge hands every tool result to Claude Code inside an <untrusted_data> envelope — that is for the model. The
 * transcript holds the result as the tool wrote it: what the card shows, what the artifacts are read from.
 */
function rawResultText(content: unknown): string {
  // Each text block is enveloped on its own.
  if (typeof content === 'string') return unframe(content)
  if (Array.isArray(content))
    return content
      .map((b: Block) => (b.type === 'text' ? unframe(b.text ?? '') : b.type === 'image' ? '[image]' : JSON.stringify(b)))
      .join('\n')
  return content === undefined ? '' : JSON.stringify(content)
}
