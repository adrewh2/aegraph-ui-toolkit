import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Voice with Third-party services off. The browser's own recogniser streams the microphone to Google (Chrome) or
 * Apple (Safari), and Chrome's Google voices send the reply they read to Google: neither is this site. Off, the
 * listener runs only on the device or not at all, and the speaker reads only with a voice on the device.
 */
const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
const { setUserSettings } = await import('../../account/settings')
const { createWebSpeechListener, OFFLINE_LISTENING } = await import('../listeners')
const { createBrowserSpeaker, OFFLINE_SPEAKING } = await import('../speakers')

const made: { processLocally?: boolean; start: () => void }[] = []
function installRecognition(available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>) {
  class Fake {
    continuous = false
    interimResults = false
    lang = ''
    onresult = null
    onend = null
    onerror = null
    start = vi.fn()
    stop = vi.fn()
    abort = vi.fn()
    constructor() {
      made.push(this)
    }
  }
  if (available) {
    Object.defineProperty(Fake.prototype, 'processLocally', { value: false, writable: true, configurable: true })
    Object.assign(Fake, { available: vi.fn(available) })
  }
  Object.defineProperty(globalThis, 'SpeechRecognition', { value: Fake, configurable: true, writable: true })
  return Fake as unknown as { available?: ReturnType<typeof vi.fn> }
}
const handlers = () => ({ onInterim: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onEnd: vi.fn() })
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => setUserSettings({ externalServices: false }))
afterEach(() => {
  made.length = 0
  Reflect.deleteProperty(globalThis as object, 'SpeechRecognition')
  vi.unstubAllGlobals()
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
  setUserSettings({ externalServices: true })
})

describe('the browser listener with Third-party services off', () => {
  it('does not start a recogniser that would send the audio away, and says why', async () => {
    installRecognition()
    const h = handlers()
    createWebSpeechListener(h).start()
    await flush()
    expect(made).toHaveLength(0)
    expect(h.onError).toHaveBeenCalledWith(OFFLINE_LISTENING, true)
  })

  it('nor one whose on-device model is not installed', async () => {
    const Ctor = installRecognition(async () => 'downloadable')
    const h = handlers()
    createWebSpeechListener(h).start()
    await flush()
    expect(Ctor.available).toHaveBeenCalledWith({ langs: [expect.any(String)], processLocally: true })
    expect(made).toHaveLength(0)
    expect(h.onError).toHaveBeenCalledWith(OFFLINE_LISTENING, true)
  })

  it('listens on the device when the browser can', async () => {
    installRecognition(async () => 'available')
    const h = handlers()
    createWebSpeechListener(h).start()
    await flush()
    expect(made).toHaveLength(1)
    expect(made[0].processLocally).toBe(true)
    expect(made[0].start).toHaveBeenCalled()
    expect(h.onError).not.toHaveBeenCalled()
  })

  it('a stop before the device answers starts nothing', async () => {
    installRecognition(async () => 'available')
    const listener = createWebSpeechListener(handlers())
    listener.start()
    listener.stop()
    await flush()
    expect(made).toHaveLength(0)
  })

  it('with the switch on, the browser recogniser starts as before, without asking the device', () => {
    setUserSettings({ externalServices: true })
    installRecognition()
    createWebSpeechListener(handlers()).start()
    expect(made).toHaveLength(1)
    expect(made[0].processLocally).toBeUndefined()
  })
})

describe('the browser speaker with Third-party services off', () => {
  const spoken: { voice?: { name: string } }[] = []
  const voice = (name: string, localService: boolean) => ({ name, lang: 'en-US', localService, default: false, voiceURI: name })
  const install = (voices: ReturnType<typeof voice>[]) => {
    spoken.length = 0
    vi.stubGlobal('navigator', { language: 'en-US' })
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => voices,
      speaking: false,
      pending: false,
      cancel: vi.fn(),
      speak: (u: { voice?: { name: string }; onend?: () => void }) => {
        spoken.push(u)
        setTimeout(() => u.onend?.(), 0)
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        voice?: unknown
        lang = ''
        rate = 1
        text: string
        constructor(text: string) {
          this.text = text
        }
      },
    )
  }

  it('reads with a voice on the device, never a network one — even the one picked in the settings', async () => {
    install([voice('Google US English', false), voice('Samantha', true)])
    await createBrowserSpeaker(() => ({ browserVoice: 'Google US English' }) as never).speak('Hello there.')
    expect(spoken.map((u) => u.voice?.name)).toEqual(['Samantha'])
  })

  it('refuses when the device has no voice of its own', async () => {
    install([voice('Google US English', false), voice('Microsoft Aria Online (Natural)', false)])
    await expect(createBrowserSpeaker(() => ({}) as never).speak('Hello.')).rejects.toThrow(OFFLINE_SPEAKING)
    expect(spoken).toHaveLength(0)
  })

  it('with the switch on, the network voice may read', async () => {
    setUserSettings({ externalServices: true })
    install([voice('Google US English', false), voice('Samantha', true)])
    await createBrowserSpeaker(() => ({ browserVoice: 'Google US English' }) as never).speak('Hello.')
    expect(spoken.map((u) => u.voice?.name)).toEqual(['Google US English'])
  })
})
