import { useSyncExternalStore } from 'react'
import { onAsk } from './ask'
import { chatEntityId } from './chatIds'
import { rebuildChat, recordChat } from './record'
import { isConversation } from '../conversations/conversation'
import { artifactsHostKey } from '../chats/show'
import { newEntityId } from '../../core/entity/ids'
import type { AnyEntity } from '../../core/entity/types'
import { AssistantSession, LEGACY_STORAGE_KEY, storageKeyFor } from './session'
import type { AppHost } from './tools'
import { announceChats, CHATS_LIST_KEY } from './instance'

/**
 * The open chats: several at once, one active — the tabs of the assistant
 * panel. Each is an AssistantSession with its own transcript, history and
 * Claude Code session, kept under its own key; the list (ids, the active
 * one) is kept beside them, so every tab comes back after a reload with
 * its chat. A chat keeps running when another tab is in front. Voice
 * control, "Ask about this" and the tools talk to the active one. Every
 * chat is also recorded as a conversation entity in the project (record.ts),
 * a little after each change.
 *
 * A chat belongs to the project that was open when it started. With a
 * project open, the tabs, the chat in front and everything that asks for
 * them (the panel, the Chats page, the `chat` tool, voice) see only that
 * project's chats; switching project brings forward the chat that was in
 * front there last, or a fresh one. With no project open (the Library),
 * every chat is there. A chat running in another project goes on running.
 */

const LIST_KEY = CHATS_LIST_KEY
const MAX_CHATS = 12

export interface ChatTab {
  id: string
  title: string
  busy: boolean
  active: boolean
  createdAt: number
  /** Nothing typed in it yet (no message, no name): a tab in the panel, but not yet a chat anywhere else. */
  blank: boolean
}

type Host = Omit<AppHost, 'confirm'>

/**
 * A chat's id is a UUID, like every other id the app mints (`newEntityId`).
 * It was a timestamp in base 36 with a counter that starts again on every
 * page load, so two tabs opening a chat in the same millisecond minted the
 * same id — and the id is the chat's storage key (`aegraph:ai:session:<id>`),
 * its address (`/chats/<id>`) and its conversation entity
 * (`assistant-chat:<id>`), so a collision is two chats sharing a transcript.
 * Chats already open keep the ids they have: nothing reads the shape of one.
 */
const newId = () => newEntityId()

/** A chat nobody has typed in: no message, no name of its own, not running. It is not listed, counted or recorded. */
const isBlank = (s: AssistantSession) => {
  const st = s.getState()
  return !st.items.length && !st.name && !st.busy
}

export class Chats {
  private sessions: AssistantSession[] = []
  private activeId = ''
  private host: Host | null = null
  private listeners = new Set<() => void>()
  private unsubscribe = new Map<string, () => void>()
  /** Bumped on any change worth a re-render (a tab's title or busy state included). */
  private version = 0
  /** Chats with changes not yet written to their conversation entity. */
  private dirty = new Set<string>()
  private recordTimer: ReturnType<typeof setTimeout> | null = null
  /** Each open chat's project (null: started in the Library), and the chat last in front in each project. */
  private projects = new Map<string, string | null>()
  private fronts = new Map<string, string>()
  /** The open project, followed from the store once a host brings one; undefined until then (every chat shows). */
  private scope: string | null | undefined
  private stopScope?: () => void

  constructor() {
    this.load()
    // "Ask about this" from a context menu: the prompt goes to the chat in front as soon as it is free.
    onAsk((text) => this.active().sendWhenIdle(text))
  }

  // ── Observable ───────────────────────────────────────────────────────

  getVersion = () => this.version
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  private changed() {
    this.version++
    this.listeners.forEach((l) => l())
    this.save()
  }

  // ── The list ─────────────────────────────────────────────────────────

  /**
   * Every open chat's id, in tab order — in every project, since what counts them decides what is in scope — each
   * with its project after a tab: what the sidebar's count needs, without a title read per chat. A blank chat is
   * left out: it is not a chat yet.
   */
  ids(): string[] {
    return this.sessions.filter((s) => !isBlank(s)).map((s) => `${s.id}\t${this.projects.get(s.id) ?? ''}`)
  }

  /** The project a chat belongs to (null: the Library), or undefined for a chat that is not open. */
  projectOf(id: string): string | null | undefined {
    return this.get(id) ? (this.projects.get(id) ?? null) : undefined
  }

  /** Whether a chat is one of the open project's (every chat is, with no project open). */
  private inScope(s: AssistantSession): boolean {
    return !this.scope || this.projects.get(s.id) === this.scope || s.id === this.activeId
  }

  /** The open project's chats, in tab order. */
  private visible(): AssistantSession[] {
    return this.sessions.filter((s) => this.inScope(s))
  }

  list(): ChatTab[] {
    return this.visible().map((s) => ({ id: s.id, title: s.title(), busy: s.getState().busy, active: s.id === this.activeId, createdAt: s.createdAt, blank: isBlank(s) }))
  }

  active(): AssistantSession {
    return this.sessions.find((s) => s.id === this.activeId) ?? this.visible()[0] ?? this.sessions[0]
  }

  /**
   * The open project changed: its chat comes to the front — the one in front there last, else its most recent, else
   * a fresh one — and the tabs are that project's.
   */
  setScope(project: string | null) {
    if (project === this.scope) return
    const leaving = this.scope
    if (leaving !== undefined && this.activeId) this.fronts.set(leaving ?? '', this.activeId)
    this.scope = project
    const mine = this.sessions.filter((s) => !project || this.projects.get(s.id) === project)
    const front = this.get(this.fronts.get(project ?? '') ?? '')
    const next = front && mine.includes(front) ? front : [...mine].sort((a, b) => b.createdAt - a.createdAt)[0]
    this.activeId = next ? next.id : this.add(new AssistantSession(newId())).id
    this.changed()
  }

  get(id: string): AssistantSession | undefined {
    return this.sessions.find((s) => s.id === id)
  }

  /** A new, empty chat, in front. */
  create(): AssistantSession {
    // An empty, unnamed chat already in front is the new chat.
    const cur = this.active()
    if (cur && isBlank(cur)) {
      this.activeId = cur.id
      this.changed()
      return cur
    }
    const s = this.add(new AssistantSession(newId()))
    if (this.sessions.length > MAX_CHATS) {
      // The oldest idle, empty-or-not, chat gives way; a busy one is never dropped.
      const victim = [...this.sessions].sort((a, b) => a.createdAt - b.createdAt).find((x) => x.id !== s.id && !x.getState().busy)
      if (victim) this.remove(victim.id)
    }
    this.activeId = s.id
    this.changed()
    return s
  }

  open(id: string): AssistantSession | undefined {
    const s = this.get(id)
    if (!s) return undefined
    this.activeId = id
    this.changed()
    return s
  }

  /** Close a tab: its chat is stopped and its transcript forgotten. The last tab closes into a fresh one. */
  close(id: string) {
    const s = this.get(id)
    if (!s) return
    const shown = this.visible()
    const i = shown.indexOf(s)
    this.remove(id)
    this.refront(id, i)
    this.changed()
  }

  /**
   * Delete a chat for good, where closing keeps its record: its tab, if it is open (a running turn is stopped), the
   * transcript and artifact tabs this browser keeps for it, and the conversation entity it is recorded as, with the
   * relationships on it. What the chat made stays. `id` is a chat id or a conversation entity — the assistant's
   * record of a chat, or an imported transcript. Returns what went, or null when `id` is neither.
   */
  delete(id: string, store = this.host?.store): { chat?: string; entity?: string } | null {
    const rec = store?.get(id)
    const chat = this.get(id) ? id : isConversation(rec) && rec.data.source === 'assistant' && typeof rec.data.sourceId === 'string' ? rec.data.sourceId : undefined
    const entityId = chat && store?.get(chatEntityId(chat)) ? chatEntityId(chat) : isConversation(rec) ? rec.id : undefined
    if (!chat && !entityId) return null
    if (chat && this.get(chat)) {
      const i = this.visible().findIndex((s) => s.id === chat)
      this.remove(chat, false)
      this.refront(chat, i)
    }
    if (chat) {
      for (const [k, v] of this.fronts) if (v === chat) this.fronts.delete(k)
      try {
        localStorage.removeItem(artifactsHostKey(chat))
      } catch {
        /* ignore */
      }
    }
    if (entityId) store?.remove(entityId)
    this.changed()
    return { ...(chat ? { chat } : {}), ...(entityId ? { entity: entityId } : {}) }
  }

  /** The chat in front was `id`, just removed from place `i` of the tabs: the next one along comes forward, or a fresh one. */
  private refront(id: string, i: number) {
    if (this.activeId !== id) return
    this.activeId = ''
    const rest = this.visible()
    this.activeId = (rest[Math.min(Math.max(i, 0), rest.length - 1)] ?? this.add(new AssistantSession(newId()))).id
  }

  /**
   * Continue a recorded chat: the conversation entity's own tab when it is still open, else a new tab seeded from
   * the record — the transcript, a history rebuilt from it, and the Claude Code session it was in when known — and
   * the record goes on being updated under the same entity. Returns the chat, or null for an entity that is not one.
   */
  resume(entity: AnyEntity | undefined): AssistantSession | null {
    if (!isConversation(entity) || entity.data.source !== 'assistant' || typeof entity.data.sourceId !== 'string') return null
    const id = entity.data.sourceId
    const open = this.get(id)
    if (open) {
      this.activeId = id
      this.changed()
      return open
    }
    const s = this.add(new AssistantSession(id, entity.data.startedAt ? Date.parse(entity.data.startedAt) || Date.now() : Date.now()), entity.meta.projects?.[0] ?? null)
    const { items, history } = rebuildChat(entity.data.messages)
    s.seed(items, history, typeof entity.data.claudeSession === 'string' ? entity.data.claudeSession : undefined)
    if (typeof entity.label === 'string' && entity.label && entity.label !== s.title()) s.rename(entity.label)
    this.activeId = id
    this.changed()
    return s
  }

  rename(id: string, name: string) {
    this.get(id)?.rename(name)
    this.changed()
  }

  /** The app host every chat runs its tools against; new chats get it too. With a store in hand, the records catch up. */
  attachHost(host: Host) {
    this.host = host
    const store = host.store
    for (const s of this.sessions) {
      s.attach(host)
      this.dirty.add(s.id)
      // A chat opened before chats had projects: the project its record is in, else the one open now.
      if (!this.projects.has(s.id)) this.projects.set(s.id, store.get(chatEntityId(s.id))?.meta.projects?.[0] ?? store.scope ?? null)
    }
    this.stopScope?.()
    const follow = () => this.setScope(store.scope ?? null)
    const off = store.subscribe((ev) => {
      if (ev.type === 'scope') follow()
    })
    this.stopScope = () => void off()
    follow()
    this.recordSoon()
  }

  /** The conversation entity of every changed chat, written now (the timer runs this a second after a change). */
  recordNow(): number {
    if (this.recordTimer) clearTimeout(this.recordTimer)
    this.recordTimer = null
    const store = this.host?.store
    if (!store) return 0
    let n = 0
    for (const id of this.dirty) {
      const s = this.get(id)
      if (s && recordChat(store, s, undefined, this.projects.get(id))) n++
    }
    this.dirty.clear()
    return n
  }

  private recordSoon() {
    if (this.recordTimer || !this.dirty.size) return
    this.recordTimer = setTimeout(() => {
      this.recordTimer = null
      this.recordNow()
    }, 1000)
  }

  // ── Internals ────────────────────────────────────────────────────────

  private add(s: AssistantSession, project: string | null | undefined = this.scope): AssistantSession {
    this.sessions.push(s)
    if (project !== undefined) this.projects.set(s.id, project)
    if (this.host) s.attach(this.host)
    // A tab shows its chat's title and whether it is busy: the list follows those, not every token of a streaming
    // reply — the list's readers (the panel's tabs, the Chats page) re-render on it, and a reply is thousands of events.
    let shown = ''
    let wasBusy = s.getState().busy
    let wasBlank = isBlank(s)
    this.unsubscribe.set(
      s.id,
      s.subscribe(() => {
        const busy = s.getState().busy
        const sig = `${s.title()}\u0001${busy ? 1 : 0}`
        if (sig !== shown) {
          shown = sig
          this.version++
          this.listeners.forEach((l) => l())
        }
        // The first message (or a name) makes a blank chat a chat: the stored list says so, for the sidebar's count
        // before the chats load.
        if (wasBlank !== isBlank(s)) {
          wasBlank = !wasBlank
          this.save()
        }
        // The chat's record (its conversation entity) is written when a message is sent (the turn starts) or received
        // in full (it ends), and for changes while idle (a rename) — never while a reply streams. A write there is a
        // store change: persistence, versioning and autosave, and everything that watches the store, once a second
        // for the length of a reply. The transcript itself survives a reload by its own save (session.persist).
        this.dirty.add(s.id)
        if (!busy || !wasBusy) this.recordSoon()
        wasBusy = busy
      }),
    )
    return s
  }

  private remove(id: string, keepRecord = true) {
    const s = this.get(id)
    if (!s) return
    this.unsubscribe.get(id)?.()
    this.unsubscribe.delete(id)
    this.sessions = this.sessions.filter((x) => x.id !== id)
    // The record stays: closing the tab forgets the transcript here, not in the project (deleting forgets both).
    if (keepRecord && this.dirty.has(id) && this.host?.store) recordChat(this.host.store, s, undefined, this.projects.get(id))
    this.projects.delete(id)
    this.dirty.delete(id)
    s.discard()
  }

  private load() {
    let ids: string[] = []
    let active = ''
    try {
      const raw = localStorage.getItem(LIST_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { ids?: unknown; active?: unknown; projects?: unknown; fronts?: unknown }
        if (Array.isArray(parsed.ids)) ids = parsed.ids.filter((x): x is string => typeof x === 'string' && !!x)
        if (typeof parsed.active === 'string') active = parsed.active
        if (parsed.projects && typeof parsed.projects === 'object')
          for (const [k, v] of Object.entries(parsed.projects as Record<string, unknown>)) if (typeof v === 'string' || v === null) this.projects.set(k, v)
        if (parsed.fronts && typeof parsed.fronts === 'object')
          for (const [k, v] of Object.entries(parsed.fronts as Record<string, unknown>)) if (typeof v === 'string') this.fronts.set(k, v)
      }
      // The single chat from before there were tabs becomes the first tab.
      if (!ids.length) {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
        if (legacy) {
          const id = newId()
          localStorage.setItem(storageKeyFor(id), legacy)
          localStorage.removeItem(LEGACY_STORAGE_KEY)
          ids = [id]
        }
      }
    } catch {
      /* no storage: one chat for the session */
    }
    for (const id of ids) this.add(new AssistantSession(id), this.projects.has(id) ? this.projects.get(id) : undefined)
    if (!this.sessions.length) this.add(new AssistantSession(newId()))
    this.activeId = this.get(active)?.id ?? this.sessions[0].id
    // Written back at once, so the stored list says which chats are blank (a list from before it did, or a fresh one).
    this.save()
  }

  private save() {
    try {
      localStorage.setItem(LIST_KEY, JSON.stringify({ ids: this.sessions.map((s) => s.id), blank: this.sessions.filter(isBlank).map((s) => s.id), active: this.activeId, projects: Object.fromEntries(this.projects), fronts: Object.fromEntries(this.fronts) }))
    } catch {
      /* ignore */
    }
  }
}

/** The chats of this tab. */
export const chats = new Chats()
announceChats(chats)

export function useChats(): { tabs: ChatTab[]; active: AssistantSession } {
  useSyncExternalStore(chats.subscribe, chats.getVersion, chats.getVersion)
  return { tabs: chats.list(), active: chats.active() }
}
