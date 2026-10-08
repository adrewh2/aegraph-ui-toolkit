import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The dictation draft, against a fake SpeechRecognition: phrases the recogniser finalises at each pause join
 * one command, sent after the silence or on "send it", and kept across the browser restarting recognition.
 */
class FakeRecognition {
  static instances: FakeRecognition[] = []
  continuous = false
  interimResults = false
  lang = ''
  onresult: ((ev: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((ev: { error: string }) => void) | null = null
  started = 0
  constructor() {
    FakeRecognition.instances.push(this)
  }
  start() {
    this.started++
  }
  stop() {}
  abort() {
    this.onend?.()
  }
  say(transcript: string, isFinal: boolean) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] })
  }
}

const g = globalThis as { SpeechRecognition?: unknown; localStorage?: unknown }

describe('dictation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeRecognition.instances = []
    g.SpeechRecognition = FakeRecognition
    vi.resetModules()
  })
  afterEach(() => {
    delete g.SpeechRecognition
    vi.useRealTimers()
  })

  const setup = async () => {
    const { voice } = await import('../voice')
    const { setVoiceSettings } = await import('../settings')
    setVoiceSettings({ pauseMs: 2000 })
    const heard: string[] = []
    voice.onHeard((t) => heard.push(t))
    voice.start()
    expect(voice.getState().enabled).toBe(true)
    const rec = FakeRecognition.instances.at(-1)!
    return { voice, rec, heard }
  }

  it('joins the phrases of one command and sends it after the pause', async () => {
    const { voice, rec, heard } = await setup()
    rec.say('filter the graph to', false)
    rec.say('filter the graph to people', true)
    expect(voice.getState()).toMatchObject({ heard: 'filter the graph to people', heardFinal: false })
    vi.advanceTimersByTime(1500)
    rec.say('within two hops of Ada', true)
    expect(voice.getState().heard).toBe('filter the graph to people within two hops of Ada')
    vi.advanceTimersByTime(1500)
    expect(heard).toEqual([]) // still inside the pause after the last phrase
    vi.advanceTimersByTime(600)
    expect(heard).toEqual(['filter the graph to people within two hops of Ada'])
    expect(voice.getState()).toMatchObject({ heard: 'filter the graph to people within two hops of Ada', heardFinal: true })
    voice.stop()
  })

  it('interim words keep the command open past the pause', async () => {
    const { rec, heard } = await setup()
    rec.say('open the document', true)
    vi.advanceTimersByTime(1900)
    rec.say('called', false) // still talking
    vi.advanceTimersByTime(1900)
    expect(heard).toEqual([])
    rec.say('called notes', true)
    vi.advanceTimersByTime(2100)
    expect(heard).toEqual(['open the document called notes'])
  })

  it('"send it" ends the command at once', async () => {
    const { rec, heard } = await setup()
    rec.say('tag these as reviewed', true)
    rec.say('send it', true)
    expect(heard).toEqual(['tag these as reviewed'])
  })

  it('survives the browser ending recognition mid-command', async () => {
    const { rec, heard, voice } = await setup()
    rec.say('create a note about', true)
    rec.onend?.() // Chrome's session limit
    vi.advanceTimersByTime(300) // the restart
    const rec2 = FakeRecognition.instances.at(-1)!
    expect(rec2).not.toBe(rec)
    expect(rec2.started).toBe(1)
    rec2.say('the meeting', true)
    vi.advanceTimersByTime(2100)
    expect(heard).toEqual(['create a note about the meeting'])
    voice.stop()
  })

  it('answers a waiting question with the first phrase, without buffering', async () => {
    const { rec, voice, heard } = await setup()
    const answer = voice.expectAnswer({ kind: 'choice', message: 'Which?', options: ['The map', 'A note'] }, 'Which?')
    rec.say('the second one', true)
    expect(await answer).toBe('A note')
    expect(heard).toEqual([])
  })
})

describe('answers are never dropped as echo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeRecognition.instances = []
    g.SpeechRecognition = FakeRecognition
    vi.resetModules()
  })
  afterEach(() => {
    delete g.SpeechRecognition
    vi.useRealTimers()
  })
  it('takes the option said back verbatim while a question waits', async () => {
    const { voice } = await import('../voice')
    voice.start()
    const rec = FakeRecognition.instances.at(-1)!
    const answer = voice.expectAnswer({ kind: 'choice', message: 'Which one?', options: ['The map', 'A new note'] }, 'Which one? 1: The map. 2: A new note. Choose in the assistant, or say one.')
    rec.say('a new note', true)
    expect(await answer).toBe('A new note')
    voice.stop()
  })
})
