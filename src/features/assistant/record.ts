import { getAiSettings } from '../../core/ai/settings'
import { createEntity } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import { CONVERSATION_TYPE, isConversation, type ConversationData, type ConversationMessage } from '../conversations/conversation'
import type Anthropic from '@anthropic-ai/sdk'
import type { AssistantSession, TranscriptItem } from './session'
import { artifactRefsOf, mergeRefs, recordedRefs } from '../chats/artifacts'
import { chatEntityId } from './chatIds'
import type { Attachment } from './attachments'

/**
 * A chat as an entity: every conversation with the assistant is a
 * `conversation` (source `assistant`) in the entity system, in the project
 * that was open when it started, kept up to date as the chat goes on — so
 * it is browsed, searched, linked and exported like any other transcript
 * (the ChatGPT ones included). Closing the tab keeps the record.
 */

export const CHAT_TAG = 'assistant:chat'
/** The entity a chat is recorded as; stable, so updates land on the same one. */
export { chatEntityId }

const RESULT_CHARS = 400
/** A stopped turn in the record: a system line of its own, read back as the quiet marker it was. */
const STOPPED = 'Stopped by the user.'
const NOT_ANSWERED = ' — not answered: the chat was stopped'

/** An attachment in a recorded message: a line of its own after the words, read back by `rebuildChat`. */
const attachedLine = (a: Attachment) => `[attached ${a.kind}: ${a.label.replace(/[\]\n]/g, ' ')} · ${a.id}]`
const ATTACHED = /^\[attached (image|document|dataset): (.*) · ([^\s\]]+)\]$/

/** A recorded user message split back into its words and what was attached to it. */
export function splitAttached(content: string): { text: string; attachments: Attachment[] } {
  const lines = content.split('\n')
  const attachments: Attachment[] = []
  while (lines.length) {
    const m = ATTACHED.exec(lines[lines.length - 1])
    if (!m) break
    attachments.unshift({ kind: m[1] as Attachment['kind'], label: m[2], id: m[3] })
    lines.pop()
  }
  return { text: lines.join('\n').trimEnd(), attachments }
}

/** The transcript as conversation messages: what was said, and what was done (tool calls, compactly). */
export function messagesOf(items: TranscriptItem[]): ConversationMessage[] {
  const out: ConversationMessage[] = []
  for (const it of items) {
    if (it.kind === 'user') out.push({ id: it.id, role: 'user', content: [it.text, ...(it.attachments ?? []).map(attachedLine)].filter(Boolean).join('\n') })
    else if (it.kind === 'assistant') {
      if (it.text.trim()) out.push({ id: it.id, role: 'assistant', content: it.text })
    } else if (it.kind === 'tool') {
      const input = JSON.stringify(it.input ?? {})
      const result = it.result === undefined ? '' : it.result.length > RESULT_CHARS ? `${it.result.slice(0, RESULT_CHARS)}…` : it.result
      out.push({ id: it.id, role: 'tool', content: `${it.name} ${input.length > RESULT_CHARS ? `${input.slice(0, RESULT_CHARS)}…` : input}${result ? `\n→ ${result}` : ''}${it.status === 'error' ? ' (failed)' : it.status === 'unknown' ? ' (outcome unknown: the chat lost its answer)' : ''}` })
    } else if (it.kind === 'confirm') out.push({ id: it.id, role: 'system', content: `${it.message}${it.stopped ? NOT_ANSWERED : it.answer === undefined ? '' : it.answer ? ' — confirmed' : ' — declined'}` })
    else if (it.kind === 'question') out.push({ id: it.id, role: 'system', content: `${it.message} [${it.options.join(' / ')}]${it.stopped ? NOT_ANSWERED : it.answer === undefined ? '' : it.answer === null ? ' — declined' : ` — chose ${it.answer}`}` })
    else if (it.kind === 'error') out.push({ id: it.id, role: 'system', content: `Error: ${it.text}` })
    else if (it.kind === 'stopped') out.push({ id: it.id, role: 'system', content: STOPPED })
  }
  return out
}

/**
 * Write (or rewrite) the chat's conversation entity. Nothing is written for a chat nobody has spoken in. A new
 * record goes into the chat's own project (`project`: where it started; null, the Library) — not whichever is open
 * when the record is first written, a second later — and without one is stamped with the open project by the store;
 * a later write keeps the project the record started in.
 */
export function recordChat(store: EntityStore, session: AssistantSession, at = new Date().toISOString(), project?: string | null): boolean {
  const items = session.getState().items
  if (!items.some((it) => it.kind === 'user')) return false
  const messages = messagesOf(items)
  const id = chatEntityId(session.id)
  const cur = store.get(id)
  const model = getAiSettings().model
  const data: ConversationData = {
    ...(isConversation(cur) ? cur.data : {}),
    source: 'assistant',
    sourceId: session.id,
    messages,
    messageCount: messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
    charLength: messages.reduce((n, m) => n + m.content.length, 0),
    startedAt: isConversation(cur) && cur.data.startedAt ? cur.data.startedAt : new Date(session.createdAt).toISOString(),
    endedAt: at,
    model: isConversation(cur) && cur.data.model ? cur.data.model : model,
    ...(session.claudeSessionId ? { claudeSession: session.claudeSessionId } : {}),
  }
  // What the chat made or changed, whole: the record's own list (a resumed chat's earlier turns) with this session's on top.
  const artifacts = mergeRefs(recordedRefs(cur), artifactRefsOf(items))
  if (artifacts.length) data.artifacts = artifacts
  const label = session.title()
  if (cur) {
    if (isConversation(cur) && cur.label === label && sameMessages(cur.data.messages, messages) && sameRefs(cur.data.artifacts, data.artifacts)) return false
    store.update(id, { label, data })
    return true
  }
  store.upsert(createEntity<ConversationData>({ id, type: CONVERSATION_TYPE, label, tags: [CHAT_TAG], data, meta: { source: 'assistant', ...(project ? { projects: [project] } : {}) } }))
  return true
}

function sameRefs(a: ConversationData['artifacts'], b: ConversationData['artifacts']): boolean {
  const x = a ?? [], y = b ?? []
  return x.length === y.length && x.every((r, i) => r.id === y[i].id && r.tool === y[i].tool && r.at === y[i].at)
}

function sameMessages(a: ConversationMessage[], b: ConversationMessage[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i].role !== b[i].role || a[i].content !== b[i].content) return false
  return true
}

/**
 * A recorded chat back into a chat: the transcript items as they were shown, and the API history rebuilt from what
 * was said. Tool calls come back as cards (name, input, the short result that was kept) and, for the model, as a
 * note in the assistant's turn — the original tool_use/tool_result pairs are gone with their ids. Turns are merged
 * so the history alternates user / assistant, as the API requires.
 */
export function rebuildChat(messages: ConversationMessage[]): { items: TranscriptItem[]; history: Anthropic.Beta.BetaMessageParam[] } {
  const items: TranscriptItem[] = []
  const history: Anthropic.Beta.BetaMessageParam[] = []
  let n = 0
  const uid = (m: ConversationMessage) => m.id ?? `r${(n++).toString(36)}`
  const addTurn = (role: 'user' | 'assistant', text: string) => {
    const last = history.at(-1)
    if (last && last.role === role && typeof last.content === 'string') last.content = `${last.content}\n\n${text}`
    else history.push({ role, content: text })
  }
  for (const m of messages) {
    if (m.role === 'user') {
      const { text, attachments } = splitAttached(m.content)
      items.push({ kind: 'user', id: uid(m), text, ...(attachments.length ? { attachments } : {}) })
      addTurn('user', m.content)
    } else if (m.role === 'assistant') {
      items.push({ kind: 'assistant', id: uid(m), text: m.content, streaming: false })
      addTurn('assistant', m.content)
    } else if (m.role === 'tool') {
      const [head, ...rest] = m.content.split('\n→ ')
      const sp = head.indexOf(' ')
      const name = sp > 0 ? head.slice(0, sp) : head
      let input: unknown = {}
      try {
        input = JSON.parse(sp > 0 ? head.slice(sp + 1).replace(/…$/, '') : '{}')
      } catch {
        input = sp > 0 ? head.slice(sp + 1) : {}
      }
      const failed = / \(failed\)$/.test(m.content)
      const result = rest.length ? rest.join('\n→ ').replace(/ \(failed\)$/, '') : undefined
      items.push({ kind: 'tool', id: uid(m), name, input, status: failed ? 'error' : 'done', ...(result !== undefined ? { result } : {}) })
      addTurn('assistant', `(used ${name}${result ? `: ${result.slice(0, 200)}` : ''})`)
    } else if (m.role === 'system') items.push(m.content === STOPPED ? { kind: 'stopped', id: uid(m) } : { kind: 'error', id: uid(m), text: m.content })
  }
  // The next message is a user turn: a history that ends on one would put two in a row.
  if (history.at(-1)?.role === 'user') history.push({ role: 'assistant', content: '(the chat was resumed here)' })
  return { items, history }
}
