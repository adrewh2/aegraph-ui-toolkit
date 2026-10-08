/**
 * Colour palettes for data-driven appearance. Stops are embedded (sampled
 * once from d3-scale-chromatic) so the mapping is deterministic, dependency
 * free, and cheap: a lookup plus one linear interpolation per node.
 */

export type PaletteKind = 'sequential' | 'diverging' | 'categorical'
export type PaletteId =
  | 'viridis'
  | 'plasma'
  | 'inferno'
  | 'magma'
  | 'cividis'
  | 'turbo'
  | 'blues'
  | 'greens'
  | 'oranges'
  | 'greys'
  | 'RdBu'
  | 'PiYG'
  | 'RdYlGn'
  | 'tableau10'
  | 'category10'
  | 'set3'
  | 'okabeIto'

export interface Palette {
  id: PaletteId
  label: string
  kind: PaletteKind
  stops: string[]
}

export const PALETTES: Palette[] = [
  { id: 'viridis', label: 'Viridis', kind: 'sequential', stops: ['#440154', '#482173', '#433e85', '#38588c', '#2d708e', '#25858e', '#1e9b8a', '#2ab07f', '#52c569', '#86d549', '#c2df23', '#fde725'] },
  { id: 'plasma', label: 'Plasma', kind: 'sequential', stops: ['#0d0887', '#3e049c', '#6300a7', '#8606a6', '#a62098', '#c03a83', '#d5546e', '#e76f5a', '#f68d45', '#fdae32', '#fcd225', '#f0f921'] },
  { id: 'inferno', label: 'Inferno', kind: 'sequential', stops: ['#000004', '#140b34', '#390963', '#5f136e', '#85216b', '#a92e5e', '#cb4149', '#e65d2f', '#f78410', '#fcae12', '#f5db4c', '#fcffa4'] },
  { id: 'magma', label: 'Magma', kind: 'sequential', stops: ['#000004', '#120d31', '#331067', '#59157e', '#7e2482', '#a3307e', '#c83e73', '#e95462', '#fa7d5e', '#fea973', '#fed395', '#fcfdbf'] },
  { id: 'cividis', label: 'Cividis', kind: 'sequential', stops: ['#002051', '#083069', '#24416e', '#44516d', '#5f626e', '#757372', '#898477', '#9d9778', '#b4aa73', '#d0be67', '#ecd354', '#fdea45'] },
  { id: 'turbo', label: 'Turbo', kind: 'sequential', stops: ['#23171b', '#4a51d4', '#3491f8', '#25c9d5', '#3aef9a', '#71fe65', '#b8f140', '#f2cb2c', '#ff9220', '#ed5215', '#b41d07', '#900c00'] },
  { id: 'blues', label: 'Blues', kind: 'sequential', stops: ['#e5eff9', '#d3e4f3', '#bdd8ec', '#a0cae3', '#7eb8da', '#5da4d0', '#408ec4', '#2877b7', '#1460a7', '#0a488d', '#08306b'] },
  { id: 'greens', label: 'Greens', kind: 'sequential', stops: ['#e9f7e5', '#d7efd1', '#bfe6b9', '#a4da9e', '#84cb84', '#61bb6d', '#41a75b', '#289149', '#117a38', '#026128', '#00441b'] },
  { id: 'oranges', label: 'Oranges', kind: 'sequential', stops: ['#feead5', '#fedcb9', '#fdc997', '#fdb171', '#fc994d', '#f8802e', '#ed6614', '#db4f06', '#bd3e02', '#9c3203', '#7f2704'] },
  { id: 'greys', label: 'Greys', kind: 'sequential', stops: ['#e5e5e5', '#d3d3d3', '#bebebe', '#a4a4a4', '#898989', '#707070', '#575757', '#393939', '#1b1b1b', '#000000'] },
  { id: 'RdBu', label: 'Red–Blue', kind: 'diverging', stops: ['#67001f', '#a61c2d', '#cf5349', '#ea9175', '#f9c6ad', '#f9e9df', '#e4edf2', '#b9d9e9', '#7cb6d6', '#418bbf', '#1f609f', '#053061'] },
  { id: 'PiYG', label: 'Pink–Green', kind: 'diverging', stops: ['#8e0152', '#bc217a', '#d964a5', '#eba3cd', '#f8d0e7', '#f9ecf2', '#eff5e3', '#d4edb4', '#a8d674', '#77b43f', '#4b8d23', '#276419'] },
  { id: 'RdYlGn', label: 'Red–Yellow–Green', kind: 'diverging', stops: ['#a50026', '#d02d2a', '#ed623e', '#fa9b5a', '#fecd7c', '#fdefa5', '#ecf6a5', '#c6e780', '#94d16a', '#57b55e', '#1e924d', '#006837'] },
  { id: 'tableau10', label: 'Tableau 10', kind: 'categorical', stops: ['#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'] },
  { id: 'category10', label: 'Category 10', kind: 'categorical', stops: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'] },
  { id: 'set3', label: 'Set 3 (pastel)', kind: 'categorical', stops: ['#8dd3c7', '#ffffb3', '#bebada', '#fb8072', '#80b1d3', '#fdb462', '#b3de69', '#fccde5', '#d9d9d9', '#bc80bd', '#ccebc5', '#ffed6f'] },
  { id: 'okabeIto', label: 'Okabe–Ito (colour-blind safe)', kind: 'categorical', stops: ['#e69f00', '#56b4e9', '#009e73', '#f0e442', '#0072b2', '#d55e00', '#cc79a7', '#999999'] },
]

const byId = new Map(PALETTES.map((p) => [p.id, p]))
export const isPaletteId = (id: unknown): id is PaletteId => typeof id === 'string' && byId.has(id as PaletteId)
export const palette = (id: PaletteId): Palette => byId.get(id) ?? PALETTES[0]
export const paletteIds = (kind?: PaletteKind) => PALETTES.filter((p) => !kind || p.kind === kind).map((p) => p.id)

/** Colour for nodes whose mapped value is missing. */
export const MISSING_COLOR = '#c9c6bf'

const hexCache = new Map<string, [number, number, number]>()
function rgb(hex: string): [number, number, number] {
  let c = hexCache.get(hex)
  if (!c) {
    const n = parseInt(hex.slice(1), 16)
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    hexCache.set(hex, c)
  }
  return c
}
const toHex = (r: number, g: number, b: number) => `#${((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).slice(1)}`

/** Continuous colour at t ∈ [0,1] (clamped) by linear interpolation between stops. */
export function paletteColor(id: PaletteId, t: number): string {
  const stops = palette(id).stops
  if (!Number.isFinite(t)) return MISSING_COLOR
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.floor(x)
  if (i >= stops.length - 1) return stops[stops.length - 1]
  const f = x - i
  if (f === 0) return stops[i]
  const a = rgb(stops[i])
  const b = rgb(stops[i + 1])
  return toHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f)
}

/** Categorical colour for the i-th category (cycles). */
export function categoricalColor(id: PaletteId, i: number): string {
  const stops = palette(id).stops
  return stops[((i % stops.length) + stops.length) % stops.length]
}

/** CSS gradient preview of a palette. */
export function paletteGradient(id: PaletteId): string {
  const p = palette(id)
  return p.kind === 'categorical' ? `linear-gradient(to right, ${p.stops.map((s, i) => `${s} ${(i / p.stops.length) * 100}% ${((i + 1) / p.stops.length) * 100}%`).join(', ')})` : `linear-gradient(to right, ${p.stops.join(', ')})`
}
