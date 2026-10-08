import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeClient, toBridgeBlocks } from '../bridge'

/**
 * The links a tab keeps: every chat turn's own bridge comes up on a fresh port the tab is told about (`probe`).
 * Such a link is followed while its turn needs it and dropped once it has gone — not retried every half minute for
 * the life of the tab, one more per turn — and turning the bridge off ends the turns still waiting on it.
 */
class FakeSocket {
  static OPEN = 1
  static made: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  sent: string[] = []
  url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.made.push(this)
  }
  send(m: string) {
    this.sent.push(m)
  }
  up() {
    this.readyState = 1
    this.onopen?.()
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

const CHILD = 'ws://127.0.0.1:50123'
const socketsFor = (url: string) => FakeSocket.made.filter((s) => s.url === url)

function connected() {
  const b = new BridgeClient()
  const inner = b as unknown as { host: unknown; state: { enabled: boolean }; connect(): void; links: { url: string }[] }
  inner.host = {}
  inner.state.enabled = true
  inner.connect()
  const base = FakeSocket.made[0]
  base.up()
  return { b, base, links: () => inner.links.map((l) => l.url) }
}

describe('bridge links', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.made = []
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('location', { href: 'http://127.0.0.1:5199/' })
    vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("drops a chat turn's link once its server has come and gone", async () => {
    const { b, base, links } = connected()
    const span = links().length
    const run = b.chat('hi', { onEvent: () => {} })
    base.receive({ type: 'probe', url: CHILD, chat: 1 })
    expect(links()).toHaveLength(span + 1)
    // Still starting when the probe arrives: the port is tried again until it answers.
    socketsFor(CHILD)[0].close()
    vi.advanceTimersByTime(300)
    expect(socketsFor(CHILD)).toHaveLength(2)
    socketsFor(CHILD)[1].up()
    base.receive({ type: 'chat-end', id: 1, ok: true })
    await run.done
    socketsFor(CHILD)[1].close() // the turn's process exits
    expect(links()).toHaveLength(span)
    vi.advanceTimersByTime(120_000)
    expect(socketsFor(CHILD)).toHaveLength(2)
  })

  it('drops the link of a turn that ended before its server ever answered', async () => {
    const { b, base, links } = connected()
    const span = links().length
    const run = b.chat('hi', { onEvent: () => {} })
    base.receive({ type: 'probe', url: CHILD, chat: 1 })
    base.receive({ type: 'chat-end', id: 1, ok: false, error: 'claude was not found' })
    await expect(run.done).rejects.toThrow('claude was not found')
    socketsFor(CHILD)[0].close()
    expect(links()).toHaveLength(span)
    vi.advanceTimersByTime(120_000)
    expect(socketsFor(CHILD)).toHaveLength(1)
  })

  it('follows a probe only to a bridge on this machine — never a host a server names', () => {
    const { base, links } = connected()
    const span = links().length
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const url of ['wss://evil.example/bridge', 'ws://evil.example:8787', 'ws://127.0.0.1.evil.example:8787', 'ws://user:pw@127.0.0.1:8790', 'http://127.0.0.1:8790', 'ws://10.0.0.5:8787', 'ws://[::2]:8787', 'not a url', 42]) {
      base.receive({ type: 'probe', url, chat: 1 })
    }
    expect(links()).toHaveLength(span)
    for (const url of ['ws://127.0.0.1:50200', 'ws://localhost:50201', 'ws://[::1]:50202']) base.receive({ type: 'probe', url })
    expect(links()).toHaveLength(span + 3)
    expect(FakeSocket.made.map((s) => s.url)).not.toContain('ws://evil.example:8787')
  })

  it('puts a second question behind the first rather than in its place, and declines every one when the bridge goes off', async () => {
    const { b } = connected()
    const ask = (b as unknown as { ask(m: string, k: 'tool'): Promise<boolean> }).ask.bind(b)
    const first = ask('Delete “A”?', 'tool')
    const second = ask('Fetch https://x.example/?', 'tool')
    const third = ask('Delete “C”?', 'tool')
    expect(b.getState().confirm?.message).toBe('Delete “A”?')
    b.answer(b.getState().confirm!.id, true)
    await expect(first).resolves.toBe(true)
    // The next one comes up in its own right, unanswered.
    expect(b.getState().confirm?.message).toBe('Fetch https://x.example/?')
    b.setEnabled(false)
    await expect(second).resolves.toBe(false)
    await expect(third).resolves.toBe(false)
    expect(b.getState().confirm).toBeNull()
  })

  it('follows a turn’s probe with the token the server put in it', () => {
    const { base, links } = connected()
    base.receive({ type: 'probe', url: 'ws://127.0.0.1:50300/?token=0123456789abcdef0123456789abcdef', chat: 1 })
    expect(links()).toContain('ws://127.0.0.1:50300/?token=0123456789abcdef0123456789abcdef')
    expect(FakeSocket.made.map((s) => s.url)).toContain('ws://127.0.0.1:50300/?token=0123456789abcdef0123456789abcdef')
  })

  it('never hands an image on by address: the server would have to fetch it', () => {
    expect(toBridgeBlocks([{ type: 'text', text: 'meta' }, { type: 'image', source: { type: 'url', url: 'https://attacker.example/?d=1' } }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }])).toEqual([
      { type: 'text', text: 'meta' },
      { type: 'text', text: '[an image given by address, not sent]' },
      { type: 'image', mimeType: 'image/png', data: 'AA==' },
    ])
  })

  it('ends the turns in flight when the bridge is turned off', async () => {
    const { b } = connected()
    const run = b.chat('hi', { onEvent: () => {} })
    b.setEnabled(false)
    await expect(run.done).rejects.toThrow(/turned off/)
    expect((b as unknown as { chats: Map<number, unknown> }).chats.size).toBe(0)
  })
})
