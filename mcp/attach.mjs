#!/usr/bin/env node
/**
 * Run steps against the aegraph tab the user has open — over MCP, through
 * the real bridge server, without launching a browser:
 *
 *   node mcp/attach.mjs steps.mjs
 *
 * It spawns mcp/server.mjs, which takes the first free port in the bridge
 * span (8787 and the nine after it), and waits for the tab to connect —
 * the app links to every port in the span, so a tab with the bridge
 * enabled finds this server within a few seconds. Then it runs your steps:
 *
 *   export default async ({ call, sleep }) => {
 *     console.log(await call('project_list'))
 *   }
 *
 * `call(name, args)` is an MCP tool call; the result text comes back
 * parsed as JSON when it is JSON, and a tool error throws. Delete
 * confirmations are the user's to answer in the app (nothing is accepted
 * for them). WAIT_MS bounds the wait for the tab (default 30 s).
 */
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { unframe } from './frame.mjs'

const [stepsPath] = process.argv.slice(2)
if (!stepsPath) {
  console.error('usage: node mcp/attach.mjs steps.mjs')
  process.exit(2)
}
const WAIT_MS = Number(process.env.WAIT_MS ?? 30_000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const client = new Client({ name: 'mcpattach', version: '0' })
const transport = new StdioClientTransport({ command: 'node', args: [new URL('./server.mjs', import.meta.url).pathname], env: { ...process.env, AEGRAPH_BRIDGE_TIMEOUT_MS: process.env.AEGRAPH_BRIDGE_TIMEOUT_MS ?? '900000' }, stderr: 'pipe' })
await client.connect(transport)
if (process.env.VERBOSE) transport.stderr?.on('data', (d) => process.stderr.write(d))

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content.filter((c) => c.type === 'text').map((c) => unframe(c.text)).join('\n')
  if (r.isError) throw new Error(`${name}: ${text}`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

try {
  // Wait for a tab, then for its tools (the manifest follows the socket by a moment).
  let status = await call('aegraph_bridge_status')
  const until = Date.now() + WAIT_MS
  while (!(status.connected && status.tools?.length) && Date.now() < until) {
    await sleep(250)
    status = await call('aegraph_bridge_status')
  }
  if (!status.connected) throw new Error(`No aegraph tab connected to ws://127.0.0.1:${status.port} within ${WAIT_MS / 1000}s. Is the app open with the Claude Code bridge enabled?`)
  console.error(`[attach] tab connected on port ${status.port} · ${status.tools.length} tools`)
  const steps = (await import(resolve(stepsPath))).default
  await steps({ call, sleep, client, status })
} finally {
  await client.close().catch(() => {})
}
