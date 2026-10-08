import { hashColor } from '../../lib/format'

/**
 * Node fill: the type's color, darkened if it's too light to read on the page
 * background. Remembered per input — a big view asks the same few answers
 * hundreds of thousands of times, and the parse is regexes.
 */
const nodeColorCache = new Map<string, string>()
export function nodeColor(typeColor: string | undefined, type: string): string {
  const k = typeColor === undefined ? `\u0000${type}` : typeColor
  const hit = nodeColorCache.get(k)
  if (hit !== undefined) return hit
  const v = nodeColorOf(typeColor, type)
  if (nodeColorCache.size > 4096) nodeColorCache.clear()
  nodeColorCache.set(k, v)
  return v
}
function nodeColorOf(typeColor: string | undefined, type: string): string {
  const c = typeColor ?? hashColor(type)
  const rgb = toRgb(c)
  if (!rgb) return c
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  // Always hand renderers hex: sigma can't parse hsl().
  if (lum < 0.78) return toHexColor(c)
  // Mix toward a mid grey so near-white palette entries stay visible.
  const k = Math.min(0.6, (lum - 0.78) * 3 + 0.25)
  const mix = (v: number) => Math.round(v * (1 - k) + 110 * k)
  return `rgb(${mix(rgb[0])}, ${mix(rgb[1])}, ${mix(rgb[2])})`
}

/** Default edge colour for a relationship type: a pale hue, as #rrggbb (sigma parses only hex and rgb()). */
export function edgeColor(relType: string): string {
  const [h] = hsl(relType)
  return toHexColor(`hsl(${h} 30% 76%)`)
}

export function nodeSize(degree: number): number {
  return 3 + Math.log1p(degree) * 2.2
}

function hsl(s: string): [number] {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return [Math.abs(h) % 360]
}

/** Any of the colour forms we produce (#hex, rgb(), hsl()) as #rrggbb, or the input unchanged when unrecognised. */
export function toHexColor(c: string): string {
  const rgb = toRgb(c)
  return rgb ? `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}` : c
}

function toRgb(c: string): [number, number, number] | undefined {
  const m6 = /^#([0-9a-f]{6})$/i.exec(c)
  if (m6) {
    const n = parseInt(m6[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const m3 = /^#([0-9a-f]{3})$/i.exec(c)
  if (m3) return [parseInt(m3[1][0] + m3[1][0], 16), parseInt(m3[1][1] + m3[1][1], 16), parseInt(m3[1][2] + m3[1][2], 16)]
  const rgbm = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c)
  if (rgbm) return [Number(rgbm[1]), Number(rgbm[2]), Number(rgbm[3])]
  const hslm = /^hsl\((\d+)\s+(\d+)%\s+(\d+)%/.exec(c)
  if (hslm) {
    const h = Number(hslm[1]) / 360
    const s = Number(hslm[2]) / 100
    const l = Number(hslm[3]) / 100
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    const f = (t: number) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)]
  }
  return undefined
}
