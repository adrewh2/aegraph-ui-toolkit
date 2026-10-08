import { afterEach, describe, expect, it, vi } from 'vitest'
import { canCapture, createWebSpeechListener, recognitionCtor, type ListenerHandlers } from '../listeners'

/**
 * The browser listener: a machine with four wires into the page
 * (onresult, onerror, onend, and what start() throws) and four out to
 * the controller. What it does with a browser that cannot listen, the
 * webkit spelling, interim words against finished phrases, the results
 * before the index it was given, an empty one, the errors that mean stop
 * and the ones that mean carry on, an ending it did not ask for against
 * one it did, and a start the browser refuses.
 */
interface FakeRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  onerror: ((ev: { error: string; message?: string }) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

const made: FakeRecognition[] = []
function install(over: Partial<FakeRecognition> = {}, key: 'SpeechRecognition' | 'webkitSpeechRecognition' = 'SpeechRecognition') {
  class Fake {
    continuous = false
    interimResults = false
    lang = ''
    onresult = null
    onend = null
    onerror = null
    start = over.start ?? vi.fn()
    stop = over.stop ?? vi.fn()
    abort = over.abort ?? vi.fn()
    constructor() {
      made.push(this as unknown as FakeRecognition)
    }
  }
  Object.defineProperty(globalThis, key, { value: Fake, configurable: true, writable: true })
}
const handlers = () => {
  const h = { onInterim: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onEnd: vi.fn(), onActivity: vi.fn() }
  return h as ListenerHandlers & typeof h
}
/** The shape the Web Speech API hands back: an array-like of alternatives. */
const results = (...phrases: [string, boolean][]) => phrases.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } }))

afterEach(() => {
  made.length = 0
  for (const k of ['SpeechRecognition', 'webkitSpeechRecognition']) Reflect.deleteProperty(globalThis as object, k)
  vi.unstubAllGlobals()
})

describe('recognitionCtor and canCapture', () => {
  it('finds either spelling, prefers the standard one, and answers null when the browser has neither', () => {
    expect(recognitionCtor()).toBeNull()
    install({}, 'webkitSpeechRecognition')
    expect(recognitionCtor()).not.toBeNull()
    install()
    expect(recognitionCtor()).toBe((globalThis as unknown as { SpeechRecognition: unknown }).SpeechRecognition)
  })

  it('says a browser with no microphone API cannot capture', () => {
    expect(canCapture()).toBe(false) // node: no navigator.mediaDevices, no AudioContext
  })
})

describe('createWebSpeechListener', () => {
  it('says so, fatally, when the browser cannot listen at all', () => {
    const h = handlers()
    createWebSpeechListener(h).start()
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining('cannot listen'), true)
    expect(made).toHaveLength(0)
  })

  it('takes the webkit spelling when it is the only one, and sets up a continuous session in the page language', () => {
    vi.stubGlobal('navigator', { language: 'fr-CA' })
    install({}, 'webkitSpeechRecognition')
    createWebSpeechListener(handlers()).start()
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ continuous: true, interimResults: true, lang: 'fr-CA' })
    expect(made[0].start).toHaveBeenCalled()
  })

  it('sends finished phrases on as they finish and gathers the unfinished ones into one line', () => {
    install()
    const h = handlers()
    createWebSpeechListener(h).start()
    made[0].onresult!({ resultIndex: 0, results: results(['  open the ', true], ['graph ', false], ['explorer', false]) })
    expect(h.onFinal).toHaveBeenCalledTimes(1)
    expect(h.onFinal).toHaveBeenCalledWith('open the', false) // never complete: this listener does not wait out the pause
    expect(h.onInterim).toHaveBeenCalledWith('graph explorer')
  })

  it('starts at the index it is given and skips a result with nothing in it', () => {
    install()
    const h = handlers()
    createWebSpeechListener(h).start()
    made[0].onresult!({ resultIndex: 1, results: results(['already said', true], ['   ', true], ['now', false]) })
    expect(h.onFinal).not.toHaveBeenCalled()
    expect(h.onInterim).toHaveBeenCalledWith('now')
    // Nothing recognised at all: no interim either.
    h.onInterim.mockClear()
    made[0].onresult!({ resultIndex: 0, results: results(['', false]) })
    expect(h.onInterim).not.toHaveBeenCalled()
  })

  it('mends the name the transcriber gets wrong, and leaves a real request for a graph alone', () => {
    install()
    const h = handlers()
    createWebSpeechListener(h).start()
    made[0].onresult!({ resultIndex: 0, results: results(['ask ay-graph to help', true], ['show me a graph', true]) })
    expect(h.onFinal.mock.calls.map((c) => c[0])).toEqual(['ask Aegraph to help', 'show me a graph'])
  })

  it('stops for good on an error that means stop, and stays quiet when that session then ends', () => {
    install()
    const h = handlers()
    createWebSpeechListener(h).start()
    made[0].onerror!({ error: 'not-allowed' })
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining('Microphone access was denied'), true)
    made[0].onend!()
    expect(h.onEnd).not.toHaveBeenCalled() // the listener has let go: nothing to restart
    const mic = handlers()
    createWebSpeechListener(mic).start()
    made[1].onerror!({ error: 'audio-capture' })
    expect(mic.onError).toHaveBeenCalledWith('No microphone was found.', true)
    const other = handlers()
    createWebSpeechListener(other).start()
    made[2].onerror!({ error: 'language-not-supported' })
    expect(other.onError).toHaveBeenCalledWith('Speech recognition failed: language-not-supported', true)
  })

  it('mentions the network once, says nothing about a silence, and lets the session end so the controller restarts it', () => {
    install()
    const h = handlers()
    createWebSpeechListener(h).start()
    made[0].onerror!({ error: 'network' })
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining('network connection'), false)
    h.onError.mockClear()
    made[0].onerror!({ error: 'no-speech' })
    made[0].onerror!({ error: 'aborted' })
    expect(h.onError).not.toHaveBeenCalled() // the browser ends the session; onend is the signal, not these
    made[0].onend!()
    expect(h.onEnd).toHaveBeenCalledTimes(1)
  })

  it('goes quiet when it is stopped, whatever the browser says afterwards', () => {
    install()
    const h = handlers()
    const listener = createWebSpeechListener(h)
    listener.start()
    listener.stop()
    expect(made[0].abort).toHaveBeenCalled()
    made[0].onend!()
    expect(h.onEnd).not.toHaveBeenCalled()
    expect(() => listener.stop()).not.toThrow() // stopping twice is nothing at all
  })

  it('lets go of the session it had when it is started again, so one voice is not heard twice', () => {
    install()
    const h = handlers()
    const listener = createWebSpeechListener(h)
    listener.start()
    listener.start()
    expect(made).toHaveLength(2)
    expect(made[0].abort).toHaveBeenCalled() // the first session is let go rather than left running
    expect(made[0].onresult).toBeNull() // and unhooked, so a late word from it cannot be reported twice
    made[1].onresult!({ resultIndex: 0, results: results(['live', true]) })
    expect(h.onFinal.mock.calls.map((c) => c[0])).toEqual(['live'])
  })

  it('treats a start the browser refuses as an ending, so the controller tries again', () => {
    install({ start: vi.fn(() => { throw new Error('already started') }) })
    const h = handlers()
    createWebSpeechListener(h).start()
    expect(h.onEnd).toHaveBeenCalledTimes(1)
    expect(h.onError).not.toHaveBeenCalled()
  })
})
