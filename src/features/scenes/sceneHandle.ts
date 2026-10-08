import type { EntityId } from '../../core/entity/types'

/** What an open Scenes exposes to the assistant tools, mirroring plotHandle. */
export interface SceneHandle {
  getState: () => {
    /** The saved scene shown, if any. */
    scene?: EntityId
    /** A scene made here that has not been saved yet. */
    unsaved: boolean
    /** The plot shown instead, if any (`new` for an unsaved one). */
    plot?: EntityId
    /** The scene drawn underneath for comparison, if any. */
    over?: EntityId
    selection: EntityId[]
    dirty: boolean
    nodes?: number
    edges?: number
  }
  /** Show a scene or a plot. */
  show: (target: { scene?: EntityId; plot?: EntityId }) => void
  /** Draw another scene underneath, faded; null stops comparing. */
  compareWith: (id: EntityId | null) => void
  select: (ids: EntityId[]) => void
  /** Save the working copy as a scene; `existing` updates that one. */
  save: (name: string, existing?: EntityId) => EntityId | undefined
  fit: () => void
}

const g = globalThis as unknown as { __aegraphDisplay?: { handle: SceneHandle | null; listeners: Set<() => void> } }
const reg = (g.__aegraphDisplay ??= { handle: null, listeners: new Set() })

export function registerDisplayHandle(h: SceneHandle): () => void {
  reg.handle = h
  reg.listeners.forEach((l) => l())
  return () => {
    if (reg.handle === h) reg.handle = null
    reg.listeners.forEach((l) => l())
  }
}
export const getSceneHandle = (): SceneHandle | null => reg.handle

export function waitForDisplay(timeoutMs = 5000): Promise<SceneHandle | null> {
  if (reg.handle) return Promise.resolve(reg.handle)
  return new Promise((resolve) => {
    const done = (h: SceneHandle | null) => {
      reg.listeners.delete(check)
      clearTimeout(timer)
      resolve(h)
    }
    const check = () => reg.handle && done(reg.handle)
    const timer = setTimeout(() => done(null), timeoutMs)
    reg.listeners.add(check)
  })
}
