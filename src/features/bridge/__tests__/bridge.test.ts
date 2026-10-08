import { describe, expect, it } from 'vitest'
import { spanUrls } from '../bridge'

describe('bridge port span', () => {
  it('stands for the base port and the ones after it', () => {
    expect(spanUrls('ws://127.0.0.1:8787', 3)).toEqual(['ws://127.0.0.1:8787', 'ws://127.0.0.1:8788', 'ws://127.0.0.1:8789'])
    expect(spanUrls('ws://localhost:9000/bridge', 2)).toEqual(['ws://localhost:9000/bridge', 'ws://localhost:9001/bridge'])
    expect(spanUrls('wss://bridge.example', 4)).toEqual(['wss://bridge.example'])
    // A driver's private bridge: its one port, whatever servers sit on the ports after it.
    expect(spanUrls('ws://127.0.0.1:9412/?token=abc&span=1', 3)).toEqual(['ws://127.0.0.1:9412/?token=abc&span=1'])
  })
})
