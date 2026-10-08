import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { quoteLabel } from '../../core/entity/entity'
import { chatEntityId } from './record'
import { json } from './toolkit'
import type { AppHost } from './tools'

/**
 * The assistant panel's chats — the tabs — over MCP: list them, open one,
 * start one, close, rename or delete one. Whatever is said in a chat is that
 * chat's; the tools only move between them.
 */
export function createChatTools(host: AppHost) {
  const chat = betaTool({
    name: 'chat',
    description: "The assistant panel's chat tabs — the open project's: a chat belongs to the project open when it started, and with a project open only its chats are listed and in front (switching project brings its own forward; with no project open, every chat). `transcript` returns a chat as Markdown or JSON — every message and tool call with input, full result and timing, the token counts — the material for reviewing how a task went and improving the tools and prompts (the panel's Download transcript button writes the same file). `list` names them (id, title, busy, which is in front, and `entity`: the conversation entity each chat is recorded as in the project, kept up to date as the chat goes on); `new` opens a fresh chat in front; `open` brings `id` to the front; `close` ends `id` and forgets its transcript here (the conversation entity stays); `delete` deletes `id` for good — a chat id or a conversation entity (a recorded chat or an imported transcript): its tab, its transcript and its conversation entity, after the user confirms in the app (what the chat made stays); `rename` gives `id` the `title`; `resume` continues the chat a conversation entity (`id`, one recorded by the assistant — source assistant) holds, in front: its own tab if still open, else a new one seeded from the record with the full transcript, so the conversation goes on where it left off. `artifacts` lists what a chat made or changed — documents, diagrams, maps, scenes, entities, newest first, each with its kind and where it opens (`id`: a chat id or its conversation entity; default the chat in front; kept in the record, so a chat recorded long ago still knows). `show` opens the Chats page (/chats) on chat `id` — continuing a recorded one — and, given `artifact`, opens it in the page's side panel beside the conversation — one of the chat's artifacts or any other entity (a map, a document, a scene…). When the user is on the Chats page (chats_page in the context) and asks to see something, this is how: it stays on the page. The panel, voice control and \"Ask about this\" all talk to the chat in front; the Chats page shows the same chats full size.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'open', 'close', 'rename', 'resume', 'delete', 'transcript', 'artifacts', 'show'] },
        id: { type: 'string', description: 'A chat id (list/open/close/rename/delete/transcript/artifacts/show; transcript and artifacts default to the chat in front), or for `resume` and `delete` (and artifacts/show) the conversation entity (assistant-chat:…, or an imported conversation for delete)' },
        artifact: { type: 'string', description: 'show: the entity to open in the Chats page\'s side panel — one of the chat\'s artifacts (see action artifacts) or any other entity' },
        title: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'json'], description: 'transcript: Markdown (default) — every message and tool call with input, result and timing — or JSON, the same plus the conversation as the API saw it. What the panel\'s Download transcript button writes.' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, id, title, format, artifact }) => {
      const { chats } = await import('./chats') // lazily: the chats hold sessions, which hold these tools
      if (action === 'transcript') {
        const { transcriptJson, transcriptMarkdown } = await import('./transcript')
        const s = id ? chats.get(id) : chats.list().find((t) => t.active) ? chats.get(chats.list().find((t) => t.active)!.id) : undefined
        if (!s) throw new Error(id ? `No chat ${id}. Use chat {action:"list"}.` : 'No chat is open.')
        return format === 'json' ? transcriptJson(s) : transcriptMarkdown(s)
      }
      if (action === 'artifacts' || action === 'show') {
        const { artifactRefsOf, mergeRefs, recordedRefs, resolveArtifacts } = await import('../chats/artifacts')
        const front = chats.list().find((t) => t.active)?.id
        const asked = id ?? front
        if (!asked) throw new Error('No chat is open.')
        // A chat id, or the conversation entity a chat is recorded as.
        const rec = host.store.get(asked)
        const chatId = chats.get(asked) ? asked : rec && typeof rec.data?.sourceId === 'string' && rec.data?.source === 'assistant' ? (rec.data.sourceId as string) : undefined
        if (!chatId) throw new Error(`${asked} is neither a chat nor a chat's record. Use chat {action:"list"}.`)
        const live = chats.get(chatId)
        const refs = mergeRefs(recordedRefs(host.store.get(chatEntityId(chatId))), live ? artifactRefsOf(live.getState().items) : [])
        const found = resolveArtifacts(refs, host.store)
        if (action === 'artifacts') {
          const { artifactPath } = await import('../chats/artifactPath')
          return json({ chat: chatId, artifacts: found.map((a) => ({ id: a.id, kind: a.kind, type: a.entity.type, label: a.entity.label, tool: a.tool, at: a.at, opens: artifactPath(a) })) })
        }
        if (artifact && !host.store.get(artifact)) throw new Error(`No entity ${artifact} to show.`)
        const { showArtifact } = await import('../chats/show')
        if (!(artifact && showArtifact(chatId, artifact))) host.navigate(`/chats/${encodeURIComponent(chatId)}${artifact ? `?artifact=${encodeURIComponent(artifact)}` : ''}`)
        return json({ shown: chatId, ...(artifact ? { artifact } : {}), page: `/chats/${chatId}` })
      }
      const list = () => chats.list().map((t) => ({ id: t.id, title: t.title, busy: t.busy, active: t.active, messages: chats.get(t.id)?.getState().items.filter((i) => i.kind === 'user').length ?? 0, entity: chatEntityId(t.id) }))
      if (action === 'list') return json({ chats: list() })
      if (action === 'new') {
        const s = chats.create()
        if (title?.trim()) chats.rename(s.id, title)
        return json({ opened: s.id, chats: list() })
      }
      if (!id) throw new Error(`${action} needs an id (see chat {action:"list"}).`)
      if (action === 'resume') {
        const s = chats.resume(host.store.get(id))
        if (!s) throw new Error(`${id} is not a conversation recorded by the assistant (source "assistant").`)
        return json({ opened: s.id, messages: s.getState().items.filter((i) => i.kind === 'user').length, chats: list() })
      }
      if (action === 'delete') {
        const rec = host.store.get(id)
        const open = chats.get(id)
        if (!open && !(rec?.type === 'conversation')) throw new Error(`${id} is neither a chat nor a conversation. Use chat {action:"list"} or search_entities.`)
        const title = open ? chats.list().find((t) => t.id === id)?.title : rec?.label
        if (!(await host.confirm(`Delete a chat for good — its transcript and its record in the project (what it made stays) — ${quoteLabel(title || id)}?`, { yes: 'Delete', danger: true }))) return json({ deleted: false, reason: 'The user declined.' })
        const gone = chats.delete(id, host.store)
        return json({ deleted: !!gone, ...gone, chats: list() })
      }
      if (!chats.get(id)) throw new Error(`No chat ${id}. Use chat {action:"list"}.`)
      if (action === 'open') chats.open(id)
      else if (action === 'close') chats.close(id)
      else {
        if (!title?.trim()) throw new Error('rename needs a title.')
        chats.rename(id, title)
      }
      return json({ chats: list() })
    },
  })
  return [chat]
}
