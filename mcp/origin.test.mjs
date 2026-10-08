import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

/**
 * The bridge's origin check. A WebSocket is not subject to the same-origin
 * policy, so without this any page open in the browser could connect to the
 * loopback, register itself as the tab and drive the app — and ask for a
 * chat turn, which spawns `claude -p` in the repo. The handshake is refused
 * for anything but this machine's dev servers and the deployed site.
 */
const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))

/**
 * A bridge, with the environment a case needs. Resolves with the child and **the port it actually took**: asked for
 * one that another test file's bridge already holds, the server moves to the next free port in its span, and a case
 * that assumed the port it asked for would end up talking to the other bridge — which is how this test first flaked.
 */
function bridge(env = {}) {
  const child = spawn('node', [SERVER], { env: { ...process.env, AEGRAPH_BRIDGE_PORT_SPAN: '40', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    const onData = (d) => {
      const port = /listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]
      if (port) {
        child.stderr.off('data', onData)
        resolve({ child, port: Number(port) })
      }
    }
    child.stderr.on('data', onData)
    child.on('error', reject)
  })
}

/** How the bridge answers a connection from this origin: 'open' or the HTTP status it refused with. */
const connect = (port, origin) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {})
    let opened = false
    ws.on('open', () => {
      opened = true
      ws.close()
      resolve('open')
    })
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode))
    ws.on('error', (err) => resolve(opened ? 'open' : /Unexpected server response: (\d+)/.exec(err.message)?.[1] ?? `error: ${err.message}`))
    ws.on('close', () => resolve(opened ? 'open' : 'closed'))
  })

/** The default bridge and one told to take only a deployment of its own; each reports the port it really took. */
let PORT
let LIMITED
let NO_HOSTED
let CORP
let servers = []
beforeAll(async () => {
  // A range of its own: `server.test.mjs` works in 8790–8890 and `server-edges.test.mjs` in 8900–8999, and a bridge
  // whose port is taken moves to the next free one — so a file that camps in another's range makes that file flaky.
  // The default: no AEGRAPH_HOSTED_ORIGIN, whatever the shell running the tests has set.
  const [open, limited] = [await bridge({ AEGRAPH_BRIDGE_PORT: '8600', AEGRAPH_HOSTED_ORIGIN: undefined }), await bridge({ AEGRAPH_BRIDGE_PORT: '8650', AEGRAPH_BRIDGE_ORIGINS: 'https://only.example' })]
  PORT = open.port
  LIMITED = limited.port
  expect(PORT, 'the two bridges must be on different ports').not.toBe(LIMITED)
  // No hosted site trusted, said explicitly; or a deployment of one's own.
  const [none, corp] = [await bridge({ AEGRAPH_BRIDGE_PORT: '8700', AEGRAPH_HOSTED_ORIGIN: '' }), await bridge({ AEGRAPH_BRIDGE_PORT: '8745', AEGRAPH_HOSTED_ORIGIN: 'https://graph.corp.example/' })]
  NO_HOSTED = none.port
  CORP = corp.port
  servers = [open.child, limited.child, none.child, corp.child]
}, 30_000)
afterAll(() => servers.forEach((s) => s.kill('SIGTERM')))

describe('the bridge only takes connections from pages it should', () => {
  it('refuses a page on any other site, including one whose name contains an allowed one', async () => {
    for (const origin of ['https://evil.example', 'http://evil.localhost.attacker.com', 'https://aegraph.dev.evil.com', 'https://notaegraph.dev', 'null']) {
      expect(await connect(PORT, origin), origin).toBe(403)
    }
  })

  it('takes this machine’s dev servers and previews', async () => {
    for (const origin of ['http://localhost:5173', 'http://localhost:5199', 'http://127.0.0.1:4173']) {
      expect(await connect(PORT, origin), origin).toBe('open')
    }
  })

  it('by default trusts aegraph.sh, this edition\'s own site, and no other: aegraph.dev or any other deployment is refused', async () => {
    expect(await connect(PORT, 'https://aegraph.sh')).toBe('open')
    for (const origin of ['https://aegraph.dev', 'https://www.aegraph.sh', 'http://aegraph.sh', 'https://aegraph.sh.evil.example', 'https://graph.corp.example']) {
      expect(await connect(PORT, origin), origin).toBe(403)
    }
  })

  it('takes a connection with no origin: a driver or a test on the loopback, never a browser page', async () => {
    expect(await connect(PORT, null)).toBe('open')
  })

  it('AEGRAPH_BRIDGE_ORIGINS replaces the list, so a deployment of one’s own is the only page that drives it', async () => {
    expect(await connect(LIMITED, 'https://only.example')).toBe('open')
    for (const origin of ['http://localhost:5173', 'https://aegraph.dev', 'https://evil.example']) {
      expect(await connect(LIMITED, origin), origin).toBe(403)
    }
  })

  it('AEGRAPH_HOSTED_ORIGIN empty trusts no hosted site; set, it trusts that one and no other', async () => {
    expect(await connect(NO_HOSTED, 'https://aegraph.sh')).toBe(403)
    expect(await connect(NO_HOSTED, 'https://aegraph.dev')).toBe(403)
    expect(await connect(NO_HOSTED, 'http://localhost:5199')).toBe('open')
    expect(await connect(CORP, 'https://graph.corp.example')).toBe('open')
    expect(await connect(CORP, 'https://aegraph.sh')).toBe(403)
    expect(await connect(CORP, 'https://aegraph.dev')).toBe(403)
    expect(await connect(CORP, 'https://evil.example')).toBe(403)
  })
})
