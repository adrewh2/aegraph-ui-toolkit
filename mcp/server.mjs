#!/usr/bin/env node
/**
 * aegraph MCP bridge.
 *
 * Claude Code spawns this over stdio. It opens a local WebSocket that the
 * running aegraph-ui tab connects to (enable "Claude Code bridge" in the
 * app). The tab sends its tool manifest — the same tools the in-app
 * assistant uses — and executes every call, so this process holds no app
 * state and needs no API key: the model is Claude Code, on your
 * subscription; the workspace is whatever tab is open.
 *
 *   claude mcp add aegraph -- node mcp/server.mjs      (or use .mcp.json)
 *   AEGRAPH_BRIDGE_PORT=8787  AEGRAPH_BRIDGE_TOKEN=…   (optional)
 *
 * The socket listens on the loopback only, and only a page whose `Origin` is
 * allowed may connect (this machine's dev servers and previews, and the one
 * deployed site named by `AEGRAPH_HOSTED_ORIGIN`, this edition's own site
 * unless it is set; `AEGRAPH_BRIDGE_ORIGINS` replaces that list). Without
 * that check any website could drive the app and spawn a chat turn — see
 * SECURITY.md › The bridge.
 *
 * When the port is taken (another session's bridge), the next free port in
 * the span after it is used; the tab connects to the whole span.
 *
 * The bridge also works the other way round: the tab's assistant panel can
 * send a message *to* Claude Code (no API key in the browser). The server
 * runs `claude -p` for that turn — with this same script as its MCP server
 * on a port of its own, so the tab's tools are there — and streams the
 * events back to the tab. See `startChat`.
 *
 *   AEGRAPH_CLAUDE_BIN=claude   AEGRAPH_CLAUDE_ARGS='--model …'   (optional)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { chatArgs, chatDir, chatEnv, describeToolUse, filterClaudeArgs } from './chat.mjs'
import { INSTRUCTIONS, cleanPageText, frame } from './frame.mjs'
import { tokenMatches } from './token.mjs'

const PORT = Number(process.env.AEGRAPH_BRIDGE_PORT ?? 8787)
const TOKEN = process.env.AEGRAPH_BRIDGE_TOKEN ?? ''

/**
 * Which pages may drive this bridge.
 *
 * A WebSocket is not subject to the same-origin policy: without this check any
 * page open in the browser could connect to 127.0.0.1, register itself as the
 * tab, receive Claude Code's tool calls and answer them — and ask for a chat
 * turn, which spawns `claude -p`. So the `Origin` of the upgrade
 * is checked against a list: this machine's dev servers and previews, and the
 * deployed site. `AEGRAPH_BRIDGE_ORIGINS` replaces the list (comma-separated
 * origins, or `*` to allow any — only for a throwaway machine).
 *
 * Loopback is allowed on any port because every worktree's dev server takes a
 * port of its own; a page there is code on this machine. A deployment is a
 * different matter: `HOSTED_ORIGIN` is the one site outside this machine that
 * may drive the bridge by default — whoever controls the page there can call
 * every tool of a developer's open workspace. It is `AEGRAPH_HOSTED_ORIGIN`
 * when that is set (**empty trusts no hosted site at all**; an organisation's
 * machines set it to their own deployment or to nothing), else this edition's
 * own site: `site` in `src/app/edition.json` (https://aegraph.dev for
 * aegraph-ui), the file that also tells the app which edition it is.
 */
const EDITION_SITE = JSON.parse(readFileSync(new URL('../src/app/edition.json', import.meta.url), 'utf8')).site
const HOSTED_ORIGIN = hostedOrigin(process.env.AEGRAPH_HOSTED_ORIGIN)
const DEFAULT_ORIGINS = HOSTED_ORIGIN ? [HOSTED_ORIGIN] : []

/** The hosted origin the bridge trusts: unset → this edition's site; empty → none; otherwise the origin of the URL given (a path or a trailing slash is not part of an origin). */
function hostedOrigin(raw) {
  if (raw === undefined) return new URL(EDITION_SITE).origin
  const v = raw.trim()
  if (!v) return ''
  try {
    const u = new URL(v)
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin
  } catch {
    /* fall through */
  }
  // A value that is not an origin trusts nothing rather than something unintended.
  console.error(`[aegraph-bridge] AEGRAPH_HOSTED_ORIGIN=${JSON.stringify(v)} is not an http(s) origin; no hosted site is trusted.`)
  return ''
}
const ORIGINS = (process.env.AEGRAPH_BRIDGE_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
const ANY_ORIGIN = ORIGINS.includes('*')
/** Loopback on any port: the dev server, `vite preview`, a driven Chrome. */
const isLoopback = (o) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o)

/** Whether a page at this origin may drive the bridge. A connection with no Origin is not a browser page (a driver, a test) and is allowed on loopback. */
function originAllowed(origin) {
  if (ANY_ORIGIN) return true
  if (!origin) return true
  if (ORIGINS.length > 0) return ORIGINS.includes(origin)
  return isLoopback(origin) || DEFAULT_ORIGINS.includes(origin)
}
const CALL_TIMEOUT_MS = Number(process.env.AEGRAPH_BRIDGE_TIMEOUT_MS ?? 120_000)
/**
 * Set on the bridge a chat turn spawns for its `claude -p`: the tool list waits (briefly) for the tab to connect, so
 * the model's first request already sees the app's tools, and the permission tool is offered.
 */
const CHAT_CHILD = process.env.AEGRAPH_BRIDGE_CHAT === '1'
const TAB_WAIT_MS = Number(process.env.AEGRAPH_BRIDGE_WAIT_MS ?? 8000)
/**
 * The largest message a tab may send. Results come back whole (a text result travels twice, as `content` and as
 * `blocks`) and a screenshot is a few megabytes of base64; nothing an MCP client will accept as one tool result comes
 * near this. The `ws` default is 100 MiB, which lets any page that may connect hold that much of this process's memory
 * per message. A tab past the cap is disconnected (close 1009) and its calls fail as disconnected.
 */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024
/** Chat turns one connection may have running at once: each is a `claude` process and a bridge of its own. */
const MAX_CHATS_PER_TAB = 3
/** …all the connections from one origin together (a page can open many sockets), and this whole process. */
const MAX_CHATS_PER_ORIGIN = 3
const MAX_CHATS = 6
/** What a tab's manifest may hold: tool names Claude Code accepts, descriptions and schemas of a sane size. */
const MAX_TOOLS = 400
const MAX_DESCRIPTION_CHARS = 32_000
const MAX_SCHEMA_BYTES = 64 * 1024
const RESERVED_TOOLS = new Set(['aegraph_bridge_status', 'permission_prompt'])

const log = (...args) => console.error('[aegraph-bridge]', ...args)

// ── Browser side ─────────────────────────────────────────────────────────

/** Connected tabs, the active one last. Calls go to the tab the user most recently brought to the front (else the most recently connected one that was visible). */
const tabs = []
let manifest = [] // [{ name, description, inputSchema }]
let callSeq = 0
const pending = new Map() // id → { resolve, reject, timer }

/**
 * Which tabs calls may go to. Any page on this machine's loopback may connect (every worktree's dev server has a port
 * of its own), and without this any of them — another project's dev server, a local tool serving pages it fetched —
 * could say it is in front and take Claude Code's calls, put its own tool list (descriptions and all) in front of the
 * model, and answer for the app. So the first tab to connect sets the bridge's origin, and only tabs from that origin
 * are routed to; a tab from another origin is connected but never active. When the last of them leaves, the next tab
 * to connect sets it again. With `AEGRAPH_BRIDGE_TOKEN` every tab has shown the token, and every one is routed to.
 */
let homeOrigin = null
const routed = () => tabs.filter((t) => t.routed)

/** The tab a chat child was spawned for: its calls go there whichever tab is in front. */
const FOR_TAB = process.env.AEGRAPH_BRIDGE_FOR_TAB || ''
const active = () => {
  const ok = routed()
  return (FOR_TAB && ok.find((t) => t.id === FOR_TAB)) || ok.at(-1) || null
}
/** Resolves when the first tab says hello (the chat child's tool list waits on it). */
let tabReady
const firstTab = new Promise((r) => (tabReady = r))

function setManifest(next, from) {
  manifest = next
  log(`tools from ${from}: ${next.length}`)
  server.sendToolListChanged().catch(() => {})
}

/**
 * A tab's tool list as Claude Code will see it. The descriptions go into the developer's own tool list, unframed, so
 * they are a page's words in the model's context: each is made plain text (line breaks kept, no other control,
 * direction or invisible characters), capped, with the envelope's tag name broken (`cleanPageText`), and so is every
 * description inside the schema; a name Claude Code would refuse, one
 * of the bridge's own, a repeat, or a schema past its size is dropped.
 */
function cleanManifest(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const t of raw.slice(0, MAX_TOOLS)) {
    const name = typeof t?.name === 'string' ? t.name : ''
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || RESERVED_TOOLS.has(name) || seen.has(name)) continue
    const schema = t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema) ? cleanSchema(t.inputSchema) : { type: 'object' }
    if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) continue
    seen.add(name)
    out.push({ name, description: cleanPageText(t.description, MAX_DESCRIPTION_CHARS, { lines: true }), inputSchema: schema })
  }
  return out
}
/** A schema with every `description` and `title` in it cleaned like a tool's description. */
function cleanSchema(v, depth = 0) {
  if (depth > 32 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => cleanSchema(x, depth + 1))
  const out = {}
  for (const [k, x] of Object.entries(v)) {
    if (k === '__proto__') continue
    out[k] = (k === 'description' || k === 'title') && typeof x === 'string' ? cleanPageText(x, MAX_DESCRIPTION_CHARS) : cleanSchema(x, depth + 1)
  }
  return out
}
const cleanLabel = (s) => cleanPageText(s, 200) || 'tab'

/** The handshake itself: a page from an origin that may not drive this bridge is refused before the socket opens. */
function verifyClient({ origin, req }, done) {
  const from = origin ?? req?.headers?.origin ?? ''
  if (originAllowed(from)) return done(true)
  log(`refused a connection from ${from || '(no origin)'} — not an allowed origin. AEGRAPH_BRIDGE_ORIGINS adds one.`)
  done(false, 403, 'origin not allowed')
}

function onTab(ws, req) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (TOKEN && !tokenMatches(url.searchParams.get('token'), TOKEN)) {
    ws.close(4001, 'bad token')
    return
  }
  const origin = String(req.headers?.origin ?? '')
  // With the token every tab has proved itself; without it, the first tab's origin is the bridge's (see `homeOrigin`).
  if (!TOKEN && !routed().length) homeOrigin = origin
  /** `chats` are this connection's own turns, by the id the tab gave them: another tab can neither stop nor shadow them. */
  const tab = { ws, origin, routed: !!TOKEN || origin === homeOrigin, label: 'tab', alive: true, tools: [], chats: new Map() }
  if (!tab.routed) log(`a tab from ${origin || '(no origin)'} connected; calls go only to tabs from ${homeOrigin || '(no origin)'} — set AEGRAPH_BRIDGE_TOKEN to route to any tab that has it`)
  tabs.push(tab)
  /** Make this tab the one calls go to, and its tools the manifest — only a tab calls may go to. */
  const activate = () => {
    if (!tab.routed) return
    const i = tabs.indexOf(tab)
    if (i >= 0 && i !== tabs.length - 1) {
      tabs.splice(i, 1)
      tabs.push(tab)
    }
    setManifest(tab.tools, tab.label)
  }
  ws.on('pong', () => (tab.alive = true))
  // A frame past the size cap, a bad opcode, invalid UTF-8: `ws` closes the socket and emits an error, which unheard
  // would take this whole process down — any page that may connect could stop the bridge with one bad frame.
  ws.on('error', (err) => log(`a tab's socket failed (${err.code ?? err.message}); it is closed`))
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'hello') {
      tab.label = cleanLabel(msg.client?.url)
      if (typeof msg.client?.tab === 'string') tab.id = msg.client.tab.slice(0, 100)
      tab.tools = cleanManifest(msg.tools)
      // A background tab (a reload behind another window) keeps its place; the one in front takes over.
      if (!tab.routed) {
        /* connected, never in front */
      } else if (msg.active !== false) activate()
      else if (tab === active()) {
        const others = routed().filter((t) => t !== tab)
        const prev = others.at(-1)
        if (prev) {
          tabs.splice(tabs.indexOf(tab), 1)
          tabs.unshift(tab)
          setManifest(prev.tools, prev.label)
        } else setManifest(tab.tools, tab.label)
      }
      ws.send(JSON.stringify({ type: 'welcome', server: 'aegraph-bridge', activeTabs: tabs.length }))
      tabReady()
    } else if (msg.type === 'chat') {
      void startChat(tab, msg)
    } else if (msg.type === 'chat-stop') {
      stopChild(tab.chats.get(msg.id))
    } else if (msg.type === 'confirm-result' && confirms.get(msg.id)?.tab === tab) {
      // Only the tab that was asked answers, and only a question still open.
      const c = confirms.get(msg.id)
      confirms.delete(msg.id)
      clearTimeout(c.timer)
      c.resolve(!!msg.ok)
    } else if (msg.type === 'active') {
      if (msg.client?.url) tab.label = cleanLabel(msg.client.url)
      if (tab !== active()) activate()
    } else if (msg.type === 'result' && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(p.timer)
      p.resolve(msg)
    }
  })
  ws.on('close', () => {
    const i = tabs.indexOf(tab)
    if (i >= 0) tabs.splice(i, 1)
    // The last tab of the bridge's origin is gone: the next one to connect sets it (those connected now stay as they are).
    if (!TOKEN && !routed().length) homeOrigin = null
    for (const [id, p] of pending) {
      if (p.tab === tab) {
        pending.delete(id)
        clearTimeout(p.timer)
        p.reject(new Error('The aegraph tab disconnected mid-call.'))
      }
    }
    for (const [id, c] of confirms) {
      if (c.tab === tab) {
        confirms.delete(id)
        clearTimeout(c.timer)
        c.resolve(false)
      }
    }
    for (const child of tab.chats.values()) child?.kill('SIGTERM')
    const next = active()
    if (next) setManifest(next.tools, next.label)
    else setManifest([], 'nobody')
  })
}

function callInTab(name, input) {
  const tab = active()
  if (!tab) return Promise.reject(new Error(tabs.length ? `No aegraph tab this bridge routes to is connected: the tabs connected are from ${[...new Set(tabs.map((t) => t.origin || '(no origin)'))].join(', ')}, and calls go only to tabs from the origin of the first tab that connected. Reload the app's tab after closing the others, or set AEGRAPH_BRIDGE_TOKEN.` : 'No aegraph tab is connected. Open the app (npm run dev) and enable the Claude Code bridge in the assistant panel.'))
  const id = ++callSeq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out after ${CALL_TIMEOUT_MS / 1000}s waiting for the tab (a confirmation may be waiting in the app).`))
    }, CALL_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer, tab })
    tab.ws.send(JSON.stringify({ type: 'call', id, name, input }))
  })
}

/** A yes/no put to the user in the active tab (a permission Claude Code asks for). Silence, or no tab, is a no. */
const confirms = new Map() // id → { resolve, timer, tab }
function confirmInTab(message) {
  const tab = active()
  if (!tab) return Promise.resolve(false)
  const id = ++callSeq
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      confirms.delete(id)
      resolve(false)
    }, CALL_TIMEOUT_MS)
    confirms.set(id, { resolve, timer, tab })
    tab.ws.send(JSON.stringify({ type: 'confirm', id, message }))
  })
}

// ── Chat: Claude Code as the assistant's model ───────────────────────────

const CLAUDE_BIN = process.env.AEGRAPH_CLAUDE_BIN || 'claude'
/** How long `claude -p` may take to exit after its `result` before it is put down. */
const LINGER_MS = Number(process.env.AEGRAPH_CLAUDE_LINGER_MS ?? 5000)
/** Extra `claude` arguments, split on whitespace (e.g. `--model claude-sonnet-5`) — never one that widens a permission. */
const { kept: CLAUDE_ARGS, refused: REFUSED_ARGS } = filterClaudeArgs((process.env.AEGRAPH_CLAUDE_ARGS || '').split(/\s+/).filter(Boolean))
if (REFUSED_ARGS.length) log(`AEGRAPH_CLAUDE_ARGS: ignored ${REFUSED_ARGS.join(', ')} — a chat turn's permissions are the bridge's to set, not the environment's`)

/**
 * A free loopback port for the chat child's own bridge, chosen by the system — not one from the span. The span is
 * how Claude Code sessions find a port each (every session runs this server), and with a handful of sessions open it
 * is full; a chat child needs no place in it, because the tab is told its exact address (`probe`) the moment it is
 * spawned. Null only if the system has no port to give.
 */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(null))
    s.listen(0, '127.0.0.1', () => {
      const { port: p } = s.address()
      s.close(() => resolve(p))
    })
  })
}

/**
 * One assistant turn from the tab: `claude -p` on the user's subscription, streaming its `stream-json` events back
 * as `chat-event` messages and closing with `chat-end`. The child gets its own copy of this bridge (on a free port
 * the tab is told to connect to right away), so the model has the app's tools — and only those: `chat.mjs` says why
 * and how. The app confirms its destructive tools itself; anything else Claude Code asks is put to the user in the
 * tab through the permission tool. `resume` continues a previous turn's Claude Code session.
 */
/** The chat children this bridge asked to stop: how they end is the stop, not a failure. */
const stopRequested = new WeakSet()
function stopChild(child) {
  if (!child) return
  stopRequested.add(child)
  child.kill('SIGTERM')
}

async function startChat(tab, msg) {
  const id = msg.id
  const send = (m) => tab.ws.readyState === tab.ws.OPEN && tab.ws.send(JSON.stringify(m))
  if (tab.chats.has(id)) return send({ type: 'chat-end', id, ok: false, error: `Chat ${id} is already running.` })
  if (tab.chats.size >= MAX_CHATS_PER_TAB) return send({ type: 'chat-end', id, ok: false, error: `${MAX_CHATS_PER_TAB} chat turns are already running from this tab; wait for one to finish.` })
  const running = (from) => from.reduce((n, t) => n + t.chats.size, 0)
  if (running(tabs.filter((t) => t.origin === tab.origin)) >= MAX_CHATS_PER_ORIGIN) return send({ type: 'chat-end', id, ok: false, error: `${MAX_CHATS_PER_ORIGIN} chat turns are already running from this site's tabs; wait for one to finish.` })
  if (running(tabs) >= MAX_CHATS) return send({ type: 'chat-end', id, ok: false, error: `${MAX_CHATS} chat turns are already running on this bridge; wait for one to finish.` })
  tab.chats.set(id, null) // held while the port is found, so two quick requests cannot both pass the cap
  const p = await freePort()
  // The tab may have left while the port was found: its close put down the turns it had, and this one is not started.
  if (tab.ws.readyState !== tab.ws.OPEN) return void tab.chats.delete(id)
  if (p === null) tab.chats.delete(id)
  if (p === null) return send({ type: 'chat-end', id, ok: false, error: "This machine had no free port for the chat's bridge." })
  // The turn's bridge takes a token of its own, made for this turn and told only to the tab that asked (in the probe):
  // no other page can be first to connect to it and become the tab its calls go to, and the tab needs no token of its
  // own configured to follow the probe.
  const turnToken = randomBytes(16).toString('hex')
  const childEnv = { AEGRAPH_BRIDGE_PORT: String(p), AEGRAPH_BRIDGE_PORT_SPAN: '1', AEGRAPH_BRIDGE_CHAT: '1', AEGRAPH_BRIDGE_TOKEN: turnToken, ...(tab.id ? { AEGRAPH_BRIDGE_FOR_TAB: tab.id } : {}) }
  const mcp = JSON.stringify({ mcpServers: { aegraph: { command: process.execPath, args: [fileURLToPath(import.meta.url)], env: childEnv } } })
  const args = chatArgs(msg, mcp, CLAUDE_ARGS)
  let child
  try {
    child = spawn(CLAUDE_BIN, args, { cwd: chatDir(), env: chatEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    tab.chats.delete(id)
    return send({ type: 'chat-end', id, ok: false, error: `Could not start ${CLAUDE_BIN}: ${err.message}` })
  }
  tab.chats.set(id, child)
  log(`chat ${id}: claude -p on port ${p}${msg.resume ? ` (resume ${msg.resume})` : ''}`)
  // The child's port is outside the span the tab watches: the tab connects because it is told, before the model's first request.
  send({ type: 'probe', url: `ws://127.0.0.1:${p}/?token=${turnToken}`, chat: id })
  child.on('error', (err) => {
    if (tab.chats.get(id) === child) tab.chats.delete(id)
    send({ type: 'chat-end', id, ok: false, error: err.code === 'ENOENT' ? `\`${CLAUDE_BIN}\` was not found on PATH. Install Claude Code, or set AEGRAPH_CLAUDE_BIN.` : err.message })
  })
  child.stdin.on('error', () => {})
  child.stdin.end(String(msg.prompt ?? ''))
  let buf = ''
  let lingering
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      // Hook chatter and rate-limit notes are the terminal's business, not the panel's.
      if (event.type === 'rate_limit_event' || (event.type === 'system' && event.subtype !== 'init')) continue
      send({ type: 'chat-event', id, event })
      // The turn is over at `result`; `claude` then shuts its MCP servers down, which can take a while or hang.
      // The tab has already moved on — give the process a moment, then put it down so the next turn's resume is clean.
      if (event.type === 'result') lingering = setTimeout(() => stopChild(child), LINGER_MS)
    }
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)))
  child.on('close', (code, signal) => {
    clearTimeout(lingering)
    if (tab.chats.get(id) === child) tab.chats.delete(id)
    // Put down on purpose — the user's Stop, or the linger after `result`. `claude` handles SIGTERM itself and exits
    // with code 143 rather than by the signal, so the signal alone does not say it; what was asked of it does.
    const stopped = signal === 'SIGTERM' || stopRequested.has(child)
    send({ type: 'chat-end', id, ok: code === 0 || stopped, ...(code && !stopped ? { error: stderr.trim().split('\n').slice(-3).join('\n') || `claude exited with code ${code}` } : {}) })
  })
}

// Several Claude Code sessions may run at once, each with its own bridge: the first takes the base port, the next ones the
// ports after it (up to PORT_SPAN of them). The tab connects to every port in the span, so every session reaches it.
const PORT_SPAN = Number(process.env.AEGRAPH_BRIDGE_PORT_SPAN ?? 10)
let port = PORT
let wss
function listen(p) {
  wss = new WebSocketServer({ host: '127.0.0.1', port: p, verifyClient, maxPayload: MAX_MESSAGE_BYTES })
  wss.on('connection', onTab)
  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && p + 1 < PORT + PORT_SPAN) {
      log(`port ${p} is taken (another session's bridge); trying ${p + 1}`)
      wss.removeAllListeners()
      listen(p + 1)
    } else {
      // Nothing of ours is listening: the status tool must not name a port another session owns.
      port = null
      log('websocket error', err.message)
    }
  })
  wss.on('listening', () => {
    port = p
    log(`listening on ws://127.0.0.1:${p} (origins: ${ANY_ORIGIN ? 'any — AEGRAPH_BRIDGE_ORIGINS=*' : ORIGINS.length ? ORIGINS.join(', ') : ['loopback', ...DEFAULT_ORIGINS].join(', ')}${TOKEN ? ', token required' : ''})`)
  })
}
listen(PORT)
setInterval(() => {
  for (const t of tabs) {
    if (!t.alive) t.ws.terminate()
    else {
      t.alive = false
      t.ws.ping()
    }
  }
}, 30_000).unref()

// ── MCP side ─────────────────────────────────────────────────────────────

const server = new Server({ name: 'aegraph', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS })

const STATUS_TOOL = {
  name: 'aegraph_bridge_status',
  description: 'Whether an aegraph tab is connected to this bridge, and which tools it exposes. Call this if other aegraph tools are missing or failing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

/** Claude Code's `--permission-prompt-tool` for a chat turn: the question goes to the user in the tab. */
const PERMISSION_TOOL = {
  name: 'permission_prompt',
  description: 'Internal: asks the user, in the aegraph tab, whether Claude Code may use a tool. The bridge names it as the permission prompt tool; it is not for the model to call.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (CHAT_CHILD && !tabs.length) await Promise.race([firstTab, new Promise((r) => setTimeout(r, TAB_WAIT_MS))])
  return { tools: [STATUS_TOOL, ...(CHAT_CHILD ? [PERMISSION_TOOL] : []), ...manifest.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))] }
})

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: input } = req.params
  if (name === STATUS_TOOL.name) {
    // The tab's address is the page's to say, so the answer is framed like a tool result's.
    const notRouted = tabs.filter((t) => !t.routed).map((t) => t.origin || '(no origin)')
    const status = { connected: tabs.length > 0, activeTab: active()?.label ?? null, tabs: tabs.length, tools: manifest.map((t) => t.name), port, basePort: PORT, ...(notRouted.length ? { notRouted: [...new Set(notRouted)], routedOrigin: TOKEN ? 'any with the token' : homeOrigin || '(no origin)' } : {}) }
    return { content: [framed(name, JSON.stringify(status))] }
  }
  if (name === PERMISSION_TOOL.name) {
    const what = describeToolUse(String(input?.tool_name ?? 'a tool'), input?.input)
    // Too long to show whole is too long to ask about: part of it would be a question the user never saw.
    const ok = what !== null && (await confirmInTab(`Claude Code wants to run ${what}`))
    if (what === null) return text(JSON.stringify({ behavior: 'deny', message: 'The request was too long to show the user in full, so it was declined.' }))
    return text(JSON.stringify(ok ? { behavior: 'allow', updatedInput: input?.input ?? {} } : { behavior: 'deny', message: 'The user declined this in aegraph.' }))
  }
  if (!manifest.some((t) => t.name === name)) return error(`Unknown tool ${name}. Connected tools: ${manifest.map((t) => t.name).join(', ') || 'none'}.`)
  try {
    const res = await callInTab(name, input ?? {})
    // A tool's error is the tab's words — it may quote a page, a URL, a parser's complaint about a file — so it is framed.
    if (!res.ok) return { content: [framed(name, res.content)], isError: true }
    return { content: Array.isArray(res.blocks) ? toMcpContent(res.blocks, name) : [framed(name, res.content)] }
  } catch (err) {
    // The bridge's own (no tab, a timeout, the tab gone): ours, not the workspace's, so not framed.
    return error(err instanceof Error ? err.message : String(err))
  }
})

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] })
/** A tool result's text is the workspace's, so it goes to the model as data (`frame.mjs`). */
const framed = (tool, s) => ({ type: 'text', text: frame(tool, typeof s === 'string' ? s : JSON.stringify(s)) })

/**
 * Tab result blocks → MCP content. An image arrives as pixels or not at all: the bridge fetches nothing. A URL in a
 * result is workspace data — an image entity in a bundle someone sent — and a request made from here would go with no
 * question asked, past the Third-party services switch, from the developer's machine (where the URL itself, or its
 * DNS name, carries whatever it was made to). The tab fetches a remote image itself, after asking (`view_image`).
 */
function toMcpContent(blocks, tool) {
  const out = []
  for (const b of blocks) {
    if (b.type === 'text') out.push(framed(tool, String(b.text ?? '')))
    else if (b.type === 'image' && b.data) out.push({ type: 'image', data: String(b.data), mimeType: /^image\/(png|jpeg|gif|webp)$/.test(b.mimeType) ? b.mimeType : 'image/png' })
    else if (b.type === 'image' && b.url) out.push(framed(tool, '[an image given by address, not fetched: the bridge fetches nothing; the tab sends the picture itself]'))
  }
  return out.length ? out : [framed(tool, '')]
}
const error = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }], isError: true })

const transport = new StdioServerTransport()
await server.connect(transport)
log('ready')

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
// The bridge lives as long as its client. When Claude Code goes without a signal — or a chat turn's `claude -p` is put
// down while it shuts its MCP servers — stdin ends, and the listening socket alone would keep this process, its port
// and the tab's link to it alive for good.
process.stdin.on('end', () => process.exit(0))
// A chat turn is a `claude` process of this bridge's: it goes with the bridge, whichever way the bridge goes, rather than
// running on (a hung one for ever) with nobody to read it.
process.on('exit', () => {
  for (const t of tabs) for (const child of t.chats.values()) child?.kill('SIGTERM')
})
