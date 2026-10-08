#!/usr/bin/env node
/**
 * aegraph headless — the engine over MCP, with no browser in the loop.
 *
 * The UI is one client of the logical engine; this is another. A workspace
 * file is loaded at boot, the app's own tools are exposed over stdio MCP,
 * and every change is written back to that file. Claude Code (or anything
 * else that speaks MCP) drives project creation and management on a running
 * instance:
 *
 *   claude mcp add aegraph-headless -- node dist-headless/aegraph-headless.mjs ~/work.ae.json
 *   npm run headless -- ~/work.ae.json            (from the repo)
 *
 * One process owns one workspace file — it autosaves, so two would fight
 * over it — and a lock beside the file says so. To let several clients drive
 * *one* running instance, give it a port instead of stdio: the engine stays
 * up, and each client connects over MCP's streamable HTTP transport.
 *
 *   node dist-headless/aegraph-headless.mjs ~/work.ae.json --port 8788
 *   claude mcp add --transport http aegraph-headless http://127.0.0.1:8788/mcp --header "Authorization: Bearer <token>"
 *
 * Over a port the engine wants a bearer token (`AEGRAPH_HEADLESS_TOKEN`, or
 * one made at startup and printed with the line above), refuses any Host but
 * the loopback's and any browser Origin not given with `--allow-origin`
 * (`httpGate.ts`). Files are read and written only under the root
 * (`paths.ts`).
 *
 * Options:
 *   --port <n>           serve MCP over HTTP on 127.0.0.1 instead of stdio
 *   --root <dir>         the directory import_file / export_file may touch (default: the workspace's)
 *   --allow-origin <o>   a browser origin that may drive the port (repeatable; default none)
 *   --no-autosave        write only when `workspace_save` asks
 *   --refuse-destructive decline the tools that would ask the user first
 *   --yes                over a port, run them anyway (stdio runs them by default)
 *   --allow-network      let a tool reach a site it was handed (an image, a bundle, a page); declined by default
 *   --force              take the workspace even if another process holds it
 *   --list-tools         print the tool names and exit
 *
 * The bridge (`mcp/server.mjs`) and this server are the two halves of the
 * same idea: there, the tools run in a tab and the state is what is on
 * screen; here, they run in this process and the state is a file. The tool
 * names and their JSON are the same, so a script written against one works
 * against the other, minus the tools that need a screen (see `tools.ts`).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { HeadlessEngine } from './engine'
import { installPublicFetch } from './publicFetch'
import { refuse } from './httpGate'
import { createHeadlessTools } from './tools'
import { serverError, toolContent, toolError } from './results'
import { HEADLESS_INSTRUCTIONS } from '../../mcp/frame.mjs'

// Before any tool can run: in Node nothing else keeps a handed URL off the loopback and the local network.
installPublicFetch()

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const values = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []))
const TAKES_VALUE = new Set(['--port', '--root', '--allow-origin'])
const file = argv.find((a, i) => !a.startsWith('-') && !TAKES_VALUE.has(argv[i - 1])) ?? process.env.AEGRAPH_WORKSPACE

if (flag('help') || !file) {
  process.stderr.write('usage: aegraph-headless <workspace.ae.json[.gz]> [--port <n>] [--root <dir>] [--allow-origin <origin>] [--no-autosave] [--refuse-destructive] [--yes] [--force] [--list-tools]\n')
  process.exit(file ? 0 : 1)
}

const log = (...parts: unknown[]) => process.stderr.write(`[aegraph-headless] ${parts.join(' ')}\n`)

/**
 * One writer per workspace. The engine autosaves, so a second process on the
 * same file would overwrite the first's work with its own idea of it; a lock
 * naming the owner is enough to say so, and a stale one (the process is gone)
 * is taken over silently.
 */
const lock = `${file}.lock`
if (!flag('list-tools')) {
  if (existsSync(lock) && !flag('force')) {
    const pid = Number(readFileSync(lock, 'utf8').trim())
    const alive = (() => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })()
    if (alive) {
      log(`${file} is held by process ${pid}. Drive that instance over its port, or start this one with --force.`)
      process.exit(1)
    }
  }
  writeFileSync(lock, String(process.pid))
}

const port = Number(value('port') ?? process.env.AEGRAPH_HEADLESS_PORT ?? 0)

/**
 * Destructive tools ask first in the tab; here nobody is watching. Over stdio the client is the developer's own
 * Claude Code, whose permission prompt already stood in front of the call, so they run. Over a port any holder of
 * the token is a client, so they are declined unless the engine was started with `--yes`
 * (or `AEGRAPH_HEADLESS_CONFIRM=allow`).
 */
const confirmEnv = process.env.AEGRAPH_HEADLESS_CONFIRM
const confirm: 'allow' | 'refuse' = flag('refuse-destructive') || confirmEnv === 'refuse' ? 'refuse' : flag('yes') || confirmEnv === 'allow' || !port ? 'allow' : 'refuse'

/**
 * A URL a tool is handed — by the data, by the model — is reached only with `--allow-network`: the developer's Claude Code asked to run the tool, not to reach whatever host its
 * arguments name, and in the tab that question is the user's. Public addresses only either way (`publicFetch.ts`).
 */
const network: 'allow' | 'refuse' = flag('allow-network') ? 'allow' : 'refuse'

const engine = new HeadlessEngine({ file, autosave: !flag('no-autosave'), confirm, network, root: value('root') })
const tools = createHeadlessTools(engine)

if (flag('list-tools')) {
  process.stdout.write(`${tools.map((t) => t.name).join('\n')}\n`)
  process.exit(0)
}

const status = engine.status()
log(`${status.file} — ${status.entities} entities, ${status.relationships} relationships, ${tools.length} tools${status.project ? `, project ${status.project}` : ''}`)

/** A server over this engine's tools. One per client: the engine is the state, the server is only a wire. */
function makeServer(): Server {
  // The results are the workspace's text, handed over as data (`results.ts`, the bridge's `mcp/frame.mjs`), and the
  // instructions every client receives say what that means.
  const server = new Server({ name: 'aegraph-headless', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: HEADLESS_INSTRUCTIONS })
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({ name: t.name, description: (t as { description?: string }).description ?? '', inputSchema: (t as unknown as { input_schema: Record<string, unknown> }).input_schema })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: input } = req.params
    const tool = tools.find((t) => t.name === name)
    if (!tool) return serverError(`Unknown tool ${name}. This is the headless engine; the tools that need a browser are not here.`)
    try {
      const result = await tool.run(tool.parse(input ?? {}))
      return { content: toolContent(name, result) }
    } catch (err) {
      return toolError(name, err instanceof Error ? err.message : String(err))
    }
  })
  return server
}

if (port) {
  const token = process.env.AEGRAPH_HEADLESS_TOKEN || randomBytes(24).toString('base64url')
  const origins = values('allow-origin')
  // Several clients, one engine: a session per client, all driving the same workspace. Loopback only — the
  // engine reads and writes this machine's files, which have no business on the network.
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const http = createServer((req, res) => {
    void (async () => {
      const header = (k: string) => (typeof req.headers[k] === 'string' ? (req.headers[k] as string) : undefined)
      const no = refuse({ host: header('host'), origin: header('origin'), authorization: header('authorization') }, { port, token, origins })
      if (no) {
        res.statusCode = no[0]
        res.end(no[1])
        return
      }
      const path = (req.url ?? '/').split('?')[0]
      if (path !== '/mcp') {
        res.statusCode = 404
        res.end('aegraph-headless speaks MCP at /mcp')
        return
      }
      const id = req.headers['mcp-session-id']
      const existing = typeof id === 'string' ? sessions.get(id) : undefined
      let transport: StreamableHTTPServerTransport
      if (existing) transport = existing
      else {
        const fresh: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // The gate above already did this; the SDK's own check stays on behind it.
          enableDnsRebindingProtection: true,
          allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
          ...(origins.length ? { allowedOrigins: origins } : {}),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, fresh)
          },
        })
        fresh.onclose = () => {
          if (fresh.sessionId) sessions.delete(fresh.sessionId)
        }
        await makeServer().connect(fresh)
        transport = fresh
      }
      await transport.handleRequest(req, res)
    })().catch((err: unknown) => {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) res.statusCode = 500
      res.end()
    })
  })
  http.listen(port, '127.0.0.1', () => {
    log(`ready on http://127.0.0.1:${port}/mcp — destructive tools ${confirm === 'allow' ? 'run' : 'are declined (--yes runs them)'}, handed URLs ${network === 'allow' ? 'are fetched' : 'are not fetched (--allow-network)'}, files under ${engine.paths().root}`)
    if (!process.env.AEGRAPH_HEADLESS_TOKEN) log(`token for this run: claude mcp add --transport http aegraph-headless http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`)
  })
} else {
  await makeServer().connect(new StdioServerTransport())
  log('ready')
}

// The workspace is the product of a session: nothing pending is left unwritten.
const bye = () => {
  try {
    engine.flush()
  } catch (err) {
    log(`could not write the workspace: ${err instanceof Error ? err.message : String(err)}`)
  }
  release()
  process.exit(0)
}
const release = () => {
  try {
    if (existsSync(lock) && readFileSync(lock, 'utf8').trim() === String(process.pid)) rmSync(lock, { force: true })
  } catch {
    /* the lock is advisory; a leftover one is taken over by the next process */
  }
}
process.on('exit', release)
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
process.on('beforeExit', () => engine.flush())
