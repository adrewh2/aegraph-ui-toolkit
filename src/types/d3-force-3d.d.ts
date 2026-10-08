declare module 'd3-force-3d' {
  export interface SimNode {
    x?: number
    y?: number
    z?: number
    vx?: number
    vy?: number
    vz?: number
    fx?: number | null
    fy?: number | null
    fz?: number | null
    index?: number
  }
  export interface SimLink<N> {
    source: N | string | number
    target: N | string | number
  }
  export interface Force<N> {
    (alpha: number): void
    initialize?(nodes: N[], random?: () => number, numDimensions?: number): void
  }
  export interface Simulation<N extends SimNode, L> {
    nodes(): N[]
    nodes(nodes: N[]): this
    alpha(a: number): this
    alphaDecay(d: number): this
    alphaMin(m: number): this
    velocityDecay(d: number): this
    force(name: string, force: Force<N> | null): this
    tick(iterations?: number): this
    stop(): this
    numDimensions(n: number): this
  }
  export function forceSimulation<N extends SimNode = SimNode, L = SimLink<N>>(nodes?: N[], numDimensions?: number): Simulation<N, L>
  export function forceLink<N extends SimNode, L extends SimLink<N>>(links?: L[]): Force<N> & {
    id(fn: (d: N) => string): ReturnType<typeof forceLink<N, L>>
    distance(d: number | ((l: L) => number)): ReturnType<typeof forceLink<N, L>>
    strength(s: number | ((l: L) => number)): ReturnType<typeof forceLink<N, L>>
  }
  export function forceManyBody<N extends SimNode>(): Force<N> & { strength(s: number): ReturnType<typeof forceManyBody<N>> }
  export function forceCenter<N extends SimNode>(x?: number, y?: number, z?: number): Force<N> & { strength(s: number): Force<N> & { strength(s: number): unknown } }
  export function forceCollide<N extends SimNode>(r?: number | ((n: N) => number)): Force<N>
}
