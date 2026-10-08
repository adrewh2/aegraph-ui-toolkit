/**
 * How the graph views colour focus: what is hovered, selected, on a path or pinned keeps or deepens its own colour,
 * and everything else fades toward the page background. Shared by the 2D and 3D renderers so the same selection
 * looks the same in both.
 */
/**
 * Out of focus, a node or edge keeps its own colour, faded toward the page background — not a flat grey, which
 * reads as a different picture. Blended here rather than with alpha: sigma's blending is premultiplied, so a
 * translucent colour on the background comes out over-bright.
 */
export const BG = [0xfa, 0xf9, 0xf6]
export const FADE = 0.45
/** How much of the edge's colour its halo keeps: a pale band, not a second line. */
export const HALO = 0.22
// Edges fade less than nodes: a line at a third of its colour is gone; at 0.6 the wiring stays readable behind the focus.
export const FADE_EDGE = 0.6
const faded = new Map<string, string>()
export const parseRgb = (c: string): [number, number, number] | null => {
  const m6 = /^#([0-9a-f]{6})$/i.exec(c)
  if (m6) {
    const n = parseInt(m6[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const m3 = /^#([0-9a-f]{3})$/i.exec(c)
  if (m3) return [parseInt(m3[1][0] + m3[1][0], 16), parseInt(m3[1][1] + m3[1][1], 16), parseInt(m3[1][2] + m3[1][2], 16)]
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  // hsl(211 55% 78%) — the type palette's form.
  const hsl = /^hsla?\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/.exec(c)
  if (hsl) {
    const h = Number(hsl[1]) / 360, sat = Number(hsl[2]) / 100, l = Number(hsl[3]) / 100
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q
    const t = (x: number) => { x = ((x % 1) + 1) % 1; return x < 1 / 6 ? p + (q - p) * 6 * x : x < 0.5 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p }
    return [Math.round(t(h + 1 / 3) * 255), Math.round(t(h) * 255), Math.round(t(h - 1 / 3) * 255)]
  }
  return null
}
export const fade = (color: string, keep: number) => {
  const key = color + keep
  let out = faded.get(key)
  if (!out) {
    const rgb = parseRgb(color)
    const ch = (i: number) => Math.round((rgb ? rgb[i] : 0x99) * keep + BG[i] * (1 - keep)).toString(16).padStart(2, '0')
    faded.set(key, (out = `#${ch(0)}${ch(1)}${ch(2)}`))
  }
  return out
}
export const FOCUS = '#1f1e1b'
/** A colour pulled toward the ink: what an edge in focus is drawn with, so a pale type colour still reads as a line. */
const INK = [0x1f, 0x1e, 0x1b]
const deepened = new Map<string, string>()
export const deepen = (color: string, amount: number) => {
  const key = color + amount
  let out = deepened.get(key)
  if (!out) {
    const rgb = parseRgb(color)
    const ch = (i: number) => Math.round((rgb ? rgb[i] : 0x99) * (1 - amount) + INK[i] * amount).toString(16).padStart(2, '0')
    deepened.set(key, (out = `#${ch(0)}${ch(1)}${ch(2)}`))
  }
  return out
}
/** How far an edge in focus is pulled toward the ink. */
export const EDGE_FOCUS_DEEPEN = 0.35
export const PATH = '#c2410c'
export const PIN = '#7c3aed'
