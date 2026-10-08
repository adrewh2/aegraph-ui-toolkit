import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrameCapturer } from '../capture'

/** A display-capture stream whose one track records whether it was stopped. */
function fakeStream() {
  const track = {
    readyState: 'live',
    stopped: false,
    stop() {
      this.stopped = true
      this.readyState = 'ended'
    },
    addEventListener() {},
  }
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } }
}

describe('FrameCapturer', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('ends a share granted after stop() instead of keeping it live', async () => {
    const { track, stream } = fakeStream()
    let grant!: (s: unknown) => void
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: () => new Promise((r) => (grant = r)) } })
    vi.stubGlobal('document', { createElement: () => ({ play: () => Promise.resolve(), srcObject: null }) })
    const c = new FrameCapturer()
    const pending = c.capture({} as HTMLElement)
    // The page leaves while the picker is still open…
    c.stop()
    // …and the user grants the share afterwards.
    grant(stream)
    await expect(pending).rejects.toThrow(/stopped/)
    expect(track.stopped).toBe(true)
    expect(c.active).toBe(false)
  })
})
