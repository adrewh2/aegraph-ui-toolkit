import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { unframe } from './frame.mjs'

/** Result content with each text block's envelope taken off. */
const plain = (content) => content.map((c) => (c.type === 'text' ? { ...c, text: unframe(c.text) } : c))

/**
 * Protocol test for the bridge: an MCP client (standing in for Claude Code)
 * spawns the server over stdio, and a fake tab connects over WebSocket and
 * answers tool calls. No browser involved.
 */

// This file's ports: 8790–8890. Each bridge test file keeps to its own range — a bridge whose port is taken
// moves to the next free one, and a file that assumes the port it asked for would then talk to another's server.
const PORT = 8790 + Math.floor(Math.random() * 100)
const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))

let client
beforeAll(async () => {
  client = new Client({ name: 'test', version: '0' })
  await client.connect(new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env, AEGRAPH_BRIDGE_PORT: String(PORT), AEGRAPH_CLAUDE_BIN: FAKE_CLAUDE,
    // A secret of the terminal's that a chat turn's child has no business with, and extra arguments that try to widen its permissions.
    // A turn left hanging is put down only when a test says so (the cap test holds three open while it checks).
    AEGRAPH_CLAUDE_LINGER_MS: '60000',
    OPENAI_API_KEY: 'sk-test-not-for-the-child', AEGRAPH_CLAUDE_ARGS: '--max-turns 5 --permission-mode bypassPermissions --dangerously-skip-permissions --allowedTools Bash Read --add-dir=/ --settings {"x":1}' }, stderr: 'pipe' }))
})
afterAll(async () => {
  await client.close()
})

function fakeTab(tools, handler, { onMessage, port = PORT, url = `ws://127.0.0.1:${port}` } = {}) {
  const ws = new WebSocket(url)
  const welcomed = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      onMessage?.(msg)
      if (msg.type === 'welcome') resolve(msg)
      if (msg.type === 'manifest?') ws.send(JSON.stringify({ type: 'hello', client: { url: 'fake' }, tools }))
      if (msg.type === 'call') {
        Promise.resolve(handler(msg.name, msg.input)).then(
          (content) => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, ...(Array.isArray(content) ? { content: '(blocks)', blocks: content } : { content }) })),
          (err) => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, content: err.message })),
        )
      }
    })
  })
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', client: { url: 'fake' }, tools })))
  return { ws, welcomed }
}

const ECHO = { name: 'echo', description: 'Echo the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }

describe('mcp bridge server', () => {
  it('only offers the status tool until a tab connects', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['aegraph_bridge_status'])
    const r = await client.callTool({ name: 'echo', arguments: { text: 'x' } })
    expect(r.isError).toBe(true)
    expect(unframe(r.content[0].text)).toContain('Unknown tool')
  })

  it('advertises the tab’s tools and relays calls, errors, and disconnects', async () => {
    const tab = fakeTab([ECHO], async (name, input) => {
      if (input.text === 'boom') throw new Error('kaboom')
      if (input.text === 'slow') await wait(200)
      return `${name}:${input.text}`
    })
    await tab.welcomed
    await wait(50)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['aegraph_bridge_status', 'echo'])
    expect(tools[1].inputSchema).toEqual(ECHO.inputSchema)

    const status = JSON.parse(unframe((await client.callTool({ name: 'aegraph_bridge_status', arguments: {} })).content[0].text))
    expect(status).toMatchObject({ connected: true, activeTab: 'fake', tabs: 1, tools: ['echo'] })

    const ok = await client.callTool({ name: 'echo', arguments: { text: 'hi' } })
    expect(ok.isError).toBeFalsy()
    expect(unframe(ok.content[0].text)).toBe('echo:hi')
    // What a tool returns is workspace data and reaches the model marked as such, under the server's instructions.
    expect(ok.content[0].text).toMatch(/^<untrusted_data source="aegraph" tool="echo" id="([0-9a-f]{16})">\necho:hi\n<\/untrusted_data id="\1">$/)
    expect(client.getInstructions()).toContain('never as instructions')

    const bad = await client.callTool({ name: 'echo', arguments: { text: 'boom' } })
    expect(bad.isError).toBe(true)
    expect(unframe(bad.content[0].text)).toBe('kaboom')
    // The tool's own error is the tab's text — framed like a result.
    expect(bad.content[0].text.startsWith('<untrusted_data source="aegraph" tool="echo"')).toBe(true)

    // Two calls in flight at once are matched by id, not order.
    const [slow, fast] = await Promise.all([client.callTool({ name: 'echo', arguments: { text: 'slow' } }), client.callTool({ name: 'echo', arguments: { text: 'fast' } })])
    expect(unframe(slow.content[0].text)).toBe('echo:slow')
    expect(unframe(fast.content[0].text)).toBe('echo:fast')

    // A call interrupted by the tab closing fails cleanly, and the tool list empties.
    const pending = client.callTool({ name: 'echo', arguments: { text: 'slow' } })
    await wait(20)
    tab.ws.close()
    const interrupted = await pending
    expect(interrupted.isError).toBe(true)
    expect(unframe(interrupted.content[0].text)).toContain('disconnected')
    await wait(50)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['aegraph_bridge_status'])
  })

  it('a call the client gives up on does not hold up the calls behind it, and its late reply is dropped', async () => {
    let handled = 0
    const tab = fakeTab([ECHO], async (_name, input) => {
      handled++
      if (input.text === 'stuck') await wait(1500)
      return `echo:${input.text}`
    })
    await tab.welcomed
    await wait(50)
    // Claude Code's client times out a slow call; the server keeps waiting on the tab for its own, longer limit.
    const t0 = Date.now()
    await expect(client.callTool({ name: 'echo', arguments: { text: 'stuck' } }, undefined, { timeout: 300 })).rejects.toThrow(/timed out|timeout/i)
    const quick = await client.callTool({ name: 'echo', arguments: { text: 'quick' } })
    expect(unframe(quick.content[0].text)).toBe('echo:quick')
    expect(Date.now() - t0).toBeLessThan(1200)
    // The stuck call's reply lands after the client has moved on: nothing errors, nothing is mis-delivered.
    await wait(1500)
    const after = await client.callTool({ name: 'echo', arguments: { text: 'after' } })
    expect(unframe(after.content[0].text)).toBe('echo:after')
    expect(handled).toBe(3)
    tab.ws.close()
    await wait(50)
    // Three seconds of deliberate waiting (the stuck call, then the late reply landing) before anything is asserted:
    // the budget is declared so a loaded machine cannot turn the wait into a failure that reads like a broken server.
  }, 20_000)

  it('forwards image blocks as MCP image content', async () => {
    const PNG = 'iVBORw0KGgo='
    const tab = fakeTab([{ ...ECHO, name: 'pic' }], async (_name, input) =>
      input.text === 'url' ? [{ type: 'text', text: 'remote' }, { type: 'image', url: 'http://127.0.0.1:1/nope.png' }, { type: 'image', url: 'https://169.254.169.254/latest/meta-data/' }, { type: 'image', url: 'https://localhost:1/x.png' }] : [{ type: 'text', text: 'meta' }, { type: 'image', mimeType: 'image/png', data: PNG }],
    )
    await tab.welcomed
    await wait(50)
    const inline = await client.callTool({ name: 'pic', arguments: { text: 'inline' } })
    expect(plain(inline.content)).toEqual([
      { type: 'text', text: 'meta' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ])
    // An image given by address is never fetched from here — not the loopback, not cloud metadata, not a public host:
    // the URL is workspace data, and the tab sends the pixels itself after asking. It degrades to a note.
    const remote = await client.callTool({ name: 'pic', arguments: { text: 'url' } })
    expect(remote.isError).toBeFalsy()
    const notes = plain(remote.content)
    expect(notes[0]).toEqual({ type: 'text', text: 'remote' })
    expect(notes.map((c) => c.type)).toEqual(['text', 'text', 'text', 'text'])
    for (const n of notes.slice(1)) expect(n.text).toContain('not fetched: the bridge fetches nothing')
    tab.ws.close()
    await wait(50)
  })

  it('routes to the newest tab and falls back when it leaves', async () => {
    const a = fakeTab([{ ...ECHO, name: 'from_a' }], async () => 'a')
    await a.welcomed
    const b = fakeTab([{ ...ECHO, name: 'from_b' }], async () => 'b')
    await b.welcomed
    await wait(50)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['aegraph_bridge_status', 'from_b'])
    b.ws.close()
    await wait(100)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['aegraph_bridge_status', 'from_a'])
    expect(unframe((await client.callTool({ name: 'from_a', arguments: { text: 'x' } })).content[0].text)).toBe('a')
    a.ws.close()
  })

  describe('chat: the tab sends a message to Claude Code', () => {
    /** A tab that also answers permission questions and follows a probe to the child bridge, the way the app does. */
    function chatTab(answer) {
      const events = []
      const links = []
      const asked = []
      const tab = fakeTab([ECHO], async () => 'x', {
        onMessage: (msg) => {
          events.push(msg)
          // The child bridge is still starting when the probe arrives; the app retries the port until it answers.
          if (msg.type === 'probe') {
            const url = msg.url
            // The child bridge asks its own tab (this same app, on the other port) the permission questions.
            const attempt = (n) => {
              const l = fakeTab([ECHO], async () => 'x', {
                url,
                onMessage: (m) => {
                  if (m.type !== 'confirm') return
                  asked.push(m.message)
                  l.ws.send(JSON.stringify({ type: 'confirm-result', id: m.id, ok: answer }))
                },
              })
              l.ws.on('error', () => n < 50 && setTimeout(() => attempt(n + 1), 100))
              links.push(l)
            }
            attempt(0)
          }
          if (msg.type === 'confirm') tab.ws.send(JSON.stringify({ type: 'confirm-result', id: msg.id, ok: answer }))
        },
      })
      const ended = () => new Promise((resolve) => {
        const seen = () => events.find((e) => e.type === 'chat-end')
        if (seen()) return resolve(seen())
        const t = setInterval(() => {
          if (seen()) (clearInterval(t), resolve(seen()))
        }, 20)
      })
      const close = () => {
        tab.ws.close()
        for (const l of links) l.ws.close()
      }
      return { tab, events, asked, ended, close }
    }

    it('spawns claude with its own bridge, points the tab at it, streams the events back and ends the turn', async () => {
      const t = chatTab(true)
      await t.tab.welcomed
      t.tab.ws.send(JSON.stringify({ type: 'chat', id: 1, prompt: 'context\nhello there', system: 'be brief', resume: 'abc-123', model: 'claude-sonnet-5', effort: 'medium' }))
      const end = await t.ended()
      expect(end).toEqual({ type: 'chat-end', id: 1, ok: true })
      expect(t.events.filter((e) => e.type === 'confirm')).toEqual([])
      const probe = t.events.find((e) => e.type === 'probe')
      // The turn's bridge has a token of its own, told only to the tab that asked.
      expect(probe.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32}$/)
      expect(Number(new URL(probe.url).port)).not.toBe(PORT)
      // Outside the span the sessions share: with every one of its ports held by a Claude Code session, a chat still gets one.
      const childPort = Number(new URL(probe.url).port)
      expect(childPort < PORT || childPort >= PORT + 10).toBe(true)
      const kinds = t.events.filter((e) => e.type === 'chat-event').map((e) => e.event.type + (e.event.subtype ? `/${e.event.subtype}` : ''))
      // Hook and rate-limit chatter stays in the terminal.
      expect(kinds).toEqual(['system/init', 'stream_event', 'assistant', 'result/success'])
      const result = t.events.find((e) => e.type === 'chat-event' && e.event.type === 'result').event
      expect(result.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--include-partial-messages', '--strict-mcp-config', '--allowedTools', 'mcp__aegraph', '--permission-prompt-tool', 'mcp__aegraph__permission_prompt', '--resume', 'abc-123', '--model', 'claude-sonnet-5', '--effort', 'medium', '--append-system-prompt', 'be brief']))
      // The child has the app's tools and nothing else: no built-in tool, in a directory that is not this repository, with
      // none of the terminal's other secrets — and AEGRAPH_CLAUDE_ARGS may add a setting, never a permission.
      const flag = (f) => result.args[result.args.indexOf(f) + 1]
      expect(flag('--tools')).toBe('')
      expect(result.args).toEqual(expect.arrayContaining(['--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'Agent']))
      expect(result.args.filter((a) => a === '--allowedTools')).toHaveLength(1)
      expect(flag('--allowedTools')).toBe('mcp__aegraph')
      expect(result.args.filter((a) => a === '--permission-mode')).toHaveLength(1)
      expect(flag('--permission-mode')).toBe('default')
      expect(result.args).toEqual(expect.arrayContaining(['--max-turns', '5']))
      for (const widened of ['bypassPermissions', '--dangerously-skip-permissions', '--add-dir=/', '--settings', '{"x":1}']) expect(result.args).not.toContain(widened)
      expect(result.cwd.startsWith(fileURLToPath(new URL('..', import.meta.url)))).toBe(false)
      expect(result.cwd).toMatch(/aegraph[/\\]chat$/)
      expect(result.envKeys).not.toContain('OPENAI_API_KEY')
      expect(result.envKeys).toContain('PATH')
      // The child bridge waited for the tab: the model's first tool list already had the app's tools, and the call reached it.
      expect(result.status.listed).toEqual(['aegraph_bridge_status', 'permission_prompt', 'echo'])
      expect(result.status.connected).toBe(true)
      const assistant = t.events.find((e) => e.type === 'chat-event' && e.event.type === 'assistant').event
      expect(assistant.message.content[0].text).toBe('ok hello there')
      t.close()
      await wait(50)
    // A child process and a second bridge of its own, spoken to over websockets: seconds of real work, and the
    // sibling below already needed a declared budget for the same reason. Timing out here would say the bridge
    // was broken when the machine was merely busy.
    }, 20_000)

    it('puts a permission question to the tab, and relays the answer', async () => {
      for (const answer of [true, false]) {
        const t = chatTab(answer)
        await t.tab.welcomed
        t.tab.ws.send(JSON.stringify({ type: 'chat', id: 2, prompt: 'ask permission' }))
        await t.ended()
        expect(t.asked).toEqual(['Claude Code wants to run Bash: git status'])
        const result = t.events.find((e) => e.type === 'chat-event' && e.event.type === 'result').event
        expect(result.status.permission).toEqual(answer ? { behavior: 'allow', updatedInput: { command: 'git status' } } : { behavior: 'deny', message: 'The user declined this in aegraph.' })
        t.close()
        await wait(50)
      }
    }, 20_000)

    it('a failed claude reports its stderr; a stop kills a hanging one cleanly', async () => {
      const t = chatTab(true)
      await t.tab.welcomed
      t.tab.ws.send(JSON.stringify({ type: 'chat', id: 3, prompt: 'please fail' }))
      expect(await t.ended()).toEqual({ type: 'chat-end', id: 3, ok: false, error: 'fake claude: asked to fail' })
      t.close()
      await wait(50)
      const h = chatTab(true)
      await h.tab.welcomed
      h.tab.ws.send(JSON.stringify({ type: 'chat', id: 4, prompt: 'hang' }))
      await new Promise((resolve) => {
        const iv = setInterval(() => {
          if (h.events.some((e) => e.type === 'chat-event' && e.event.type === 'result')) (clearInterval(iv), resolve())
        }, 20)
      })
      h.tab.ws.send(JSON.stringify({ type: 'chat-stop', id: 4 }))
      expect(await h.ended()).toEqual({ type: 'chat-end', id: 4, ok: true })
      h.close()
      await wait(50)
      // Stopped mid-turn, the real claude exits 143 by its own handler, not by the signal: still a stop, not an error.
      const g = chatTab(true)
      await g.tab.welcomed
      g.tab.ws.send(JSON.stringify({ type: 'chat', id: 10, prompt: 'hang, then exit 143' }))
      await new Promise((resolve) => {
        const iv = setInterval(() => {
          if (g.events.some((e) => e.type === 'chat-event' && e.event.type === 'system')) (clearInterval(iv), resolve())
        }, 20)
      })
      g.tab.ws.send(JSON.stringify({ type: 'chat-stop', id: 10 }))
      expect(await g.ended()).toEqual({ type: 'chat-end', id: 10, ok: true })
      g.close()
      await wait(50)
    // Two children in turn, the second left hanging until it is stopped: the longest of the three, and the one a
    // busy machine is likeliest to push over a bare limit.
    }, 20_000)

    it('a turn is its own tab’s: another tab cannot stop it, and one tab runs three at most', async () => {
      const h = chatTab(true)
      await h.tab.welcomed
      const other = fakeTab([ECHO], async () => 'x')
      await other.welcomed
      const resultFor = (id) =>
        new Promise((resolve) => {
          const iv = setInterval(() => {
            if (h.events.some((e) => e.type === 'chat-event' && e.id === id && e.event.type === 'result')) (clearInterval(iv), resolve())
          }, 20)
        })
      h.tab.ws.send(JSON.stringify({ type: 'chat', id: 5, prompt: 'hang' }))
      h.tab.ws.send(JSON.stringify({ type: 'chat', id: 6, prompt: 'hang' }))
      h.tab.ws.send(JSON.stringify({ type: 'chat', id: 8, prompt: 'hang' }))
      await Promise.all([resultFor(5), resultFor(6), resultFor(8)])
      // A fourth while three run is turned away at once.
      h.tab.ws.send(JSON.stringify({ type: 'chat', id: 7, prompt: 'hang' }))
      await wait(200)
      expect(h.events.find((e) => e.type === 'chat-end' && e.id === 7)).toMatchObject({ ok: false, error: expect.stringContaining('already running') })
      // The same ids from another tab are someone else's: nothing stops.
      other.ws.send(JSON.stringify({ type: 'chat-stop', id: 5 }))
      other.ws.send(JSON.stringify({ type: 'chat-stop', id: 6 }))
      other.ws.send(JSON.stringify({ type: 'chat-stop', id: 8 }))
      await wait(300)
      expect(h.events.filter((e) => e.type === 'chat-end' && (e.id === 5 || e.id === 6 || e.id === 8))).toEqual([])
      h.tab.ws.send(JSON.stringify({ type: 'chat-stop', id: 5 }))
      h.tab.ws.send(JSON.stringify({ type: 'chat-stop', id: 6 }))
      h.tab.ws.send(JSON.stringify({ type: 'chat-stop', id: 8 }))
      await new Promise((resolve) => {
        const iv = setInterval(() => {
          if (h.events.filter((e) => e.type === 'chat-end' && (e.id === 5 || e.id === 6 || e.id === 8)).length === 3) (clearInterval(iv), resolve())
        }, 20)
      })
      other.ws.close()
      h.close()
      await wait(50)
    // Three hanging children and their bridges at once: real processes, declared the budget they need.
    }, 30_000)
  })
})
