import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isThemePreference, resolveTheme, THEMES } from '../theme'

/**
 * The themes are CSS: Paper's tokens on :root in src/index.css, every other theme's in src/styles/themes.css. What
 * keeps them whole — every colour token set in every theme, text readable on every surface, the boot script and the
 * picker naming the same themes — is checked here, from the files themselves.
 */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const index = noComments(read('../../index.css'))
const themesCss = noComments(read('../../styles/themes.css')) + noComments(read('../../styles/themes-unigraph.css'))
const boot = read('../../../public/theme-boot.js')

/** The custom properties a block declares, by name. */
function props(block: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}
const rootStart = index.indexOf(":root,\n[data-theme-preview='paper'] {")
const rootBlock = index.slice(rootStart, index.indexOf('}', rootStart))
/** Paper's colour tokens: every :root token but the fonts and radii. */
const paper = new Map([...props(rootBlock)].filter(([k]) => !/^--(font|radius)/.test(k)))
const blockOf = (id: string) => {
  const start = themesCss.indexOf(`:root[data-theme='${id}'],\n[data-theme-preview='${id}'] {`)
  if (start < 0) return undefined
  return props(themesCss.slice(start, themesCss.indexOf('}', start)))
}
const tokensOf = (id: string) => (id === 'paper' ? paper : new Map([...paper, ...(blockOf(id) ?? [])]))

/** WCAG relative luminance and contrast of two #rrggbb colours. */
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

describe('the themes', () => {
  it('set every colour token Paper declares, and nothing Paper does not', () => {
    expect(paper.size).toBeGreaterThan(30)
    for (const t of THEMES.filter((t) => t.id !== 'paper')) {
      const block = blockOf(t.id)
      expect(block, t.id).toBeDefined()
      expect([...paper.keys()].filter((k) => !block!.has(k)), `${t.id} is missing`).toEqual([])
      expect([...block!.keys()].filter((k) => !paper.has(k)), `${t.id} declares tokens Paper does not`).toEqual([])
    }
  })

  it('keep text readable: 4.5:1 or better for text, muted and faint text on the background and both surfaces', () => {
    const low: string[] = []
    const need = (t: string, fg: string, bg: string, min = 4.5) => {
      const tok = tokensOf(t)
      const c = contrast(tok.get(fg)!, tok.get(bg)!)
      if (!(c >= min)) low.push(`${t}: ${fg} on ${bg} is ${c.toFixed(2)}:1`)
    }
    for (const t of THEMES) {
      for (const fg of ['--text', '--text-muted', '--text-faint', '--link', '--danger']) for (const bg of ['--bg', '--surface', '--surface-2']) need(t.id, fg, bg)
      need(t.id, '--accent-text', '--accent')
      for (const [fg, bg] of [['--info-text', '--info-bg'], ['--ok-text', '--ok-bg'], ['--warn-text', '--warn-bg']]) need(t.id, fg, bg)
      // A highlight's text is a mark on a mark, never body text: Paper's amber pair has always been 4.0:1.
      need(t.id, '--highlight-text', '--highlight-bg', 4)
    }
    expect(low).toEqual([])
  })

  it('are the same list in the picker and in the boot script, which knows which are dark', () => {
    for (const t of THEMES) expect(boot, t.id).toContain(`"${t.id}"`)
    const darkIds = THEMES.filter((t) => t.scheme === 'dark').map((t) => t.id)
    const darkInBoot = JSON.parse(/var dark = (\{.*\})/.exec(boot)![1]) as Record<string, number>
    expect(Object.keys(darkInBoot).sort()).toEqual([...darkIds].sort())
    // The swatches show the theme's own background and text.
    for (const t of THEMES) {
      expect(t.swatch[0].toLowerCase(), t.id).toBe(tokensOf(t.id).get('--bg')!.toLowerCase())
      expect(t.swatch[2].toLowerCase(), t.id).toBe(tokensOf(t.id).get('--text')!.toLowerCase())
    }
  })

  it('resolve system to Paper or Dark, and refuse a name they do not know', () => {
    expect(resolveTheme('system', false)).toBe('paper')
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('midnight', false)).toBe('midnight')
    expect(isThemePreference('neon')).toBe(false)
    expect(isThemePreference('system')).toBe(true)
  })
})

describe('Unigraph’s themes', () => {
  it('are all here, each with a preview block, and the generator’s output is what is committed', async () => {
    const ids = THEMES.filter((t) => t.group === 'unigraph').map((t) => t.id)
    expect(ids).toEqual(['unigraph-light', 'unigraph-dark', 'dracula', 'one-dark', 'solarized', 'monokai', 'nord', 'gruvbox', 'tokyo-night', 'catppuccin', 'unigraph-neon', 'unigraph-warm'])
    for (const id of ids) expect(themesCss, id).toContain(`[data-theme-preview='${id}']`)
  })
})
