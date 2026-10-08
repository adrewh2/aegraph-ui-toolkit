/**
 * What the two GPU backends (WebGPU, WebGL2) have in common. The engine
 * keeps the graph in typed arrays; a backend keeps a copy of them on the
 * GPU and redraws from a handful of uniforms. Nothing per element crosses
 * the boundary per frame — only the ranges that changed since the last
 * upload, and the frame parameters.
 */

// ── Flag bits ────────────────────────────────────────────────────────────
// Node flags (one Uint32 per node; the shaders read them from a texture / storage buffer).
export const N_HIDDEN = 1
export const N_SELECTED = 2
export const N_HOVERED = 4
export const N_AROUND = 8
export const N_PINNED = 16
export const N_PATH = 32
export const N_LABEL = 64
/** A node that is in the graph but not the current picture (filtered out); differs from HIDDEN only in bookkeeping. */
export const N_FILTERED = 128
/** The node's shape, two bits: 0 circle, 1 square, 2 diamond, 3 triangle (the style's `shape`; the shaders draw the outline by its distance field). */
export const N_SHAPE_SHIFT = 8
export const N_SHAPE_MASK = 3 << N_SHAPE_SHIFT
export const SHAPE_CODES = { circle: 0, square: 1, diamond: 2, triangle: 3 } as const
export type ShapeName = keyof typeof SHAPE_CODES
// Edge flags (low 16 bits of the instance's flag word; the high 16 bits carry the width ×16).
export const E_HIDDEN = 1
export const E_SELECTED = 2
export const E_HOVERED = 4
export const E_PATH = 32
export const E_DIRECTED = 64
export const E_FILTERED = 128

/** Width in px → the high half of the edge flag word (fixed point, 1/16 px). */
export const packEdgeWidth = (width: number) => (Math.max(0, Math.min(4095, Math.round(width * 16))) << 16) >>> 0
/**
 * Curvature → bits 8–15 of the edge flag word: a signed byte in 1/64ths, so a parallel edge bends to its own side.
 * The control point of the quadratic sits `curvature × length` off the midpoint, as the SVG writer puts it.
 */
export const packEdgeCurvature = (curvature: number) => ((Math.max(-128, Math.min(127, Math.round(curvature * 64))) & 0xff) << 8) >>> 0
export const E_CURVE_MASK = 0xff00
/** Vertices a curved edge quad is drawn with: a strip of two per point over `EDGE_SEGMENTS` segments. */
export const EDGE_SEGMENTS = 8
export const EDGE_QUAD_VERTICES = (EDGE_SEGMENTS + 1) * 2

/** The width of the node data textures: index → (i & 2047, i >> 11). */
export const TEX_WIDTH = 2048
export const TEX_SHIFT = 11

/**
 * The frame as the shaders see it. One view-projection matrix does both
 * dimensions — orthographic for the 2D camera, perspective for the orbit
 * camera — and everything else is screen-space: a node's radius in px is
 * `clamp(size × sizeK / depth, minPx, maxPx)` (depth is 1 in 2D).
 */
export interface FrameParams {
  width: number
  height: number
  dpr: number
  /** Column-major 4×4, world → clip. */
  viewProj: Float32Array
  /** 2D: no perspective division of sizes, no depth test. */
  ortho: boolean
  /** Px per world unit of radius (before the perspective division). */
  sizeK: number
  nodeMinPx: number
  nodeMaxPx: number
  /** 0 far … 3 close: what gets drawn (see `lod.ts`). */
  lod: number
  edgeWidthPx: number
  edgeAlpha: number
  /** Draw every n-th edge (1: all) — far out, a dense picture's edges are indistinguishable from a sample of them drawn n times as opaque. */
  edgeStride: number
  /** Whether something is in focus (selection, hover, path) so the rest fades. */
  focus: boolean
  fadeAlpha: number
  edgeFadeAlpha: number
  arrows: boolean
  /** Packed RGBA (little-endian) colours. */
  background: number
  selectColor: number
  hoverColor: number
  pathColor: number
  nodeCount: number
  edgeCount: number
}

export interface NodeArrays {
  /** x, y, z, radius — four floats per node. */
  posr: Float32Array
  color: Uint32Array
  flags: Uint32Array
}
export interface EdgeArrays {
  /** source, target, colour, flags|width — four u32 per edge. */
  data: Uint32Array
}

export interface Renderer {
  readonly kind: 'webgpu' | 'webgl2'
  readonly canvas: HTMLCanvasElement
  /** Size in CSS px and device pixel ratio. */
  resize(width: number, height: number, dpr: number): void
  /** (Re)allocate for this many nodes / edges; existing GPU data is not kept — upload everything after. */
  allocate(nodes: number, edges: number): void
  /** Upload nodes [from, to) of the given arrays. */
  uploadNodes(a: NodeArrays, from: number, to: number, what: { posr?: boolean; color?: boolean; flags?: boolean }): void
  uploadEdges(a: EdgeArrays, from: number, to: number): void
  render(f: FrameParams): void
  /** The edge under a screen point (CSS px), or -1 — an id pass over a tiny offscreen target. */
  pickEdge(f: FrameParams, x: number, y: number): Promise<number>
  /** The node under a screen point, by the same id pass (what the 3D view picks with; 2D uses the grid). */
  pickNode(f: FrameParams, x: number, y: number): Promise<number>
  /** Statistics of the last frame. */
  readonly drawCalls: number
  destroy(): void
}
