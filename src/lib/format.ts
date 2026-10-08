export function formatDate(value: unknown, { relative = true } = {}): string {
  if (!value) return ''
  // A number is epoch milliseconds; `new Date("1700000000000")` would be invalid.
  const d = value instanceof Date ? value : typeof value === 'number' ? new Date(value) : new Date(String(value))
  if (Number.isNaN(d.getTime())) return String(value)
  if (!relative) return d.toLocaleString()
  const diff = Date.now() - d.getTime()
  const abs = Math.abs(diff)
  const m = 60_000
  const h = 60 * m
  const day = 24 * h
  const sign = diff >= 0 ? '' : 'in '
  const suffix = diff >= 0 ? ' ago' : ''
  if (abs < m) return 'just now'
  if (abs < h) return `${sign}${Math.round(abs / m)}m${suffix}`
  if (abs < day) return `${sign}${Math.round(abs / h)}h${suffix}`
  if (abs < 7 * day) return `${sign}${Math.round(abs / day)}d${suffix}`
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatNumber(value: unknown): string {
  let n = typeof value === 'number' ? value : Number(value)
  if (value == null || value === '' || Number.isNaN(n)) return ''
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '-∞'
  if (Object.is(n, -0)) n = 0
  // The unit steps up where the shorter form would round to 1000 of the smaller one (999,950 is "1M", not "1000K").
  if (Math.abs(n) >= 999_950) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (Math.abs(n) >= 999.95) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return n.toLocaleString()
}

/** Seconds → `h:mm:ss` or `m:ss`. */
export function formatDuration(value: unknown): string {
  const s = typeof value === 'number' ? value : Number(value)
  if (value == null || !Number.isFinite(s) || s < 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`
}

/** ISO 8601 duration (`PT1H2M3S`) → seconds. */
export function parseIsoDuration(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso)
  if (!m) return undefined
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

export function truncate(s: string, n = 80): string {
  // By code point, so an emoji is never cut in half; at 0 or 1 only the ellipsis remains.
  if (s.length <= n) return s
  const chars = [...s]
  return chars.length > n ? chars.slice(0, Math.max(0, n - 1)).join('') + '…' : s
}

/** Deterministic pastel from a string — used for tag colors that haven't been set. */
/**
 * A colour for a name — a type with none of its own, a tag, a category —
 * the same one every time, on any machine, for good: the colours in a
 * picture cannot move about between reloads, and nothing is stored.
 *
 * The old hash (`h * 31 + code`, hue = h % 360) put short lowercase words
 * almost on top of each other: `tree` 222°, `ward` 220°, `genus` 246°,
 * `species` 252° — four types of one pale blue, and a legend nobody could
 * read. This one avalanches the bits (an FNV-1a hash through murmur3's
 * finalizer, so one letter's difference scatters), then picks a slot on a
 * grid of HUE_SLOTS hues spaced by the golden angle — the sequence stays
 * evenly spread however much of it is used — crossed with three bands of
 * saturation and lightness. `HUE_SLOTS × bands` colours, none of them
 * close to another; two names still land together when their hashes agree
 * on both, which is why the type registry spreads the ones it has
 * (`colorOf`) rather than trusting the hash alone.
 */
export function hashColor(input: string): string {
  const h = avalanche(input)
  const [saturation, lightness] = COLOR_BANDS[Math.floor(h / HUE_SLOTS) % COLOR_BANDS.length]
  return `hsl(${Math.round(((h % HUE_SLOTS) * GOLDEN_ANGLE) % 360)} ${saturation}% ${lightness}%)`
}
/** Hues on the circle, and the (saturation, lightness) bands crossed with them: one colour per slot, all distinct. */
export const HUE_SLOTS = 24
export const COLOR_BANDS: readonly (readonly [number, number])[] = [
  [62, 72],
  [50, 60],
  [72, 82],
]
const GOLDEN_ANGLE = 137.50776405003785
/** FNV-1a over the characters, then murmur3's finalizer: neighbouring strings land nowhere near each other. */
export function avalanche(input: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  h ^= h >>> 16
  h = Math.imul(h, 2246822507) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 3266489909) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}
/** The colour of a slot: `hashColor` without the hashing, for spreading a set of names over the same grid. */
export function slotColor(slot: number): string {
  const s = ((slot % (HUE_SLOTS * COLOR_BANDS.length)) + HUE_SLOTS * COLOR_BANDS.length) % (HUE_SLOTS * COLOR_BANDS.length)
  const [saturation, lightness] = COLOR_BANDS[Math.floor(s / HUE_SLOTS)]
  return `hsl(${Math.round(((s % HUE_SLOTS) * GOLDEN_ANGLE) % 360)} ${saturation}% ${lightness}%)`
}

export function hostOf(url: unknown): string {
  if (url instanceof URL) url = url.href
  if (typeof url !== 'string') return ''
  try {
    const s = url.trim()
    // A bare host or host/path is what people paste; read it as https.
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const contrastCache = new Map<string, string>()

/**
 * Text colour that reads on a given background: dark ink on light colours,
 * white on dark ones. Understands hex, rgb() and hsl(); anything else is
 * resolved through a canvas when one is available, else assumed light.
 */
export function contrastText(bg: string | undefined, dark = '#1f1e1b', light = '#fff'): string {
  if (!bg) return dark
  const key = `${bg}\u0000${dark}\u0000${light}`
  const cached = contrastCache.get(key)
  if (cached) return cached
  const rgb = parseColor(bg)
  const out = rgb ? (luminance(rgb) < 0.42 ? light : dark) : dark
  contrastCache.set(key, out)
  return out
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function parseColor(s: string): [number, number, number] | undefined {
  const v = s.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v)
  if (hex) {
    let h = hex[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(v)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i.exec(v)
  if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100)
  // Named colours and anything exotic: let the browser resolve it.
  if (typeof document !== 'undefined') {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#000'
      ctx.fillStyle = v
      const norm = ctx.fillStyle
      if (norm !== '#000000' || /^black$/i.test(v)) return parseColor(norm)
    }
  }
  return undefined
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}
