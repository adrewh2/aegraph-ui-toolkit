import { MessagesSquare } from 'lucide-react'
import { defineEntityType, type EntityTypeDef } from '../../core/entity/schema'
import { isRelationship, type AnyEntity, type Entity, type EntityData } from '../../core/entity/types'
import { formatNumber } from '../../lib/format'

export const CONVERSATION_TYPE = 'conversation'

export interface ConversationMessage {
  id?: string
  role: 'user' | 'assistant' | 'system' | 'tool' | string
  content: string
  /** ISO timestamp. */
  at?: string
  model?: string
}

export interface ConversationData extends EntityData {
  /** Where it came from: `chatgpt-export`, `chatgpt-prepared`, … */
  source: string
  /** The id in the source system, when known. */
  sourceId?: string
  messages: ConversationMessage[]
  messageCount: number
  charLength: number
  startedAt?: string
  endedAt?: string
  model?: string
  /** From prepared (analysed) exports. */
  summary?: string
  excerpt?: string
  topic?: string
  keywords?: string[]
  sentiment?: string
  /**
   * A chat with the assistant: what it made or changed as the chat went on (documents, diagrams, maps, scenes,
   * entities), latest touch last — the Chats page's artifacts panel. Kept whole, unlike the tool calls in
   * `messages`, whose results are cut short. (`src/features/chats/artifacts.ts`.)
   */
  artifacts?: { id: string; tool: string; at?: string }[]
  /** From a linked conversation atlas: the segments the pipeline cut this conversation into, with their facets. */
  atlas?: {
    segments: { id: string; index: number; label: string; summary?: string; messages?: number; region?: string; cluster?: string; topics: string[]; domains: string[] }[]
    regions: string[]
    clusters: string[]
  }
}

export type ConversationEntity = Entity<ConversationData>

export const isConversation = (e: AnyEntity | undefined): e is ConversationEntity => !!e && !isRelationship(e) && e.type === CONVERSATION_TYPE && Array.isArray(e.data.messages)

export const conversationType: EntityTypeDef = defineEntityType({
  type: CONVERSATION_TYPE,
  category: 'resource',
  label: 'Conversation',
  pluralLabel: 'Conversations',
  icon: MessagesSquare,
  color: '#10a37f',
  description: 'A chat transcript — from a ChatGPT export, loaded locally from a file. Messages are kept in order with their roles and times.',
  fields: [
    { key: 'data.messageCount', label: 'Messages', kind: 'number', width: 90 },
    { key: 'data.topic', label: 'Topic', kind: 'text', editable: true, width: 160 },
    { key: 'data.summary', label: 'Summary', kind: 'longtext', editable: true, width: 320 },
    { key: 'data.startedAt', label: 'Started', kind: 'date', width: 110 },
    { key: 'data.model', label: 'Model', kind: 'text', width: 140, hidden: true },
    { key: 'data.charLength', label: 'Length', kind: 'number', width: 90, hidden: true, format: (v) => (typeof v === 'number' ? `${formatNumber(v)} chars` : '') },
    { key: 'data.sentiment', label: 'Sentiment', kind: 'text', width: 100, hidden: true },
    { key: 'data.source', label: 'Source', kind: 'text', width: 130, hidden: true },
  ],
})

/** When a message was sent, in words: nothing at all when there is no timestamp, or when it is not a time. */
export const messageTime = (at: string | undefined): string | undefined => {
  if (!at) return undefined
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString()
}

/** Plain Markdown of the transcript, for export, search, and the assistant. */
export function transcriptMarkdown(c: ConversationEntity): string {
  const lines = [`# ${c.label ?? 'Conversation'}`, '']
  for (const m of c.data.messages) {
    const when = messageTime(m.at)
    lines.push(`## ${roleLabel(m.role)}${when ? ` · ${when}` : ''}`, '', m.content, '')
  }
  return lines.join('\n')
}

export const roleLabel = (role: string) => (role === 'user' ? 'You' : role === 'assistant' ? 'Assistant' : role === 'system' ? 'System' : role === 'tool' ? 'Tool' : role.charAt(0).toUpperCase() + role.slice(1))
