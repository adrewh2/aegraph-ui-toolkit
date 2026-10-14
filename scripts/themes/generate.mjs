#!/usr/bin/env node
/**
 * Unigraph's themes as aegraph themes. `unigraph-palettes.json` holds the palettes Unigraph ships (from
 * `@aesgraph/app-shell`'s themes and Unigraph's own Neon and Warm), in Unigraph's roles — background, surface, text,
 * textMuted, primary, success… This maps each role onto aegraph's colour tokens and writes:
 *
 *   src/styles/themes-unigraph.css   one `:root[data-theme='<id>']` block per theme (every token, as Paper declares them)
 *   src/app/themes.unigraph.ts       the picker's entries (id, label, scheme, swatch, group)
 *   public/theme-boot.js             the ids and the dark ones, between its GENERATED markers
 *
 * Run `npm run themes` after changing a palette or the mapping; the output is committed. Colours with an alpha are
 * laid over the theme's background first, so every token is opaque. Text that a palette makes too faint for aegraph's
 * rule (4.5:1 on the background and both surfaces, `src/app/__tests__/theme.test.ts`) is moved toward white or black
 * until it reads: a palette's character is kept, its faintest grey is not.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const palettes = JSON.parse(readFileSync(join(root, 'scripts/themes/unigraph-palettes.json'), 'utf8'))

/** Unigraph's id → aegraph's id, label and a line for the picker. */
const NAMES = {
  light: ['unigraph-light', 'Unigraph Light', 'Cool white and slate, blue accents.'],
  dark: ['unigraph-dark', 'Unigraph Dark', 'Slate grey, blue accents.'],
  dracula: ['dracula', 'Dracula', 'Purple-grey, pink and purple accents.'],
  oneDark: ['one-dark', 'One Dark', 'Atom’s dark: blue-grey, soft blue.'],
  solarized: ['solarized', 'Solarized', 'Deep teal, the Solarized accents.'],
  monokai: ['monokai', 'Monokai', 'Olive-black, magenta and cyan.'],
  nord: ['nord', 'Nord', 'Arctic blue-grey, frost accents.'],
  gruvbox: ['gruvbox', 'Gruvbox', 'Retro warm brown, amber.'],
  tokyo: ['tokyo-night', 'Tokyo Night', 'Night blue, neon blue.'],
  catppuccin: ['catppuccin', 'Catppuccin', 'Mocha: soft pastels on dark.'],
  'unigraph-custom': ['unigraph-neon', 'Unigraph Neon', 'Blue-black, electric cyan.'],
  'unigraph-warm': ['unigraph-warm', 'Unigraph Warm', 'Warm black, gold text.'],
}

// ── colour arithmetic ──────────────────────────────────────────────────────────────────────────────────────────────
function parse(c) {
  c = c.trim()
  let m = /^#([0-9a-f]{3})$/i.exec(c)
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16)).concat(1)
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c)
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(m[2] ? parseInt(m[2], 16) / 255 : 1)
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)$/i.exec(c)
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]]
  throw new Error(`not a colour: ${c}`)
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1)
const mix = (a, b, t) => [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t).concat(1)
const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
const rgba = (c, a) => `rgba(${c.slice(0, 3).map(Math.round).join(', ')}, ${a})`
const lum = (c) => {
  const [r, g, b] = c.slice(0, 3).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const WHITE = [255, 255, 255, 1]
const BLACK = [0, 0, 0, 1]
/** `fg`, moved toward white (on dark grounds) or black until it reaches `min` against every ground. */
function readable(fg, grounds, dark, min = 4.6) {
  const to = dark ? WHITE : BLACK
  let c = fg
  for (let t = 0; t <= 1.0001; t += 0.02) {
    c = mix(fg, to, t)
    // A margin over the rule: the hex rounding after this must not drop a colour just under it.
    if (grounds.every((g) => contrast(c, g) >= min)) return c
  }
  return c
}

// ── the mapping ────────────────────────────────────────────────────────────────────────────────────────────────────
function tokens(p) {
  const raw = Object.fromEntries(Object.entries(p.colors).map(([k, v]) => [k, parse(v)]))
  const bg = over(raw.background, WHITE)
  const flat = (k) => over(raw[k], bg)
  const surface = flat('surface')
  const dark = lum(bg) < 0.4
  // Surfaces. aegraph's second surface is a quiet tier — sidebars, table heads, fields — and a dark palette's tertiary
  // background is usually a highlight (Dracula's comment blue, Solarized's base01), far too bright for it: on a dark
  // ground it sits halfway between the ground and the card; on a light one it is the palette's secondary background.
  const surface2 = dark ? mix(bg, surface, 0.5) : flat('backgroundSecondary')
  // Hover lifts a row just above the card, not all the way to the palette's highlight.
  const hover = dark ? mix(surface, flat('surfaceHover'), 0.55) : flat('surfaceHover')
  const grounds = [bg, surface, surface2]
  const text = readable(flat('text'), grounds, dark, 7)
  const muted = readable(flat('textSecondary'), grounds, dark)
  const faint = readable(flat('textMuted'), grounds, dark)
  const primary = flat('primary')
  const link = readable(flat('link'), grounds, dark)
  const danger = readable(flat('error'), grounds, dark)
  const tint = (k, t) => mix(surface, flat(k), t)
  const onTint = (k, t) => readable(flat(k), [tint(k, t)], dark)
  const accentText = contrast(WHITE, primary) >= contrast(BLACK, primary) ? WHITE : BLACK
  const status = (k) => [tint(k, dark ? 0.18 : 0.14), onTint(k, dark ? 0.18 : 0.14)]
  const [dangerBg] = status('error')
  const [infoBg, infoText] = status('info')
  const [okBg, okText] = status('success')
  const [warnBg, warnText] = status('warning')
  const [highlightBg, highlightText] = [tint('warning', dark ? 0.3 : 0.35), onTint('warning', dark ? 0.3 : 0.35)]
  return {
    scheme: dark ? 'dark' : 'light',
    t: {
      '--bg': hex(bg),
      '--surface': hex(surface),
      '--surface-2': hex(surface2),
      '--surface-hover': hex(hover),
      '--border': hex(flat('border')),
      '--border-strong': hex(flat('borderHover')),
      '--scroll-thumb': hex(flat('workspaceScrollbar')),
      '--scroll-thumb-hover': hex(flat('workspaceScrollbarHover')),
      '--text': hex(text),
      '--text-muted': hex(muted),
      '--text-faint': hex(faint),
      '--accent': hex(primary),
      '--accent-text': hex(accentText),
      '--link': hex(link),
      '--danger': hex(danger),
      '--danger-bg': hex(dangerBg),
      '--info-bg': hex(infoBg),
      '--info-text': hex(infoText),
      '--ok-bg': hex(okBg),
      '--ok-text': hex(okText),
      '--warn-bg': hex(warnBg),
      '--warn-text': hex(warnText),
      '--caution': hex(readable(flat('warning'), grounds, dark, 3)),
      '--caution-bg': hex(warnBg),
      '--pending': hex(flat('warning')),
      '--shadow': dark ? '0 8px 24px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.4)' : '0 8px 24px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08)',
      '--select': hex(flat('borderFocus')),
      '--select-soft': hex(mix(flat('borderFocus'), surface, 0.25)),
      '--select-bg': hex(tint('borderFocus', dark ? 0.2 : 0.12)),
      '--select-border': hex(tint('borderFocus', 0.45)),
      '--highlight': hex(flat('warning')),
      '--highlight-bg': hex(highlightBg),
      '--highlight-text': hex(highlightText),
      '--shadow-color': '#000000',
      '--overlay': dark ? 'rgba(0, 0, 0, 0.6)' : rgba(text, 0.35),
      '--canvas': hex(over(raw.workspaceBackground, bg)),
      '--canvas-halo': rgba(over(raw.workspaceBackground, bg), 0.9),
      '--canvas-select': hex(text),
      '--canvas-edge': hex(mix(bg, text, dark ? 0.28 : 0.3)),
      '--canvas-path': hex(readable(flat('accent'), [bg], dark, 3)),
      '--swatch-ring': dark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.12)',
      '--map-ground': hex(surface2),
      '--map-tiles': dark ? 'invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9) saturate(0.6)' : 'none',
      '--on-media': '#ffffff',
    },
    swatch: [hex(bg), hex(surface), hex(text), hex(primary)],
  }
}

// ── output ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const out = []
const entries = []
for (const [from, [id, label, description]] of Object.entries(NAMES)) {
  const p = palettes[from]
  if (!p) throw new Error(`no palette ${from} in unigraph-palettes.json`)
  const { scheme, t, swatch } = tokens(p)
  out.push(`:root[data-theme='${id}'],\n[data-theme-preview='${id}'] {\n  color-scheme: ${scheme};\n${Object.entries(t).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`)
  entries.push({ id, label, scheme, description, swatch, group: 'unigraph' })
}
const head = '/* GENERATED by scripts/themes/generate.mjs from scripts/themes/unigraph-palettes.json — edit those, then `npm run themes`. */'
writeFileSync(join(root, 'src/styles/themes-unigraph.css'), `${head}\n\n${out.join('\n\n')}\n`)
writeFileSync(
  join(root, 'src/app/themes.unigraph.ts'),
  `// GENERATED by scripts/themes/generate.mjs — edit the palettes or the mapping there, then \`npm run themes\`.\n\n/** Unigraph's themes, as aegraph themes (the tokens are in src/styles/themes-unigraph.css). */\nexport const UNIGRAPH_THEMES = ${JSON.stringify(entries, null, 2).replace(/"(\w+)":/g, '$1:').replace(/"/g, "'")} as const\n`,
)
// The boot script's lists: every theme id, and the dark ones.
const bootPath = join(root, 'public/theme-boot.js')
const boot = readFileSync(bootPath, 'utf8')
const own = JSON.parse(readFileSync(join(root, 'scripts/themes/own-themes.json'), 'utf8'))
const all = [...own, ...entries.map((e) => ({ id: e.id, scheme: e.scheme }))]
const generated = `  // GENERATED (scripts/themes/generate.mjs): every theme, and the dark ones.\n  var themes = ${JSON.stringify(all.map((t) => t.id))}\n  var dark = ${JSON.stringify(Object.fromEntries(all.filter((t) => t.scheme === 'dark').map((t) => [t.id, 1])))}\n  // END GENERATED`
const next = boot.replace(/  \/\/ GENERATED[\s\S]*?\/\/ END GENERATED/, generated)
if (next === boot && !boot.includes(generated)) throw new Error('public/theme-boot.js has no GENERATED region')
writeFileSync(bootPath, next)
console.log(`themes: ${entries.length} Unigraph themes written (${entries.filter((e) => e.scheme === 'dark').length} dark)`)
