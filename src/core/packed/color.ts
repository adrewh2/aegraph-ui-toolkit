/**
 * Colours as one Uint32 per element, packed RGBA8 little-endian (r in the
 * low byte) — what the GPU reads straight from the buffer. Parsing happens
 * once per style change, never per frame.
 */
const cache = new Map<string, number>()

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`, `rgba(...)`; anything else is mid grey. */
export function packColor(css: string, alpha = 1): number {
  const key = alpha === 1 ? css : `${css}|${alpha}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let r = 128, g = 128, b = 128, a = 255
  const s = css.trim()
  if (s[0] === '#') {
    const h = s.slice(1)
    if (h.length === 3 || h.length === 4) {
      r = parseInt(h[0] + h[0], 16)
      g = parseInt(h[1] + h[1], 16)
      b = parseInt(h[2] + h[2], 16)
      if (h.length === 4) a = parseInt(h[3] + h[3], 16)
    } else if (h.length === 6 || h.length === 8) {
      r = parseInt(h.slice(0, 2), 16)
      g = parseInt(h.slice(2, 4), 16)
      b = parseInt(h.slice(4, 6), 16)
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16)
    }
  } else {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(s)
    if (m) {
      r = +m[1]
      g = +m[2]
      b = +m[3]
      if (m[4] !== undefined) a = Math.round(+m[4] * 255)
    }
  }
  if (!Number.isFinite(r + g + b + a)) r = g = b = 128
  a = Math.round(a * alpha)
  const packed = ((a & 255) << 24 | (b & 255) << 16 | (g & 255) << 8 | (r & 255)) >>> 0
  if (cache.size < 4096) cache.set(key, packed)
  return packed
}

export function unpackColor(v: number): [number, number, number, number] {
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]
}

/** The packed colour as `#rrggbb`. */
export function packedToHex(v: number): string {
  const [r, g, b] = unpackColor(v)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}
