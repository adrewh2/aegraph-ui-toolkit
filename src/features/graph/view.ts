import { useRef } from 'react'
import type { EntityId } from '../../core/entity/types'
import type { Positions } from '../../core/graph/layouts'
import type { SceneCamera } from '../../core/graph/scene'
import type { SnapshotOptions } from './snapshot'

/**
 * What the explorer asks of its view — the GPU engine's, flat or in three
 * dimensions: the camera as the explorer reads and sets it, the rectangle
 * in view, a snapshot, where every node is drawn right now. The engine's
 * view (`gpugraph/GpuGraph.tsx`) implements it; the explorer, the tools and
 * the shortcuts drive it through this and nothing else.
 */
export interface Viewport {
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** 3D: the plane the rectangle lies in, and whether the camera is not looking straight down at it. */
  z?: number
  tilted?: boolean
}
export type CameraState = { kind: '2d'; x: number; y: number; ratio: number; angle: number; center: { x: number; y: number }; viewport?: Viewport; /** Where the nodes were when the view was remembered: the view is only put back when they are there again (a force layout lands differently each run). */ extent?: Viewport } | { kind: '3d'; position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } }
export type CameraTarget = { center?: { x: number; y: number }; ratio?: number; angle?: number } | { position: { x: number; y: number; z: number }; lookAt?: { x: number; y: number; z: number } }

export interface GraphViewHandle {
  fit: () => void
  zoomIn: () => void
  zoomOut: () => void
  /** PNG of the current view, or null when the renderer can't produce one. */
  snapshot: (opts?: SnapshotOptions) => Promise<Blob | null>
  /** The visible rectangle in graph coordinates. */
  getViewport: () => Viewport | null
  /** Where every node is drawn right now — what physics or a drag in progress has moved to, not only what is held. */
  getLivePositions: () => Positions
  getCamera: () => CameraState | null
  setCamera: (target: CameraTarget, ms?: number) => void
  /**
   * Slide the camera across the picture, at once: `dx` right and `dy` up, in screen pixels — or, with `fraction`, in
   * widths and heights of the view. 2D moves over the plane, 3D in the plane facing the camera. The arrow keys use it.
   */
  panBy: (dx: number, dy: number, opts?: { fraction?: boolean }) => void
  /** Zoom about the centre of the view, at once: `factor` above 1 closer, below 1 further (3D: the distance to the point the camera looks at). Q and E use it. */
  zoomBy: (factor: number) => void
  /** 3D: turn the camera around the point it looks at, at once — `yaw` right and `pitch` up, in radians. 2D ignores it. W A S D use it. */
  orbitBy: (yaw: number, pitch: number) => void
  /**
   * 3D, the fly controls: move the eye and the point it looks at together, at once — `forward` along the line of
   * sight, `right` level to its right, `up` vertically — in shares of the distance the whole graph fits at. 2D
   * ignores it. W A S D and Q/E use it while flying.
   */
  flyBy?: (forward: number, right: number, up: number) => void
  /** 3D, the fly controls: turn the view about the eye, at once — `yaw` right and `pitch` up, in radians. The arrows use it while flying. */
  lookBy?: (yaw: number, pitch: number) => void
  /** Zoom to a set of nodes. */
  fitTo: (ids: Iterable<EntityId>, opts?: { padding?: number; ms?: number }) => void
  /** 3D: turn the camera square on to a slide hanging over the picture (`core/slides`); false when it is not hung there. */
  faceSlide?: (id: EntityId, ms?: number) => boolean
}

/** The same node box, give or take half a percent of its size: the picture the camera was remembered for. */
export function sameExtent(a: Viewport, b: Viewport): boolean {
  const tol = Math.max(a.maxX - a.minX, a.maxY - a.minY, 1) * 0.005
  return Math.abs(a.minX - b.minX) <= tol && Math.abs(a.maxX - b.maxX) <= tol && Math.abs(a.minY - b.minY) <= tol && Math.abs(a.maxY - b.maxY) <= tol
}

export interface GraphViewProps {
  /** The rectangle the other renderer was showing when the user switched: framed once, on the first picture, in place of the remembered camera. */
  initialViewport?: Viewport
  /** A scene's camera, to be the first camera of the next picture (each `token` once), ahead of the remembered one and the fit. */
  initialCamera?: { camera: SceneCamera; token: number }
}

/** The `initialCamera` prop read once per token: the renderer's first camera for a picture a scene asked for. */
export function useInitialCamera(initialCamera: GraphViewProps['initialCamera']) {
  const latest = useRef(initialCamera)
  latest.current = initialCamera
  const used = useRef(0)
  return (): SceneCamera | undefined => {
    const ic = latest.current
    if (!ic || ic.token === used.current) return undefined
    used.current = ic.token
    return ic.camera
  }
}
