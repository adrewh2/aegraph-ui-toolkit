import { describe, expect, it } from 'vitest'
import { DOCUMENT_SUGGESTIONS, SHOWCASES, suggestionsFor } from '../suggestions'

describe('what a new chat is offered', () => {
  it('six showcases, each a title, a line and a whole request — the data they name over https', () => {
    expect(SHOWCASES).toHaveLength(6)
    for (const s of SHOWCASES) {
      expect(s.title.length).toBeGreaterThan(5)
      expect(s.hint.length).toBeGreaterThan(10)
      expect(s.prompt.length).toBeGreaterThan(s.hint.length)
      for (const url of s.prompt.match(/https?:\/\/[^\s)]+/g) ?? []) expect(url).toMatch(/^https:\/\/(raw\.githubusercontent\.com\/vega\/vega-datasets\/|query\.wikidata\.org\/sparql|api\.openalex\.org\/)/)
    }
    expect(new Set(SHOWCASES.map((s) => s.title)).size).toBe(6)
  })

  it('puts the open project’s own first, in its words, and keeps six', () => {
    const s = suggestionsFor('Toronto trees')
    expect(s).toHaveLength(6)
    expect(s[0].prompt).toContain('Toronto trees')
    expect(s[1].title).toContain('Toronto trees')
    expect(suggestionsFor()).toBe(SHOWCASES)
    expect(DOCUMENT_SUGGESTIONS.every((d) => /document/.test(d))).toBe(true)
  })
})
