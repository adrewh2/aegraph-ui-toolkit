/**
 * The diagram editor's document: an Excalidraw scene file
 * (`{ type: "excalidraw", elements, appState, files }`) kept as text.
 * This module is the only place that reads and writes the elements
 * (`document.ts` knows just enough of the shape to recognise a scene and
 * count it without loading Excalidraw); the rest of the app treats a scene
 * as an opaque string and a few numbers.
 */
import { getSceneVersion, restore, serializeAsJSON } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'

export interface Scene {
  elements: readonly ExcalidrawElement[]
  appState: Partial<AppState>
  files: BinaryFiles
}

/** A scene from its text; anything unreadable is an empty canvas. Elements are normalised the way Excalidraw itself loads a file. */
export function readScene(text: string | undefined): Scene {
  let raw: { elements?: unknown; appState?: unknown; files?: unknown } = {}
  try {
    raw = text ? (JSON.parse(text) as typeof raw) : {}
  } catch {
    /* an empty canvas */
  }
  const restored = restore({ elements: Array.isArray(raw.elements) ? (raw.elements as ExcalidrawElement[]) : [], appState: (raw.appState as Partial<AppState>) ?? null, files: (raw.files as BinaryFiles) ?? null }, null, null, { repairBindings: true })
  // A freehand stroke from another tool may lack per-point pressures; the renderer indexes them.
  const elements = restored.elements.map((e) => (e.type === 'freedraw' && (!Array.isArray(e.pressures) || e.pressures.length !== e.points.length) ? ({ ...e, pressures: e.points.map(() => 0.5) } as ExcalidrawElement) : e))
  return { elements, appState: restored.appState, files: restored.files ?? {} }
}

/** The scene as a file: elements, the part of the app state a file keeps (background, grid…), and the files the elements reference. */
export function writeScene(elements: readonly ExcalidrawElement[], appState: Partial<AppState>, files: BinaryFiles): string {
  return serializeAsJSON(elements, appState as AppState, files, 'local')
}

/** Changes whenever any element changes; the cheap way to know whether a scene needs saving. */
export function sceneVersion(elements: readonly ExcalidrawElement[]): number {
  return getSceneVersion(elements)
}

