import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { useSyncExternalStore } from 'react'
import type { AppHost, ConfirmOptions } from '../assistant/tools'

/**
 * Browser half of the Claude Code bridge. Connects to `mcp/server.mjs`
 * over a local WebSocket, advertises the app's tools, and executes the
 * calls Claude Code makes — so Claude Code (on your subscription) drives
 * this tab exactly the way the in-app assistant would, with no API key.
 */

export type BridgeStatus = 'off' | 'connecting' | 'connected'

export interface PendingConfirm {
  id: number
  message: string
  /**
   * `tool`: an app tool asking before it deletes, reaches another site or changes a setting (`yes` is its button's
   * word, `danger` when something is lost); `permission`: Claude Code asking to use one of its own tools in a chat turn.
   */
  kind: 'tool' | 'permission'
  yes?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

/** A question with options from a tool call (ask_user), shown as a dialog; null answers "none of these". */
export interface PendingQuestion {
  id: number
  message: string
  options: string[]
  resolve: (answer: string | null) => void
}

export interface BridgeState {
  enabled: boolean
  status: BridgeStatus
  /** The base server URL; the ports after it (PORT_SPAN of them) are tried too, one per Claude Code session. */
  url: string
  /** Servers connected right now — one per Claude Code session whose bridge found a port. */
  servers: number
  /** Tool calls completed since the tab connected. */
  calls: number
  lastCall?: { name: string; at: number; ok: boolean }
  confirm: PendingConfirm | null
  question: PendingQuestion | null
}

const ENABLED_KEY = 'aegraph:bridge:enabled'
const URL_KEY = 'aegraph:bridge:url'
const DEFAULT_URL = 'ws://127.0.0.1:8787'
/**
 * Several Claude Code sessions run at once, each spawning its own bridge server; the first takes the base port and the
 * others the ports after it. The tab keeps a link to every port in the span, so every session's tools reach it.
 */
const PORT_SPAN = 10

type Inbound =
  | { type: 'welcome' }
  | { type: 'manifest?' }
  | { type: 'call'; id: number; name: string; input: unknown }
  /** A server just started on this port for a chat turn: connect now rather than on the slow probe. `chat` says whose. */
  | { type: 'probe'; url: string; chat?: number }
  /** Claude Code asks the user something (a permission) during a chat turn. */
  | { type: 'confirm'; id: number; message: string }
  | { type: 'chat-event'; id: number; event: ClaudeEvent }
  | { type: 'chat-end'; id: number; ok: boolean; error?: string }

/** One line of `claude -p --output-format stream-json`; the assistant session reads the shapes it knows. */
export type ClaudeEvent = { type: string; subtype?: string; [k: string]: unknown }

export interface ChatOptions {
  /** Appended to Claude Code's system prompt for this turn. */
  system?: string
  /** A Claude Code session id from an earlier turn: the conversation continues. */
  resume?: string
  model?: string
  /** Claude Code's effort for the turn (`--effort`): low, medium, high, xhigh, max. */
  effort?: string
  onEvent: (event: ClaudeEvent) => void
  /** Where this chat's own questions go (its ask_user and its tools' confirmations): the panel, not the bridge dialog. */
  confirm?: (message: string, options?: ConfirmOptions) => Promise<boolean>
  choose?: (message: string, options: string[]) => Promise<string | null>
  /** The hosts the user let this chat's `web_fetch` read: the chat's, kept across its turns (`AppHost.webApprovals`). */
  webApprovals?: Set<string>
}
export interface ChatRun {
  /** Resolves when the turn ends — rejected when the server or the link went away, or `claude` failed to run. */
  done: Promise<void>
  stop: () => void
}

/** Result content as sent to the bridge: text, and images as their pixels (base64), which the server forwards as MCP image blocks. */
export type BridgeBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }

/**
 * Flatten a tool result (string, JSON-able value, or Anthropic content blocks) into bridge blocks. An image by address
 * is not passed on: the bridge would have to fetch it, with no one asked — a tool that shows a remote picture fetches
 * it here first, after asking (`view_image`).
 */
export function toBridgeBlocks(result: unknown): BridgeBlock[] {
  if (typeof result === 'string') return [{ type: 'text', text: result }]
  if (Array.isArray(result) && result.every((b) => b && typeof b === 'object' && 'type' in b)) {
    const out: BridgeBlock[] = []
    for (const b of result as Record<string, unknown>[]) {
      if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text })
      else if (b.type === 'image' && b.source && typeof b.source === 'object') {
        const src = b.source as { type: string; media_type?: string; data?: string; url?: string }
        if (src.type === 'base64' && src.data) out.push({ type: 'image', mimeType: src.media_type ?? 'image/png', data: src.data })
        else if (src.type === 'url') out.push({ type: 'text', text: '[an image given by address, not sent]' })
      } else out.push({ type: 'text', text: JSON.stringify(b) })
    }
    return out
  }
  return [{ type: 'text', text: JSON.stringify(result) }]
}

/**
 * The URLs a base URL stands for: itself and the ports after it. A URL without a numeric port is just itself, and one
 * saying `span=1` (a driver's private bridge, `mcp/drive.mjs`) is just itself too — no other session's server on the
 * ports after it may send its calls to that tab.
 */
/**
 * The URL of a bridge the tab may be pointed at by a `probe`: `ws://` to this machine's loopback (`127.0.0.1`,
 * `localhost`, `[::1]`) on any port, with no credentials; anything else is undefined. A chat turn's bridge is always
 * one of those, so nothing a probe could legitimately name is lost.
 */
export function loopbackBridgeUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return undefined
  }
  if (u.protocol !== 'ws:' || u.username || u.password) return undefined
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') return undefined
  return raw
}

export function spanUrls(base: string, span = PORT_SPAN): string[] {
  const m = /^(.*:)(\d+)(\/.*)?$/.exec(base.trim())
  if (!m) return [base]
  const port = Number(m[2])
  const asked = /[?&]span=(\d+)/.exec(m[3] ?? '')
  const n = asked ? Math.max(1, Math.min(Number(asked[1]), span)) : span
  return Array.from({ length: n }, (_, i) => `${m[1]}${port + i}${m[3] ?? ''}`)
}

/** One server: its socket and its retry clock. */
interface Link {
  url: string
  ws: WebSocket | null
  retry?: ReturnType<typeof setTimeout>
  backoff: number
  /** A port past the base is probed less eagerly: most of them have no server behind them. */
  maxBackoff: number
  /** The chat turn (started from this tab) whose own bridge this is, when it is one. */
  chat?: number
  /**
   * A port a server told the tab about (`probe`), outside the span: a chat turn's own bridge, on a port of its own.
   * Once it has come and gone — or its turn is over — it is dropped, not retried: every turn has a new one.
   */
  probed?: boolean
  opened?: boolean
  /** This link's tools: the app's, with questions routed to the chat that owns the link. */
  tools?: BetaRunnableTool[]
  /** The hosts the user let `web_fetch` read for this server — one Claude Code session — and no other. */
  webApprovals?: Set<string>
}

/** This tab, to the servers: the chat child it spawns is told to send its calls here and not to another tab. */
const TAB_ID = (() => {
  try {
    const k = 'aegraph:bridge:tab'
    const v = sessionStorage.getItem(k) ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    sessionStorage.setItem(k, v)
    return v
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
})()

export class BridgeClient {
  private state: BridgeState
  private listeners = new Set<() => void>()
  private links: Link[] = []
  private host: Omit<AppHost, 'confirm'> | null = null
  private toolsLoaded = false
  private confirmSeq = 0
  /** Questions waiting behind the one on screen, in the order they were asked. */
  private confirmQueue: PendingConfirm[] = []
  private chatSeq = 0
  private chats = new Map<number, { link: Link; onEvent: (e: ClaudeEvent) => void; resolve: () => void; reject: (err: Error) => void; confirm?: ChatOptions['confirm']; choose?: ChatOptions['choose']; webApprovals?: Set<string> }>()
  /** The tool factory, once its module (and the SDK) has loaded. */
  private createTools: typeof import('../assistant/tools').createAppTools | null = null

  constructor() {
    this.state = { enabled: read(ENABLED_KEY) === '1', status: 'off', url: read(URL_KEY) || DEFAULT_URL, servers: 0, calls: 0, confirm: null, question: null }
    // The tab the user is looking at is the one calls should land in: tell the servers whenever this one comes to the front.
    if (typeof window !== 'undefined') {
      const front = () => document.visibilityState === 'visible' && this.sendActive()
      window.addEventListener('focus', front)
      document.addEventListener('visibilitychange', front)
    }
  }

  getState = () => this.state
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  private set(patch: Partial<BridgeState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((l) => l())
  }

  /** The tool modules — and the API SDK behind them — load the first time a host attaches, off the entry chunk. */
  private toolsReady: Promise<void> | null = null

  /** Supply (or refresh) the app host. Connects if enabled. */
  attach(host: Omit<AppHost, 'confirm'>) {
    this.host = host
    this.toolsReady = import('../assistant/tools').then(({ createAppTools }) => {
      if (this.host !== host) return // a newer host attached meanwhile; its own load wins
      this.createTools = createAppTools
      this.toolsLoaded = true
      for (const l of this.links) l.tools = undefined
      if (this.state.enabled && !this.links.length) this.connect()
      else for (const l of this.links) if (l.ws?.readyState === WebSocket.OPEN) this.sendHello(l)
    })
  }

  setEnabled(enabled: boolean) {
    write(ENABLED_KEY, enabled ? '1' : '0')
    this.set({ enabled })
    if (enabled) void (this.toolsReady ?? Promise.resolve()).then(() => this.state.enabled && this.connect())
    else this.disconnect()
  }

  setUrl(url: string) {
    write(URL_KEY, url)
    this.set({ url })
    if (this.state.enabled) {
      this.disconnect()
      this.connect()
    }
  }

  answer(id: number, ok: boolean) {
    const c = this.state.confirm
    if (!c || c.id !== id) return
    // The next question waiting comes up in its own right: it is never answered by the click that answered this one.
    this.set({ confirm: this.confirmQueue.shift() ?? null })
    c.resolve(ok)
  }

  /** Every question on screen or waiting is a no: the link it came over is gone, or the bridge is off. */
  private declineAll() {
    const all = [...(this.state.confirm ? [this.state.confirm] : []), ...this.confirmQueue]
    this.confirmQueue = []
    if (this.state.confirm) this.set({ confirm: null })
    for (const c of all) c.resolve(false)
  }

  answerQuestion(id: number, answer: string | null) {
    const q = this.state.question
    if (!q || q.id !== id) return
    this.set({ question: null })
    q.resolve(answer)
  }

  /** Whether a chat can go out: some server is connected to run `claude` for it. */
  canChat(): boolean {
    return this.openLinks().length > 0
  }

  /**
   * One assistant turn through Claude Code, on the user's subscription: the prompt goes to a connected server, which
   * runs `claude -p` (with this tab's tools) and streams its events back. Rejects at once when no server is connected.
   */
  chat(prompt: string, opts: ChatOptions): ChatRun {
    // The base port's server by preference: the same one every time, so its `claude` sessions resume cleanly.
    const link = this.openLinks()[0]
    if (!link) {
      const err = new Error('No bridge server is connected. Start Claude Code in this checkout (or `npm run mcp`) and enable the bridge.')
      return { done: Promise.reject(err), stop: () => {} }
    }
    const id = ++this.chatSeq
    const done = new Promise<void>((resolve, reject) => {
      this.chats.set(id, { link, onEvent: opts.onEvent, resolve, reject, confirm: opts.confirm, choose: opts.choose, webApprovals: opts.webApprovals })
    })
    link.ws!.send(JSON.stringify({ type: 'chat', id, prompt, system: opts.system, resume: opts.resume, model: opts.model, effort: opts.effort }))
    return {
      done,
      stop: () => {
        if (link.ws?.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify({ type: 'chat-stop', id }))
      },
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private connect() {
    if (!this.host || this.links.length) return
    this.links = spanUrls(this.state.url).map((url, i) => ({ url, ws: null, backoff: 1000, maxBackoff: i === 0 ? 15_000 : 30_000 }))
    this.refreshStatus()
    for (const l of this.links) this.open(l)
  }

  private open(link: Link) {
    clearTimeout(link.retry)
    if (!this.host || link.ws) return
    let ws: WebSocket
    try {
      ws = new WebSocket(link.url)
    } catch {
      this.scheduleRetry(link)
      return
    }
    link.ws = ws
    ws.onopen = () => {
      link.backoff = 1000
      link.opened = true
      this.refreshStatus()
      this.sendHello(link)
    }
    ws.onmessage = (ev) => {
      let msg: Inbound
      try {
        msg = JSON.parse(String(ev.data)) as Inbound
      } catch {
        return
      }
      if (msg.type === 'manifest?') this.sendHello(link)
      else if (msg.type === 'call') void this.handleCall(link, msg)
      else if (msg.type === 'probe') this.probe(msg.url, msg.chat)
      else if (msg.type === 'confirm') void this.ask(msg.message, 'permission').then((ok) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'confirm-result', id: msg.id, ok })))
      else if (msg.type === 'chat-event') this.chats.get(msg.id)?.onEvent(msg.event)
      else if (msg.type === 'chat-end') {
        const c = this.chats.get(msg.id)
        if (!c) return
        this.chats.delete(msg.id)
        if (msg.ok) c.resolve()
        else c.reject(new Error(msg.error || 'Claude Code stopped without an answer.'))
      }
    }
    ws.onclose = () => {
      if (link.ws !== ws) return
      link.ws = null
      for (const [id, c] of this.chats) {
        if (c.link !== link) continue
        this.chats.delete(id)
        c.reject(new Error('The bridge server went away mid-turn.'))
      }
      if (!this.links.some((l) => l.ws?.readyState === WebSocket.OPEN)) {
        this.declineAll()
        if (this.state.question) this.answerQuestion(this.state.question.id, null)
      }
      const gone = link.probed && (link.opened || (link.chat !== undefined && !this.chats.has(link.chat)))
      if (gone) this.links = this.links.filter((l) => l !== link)
      this.refreshStatus()
      if (this.state.enabled && !gone) this.scheduleRetry(link)
    }
    ws.onerror = () => {
      /* onclose follows and handles retry */
    }
  }

  private disconnect() {
    const links = this.links
    this.links = []
    for (const l of links) {
      clearTimeout(l.retry)
      const ws = l.ws
      l.ws = null
      ws?.close()
    }
    // Their sockets' onclose no longer sees them as current: the turns riding on them end here.
    for (const [id, c] of this.chats) {
      this.chats.delete(id)
      c.reject(new Error('The bridge was turned off mid-turn.'))
    }
    this.declineAll()
    if (this.state.question) this.answerQuestion(this.state.question.id, null)
    this.set({ status: 'off', servers: 0 })
  }

  /**
   * Connect to a port now — a chat turn's server just came up on it — instead of waiting out the probe's backoff.
   * Only ever a bridge on this machine (`loopbackBridgeUrl`): a server that could point the tab anywhere could hand
   * the app's tools, and the chat, to a host of its choosing.
   */
  private probe(raw: unknown, chat?: number) {
    const url = loopbackBridgeUrl(raw)
    if (!url) {
      console.warn('[aegraph-bridge] ignored a probe for a bridge that is not on this machine:', String(raw).slice(0, 200))
      return
    }
    let link = this.links.find((l) => l.url === url)
    if (!link) {
      if (!this.links.length) return
      link = { url, ws: null, backoff: 250, maxBackoff: 30_000, probed: true }
      this.links.push(link)
    }
    if (chat !== undefined) {
      link.chat = chat
      link.tools = undefined
    }
    if (link.ws) return
    link.backoff = 250
    this.open(link)
  }

  private scheduleRetry(link: Link) {
    clearTimeout(link.retry)
    link.retry = setTimeout(() => this.open(link), link.backoff)
    link.backoff = Math.min(link.backoff * 2, link.maxBackoff)
  }

  private openLinks() {
    return this.links.filter((l) => l.ws?.readyState === WebSocket.OPEN)
  }

  private refreshStatus() {
    const servers = this.openLinks().length
    const status: BridgeStatus = servers ? 'connected' : this.state.enabled ? 'connecting' : 'off'
    if (status !== this.state.status || servers !== this.state.servers) this.set({ status, servers, ...(status === 'connected' && this.state.status !== 'connected' ? { calls: 0 } : {}) })
  }

  private sendHello(link: Link) {
    if (link.ws?.readyState !== WebSocket.OPEN) return
    link.ws.send(
      JSON.stringify({
        type: 'hello',
        client: { url: location.href, app: 'aegraph-ui', tab: TAB_ID },
        // A tab that connects in the background (a reload behind another window) must not steal the calls.
        active: document.visibilityState === 'visible' && document.hasFocus(),
        tools: this.toolsFor(link).map((t) => ({ name: t.name, description: (t as { description?: string }).description ?? '', inputSchema: (t as { input_schema: unknown }).input_schema })),
      }),
    )
  }

  /** This tab came to the front: every server routes calls to it from now on. */
  private sendActive() {
    for (const l of this.openLinks()) l.ws!.send(JSON.stringify({ type: 'active', client: { url: location.href, tab: TAB_ID } }))
  }

  /**
   * The tools a link's calls run: the app's, with a delete confirmation or an ask_user question routed to the chat
   * that owns the link (a card in the panel) — for any other server, the bridge's own dialog. Each link has its own
   * set, so what one Claude Code session was allowed (a host `web_fetch` may read) is that session's and no other's;
   * a chat turn's link carries its chat's.
   */
  private toolsFor(link: Link): BetaRunnableTool[] {
    if (!this.toolsLoaded || !this.host || !this.createTools) return []
    if (!link.tools) {
      const chat = link.chat !== undefined ? this.chats.get(link.chat) : undefined
      link.webApprovals ??= new Set()
      link.tools = this.createTools({
        ...this.host,
        webApprovals: chat?.webApprovals ?? link.webApprovals,
        confirm: (m, o) => {
          const c = link.chat !== undefined ? this.chats.get(link.chat) : undefined
          return c?.confirm ? c.confirm(m, o) : this.ask(m, 'tool', o)
        },
        choose: (m, options) => {
          const c = link.chat !== undefined ? this.chats.get(link.chat) : undefined
          return c?.choose ? c.choose(m, options) : this.choose(m, options)
        },
      })
    }
    return link.tools
  }

  private async handleCall(link: Link, msg: { id: number; name: string; input: unknown }) {
    await this.toolsReady
    const tool = this.toolsFor(link).find((t) => t.name === msg.name)
    let ok = true
    let blocks: BridgeBlock[]
    if (!tool) {
      ok = false
      blocks = [{ type: 'text', text: `Unknown tool ${msg.name}` }]
    } else {
      try {
        blocks = toBridgeBlocks(await tool.run(tool.parse(msg.input ?? {})))
      } catch (err) {
        ok = false
        blocks = [{ type: 'text', text: err instanceof Error ? err.message : String(err)}]
      }
    }
    this.set({ calls: this.state.calls + 1, lastCall: { name: msg.name, at: Date.now(), ok } })
    // `content` keeps older servers working; `blocks` carries images.
    const content = blocks.map((b) => (b.type === 'text' ? b.text : 'url' in b ? `[image ${b.url}]` : '[image]')).join('\n')
    if (link.ws?.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify({ type: 'result', id: msg.id, ok, content, blocks }))
  }

  /**
   * Put a question to the user in the bridge's dialog. One is on screen at a time; one asked meanwhile waits its turn
   * rather than replacing it — a question swapped under the user's cursor would be answered by the click meant for
   * the one before.
   */
  private ask(message: string, kind: PendingConfirm['kind'], o: ConfirmOptions = {}): Promise<boolean> {
    return new Promise((resolve) => {
      const c: PendingConfirm = { id: ++this.confirmSeq, message, kind, ...(o.yes ? { yes: o.yes } : {}), ...(o.danger ? { danger: true } : {}), resolve }
      if (this.state.confirm) this.confirmQueue.push(c)
      else this.set({ confirm: c })
    })
  }

  private choose(message: string, options: string[]): Promise<string | null> {
    if (this.state.question) this.answerQuestion(this.state.question.id, null)
    return new Promise((resolve) => this.set({ question: { id: ++this.confirmSeq, message, options, resolve } }))
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

/** One bridge per tab. */
export const bridge = new BridgeClient()

export function useBridge(): BridgeState {
  return useSyncExternalStore(bridge.subscribe, bridge.getState, bridge.getState)
}
