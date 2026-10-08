import { createEntity, createRelationship } from '../entity/entity'
import type { AnyEntity, EntityId } from '../entity/types'
import { CONVERSATION_TYPE, type ConversationData, type ConversationMessage } from '../../features/conversations/conversation'

/**
 * ChatGPT data, two shapes:
 *
 * - the raw account export (`conversations.json`): an array of
 *   conversations, each a tree of message nodes in `mapping` with
 *   `current_node` pointing at the leaf of the active branch;
 * - the "prepared" analysis file the old aegraph produced from it: one
 *   record per conversation with a summary, keywords, topic and sentiment,
 *   without the messages.
 *
 * Both are parsed here into plain data and turned into entities; nothing
 * is fetched or stored outside the browser.
 */

export type ChatGptFormat = 'export' | 'prepared'

export interface ParsedConversation {
  sourceId?: string
  title: string
  messages: ConversationMessage[]
  createdAt?: string
  updatedAt?: string
  model?: string
  // prepared-only
  summary?: string
  excerpt?: string
  topic?: string
  keywords?: string[]
  sentiment?: string
  messageCount?: number
  charLength?: number
}

/** A time from the export as ISO text, or undefined — including a number no calendar reaches (1e300), on which `toISOString` throws. */
const iso = (t: unknown): string | undefined => {
  const d = typeof t === 'number' && Number.isFinite(t) ? new Date(t > 1e12 ? t : t * 1000) : typeof t === 'string' && t ? new Date(t) : undefined
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined
}

/** How many nodes a conversation's tree is walked through at most: far past any conversation, short of a hang. */
const MAX_WALK = 1_000_000

export function detectChatGptFormat(data: unknown): ChatGptFormat | null {
  if (Array.isArray(data)) return data.length === 0 || data.some((c) => c && typeof c === 'object' && 'mapping' in c) ? 'export' : null
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    if ('mapping' in o && 'title' in o) return 'export'
    if (Array.isArray(o.conversations) && (o.conversations as unknown[]).some((c) => c && typeof c === 'object' && 'metadata' in (c as object))) return 'prepared'
  }
  return null
}

/** Text of one message node; empty for hidden/system scaffolding. */
function messageText(msg: Record<string, unknown>): string {
  const content = msg.content as Record<string, unknown> | string | undefined
  if (!content) return ''
  if (typeof content === 'string') return content
  const type = content.content_type
  if (type === 'code') return `\`\`\`${String(content.language ?? '')}\n${String(content.text ?? '')}\n\`\`\``
  if (type === 'execution_output') return `\`\`\`\n${String(content.text ?? '')}\n\`\`\``
  if (Array.isArray(content.parts)) {
    return content.parts
      .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && 'text' in (p as object) ? String((p as { text: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content.text === 'string') return content.text
  return ''
}

/** One conversation from the export: the active branch, oldest first, hidden and empty nodes dropped. */
export function parseExportConversation(c: Record<string, unknown>): ParsedConversation {
  const raw = c.mapping && typeof c.mapping === 'object' ? (c.mapping as Record<string, unknown>) : {}
  // A node is one of the mapping's own entries that is an object: `constructor` or `__proto__` as an id names nothing.
  const node = (id: unknown): Record<string, unknown> | undefined => {
    if (typeof id !== 'string' || !Object.hasOwn(raw, id)) return undefined
    const n = raw[id]
    return n && typeof n === 'object' ? (n as Record<string, unknown>) : undefined
  }
  const mapping = raw as Record<string, Record<string, unknown>>
  // Walk from the current leaf to the root, then reverse.
  const chain: string[] = []
  const seen = new Set<string>()
  let cur = typeof c.current_node === 'string' ? c.current_node : undefined
  if (!cur || !node(cur)) {
    // No leaf pointer (or one naming a node the mapping lacks): pick the deepest node by following first children from a
    // root — each node once, so children that point back up (a → b → a) end the walk instead of looping for ever.
    const roots = Object.keys(raw).filter((id) => node(id) && !node(id)!.parent)
    let id: string | undefined = roots[0]
    const visited = new Set<string>()
    while (id && !visited.has(id) && visited.size < MAX_WALK) {
      visited.add(id)
      const kids = node(id)?.children
      const next: unknown = Array.isArray(kids) ? kids[0] : undefined
      if (typeof next !== 'string' || !node(next)) break
      id = next
    }
    cur = id
  }
  while (cur && node(cur) && !seen.has(cur) && seen.size < MAX_WALK) {
    seen.add(cur)
    chain.push(cur)
    cur = typeof mapping[cur].parent === 'string' ? (mapping[cur].parent as string) : undefined
  }
  chain.reverse()
  const messages: ConversationMessage[] = []
  let model: string | undefined
  for (const id of chain) {
    const msg = mapping[id].message as Record<string, unknown> | undefined
    if (!msg) continue
    const meta = (msg.metadata ?? {}) as Record<string, unknown>
    if (meta.is_visually_hidden_from_conversation) continue
    const author = (msg.author ?? {}) as Record<string, unknown>
    const role = String(author.role ?? 'unknown')
    const text = messageText(msg).trim()
    if (!text) continue
    if (role === 'system') continue
    if (typeof meta.model_slug === 'string' && !model) model = meta.model_slug
    messages.push({ id, role, content: text, at: iso(msg.create_time), ...(typeof meta.model_slug === 'string' && role === 'assistant' ? { model: meta.model_slug } : {}) })
  }
  return {
    sourceId: typeof c.conversation_id === 'string' ? c.conversation_id : typeof c.id === 'string' ? c.id : undefined,
    title: (typeof c.title === 'string' && c.title.trim()) || 'Untitled conversation',
    messages,
    createdAt: iso(c.create_time) ?? messages[0]?.at,
    updatedAt: iso(c.update_time) ?? messages.at(-1)?.at,
    model: typeof c.default_model_slug === 'string' ? c.default_model_slug : model,
  }
}

export function parseChatGptExport(data: unknown): ParsedConversation[] {
  const list = Array.isArray(data) ? data : [data]
  return list.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && 'mapping' in c).map(parseExportConversation)
}

export function parseChatGptPrepared(data: unknown): ParsedConversation[] {
  const o = data as { conversations?: unknown[] }
  return (o.conversations ?? [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => {
      const meta = (c.metadata ?? {}) as Record<string, unknown>
      return {
        sourceId: c.id != null ? String(c.id) : typeof c.hash === 'string' ? c.hash : undefined,
        title: (typeof c.title === 'string' && c.title.trim()) || 'Untitled conversation',
        messages: [],
        createdAt: iso(c.timestamp),
        summary: typeof meta.summary === 'string' ? meta.summary : undefined,
        excerpt: typeof c.excerpt === 'string' ? c.excerpt : undefined,
        topic: typeof meta.topic === 'string' ? meta.topic : undefined,
        keywords: Array.isArray(meta.keywords) ? meta.keywords.map(String) : undefined,
        sentiment: typeof meta.sentiment === 'string' ? meta.sentiment : undefined,
        messageCount: typeof c.message_count === 'number' ? c.message_count : undefined,
        charLength: typeof c.char_length === 'number' ? c.char_length : undefined,
      }
    })
}

export function parseChatGpt(data: unknown): { format: ChatGptFormat; conversations: ParsedConversation[] } {
  const format = detectChatGptFormat(data)
  if (!format) throw new Error('Not a ChatGPT export: expected conversations.json (an array with `mapping`) or a prepared conversations file.')
  return { format, conversations: format === 'export' ? parseChatGptExport(data) : parseChatGptPrepared(data) }
}

export interface ChatGptImportOptions {
  /** Tag added to everything imported (default `chatgpt`). */
  tag?: string
  /** Also tag each conversation with its keywords (prepared files). */
  keywordsAsTags?: boolean
  /** Create a `topic` entity per topic and link conversations to it (prepared files). */
  topics?: boolean
  /** Link conversations whose title matches an existing entity's label. */
  linkByTitle?: { id: EntityId; label: string }[]
  /** Deterministic ids so re-importing the same export updates in place. */
  idPrefix?: string
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)

/** The entity id a conversation gets from its source id (the ChatGPT conversation uuid), so other data can point at it. */
export const conversationIdFor = (sourceId: string, prefix = 'chatgpt'): EntityId => `${prefix}-${slug(sourceId)}`

/** Entities (and relationships) for a set of parsed conversations. Pure; the caller writes them to the store. */
export function chatGptToEntities(format: ChatGptFormat, conversations: ParsedConversation[], opts: ChatGptImportOptions = {}): { entities: AnyEntity[]; topics: number; linked: number } {
  const tag = opts.tag ?? 'chatgpt'
  const prefix = opts.idPrefix ?? 'chatgpt'
  const out: AnyEntity[] = []
  const topicIds = new Map<string, EntityId>()
  const byLabel = new Map<string, EntityId>()
  for (const t of opts.linkByTitle ?? []) byLabel.set(t.label.trim().toLowerCase(), t.id)
  let linked = 0
  conversations.forEach((c, i) => {
    const id = `${prefix}-${c.sourceId ? slug(c.sourceId) : `${slug(c.title)}-${i}`}`
    const chars = c.charLength ?? c.messages.reduce((n, m) => n + m.content.length, 0)
    const tags = [tag, ...(opts.keywordsAsTags && c.keywords ? c.keywords.map((k) => slug(k)).filter(Boolean) : [])]
    const data: ConversationData = {
      source: format === 'export' ? 'chatgpt-export' : 'chatgpt-prepared',
      sourceId: c.sourceId,
      messages: c.messages,
      messageCount: c.messageCount ?? c.messages.length,
      charLength: chars,
      startedAt: c.createdAt,
      endedAt: c.updatedAt,
      model: c.model,
      summary: c.summary,
      excerpt: c.excerpt,
      topic: c.topic,
      keywords: c.keywords,
      sentiment: c.sentiment,
    }
    for (const k of Object.keys(data) as (keyof ConversationData)[]) if (data[k] === undefined) delete data[k]
    out.push(createEntity<ConversationData>({ id, type: CONVERSATION_TYPE, label: c.title, description: c.summary ?? c.excerpt, tags: [...new Set(tags)], data, meta: { source: 'import:chatgpt', createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt } }))
    if (opts.topics && c.topic) {
      const key = slug(c.topic)
      let tid = topicIds.get(key)
      if (!tid) {
        tid = `${prefix}-topic-${key}`
        topicIds.set(key, tid)
        out.push(createEntity({ id: tid, type: 'topic', label: c.topic, tags: [tag], meta: { source: 'import:chatgpt' } }))
      }
      out.push(createRelationship({ id: `${id}-about`, type: 'about', source: id, target: tid, meta: { source: 'import:chatgpt' } }))
    }
    const match = byLabel.get(c.title.trim().toLowerCase())
    if (match) {
      out.push(createRelationship({ id: `${id}-discusses`, type: 'discusses', source: id, target: match, meta: { source: 'import:chatgpt' } }))
      linked++
    }
  })
  return { entities: out, topics: topicIds.size, linked }
}
