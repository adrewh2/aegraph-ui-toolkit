import { describe, expect, it } from 'vitest'
import { BRANDS, brandOf, type BrandId } from '../brands'

/**
 * Which service a dataset belongs to, from its id, label or filename: the
 * ChatGPT archive and its atlas files, the Spotify library, the Claude
 * session trails — and nothing for everything else, so a demo that is not a
 * service keeps the generic mark. Every brand we name carries a colour, and
 * one with no mark of its own says so (a file in public/brands stands in).
 */
describe('brand marks', () => {
  it('names the service behind a dataset id, label or filename, case and spelling aside', () => {
    expect(brandOf('chatgpt-atlas')).toBe('chatgpt')
    expect(brandOf('chatgpt-conversations', 'ChatGPT conversations')).toBe('chatgpt')
    expect(brandOf('x', 'Chat-GPT export')).toBe('chatgpt')
    expect(brandOf('conversation-atlas-clean.ae.json')).toBe('chatgpt')
    expect(brandOf('atlas', 'Conversation Constellation')).toBe('chatgpt')
    expect(brandOf('openai-things')).toBe('chatgpt')
    expect(brandOf('session-trails')).toBe('claude')
    expect(brandOf('x', 'Session trails', 'session-trails.ae.json')).toBe('claude')
    expect(brandOf('claude-sessions')).toBe('claude')
    expect(brandOf('my-spotify-library')).toBe('spotify')
    expect(brandOf('x', 'SPOTIFY saved tracks')).toBe('spotify')
  })

  it('names nothing for a dataset that is not one service’s, and takes odd input in its stride', () => {
    for (const hint of ['aegraph-ui-system-map', 'bahamas-tour', 'flights-today', 'knowledge-infrastructure', 'dbpedia-programming-languages.nt']) expect(brandOf(hint), hint).toBeUndefined()
    expect(brandOf()).toBeUndefined()
    expect(brandOf(undefined, '')).toBeUndefined()
    expect(brandOf('gptchat')).toBeUndefined()
    expect(brandOf('claudette')).toBeUndefined()
  })

  it('every brand carries a label and a colour; the one we ship no mark for is the one a file can replace', () => {
    for (const [id, b] of Object.entries(BRANDS) as [BrandId, (typeof BRANDS)[BrandId]][]) {
      expect(b.label.length, id).toBeGreaterThan(0)
      expect(b.hex, id).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(b.path === undefined || b.path.length > 100, id).toBe(true)
      if (!b.path) expect(b.fallback, id).toBeDefined()
    }
    expect(BRANDS.spotify.path).toMatch(/^M12 0C5\.4 0 0 5\.4/)
    expect(BRANDS.claude.path?.length).toBeGreaterThan(1000)
    expect(BRANDS.chatgpt.path).toBeUndefined()
  })
})
