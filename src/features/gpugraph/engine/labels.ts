import { N_HIDDEN, N_HOVERED, N_LABEL, N_PATH, N_SELECTED } from './types'

/**
 * Labels are the one thing not drawn by the GPU: a 2D canvas over the
 * graph canvas, redrawn when the camera or the focus changes, never per
 * pointer move. Candidates come from the spatial grid (what is in view),
 * the focus (selection, hover, path) always wins, and a screen-space
 * occupancy grid keeps labels from piling up: at most one per cell, at
 * most `cap` in all. Text is measured once per string and remembered.
 *
 * Labels also have inertia, so a moving picture (a drag, the physics, a
 * pan) does not make them pop: one that is showing keeps its place for
 * `HOLD` ms even when a bigger hub drifts into its cell — it is drawn
 * before any newcomer — and one that has just gone stays gone for
 * `COOLDOWN` ms. Leaving the view or being hidden ends a label at once.
 */
export const HOLD_MS = 1200
export const COOLDOWN_MS = 800
export interface LabelSource {
  labels: (string | undefined)[]
  labelFallback: ((i: number) => string) | null
  nodeFlags: Uint32Array
  /** Screen position of a node in CSS px; false when it is behind the camera. */
  project: (i: number, out: { x: number; y: number }) => boolean
  width: number
  height: number
  /** Candidates in the viewport, most important first (the engine gives hubs first). */
  candidates: (out: Uint32Array, max: number) => number
  radiusPx: (i: number) => number
  /**
   * Edge labels, when they are shown: each edge with both ends among the node candidates just given (its text, its
   * ends' screen positions, where its middle is for a bent one) — the lit ones (selected, hovered, on the path) first.
   */
  edges?: (visit: (text: string, ax: number, ay: number, bx: number, by: number, curvature: number, lit: boolean) => void) => void
}

export class LabelLayer {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private widths = new Map<string, number>()
  private occupied = new Uint8Array(0)
  private scratch = new Uint32Array(4096)
  /** Per node: when its label appeared (0: not showing) and when it last went. */
  private shownSince = new Float64Array(0)
  private hiddenSince = new Float64Array(0)
  /** The labels drawn by the last pass, in the order they were drawn; `shownNext` is the pass being built. */
  private shown = new Uint32Array(1024)
  private shownCount = 0
  private shownNext = new Uint32Array(1024)
  private drawnNow = new Set<number>()
  /** The nodes whose labels the last pass drew (a view: valid until the next pass). */
  showing(): Uint32Array {
    return this.shown.subarray(0, this.shownCount)
  }
  /** Forget every label's history (a new graph). */
  reset() {
    this.shownSince.fill(0)
    this.hiddenSince.fill(0)
    this.shownCount = 0
  }
  /** Where the occupancy grid's cells start, in px: moved with the picture when the view is resized around it. */
  private originX = 0
  private originY = 0
  shiftOrigin(dx: number, dy: number) {
    this.originX += dx
    this.originY += dy
  }
  private font = '12px system-ui, sans-serif'
  private edgeFont = '10px system-ui, sans-serif'
  edgeColor = '#6b6a66'
  color = '#1f1e1b'
  halo = 'rgba(255,255,255,0.9)'
  drawn = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
  }

  resize(width: number, height: number, dpr: number) {
    const w = Math.round(width * dpr), h = Math.round(height * dpr)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  clear() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.drawn = 0
  }
  private ensure(n: number) {
    if (this.shownSince.length >= n) return
    const size = Math.max(n, this.shownSince.length * 2, 1024)
    const a = new Float64Array(size)
    a.set(this.shownSince)
    this.shownSince = a
    const b = new Float64Array(size)
    b.set(this.hiddenSince)
    this.hiddenSince = b
  }

  /** The text's width in the font set on the context now; `small` keys the edge font's measurements apart. */
  private width(text: string, small = false): number {
    const key = small ? '\u0001' + text : text
    let w = this.widths.get(key)
    if (w === undefined) {
      w = this.ctx.measureText(text).width
      if (this.widths.size > 20000) this.widths.clear()
      this.widths.set(key, w)
    }
    return w
  }

  /**
   * Draw for the regime: `focus` = only selected/hovered/path nodes; `some` = those plus in-view candidates until
   * the occupancy grid is full or `cap` is reached; `all` = the same with no cap (still one per cell).
   */
  private pt = { x: 0, y: 0 }
  /**
   * One pass. `keep`: the picture has not moved, only the view around it (a resize) — whatever is showing keeps its
   * place whatever its age, and only the room that appeared is filled.
   */
  draw(src: LabelSource, dpr: number, mode: 'none' | 'focus' | 'some' | 'all', focusIds: Uint32Array, focusCount: number, cap = 300, now = performance.now(), keep = false) {
    const ctx = this.ctx
    this.clear()
    this.ensure(src.nodeFlags.length)
    const shownSince = this.shownSince, hiddenSince = this.hiddenSince
    // What the last pass drew, and this pass's list (the two buffers swap at the end).
    const was = this.shown
    const wasCount = this.shownCount
    let next = this.shownNext
    let nextCount = 0
    const drawnNow = this.drawnNow
    const finish = () => {
      // Whoever was showing and is not now went at this moment.
      for (let k = 0; k < wasCount; k++) {
        const i = was[k]
        if (shownSince[i] > 0 && !drawnNow.has(i)) {
          shownSince[i] = 0
          hiddenSince[i] = now
        }
      }
      drawnNow.clear()
      this.shownNext = was
      this.shown = next
      this.shownCount = nextCount
    }
    if (mode === 'none') {
      finish()
      return
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.font = this.font
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 3
    ctx.strokeStyle = this.halo
    ctx.fillStyle = this.color
    const W = src.width, H = src.height
    const cellW = 80, cellH = 16
    // The cells are anchored to the picture, not the canvas: when the view is resized around a picture that holds
    // still, the labels' collisions do not change under them (a shifted grid would let one label take another's cell).
    const ox = cellW - (((this.originX % cellW) + cellW) % cellW), oy = cellH - (((this.originY % cellH) + cellH) % cellH)
    const cols = Math.ceil(W / cellW) + 2, rows = Math.ceil(H / cellH) + 2
    if (this.occupied.length < cols * rows) this.occupied = new Uint8Array(cols * rows)
    else this.occupied.fill(0, 0, cols * rows)
    const occ = this.occupied
    let drawn = 0
    const tryDraw = (i: number, force: boolean): boolean => {
      if (drawnNow.has(i)) return true
      const f = src.nodeFlags[i]
      if (f & N_HIDDEN) return false
      if (!force && !(f & N_LABEL)) return false
      const text = src.labels[i] ?? src.labelFallback?.(i)
      if (!text) return false
      if (!src.project(i, this.pt)) return false
      const sx = this.pt.x, sy = this.pt.y
      if (sx < -200 || sy < -20 || sx > W + 200 || sy > H + 20) return false
      const w = this.width(text)
      const x = sx + src.radiusPx(i) + 3
      // Occupancy: the cells the text spans on its row; a forced label overwrites, a plain one yields.
      const r = Math.max(0, Math.min(rows - 1, Math.floor((sy + oy) / cellH)))
      const c0 = Math.max(0, Math.floor((x + ox) / cellW)), c1 = Math.min(cols - 1, Math.floor((x + w + ox) / cellW))
      if (!force) for (let c = c0; c <= c1; c++) if (occ[r * cols + c]) return false
      for (let c = c0; c <= c1; c++) occ[r * cols + c] = 1
      ctx.strokeText(text, x, sy)
      ctx.fillText(text, x, sy)
      drawn++
      drawnNow.add(i)
      if (nextCount === next.length) {
        const bigger = new Uint32Array(next.length * 2)
        bigger.set(next)
        next = bigger
      }
      next[nextCount++] = i
      if (!shownSince[i]) shownSince[i] = now
      return true
    }
    for (let k = 0; k < focusCount; k++) tryDraw(focusIds[k], true)
    if (mode === 'focus') {
      this.drawn = drawn
      finish()
      return
    }
    const max = mode === 'all' ? 5000 : cap
    // The labels still within their hold keep their cells: drawn first, in the order they were drawn before.
    for (let k = 0; k < wasCount && drawn < max; k++) {
      const i = was[k]
      if (shownSince[i] > 0 && (keep || now - shownSince[i] < HOLD_MS) && !(src.nodeFlags[i] & (N_SELECTED | N_HOVERED | N_PATH))) tryDraw(i, false)
    }
    const want = Math.min(20000, max * 4)
    if (this.scratch.length < want) this.scratch = new Uint32Array(want)
    const n = src.candidates(this.scratch, want)
    for (let k = 0; k < n && drawn < max; k++) {
      const i = this.scratch[k]
      if (src.nodeFlags[i] & (N_SELECTED | N_HOVERED | N_PATH)) continue
      // A label that has just gone waits before it may come back.
      if (!shownSince[i] && hiddenSince[i] && now - hiddenSince[i] < COOLDOWN_MS) continue
      tryDraw(i, false)
    }
    this.drawn = drawn
    // Edge labels sit at the middle of their edge, smaller and greyer, in the same cells the node labels took: a
    // lit edge's label is drawn whatever is there; the rest yield to anything already placed.
    if (src.edges && mode === 'all') {
      ctx.font = this.edgeFont
      ctx.fillStyle = this.edgeColor
      let edgesDrawn = 0
      src.edges((text, ax, ay, bx, by, curvature, lit) => {
        if (edgesDrawn >= max) return
        // The quadratic's middle: a quarter of each end and half of the control point off the midpoint.
        const mx = (ax + bx) / 2, my = (ay + by) / 2
        const dx = bx - ax, dy = by - ay
        const cx = mx + -dy * curvature * 0.5, cy = my + dx * curvature * 0.5
        if (cx < -100 || cy < -20 || cx > W + 100 || cy > H + 20) return
        const w = this.width(text, true)
        const x = cx - w / 2
        const r = Math.max(0, Math.min(rows - 1, Math.floor((cy + oy) / cellH)))
        const c0 = Math.max(0, Math.floor((x + ox) / cellW)), c1 = Math.min(cols - 1, Math.floor((x + w + ox) / cellW))
        if (!lit) for (let c = c0; c <= c1; c++) if (occ[r * cols + c]) return
        for (let c = c0; c <= c1; c++) occ[r * cols + c] = 1
        ctx.strokeText(text, x, cy)
        ctx.fillText(text, x, cy)
        edgesDrawn++
      })
      ctx.font = this.font
      ctx.fillStyle = this.color
      this.drawn += edgesDrawn
    }
    finish()
  }
}
