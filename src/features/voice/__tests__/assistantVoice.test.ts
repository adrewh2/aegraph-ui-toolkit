import { describe, expect, it, vi } from 'vitest'
import type { AssistantSession } from '../../assistant/session'
import { localCommand, spokenQuestion } from '../assistantVoice'

describe('spokenQuestion', () => {
  it('reads a confirmation with yes/no and says where the buttons are', () => {
    expect(spokenQuestion('confirm', 'Delete “Notes”?', ['Delete', 'Cancel'])).toBe('Delete “Notes”? Say yes or no, or choose in the assistant.')
  })
  it('numbers the options of a choice', () => {
    expect(spokenQuestion('choice', 'Which one?', ['The map', 'A note'])).toBe('Which one? 1: The map. 2: A note. Choose in the assistant, or say one.')
    expect(spokenQuestion('choice', 'Which?', ['a', 'b'], 'on screen')).toMatch(/Choose on screen, or say one\.$/)
  })
  it('does not read out more than five options', () => {
    expect(spokenQuestion('choice', 'Which?', ['a', 'b', 'c', 'd', 'e', 'f'])).toBe('Which? 6 options. Choose in the assistant, or say one.')
  })
})

describe('localCommand', () => {
  const session = () => ({ stop: vi.fn(), reset: vi.fn() }) as unknown as AssistantSession & { stop: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> }

  it('"stop" cuts the turn; "new chat" opens a tab', () => {
    const s = session()
    expect(localCommand('Stop.', s)).toBe(true)
    expect(s.stop).toHaveBeenCalled()
    expect(localCommand('new chat', s)).toBe(true) // a new chat tab, in front (the chats load lazily)
    expect(s.reset).not.toHaveBeenCalled()
  })

  it('opens and closes the assistant', () => {
    // No DOM under node: a window that only records what is dispatched to it.
    const seen: unknown[] = []
    const g = globalThis as { window?: unknown }
    g.window = { dispatchEvent: (e: CustomEvent) => seen.push(e.detail) }
    try {
      expect(localCommand('open the assistant', null)).toBe(true)
      expect(localCommand('close the chat', null)).toBe(true)
    } finally {
      delete g.window
    }
    expect(seen).toEqual([{ open: true }, { open: false }])
  })

  it('leaves anything else to the assistant', () => {
    expect(localCommand('stop the video', null)).toBe(false)
    expect(localCommand('what is on screen', null)).toBe(false)
  })
})
