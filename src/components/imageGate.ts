import { useSyncExternalStore } from 'react'
import { useExternalServices } from '../features/account/settings'
import { dataImageSrc, imageKind } from '../lib/markdown'

/**
 * The hosts whose pictures are the provider's own thumbnail of a thing the app knows by its id there — a YouTube
 * video's poster, a Spotify cover, a Wikipedia photo — and load with Third-party services on, as the player or the
 * enrichment that named them would. Whatever a URL there carries goes to that provider, never to whoever wrote the
 * data; anything else on another host waits for a click.
 */
export const PROVIDER_IMAGE_HOSTS: readonly string[] = ['i.ytimg.com', 'i.scdn.co', 'upload.wikimedia.org']

/** An https address on one of `PROVIDER_IMAGE_HOSTS`, with no port or credentials. */
export function isProviderImage(src: string): boolean {
  try {
    const u = new URL(src)
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && PROVIDER_IMAGE_HOSTS.includes(u.hostname)
  } catch {
    return false
  }
}

/**
 * The remote addresses the reader has asked for in this tab. Loading one is the reader's yes to that request, so the
 * same picture elsewhere on the page (its card, its row, its viewer) need not ask again. Never stored: a reload asks.
 */
const asked = new Set<string>()
let askedVersion = 0
const askedListeners = new Set<() => void>()
const subscribeAsked = (l: () => void) => (askedListeners.add(l), () => void askedListeners.delete(l))
const getAskedVersion = () => askedVersion
/** Record the reader's yes to `src` — a click on its stand-in, or an address they typed and added themselves. */
export function allowRemoteImage(src: string) {
  if (asked.has(src)) return
  asked.add(src)
  askedVersion++
  askedListeners.forEach((l) => l())
}

/**
 * How a picture from data may be shown:
 * - `show` — carried in the data (`data:`), on this origin, a same-origin `blob:`, a provider thumbnail (with
 *   `providers`), or one the reader already loaded — with Third-party services on for anything remote;
 * - `ask` — on another host: named, and loaded on a click;
 * - `off` — on another host while Third-party services is off: named, and not loaded at all;
 * - `undefined` — not an image address (a script-capable scheme, not a string): never a `src`.
 */
export type ImageGate = { status: 'show'; src: string } | { status: 'ask' | 'off'; src: string; host: string }

export function imageGate(value: unknown, { external, providers = false }: { external: boolean; providers?: boolean }): ImageGate | undefined {
  const src = dataImageSrc(value)
  if (!src) return undefined
  if (imageKind(src) !== 'remote') return { status: 'show', src }
  let host = src
  try {
    host = new URL(src).host
  } catch {
    /* keep the text */
  }
  if (!external) return { status: 'off', src, host }
  if ((providers && isProviderImage(src)) || asked.has(src)) return { status: 'show', src }
  return { status: 'ask', src, host }
}

/** `imageGate` for a view: re-decides when the switch changes or the reader loads a picture. */
export function useImageGate(value: unknown, opts: { providers?: boolean } = {}): ImageGate | undefined {
  const external = useExternalServices()
  useSyncExternalStore(subscribeAsked, getAskedVersion, getAskedVersion)
  return imageGate(value, { external, providers: opts.providers })
}

/**
 * A CSS `url(…)` for a picture `useImageGate` said to show, quoted so the address cannot end the value and start
 * another declaration (`x"), url(https://elsewhere/…`).
 */
export const cssImageUrl = (src: string) => `url("${src.replace(/["\\\n\r\f]/g, (c) => encodeURIComponent(c))}")`

/** For tests: forget what the reader loaded. */
export function forgetRemoteImages() {
  asked.clear()
  askedVersion++
  askedListeners.forEach((l) => l())
}
