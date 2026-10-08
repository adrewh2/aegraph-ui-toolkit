import type { EntityId } from '../../core/entity/types'
import type { GlobeSelection } from './globeData'

/**
 * The Maps page on screen, for the `globe` tool: the page registers a
 * handle while mounted (page-global, like the explorer handles); the
 * active one is preferred when several are mounted behind kept pages
 * and tabs. It drives both stages — the flat map and the globe share the
 * workbench — so "the globe" here is the Maps page in globe mode.
 */
export interface GlobeHandle {
  getState: () => {
    mode: '2d' | 'globe'
    layer: 'satellite' | 'streets' | 'terrain' | 'night'
    selectedId?: EntityId
    playhead?: string
    playing: boolean
    window?: { from: string; to: string }
    entities: number
    points: number
    arcs: number
    polygons: number
    range?: { from: string; to: string }
    selection: GlobeSelection
    /** Where the globe's camera is, when the globe is mounted. */
    camera?: { lat: number; lng: number; altitude: number }
  }
  setMode: (mode: '2d' | 'globe') => void
  setLayer: (layer: 'satellite' | 'streets' | 'terrain' | 'night') => void
  setWindow: (w: { from: string; to: string } | undefined) => void
  /** Altitude in globe radii: 0.3 is a region, 1 a continent, 2.5 the whole Earth. */
  flyTo: (lat: number, lng: number, altitude?: number, ms?: number) => void
  fit: () => void
  select: (id: EntityId | undefined) => void
  setPlayhead: (iso: string | undefined) => void
  play: (on: boolean) => void
  spin: (on: boolean) => void
}

const g = globalThis as unknown as { __aegraphGlobes?: { handles: { h: GlobeHandle; active: boolean }[] } }
const reg = (g.__aegraphGlobes ??= { handles: [] })

export function registerGlobeHandle(h: GlobeHandle, active: boolean): () => void {
  const entry = { h, active }
  reg.handles.push(entry)
  return () => {
    const i = reg.handles.indexOf(entry)
    if (i >= 0) reg.handles.splice(i, 1)
  }
}

/** The globe the user is looking at, else any mounted one. */
export function getGlobeHandle(): GlobeHandle | undefined {
  return (reg.handles.find((e) => e.active) ?? reg.handles[reg.handles.length - 1])?.h
}
