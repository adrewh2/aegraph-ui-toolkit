import { useEffect, useState, type ReactNode } from 'react'
import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import type { AnyEntity } from '../../core/entity/types'
import { buildPlot, isPlot } from '../../core/graph/plot'
import { isImageUrl, plotPreview, scenePreview } from '../../core/graph/thumbnail'
import { onPreviewCached, previewKey, readPreview } from '../graph/previewCache'
import { plotContextFor } from '../plots/plotContext'

/**
 * The pictures on the Scenes and Charts cards. A picture saved with the entity
 * (a view captured in a tab, or one drawn when a tool or the headless engine
 * saved it) is shown as it is; one that has none is drawn here from what it
 * holds and kept in memory — never written back, so opening a page changes
 * nothing in the project. A chart's is drawn off the first paint, one at a
 * time, because building it reads the whole dataset.
 */
const cache = new Map<string, string | null>()
const CACHE_MAX = 400
const remember = (key: string, url: string | null) => {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(key, url)
  return url
}

const img = (src: string, title: string) => <img className="si__preview" src={src} alt="" title={title} loading="lazy" decoding="async" />

/**
 * A scene's picture, best first: the frame saved with it, then the frame this
 * browser captured when the scene was last opened (`previewCache` — scenes
 * from a bundle or a generator arrive without one), and only then a drawing
 * made from what the scene holds, which is flat and top-down and says so.
 */
export function ScenePicture({ e, store, fallback }: { e: AnyEntity; store: EntityStore; fallback: ReactNode }) {
  const stored = (e.data as { preview?: unknown }).preview
  const captured = useCapturedPreview(isImageUrl(stored) ? '' : previewKey(e.id, e.meta.updatedAt))
  if (isImageUrl(stored)) return img(stored, 'The view as it was saved')
  if (captured) return img(captured, 'The view as it was drawn when you last opened it')
  const layoutId = (e.data as { layoutId?: string }).layoutId
  const key = `scene:${e.id}@${e.meta.updatedAt}:${layoutId ? store.get(layoutId)?.meta.updatedAt : ''}`
  const url = cache.has(key) ? cache.get(key)! : remember(key, scenePreview(e, store) ?? null)
  return url ? img(url, 'A sketch of where the scene puts things — open it once and its card becomes the picture it opens as') : <>{fallback}</>
}

/** The captured frame for a scene, read once per key and refreshed when a capture lands. */
function useCapturedPreview(key: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!key) return
    let live = true
    const load = () => void readPreview(key).then((u) => live && setUrl(u))
    load()
    return onPreviewCached(load)
  }, [key])
  return key ? url : null
}

// One chart at a time, after the page has painted: the context (the dataset as the charts read it) built once per queue.
let queue: { e: AnyEntity; done: (url: string | null) => void }[] = []
let running = false
function drain(store: EntityStore, registry: TypeRegistry) {
  if (running) return
  running = true
  let ctx: ReturnType<typeof plotContextFor> | undefined
  const idle = (fn: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 16))
  const step = () => {
    const job = queue.shift()
    if (!job) {
      running = false
      return
    }
    let url: string | null = null
    try {
      if (isPlot(job.e)) url = plotPreview(buildPlot(job.e.data.spec, (ctx ??= plotContextFor(store, registry)))) ?? null
    } catch {
      url = null
    }
    job.done(url)
    idle(step)
  }
  idle(step)
}

/** A chart's picture: stored, or built from its spec once the page is idle. */
export function ChartPicture({ e, store, registry, fallback }: { e: AnyEntity; store: EntityStore; registry: TypeRegistry; fallback: ReactNode }) {
  const stored = (e.data as { preview?: unknown }).preview
  const key = `chart:${e.id}@${e.meta.updatedAt}`
  // Bumped when this card's picture lands in the cache; the picture itself is read from the cache.
  const [, landed] = useState(0)
  const needs = !isImageUrl(stored) && !cache.has(key)
  useEffect(() => {
    if (!needs) return
    let live = true
    queue.push({
      e,
      done: (u) => {
        remember(key, u)
        if (live) landed((n) => n + 1)
      },
    })
    drain(store, registry)
    return () => {
      live = false
      queue = queue.filter((j) => j.e !== e)
    }
  }, [e, key, needs, store, registry])
  if (isImageUrl(stored)) return img(stored, 'The chart as it was saved')
  const url = cache.get(key)
  return url ? img(url, 'Drawn from the chart’s spec') : <>{fallback}</>
}
