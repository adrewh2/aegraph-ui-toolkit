import { afterEach, describe, expect, it } from 'vitest'
import { describeAccess, openAiAccess, resolveEngine } from '../access'
import { setVoiceSettings } from '../settings'

describe('openAiAccess', () => {
  afterEach(() => {
    setVoiceSettings({ openaiKey: '' })
  })

  it('is nothing when there is no key and the app is not local — so auto means the browser', () => {
    expect(openAiAccess()).toBeNull()
    expect(resolveEngine('auto')).toBe('browser')
    expect(resolveEngine('openai')).toBe('openai')
    expect(describeAccess()).toMatch(/^browser/)
  })

  it('on localhost is the dev server, with the key in .env.local', () => {
    const g = globalThis as { location?: unknown }
    g.location = { hostname: '127.0.0.1' }
    try {
      expect(openAiAccess()).toEqual({ kind: 'local' })
      expect(resolveEngine('auto')).toBe('openai')
      expect(resolveEngine('browser')).toBe('browser')
      expect(describeAccess()).toContain('.env.local')
    } finally {
      delete g.location
    }
  })

  it("prefers the user's own key, wherever the app runs", () => {
    setVoiceSettings({ openaiKey: 'sk-mine' })
    expect(openAiAccess()).toEqual({ kind: 'key', key: 'sk-mine' })
    expect(describeAccess()).toBe('OpenAI, with your key')
    const g = globalThis as { location?: unknown }
    g.location = { hostname: 'localhost' }
    try {
      expect(openAiAccess()).toEqual({ kind: 'key', key: 'sk-mine' })
    } finally {
      delete g.location
    }
  })
})
