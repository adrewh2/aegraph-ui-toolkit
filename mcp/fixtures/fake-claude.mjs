#!/usr/bin/env node
/**
 * Stands in for `claude -p` in the bridge's tests: reads the prompt from stdin, prints the arguments it was given
 * and a short stream-json turn — a tool call against its own MCP server (the child bridge), then an answer. When
 * the MCP config names a port, it connects to that bridge as a client would and calls `aegraph_bridge_status`, so
 * the test sees the child bridge come up and the tab reach it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { unframe } from '../frame.mjs'

const args = process.argv.slice(2)
const prompt = await new Promise((r) => {
  let s = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => (s += c))
  process.stdin.on('end', () => r(s))
})
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
// As the real one does: SIGTERM is handled, and the process exits 143 rather than dying by the signal.
if (prompt.includes('exit 143')) {
  process.on('SIGTERM', () => process.exit(143))
  out({ type: 'system', subtype: 'init', session_id: 'fake-session', tools: [] })
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (prompt.includes('please fail')) {
  process.stderr.write('fake claude: asked to fail\n')
  process.exit(3)
}
out({ type: 'system', subtype: 'hook_started', hook_name: 'x' })
out({ type: 'system', subtype: 'init', session_id: 'fake-session', tools: [] })
out({ type: 'rate_limit_event', rate_limit_info: {} })
const mcpIdx = args.indexOf('--mcp-config')
let status = null
if (mcpIdx >= 0) {
  const cfg = JSON.parse(args[mcpIdx + 1]).mcpServers.aegraph
  const client = new Client({ name: 'fake-claude', version: '0' })
  await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...cfg.env }, stderr: 'pipe' }))
  const tools = (await client.listTools()).tools.map((t) => t.name)
  const r = await client.callTool({ name: 'aegraph_bridge_status', arguments: {} })
  status = { listed: tools, ...JSON.parse(unframe(r.content[0].text)) }
  if (prompt.includes('ask permission')) {
    const p = await client.callTool({ name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'git status' } } })
    status.permission = JSON.parse(p.content[0].text)
  }
  await client.close()
}
out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok ' } } })
out({ type: 'assistant', message: { content: [{ type: 'text', text: `ok ${prompt.trim().split('\n').pop()}` }] } })
out({ type: 'result', subtype: 'success', session_id: 'fake-session', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, args, status, cwd: process.cwd(), pid: process.pid, envKeys: Object.keys(process.env) })
if (prompt.includes('hang')) setInterval(() => {}, 1000)
