import { afterEach, describe, expect, it, vi } from 'vitest'
import { setAiSettings } from '../../../core/ai/settings'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/resources/types'
import { bridge, type ChatOptions } from '../../bridge/bridge'
import { messagesOf, rebuildChat } from '../record'
import { AssistantSession, type SessionEvent } from '../session'
import { transcriptMarkdown } from '../transcript'

/**
 * Stopping a turn is what the user asked for, not a failure: the chat says "Stopped" quietly, a question it was
 * waiting on reads "not answered" rather than "declined", and however the stop surfaces underneath — Claude Code
 * exiting 143, a bridge that reports it as an error — no error is shown.
 */

afterEach(() => vi.restoreAllMocks())

function claudeCodeTurn() {
  let reject: (err: Error) => void = () => {}
  const chat = vi.spyOn(bridge, 'chat').mockImplementation((_prompt: string, opts: ChatOptions) => {
    opts.onEvent?.({ type: 'system', subtype: 'init', session_id: 'cc-1' })
    // The model asks, and waits on the answer — as ask_user does.
    void opts.choose?.('By "places" do you mean the Surface entities?', ['Yes', 'No'])
    // An older bridge reports the killed process as a failure.
    return { done: new Promise<void>((_, rej) => (reject = rej)), stop: () => reject(new Error('claude exited with code 143')) }
  })
  vi.spyOn(bridge, 'canChat').mockReturnValue(true)
  return chat
}

describe('stopping a turn', () => {
  it('through Claude Code: the waiting question is not answered, the turn says Stopped, and no error is shown', async () => {
    setAiSettings({ apiKey: '' })
    claudeCodeTurn()
    const session = new AssistantSession()
    session.reset()
    session.attach({ store: new EntityStore(), navigate: () => {}, getContext: () => ({ route: '/chats' }) })
    const events: SessionEvent[] = []
    session.onEvent((e) => events.push(e))

    const sent = session.send('Map the places, one pin for each')
    await vi.waitFor(() => expect(session.getState().items.some((i) => i.kind === 'question')).toBe(true))
    session.stop()
    await sent

    const items = session.getState().items
    expect(items.map((i) => i.kind)).toEqual(['user', 'question', 'stopped'])
    expect(items[1]).toMatchObject({ kind: 'question', answer: null, stopped: true })
    expect(session.getState().busy).toBe(false)
    expect(events.find((e) => e.type === 'turn')).toEqual({ type: 'turn', reply: '' })

    // The next turn starts clean: a failure then is an error again.
    vi.restoreAllMocks()
    vi.spyOn(bridge, 'canChat').mockReturnValue(true)
    vi.spyOn(bridge, 'chat').mockReturnValue({ done: Promise.reject(new Error('claude exited with code 1')), stop: () => {} })
    await session.send('again')
    expect(session.getState().items.at(-1)).toMatchObject({ kind: 'error', text: 'claude exited with code 1' })
  })

  it('is kept as Stopped in the record, the rebuilt chat and the transcript', () => {
    const items = [
      { kind: 'user' as const, id: 'u', text: 'map it' },
      { kind: 'question' as const, id: 'q', message: 'Which places?', options: ['A', 'B'], answer: null, stopped: true },
      { kind: 'stopped' as const, id: 's' },
    ]
    const messages = messagesOf(items)
    expect(messages.slice(1).map((m) => m.content)).toEqual(['Which places? [A / B] — not answered: the chat was stopped', 'Stopped by the user.'])
    expect(rebuildChat(messages).items.at(-1)).toEqual({ kind: 'stopped', id: 's' })
    const session = new AssistantSession()
    session.seed(items, [])
    const md = transcriptMarkdown(session)
    expect(md).toContain('(not answered — the chat was stopped)')
    expect(md).toContain('_Stopped by the user._')
    session.reset()
  })
})
