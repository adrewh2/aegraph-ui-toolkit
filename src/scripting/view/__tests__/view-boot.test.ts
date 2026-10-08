import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * The Visual frame's bootstrap takes away what its Content-Security-Policy does not govern before any script runs
 * (security review, pass 6, finding 4): WebRTC (STUN/TURN to any server) and DNS hints from <link>. Defence in depth —
 * the guarantee is that a Visual script never runs unless its owner presses Run.
 */
const bootPath = fileURLToPath(new URL('../../../../public/sandbox/view-boot.js', import.meta.url))

describe('the Visual bootstrap', () => {
  it('leaves no WebRTC constructor, and removes a <link> that is not a stylesheet', () => {
    let observer: ((records: { addedNodes: unknown[] }[]) => void) | undefined
    class MO {
      constructor(cb: (r: { addedNodes: unknown[] }[]) => void) {
        observer = cb
      }
      observe() {}
    }
    const window: Record<string, unknown> = { RTCPeerConnection: class {}, webkitRTCPeerConnection: class {}, RTCDataChannel: class {}, addEventListener: () => {} }
    const console = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    const ctx = { window, parent: { postMessage: () => {} }, console, document: { documentElement: {} }, MutationObserver: MO }
    vm.runInNewContext(readFileSync(bootPath, 'utf8'), ctx)
    expect(window.RTCPeerConnection).toBeUndefined()
    expect(window.webkitRTCPeerConnection).toBeUndefined()
    expect(window.RTCDataChannel).toBeUndefined()
    // A script cannot put it back.
    expect(() => (window.RTCPeerConnection = class {})).toThrow(TypeError)
    expect(window.RTCPeerConnection).toBeUndefined()
    const removed: string[] = []
    const link = (rel: string) => ({ nodeType: 1, tagName: 'LINK', getAttribute: () => rel, remove: () => removed.push(rel) })
    observer!([{ addedNodes: [link('dns-prefetch'), link('preconnect'), link('stylesheet'), link('prefetch')] }])
    expect(removed).toEqual(['dns-prefetch', 'preconnect', 'prefetch'])
  })
})
