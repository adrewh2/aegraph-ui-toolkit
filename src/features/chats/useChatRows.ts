import { useMemo, useSyncExternalStore } from 'react'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import { chats, useChats } from '../assistant/chats'
import { chatEntityId } from '../assistant/record'
import { CONVERSATION_TYPE, isConversation, type ConversationEntity } from '../conversations/conversation'
import { displayLabel } from '../../core/entity/entity'
import type { EntityStore, StoreEvent } from '../../core/entity/store'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { artifactRefsOf, mergeRefs, recordedRefs, resolveArtifacts, type ArtifactKind, type ChatArtifact } from './artifacts'

const recentOf = (list: ChatArtifact[]) => list.slice(0, 4).map((a) => ({ id: a.id, label: displayLabel(a.entity), kind: a.kind, ...(a.at ? { at: a.at } : {}) }))

/** One chat, as the list and the landing page show it: open in this browser, recorded in the Library, or imported. */
export interface ChatRow {
  key: string
  /** Where it goes: `/chats/<chat id>` for the assistant's chats, `/chats/<entity id>` for a recorded or imported one. */
  to: string
  title: string
  at?: string
  messages: number
  open: boolean
  busy: boolean
  imported: boolean
  /** The kinds of what it made, newest first (the landing's cards show them). */
  made: ArtifactKind[]
  /** Its newest artifacts, for the landing's Recently made. */
  recent: { id: string; label: string; kind: ArtifactKind; at?: string }[]
  /** The last thing the assistant said, flattened to one line. */
  last?: string
  /** The assistant chat it is (its id in the panel's tabs), for the assistant's own. */
  chat?: string
}

/** Markdown to a line of plain text: enough to recognise an answer by, not to render it. */
const flat = (md: string) =>
  md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Newest first by `at` (ISO strings compare as text; none last). */
const newerFirst = (a: ChatRow, b: ChatRow) => (a.at === b.at ? 0 : a.at === undefined ? 1 : b.at === undefined ? -1 : a.at < b.at ? 1 : -1)

/** Where `row` goes in a list sorted `newerFirst`: after every row at least as new. */
function insertAt(list: ChatRow[], row: ChatRow): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (newerFirst(list[mid], row) <= 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Where `row` is in a list sorted `newerFirst`: the run of rows with its `at`, searched for it. */
function indexIn(list: ChatRow[], row: ChatRow): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (newerFirst(list[mid], row) < 0) lo = mid + 1
    else hi = mid
  }
  for (let i = lo; i < list.length && newerFirst(list[i], row) === 0; i++) if (list[i] === row) return i
  return list.indexOf(row)
}

/** The row a recorded or imported conversation reads as. */
function rowOf(c: ConversationEntity, store: EntityStore): ChatRow {
  const mine = c.data.source === 'assistant' && typeof c.data.sourceId === 'string'
  // Only the assistant's own chats get a preview and artifacts: an imported library can hold hundreds of thousands.
  const lastSaid = mine ? [...(c.data.messages ?? [])].reverse().find((m) => m.role === 'assistant') : undefined
  const resolved = mine ? resolveArtifacts(recordedRefs(c), store) : []
  return {
    key: c.id,
    to: `/chats/${c.id}`,
    title: c.label || 'Untitled chat',
    at: c.data.endedAt ?? c.data.startedAt,
    messages: c.data.messageCount ?? 0,
    open: false,
    busy: false,
    imported: !mine,
    made: resolved.map((a) => a.kind),
    recent: recentOf(resolved),
    ...(mine ? { chat: c.data.sourceId } : {}),
    ...(lastSaid ? { last: flat(lastSaid.content).slice(0, 180) } : {}),
  }
}

/** Past this many entities in one write, the index is built again rather than patched. */
const PATCH_LIMIT = 5000

/**
 * The open project's recorded and imported conversations as rows, newest first, split as the list shows them — the
 * assistant's own chats and imported transcripts — and kept by the store's events: a write moves only the
 * conversations it touched (by binary search on their date). One per store, shared by every Chats page.
 *
 * The WildChat atlas holds 489,700 imported conversations. Listed again after every write — a walk of all of them and
 * a sort with `localeCompare` — each chat turn's record froze the tab for 0.7–0.9 s, on the Chats page and wherever
 * else it was kept open; talking in a chat was slow because the chat itself wrote.
 */
class ChatIndex {
  mine: ChatRow[] = []
  imported: ChatRow[] = []
  private rows = new Map<EntityId, ChatRow>()
  private built = false
  private listeners = new Set<() => void>()
  version = 0
  private readonly store: EntityStore

  constructor(store: EntityStore) {
    this.store = store
    store.subscribe((ev) => {
      if (!this.built) return
      if (this.apply(ev)) this.changed()
    })
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  getVersion = () => {
    this.ensure()
    return this.version
  }

  private changed() {
    this.version++
    this.listeners.forEach((l) => l())
  }

  private ensure() {
    if (this.built) return
    this.built = true
    const mine: ChatRow[] = []
    const imported: ChatRow[] = []
    this.rows.clear()
    for (const e of this.store.ofType(CONVERSATION_TYPE)) {
      if (!isConversation(e)) continue
      const row = rowOf(e, this.store)
      this.rows.set(e.id, row)
      ;(row.imported ? imported : mine).push(row)
    }
    this.mine = mine.sort(newerFirst)
    this.imported = imported.sort(newerFirst)
  }

  /** A store event, applied: whether any row changed. */
  private apply(ev: StoreEvent): boolean {
    const written: AnyEntity[] = []
    const removed: EntityId[] = []
    let rebuild = false
    const collect = (e: StoreEvent) => {
      if (e.type === 'upsert') written.push(...e.entities)
      else if (e.type === 'remove') removed.push(...e.ids)
      else if (e.type === 'batch') e.events.forEach(collect)
      else if (e.type === 'reset' || e.type === 'scope') rebuild = true
    }
    collect(ev)
    if (rebuild || written.length + removed.length > PATCH_LIMIT) {
      this.built = false
      this.ensure()
      return true
    }
    let any = false
    for (const id of removed) any = this.take(id) || any
    for (const e of written) {
      const had = this.rows.get(e.id)
      const belongs = isConversation(e) && this.store.matches(e, { type: CONVERSATION_TYPE })
      if (!belongs) {
        if (had) any = this.take(e.id) || any
        continue
      }
      this.take(e.id)
      const row = rowOf(e as ConversationEntity, this.store)
      this.rows.set(e.id, row)
      const list = row.imported ? (this.imported = this.imported.slice()) : (this.mine = this.mine.slice())
      list.splice(insertAt(list, row), 0, row)
      any = true
    }
    return any
  }

  /** Take a conversation's row out; whether it had one. */
  private take(id: EntityId): boolean {
    const row = this.rows.get(id)
    if (!row) return false
    this.rows.delete(id)
    const key = row.imported ? 'imported' : 'mine'
    const list = this[key].slice()
    const i = indexIn(list, row)
    if (i >= 0) list.splice(i, 1)
    this[key] = list
    return true
  }
}

const indexes = new WeakMap<EntityStore, ChatIndex>()
const indexOf = (store: EntityStore) => {
  let i = indexes.get(store)
  if (!i) indexes.set(store, (i = new ChatIndex(store)))
  return i
}

/** The chats, as the list groups them: open in this browser, the assistant's own recorded ones, and imported ones. */
export interface ChatGroups {
  open: ChatRow[]
  earlier: ChatRow[]
  imported: ChatRow[]
}

/**
 * The open project's chats, newest activity first (every chat, in the Library), in the list's groups.
 *
 * A running chat changes many times a second, so the open chats are keyed on what a row shows of them (title, busy),
 * not on every token; the recorded and imported ones come from the store's chat index (`ChatIndex`), which a write
 * patches. The same arrays come back while nothing a row shows has changed, so a memoised list skips its render.
 */
export function useChatRows(): ChatGroups {
  const store = useEntityStore()
  const index = indexOf(store)
  const indexVersion = useSyncExternalStore(index.subscribe, index.getVersion, index.getVersion)
  // The open chats' own rows read their records (the artifacts, the last change): a few tabs, on the store's version.
  const version = useStoreVersion(store)
  const { tabs } = useChats()
  const tabsKey = tabs.map((t) => `${t.id}\u0001${t.title}\u0001${t.busy ? 1 : 0}\u0001${t.blank ? 1 : 0}`).join('\u0002')
  const open = useMemo(() => {
    const out: ChatRow[] = []
    for (const t of tabs) {
      // A new chat nobody has typed in is not listed yet: it becomes a row with its first message.
      if (t.blank) continue
      const rec = store.get(chatEntityId(t.id))
      const items = chats.get(t.id)?.getState().items ?? []
      const lastSaid = [...items].reverse().find((i) => i.kind === 'assistant')
      const resolved = resolveArtifacts(mergeRefs(recordedRefs(rec), artifactRefsOf(items)), store)
      out.push({
        key: t.id,
        to: `/chats/${t.id}`,
        title: t.title,
        at: isConversation(rec) ? rec.data.endedAt : new Date(t.createdAt).toISOString(),
        messages: items.filter((i) => i.kind === 'user').length,
        open: true,
        busy: t.busy,
        imported: false,
        made: resolved.map((a) => a.kind),
        recent: recentOf(resolved),
        chat: t.id,
        ...(lastSaid && lastSaid.kind === 'assistant' ? { last: flat(lastSaid.text).slice(0, 180) } : {}),
      })
    }
    return out.sort(newerFirst)
    // The open chats are read through tabsKey: their rows change with what a row shows, not with every token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsKey, version, store])
  // The assistant's recorded chats, less the ones open here (their open row stands for them).
  const earlier = useMemo(() => {
    const openIds = new Set(open.map((r) => r.chat))
    return openIds.size ? index.mine.filter((r) => !r.chat || !openIds.has(r.chat)) : index.mine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, indexVersion, index])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const imported = useMemo(() => index.imported, [indexVersion, index])
  return useMemo(() => ({ open, earlier, imported }), [open, earlier, imported])
}

/** Every chat in one list, newest first — for a search across the groups. */
export function allChats(g: ChatGroups): ChatRow[] {
  return [...g.open, ...g.earlier, ...g.imported].sort(newerFirst)
}
