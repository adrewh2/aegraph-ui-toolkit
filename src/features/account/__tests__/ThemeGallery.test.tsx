import { renderToString } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }))

/**
 * The gallery shows every theme as a card drawn in that theme: each card's inside is `[data-theme-preview='<id>']`,
 * the selector every theme block answers beside `:root[data-theme='<id>']`. Opening it is a store of its own, so the
 * menu that opens it can close first.
 */
describe('the theme gallery', () => {
  const mem: Record<string, string> = {}
  beforeAll(() => {
    vi.stubGlobal('document', { body: {}, activeElement: null })
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k] })
  })
  afterAll(() => vi.unstubAllGlobals())

  it('draws a card for every theme, in that theme, grouped as aegraph’s and Unigraph’s, with System first', async () => {
    const { THEMES } = await import('../../../app/theme')
    const { ThemeGalleryHost } = await import('../ThemeGallery')
    const { openThemeGallery, closeThemeGallery } = await import('../themeGalleryStore')
    expect(renderToString(<ThemeGalleryHost />)).toBe('')
    openThemeGallery()
    const html = renderToString(<ThemeGalleryHost />)
    for (const t of THEMES) {
      expect(html, t.id).toContain(`data-theme-preview="${t.id}"`)
      expect(html, t.id).toContain(`>${t.label.replace('’', '&#x27;')}<`.replace('&#x27;', '’'))
    }
    expect(html.indexOf('System')).toBeLessThan(html.indexOf('data-theme-preview'))
    expect(html.indexOf('>aegraph<')).toBeLessThan(html.indexOf('>From Unigraph<'))
    // Light before dark in each group: a dark card between two light ones breaks the row.
    const order = [...html.matchAll(/data-theme-preview="([\w-]+)"/g)].map((m) => m[1])
    for (const g of ['aegraph', 'unigraph'] as const) {
      const schemes = order.filter((id) => THEMES.find((t) => t.id === id)!.group === g).map((id) => THEMES.find((t) => t.id === id)!.scheme)
      expect(schemes.indexOf('dark') === -1 || schemes.lastIndexOf('light') < schemes.indexOf('dark'), g).toBe(true)
    }
    // A way out in the corner.
    expect(html).toContain('class="dialog__close"')
    // The default is System, so no theme card is the chosen one yet.
    expect(html).not.toMatch(/role="radio" aria-checked="true"/)
    closeThemeGallery()
    expect(renderToString(<ThemeGalleryHost />)).toBe('')
  })

  it('names the choice in the menu: a theme by its name, System with the one it shows', async () => {
    const { themeLabel } = await import('../themeGalleryStore')
    expect(themeLabel('dracula')).toBe('Dracula')
    expect(themeLabel('system', 'dark')).toBe('System (Dark)')
  })
})
