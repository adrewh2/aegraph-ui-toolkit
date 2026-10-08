import type { EntityId } from '../../core/entity/types'
import type { Still } from '../videos/capture'

/**
 * The saved page open in the inspector's Page tab, for tools: capture what
 * the frame shows, sized so regions given as fractions of the frame map to
 * still pixels. Mirrors the video player handle.
 */
export interface WebpageHandle {
  pageId: EntityId
  capture: () => Promise<Still | undefined>
}

let handle: WebpageHandle | null = null
const listeners = new Set<() => void>()

export const setWebpageHandle = (h: WebpageHandle | null) => {
  handle = h
  listeners.forEach((l) => l())
}
export const getWebpageHandle = () => handle

/** Resolve once a Page tab for `pageId` is mounted (or give up after `timeoutMs`). */
export function waitForWebpage(pageId: EntityId, timeoutMs = 5000): Promise<WebpageHandle | null> {
  if (handle?.pageId === pageId) return Promise.resolve(handle)
  return new Promise((resolve) => {
    const done = (h: WebpageHandle | null) => {
      listeners.delete(check)
      clearTimeout(timer)
      resolve(h)
    }
    const check = () => {
      if (handle?.pageId === pageId) done(handle)
    }
    listeners.add(check)
    const timer = setTimeout(() => done(null), timeoutMs)
  })
}
