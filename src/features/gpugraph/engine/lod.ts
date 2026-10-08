/**
 * Semantic zoom. The picture at 200k nodes cannot give every node the
 * treatment a 200-node picture does, so what is drawn follows the space
 * each node has on screen: the mean spacing between nodes in the viewport,
 * in CSS px. Four regimes, from far (dots, faint straight lines, no labels)
 * to close (full nodes, anti-aliased edges with arrowheads, labels for
 * everything in view). The thresholds are what the renderer decides by; the
 * numbers each regime sets are what the shaders get.
 */
export type Regime = 0 | 1 | 2 | 3

export interface LodSettings {
  regime: Regime
  nodeMinPx: number
  nodeMaxPx: number
  edgeWidthPx: number
  edgeAlpha: number
  /** Far out, every n-th edge is drawn n times as opaque: the same density for a fraction of the work. */
  edgeStride: number
  arrows: boolean
  /** Labels drawn for: nothing / only the focus (selection, hover, path) / a density-limited subset / everything in view. */
  labels: 'none' | 'focus' | 'some' | 'all'
}

/** The mean distance between nodes in view, in CSS px, from the count inside the viewport. */
export function spacingPx(width: number, height: number, nodesInView: number): number {
  if (nodesInView <= 0) return Infinity
  return Math.sqrt((width * height) / nodesInView)
}

const THRESHOLDS = [5, 16, 48]
/** A regime is left only once the spacing is clear of the threshold by this factor. */
const HYSTERESIS = 1.15

/**
 * The regime for a spacing. Given the regime in force, a threshold has to be crossed by a margin before the regime
 * changes: a picture whose spacing sits on one would otherwise flap between two treatments — labels for some, then
 * for all; nodes a size, then another — as a few nodes enter or leave the view, a pan or a panel's resize away.
 */
export function regimeFor(spacing: number, current?: Regime): Regime {
  if (current === undefined) {
    if (spacing < THRESHOLDS[0]) return 0
    if (spacing < THRESHOLDS[1]) return 1
    if (spacing < THRESHOLDS[2]) return 2
    return 3
  }
  let r: number = current
  while (r < 3 && spacing >= THRESHOLDS[r] * HYSTERESIS) r++
  while (r > 0 && spacing < THRESHOLDS[r - 1] / HYSTERESIS) r--
  return r as Regime
}

export function lodFor(spacing: number, edgesInView: number, current?: Regime): LodSettings {
  const regime = regimeFor(spacing, current)
  switch (regime) {
    case 0: {
      // Far: the picture is density. Edges as 1px lines, faint in proportion to how many there are — and past half a
      // million in view, a sample of them, each drawn as many times as opaque: the eye cannot tell. The links are
      // part of what a zoomed-out picture says (which clusters are joined, and how much), so they are drawn strongly
      // enough to read: each edge's share of ink is about 0.18 of a line past 200k in view (it was 0.08, and at a
      // million nodes the picture read as dots with no links), for about 2 ms more of GPU a frame (measured: 4.0 → 6.0 ms at 500k edges, 8.7 → 10.8 at 2.5M).
      const stride = Math.min(8, Math.max(1, Math.floor(edgesInView / 500_000)))
      const alpha = edgesInView > 200_000 ? 0.18 : edgesInView > 50_000 ? 0.28 : 0.45
      return { regime, nodeMinPx: 1.2, nodeMaxPx: 6, edgeWidthPx: 1, edgeAlpha: Math.min(0.9, alpha * stride), edgeStride: stride, arrows: false, labels: 'none' }
    }
    case 1:
      return { regime, nodeMinPx: 2, nodeMaxPx: 14, edgeWidthPx: 1, edgeAlpha: edgesInView > 100_000 ? 0.25 : 0.45, edgeStride: 1, arrows: false, labels: 'focus' }
    case 2:
      return { regime, nodeMinPx: 3, nodeMaxPx: 30, edgeWidthPx: 1.25, edgeAlpha: 0.7, edgeStride: 1, arrows: true, labels: 'some' }
    default:
      return { regime, nodeMinPx: 4, nodeMaxPx: 60, edgeWidthPx: 1.5, edgeAlpha: 0.9, edgeStride: 1, arrows: true, labels: 'all' }
  }
}
