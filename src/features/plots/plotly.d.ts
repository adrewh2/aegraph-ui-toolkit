/** The slice of Plotly we call; the bundle's own typings are not shipped with plotly.js-dist-min. */
declare module 'plotly.js-dist-min' {
  export interface PlotlyStatic {
    react(el: HTMLElement, data: unknown[], layout?: Record<string, unknown>, config?: Record<string, unknown>): Promise<unknown>
    purge(el: HTMLElement): void
    relayout(el: HTMLElement, update: Record<string, unknown>): Promise<unknown>
    toImage(el: HTMLElement, opts: { format: 'png' | 'svg' | 'jpeg' | 'webp'; width?: number; height?: number; scale?: number }): Promise<string>
    Plots: { resize(el: HTMLElement): void }
  }
  /** A point in a click/hover event: what we read of it. */
  export interface PlotlyPoint {
    curveNumber: number
    pointNumber?: number
    pointIndex?: number
    pointNumbers?: number[]
    x?: unknown
    y?: unknown
    z?: unknown
    label?: unknown
    text?: unknown
    customdata?: unknown
    data: { name?: string; type?: string; customdata?: unknown }
  }
  export interface PlotlyEventTarget extends HTMLElement {
    on(event: 'plotly_click' | 'plotly_hover', handler: (e: { points: PlotlyPoint[]; event?: MouseEvent }) => void): void
    on(event: 'plotly_unhover', handler: () => void): void
    removeAllListeners?(event?: string): void
  }
  const Plotly: PlotlyStatic
  export default Plotly
}
