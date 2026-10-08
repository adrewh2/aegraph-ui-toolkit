#!/usr/bin/env node
/**
 * Drive the app over MCP without Claude Code in the loop, for scripted
 * checks and data jobs:
 *
 *   node mcp/drive.mjs steps.mjs [http://localhost:5199/]
 *
 * It spawns mcp/server.mjs (like Claude Code would), launches headless
 * Chrome on the dev server with a persistent profile (PROFILE=dir, default
 * ./mcp-profile — the Library lives in it between runs), points the tab's
 * bridge at the server, and runs your steps:
 *
 *   export default async ({ call, evaluate, shot, sleep, send }) => {
 *     console.log(await call('project_list'))
 *   }
 *
 * `call(name, args)` is an MCP tool call; the result text comes back parsed
 * as JSON when it is JSON, and a tool error throws. `evaluate(js)` runs in
 * the tab, `shot(file)` screenshots it, `send` is raw CDP. Downloads land
 * in DOWNLOADS (default ./downloads). Confirmations the bridge
 * raises are accepted automatically — only run steps you mean. The bridge
 * is this run's alone (a random port or BRIDGE_PORT, a token, the tab
 * linked to that one port), so no other session's tab answers its calls. GL=1 gives
 * the tab software WebGL for the graph views; GL=hw the machine's GPU
 * (Metal, WebGPU included) — the only way to time the GPU graph honestly. Against a deployed site of
 * yours (`AEGRAPH_HOSTED_ORIGIN=https://your.site node mcp/drive.mjs steps.mjs https://your.site/`: the
 * bridge trusts no hosted site unless told) add
 * CHROME_FLAGS=--disable-features=LocalNetworkAccessChecks: a public page
 * reaching 127.0.0.1 needs Chrome's Local Network Access permission, which
 * a headed browser asks for once and headless silently refuses.
 *
 * CHROME_PATH names the Chrome (or Chromium) to launch. By default it is
 * Google Chrome where macOS and Windows install it, and on Linux the first
 * of google-chrome, google-chrome-stable, chromium, chromium-browser on PATH
 * (mcp/chromePath.mjs). GL=hw's flags are for Metal, i.e. a Mac.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromePath } from './chromePath.mjs'
import { unframe } from './frame.mjs'

const [stepsPath, urlArg] = process.argv.slice(2)
const APP = urlArg ?? 'http://localhost:5199/'
// This run's own bridge: one port (no span to drift along into another session's range) and a token, and the tab told
// to link to that port alone (`span=1`). Without all three, two drivers — or a driver and a session — reach each other's
// tabs: one run's `call`s answered by a tab it is not measuring, its delete confirmations accepted in someone else's.
const PORT = Number(process.env.BRIDGE_PORT ?? 9400 + Math.floor(Math.random() * 300))
const TOKEN = randomBytes(12).toString('hex')
const BRIDGE_URL = `ws://127.0.0.1:${PORT}/?token=${TOKEN}&span=1`
const PROFILE = resolve(process.env.PROFILE ?? 'mcp-profile')
// Found before anything starts, so a machine without Chrome says so rather than leaving a bridge running.
const CHROME = chromePath()
const DOWNLOADS = resolve(process.env.DOWNLOADS ?? 'downloads')
mkdirSync(DOWNLOADS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const client = new Client({ name: 'mcpdrive', version: '0' })
const transport = new StdioClientTransport({ command: 'node', args: [new URL('./server.mjs', import.meta.url).pathname], env: { ...process.env, AEGRAPH_BRIDGE_PORT: String(PORT), AEGRAPH_BRIDGE_PORT_SPAN: '1', AEGRAPH_BRIDGE_TOKEN: TOKEN, AEGRAPH_BRIDGE_TIMEOUT_MS: '900000' }, stderr: 'pipe' })
await client.connect(transport)
// VERBOSE=1 shows the bridge server's log (tab connects, manifests, calls).
if (process.env.VERBOSE) transport.stderr?.on('data', (d) => process.stderr.write(d))

const port = 9700 + Math.floor(Math.random() * 200)
// CHROME_FLAGS adds flags, e.g. --disable-features=LocalNetworkAccessChecks to drive a deployed site (with AEGRAPH_HOSTED_ORIGIN set to it):
// Chrome gates a public page's connection to 127.0.0.1 behind a Local Network Access permission that headless cannot grant.
const extraFlags = (process.env.CHROME_FLAGS ?? '').split(' ').filter(Boolean)
const chrome = spawn(CHROME, [...extraFlags, '--headless=new', ...(process.env.GL === 'hw' ? ['--ignore-gpu-blocklist', '--use-angle=metal', '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'] : process.env.GL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--disable-gpu']), '--hide-scrollbars', '--window-size=1440,900', '--js-flags=--max-old-space-size=6144', `--remote-debugging-port=${port}`, `--user-data-dir=${PROFILE}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
let ws
try {
  let targets
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break } catch { await sleep(200) }
  }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const bws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((r) => (bws.onopen = r))
  bws.send(JSON.stringify({ id: 1, method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true } }))
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  const logs = []
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) logs.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
    else if (msg.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text))
  }
  // Chrome gone (crashed, killed, out of memory) answers nothing: every call waiting on it, and every one after, gets an
  // error instead — otherwise the steps wait for ever, and this process and its bridge live on with them.
  const gone = { error: { message: 'the browser went away' } }
  ws.onclose = () => { for (const res of pending.values()) res(gone); pending.clear() }
  const send = (method, params = {}) => new Promise((res) => { if (ws.readyState !== WebSocket.OPEN) return res(gone); const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.error) throw new Error(`evaluate: ${r.error.message} (the tab may have crashed or navigated)`)
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result.result.value
  }
  const shot = async (file) => {
    const s = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(s.result.data, 'base64'))
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: APP })
  for (let i = 0; i < 600; i++) { if (await evaluate(`!!document.querySelector('.app') && !document.body.innerText.includes('Loading workspace')`)) break; await sleep(100) }
  // Point the tab at this bridge, enable it, and auto-accept its delete confirmations.
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    localStorage.setItem('aegraph:bridge:url', '${BRIDGE_URL}')
    document.querySelector('.bridge-item').click(); await sleep(200)
    const input = document.querySelector('.dialog input.input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${BRIDGE_URL}')
    input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(50)
    ;[...document.querySelectorAll('.dialog .btn')].find((b) => b.textContent.trim() === 'Apply').click(); await sleep(50)
    const toggle = document.querySelector('.bridge-toggle input'); if (toggle && !toggle.checked) toggle.click(); await sleep(50)
    ;[...document.querySelectorAll('.dialog .btn')].find((b) => b.textContent.trim() === 'Done').click()
  })()`)
  // Accept the bridge's confirmations (a delete, a new host to read, a setting), on this document and on every one after it. A step that reloads the
  // page (or navigates with location.assign) gets a fresh document, and an interval installed only in the first one
  // dies with it: the bridge then reconnects, tools come back, and the next delete hangs for the full timeout with
  // nobody to click yes. Installed through CDP so it is there before the app's first line runs, every time.
  const AUTO_CONFIRM = `window.__autoConfirm = setInterval(() => {
    const title = [...document.querySelectorAll('.dialog__title')].find((t) => t.textContent.includes('Claude Code wants'))
    if (!title) return
    // The dialog's yes is its primary button, whatever its word (Delete, Allow, Yes…).
    const b = title.closest('.dialog').querySelector('.btn--primary')
    b?.click()
  }, 150)`
  await send('Page.addScriptToEvaluateOnNewDocument', { source: AUTO_CONFIRM })
  await evaluate(AUTO_CONFIRM)
  for (let i = 0; i < 100; i++) { if (await evaluate(`document.querySelector('.bridge-item--connected') !== null`)) break; await sleep(100) }
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: Number(process.env.CALL_TIMEOUT_MS ?? 600000) })
    const text = r.content.filter((c) => c.type === 'text').map((c) => unframe(c.text)).join('\n')
    if (r.isError) throw new Error(`${name}: ${text}`)
    try { return JSON.parse(text) } catch { return text }
  }
  // Connected is not ready: the tab announces its tools a moment after the socket opens. Wait for the manifest.
  let status
  for (let i = 0; i < 100; i++) { status = await call('aegraph_bridge_status'); if (status.tools?.length) break; await sleep(100) }
  // Refuse to run steps anywhere but this run's own tab, on this run's own port.
  if (status?.port !== PORT) throw new Error(`the bridge is not on port ${PORT} (${status?.port ?? 'none'}): taken by another run? Set BRIDGE_PORT.`)
  if (status.tabs !== 1) throw new Error(`the bridge has ${status.tabs} tabs, not this run's one`)
  const steps = (await import(resolve(stepsPath))).default
  await steps({ call, evaluate, shot, sleep, send, logs, client })
  if (logs.length) console.log('console:', logs.slice(-10).join('\n'))
  await evaluate(`(async () => { const p = window.__aegraph?.persistence; if (p) await p.flush() })()`)
  await sleep(500)
} finally {
  // Let Chrome close itself so localStorage and IndexedDB reach disk; only then force it.
  const exited = new Promise((r) => chrome.once('exit', r))
  try { await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).then((v) => { const b = new WebSocket(v.webSocketDebuggerUrl); b.onopen = () => b.send(JSON.stringify({ id: 1, method: 'Browser.close' })) }) } catch {}
  ws?.close()
  await Promise.race([exited, sleep(8000)])
  chrome.kill('SIGKILL')
  await client.close()
}
