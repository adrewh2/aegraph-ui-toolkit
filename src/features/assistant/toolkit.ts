import { displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type AnyEntity, type EntityId } from '../../core/entity/types'
import { classifyUrl } from '../../core/net/url'
import { requireExternalServices } from '../account/settings'
import { contentOf, extOf, isDocument } from '../documents/documents'
import type { AppHost } from './tools'

/** Helpers every tool file shares: compact JSON results and entity lookups that fail with a useful message. */

export const MAX_CONTENT_CHARS = 80_000
export const json = (v: unknown) => JSON.stringify(v)

/**
 * Put what a tool just made in front of the user — every tool that creates an asset does, unless it was asked
 * `open: false`. On the Chats page it opens as a tab in the chat's artifacts panel, the chat staying where it is;
 * anywhere else the tool goes to its page (and from the Chats page the chat comes along in the side panel).
 * Returns where it went: `panel`, or the path.
 */
export function openMade(host: Pick<AppHost, 'navigate' | 'reveal'>, id: EntityId, path: string): string {
  if (host.reveal?.(id)) return 'panel'
  host.navigate(path)
  return path
}

export function summarize(e: AnyEntity) {
  const base = {
    id: e.id,
    type: e.type,
    label: displayLabel(e),
    tags: e.tags,
    updatedAt: e.meta.updatedAt,
  }
  if (isRelationship(e))
    return {
      ...base,
      kind: 'relationship',
      source: e.source,
      target: e.target,
      directed: e.directed,
    }
  if (isDocument(e))
    return {
      ...base,
      extension: extOf(e),
      folderId: e.data.parentId ?? null,
      chars: contentOf(e).length,
    }
  return base
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}

export function requireEntity(store: EntityStore, id: string): AnyEntity {
  const e = store.get(id)
  if (!e) throw new Error(`No entity with id ${id}. Use search_entities or list_documents to find ids.`)
  return e
}

export const brief = (store: EntityStore, id: string) => {
  const e = store.get(id)
  return e ? { id, type: e.type, label: displayLabel(e) } : { id, type: '?', label: id }
}

/**
 * The one way a tool fetches a URL it was handed. A URL in a tool call may
 * have been written by the model, by a bundle, by a page it read — not by
 * the user — so: only http(s); this page's own origin goes straight
 * through; anywhere else needs Third-party services on and the user's yes,
 * naming the host, whoever is calling (the panel, Claude Code over the
 * bridge, the headless engine's answer to a confirmation). With no page
 * (headless) a private or loopback address is refused outright.
 * `what` names the feature as the user would ("Importing a graph").
 */
export async function approveHandedUrl(host: Pick<AppHost, 'confirm'>, url: string, what: string): Promise<string> {
  const v = classifyUrl(url, 'The URL')
  if (v.kind === 'refused') throw new Error(v.why)
  if (v.kind === 'elsewhere') {
    requireExternalServices(what)
    const shown = v.url.href.length > 600 ? `${v.url.href.slice(0, 600)}… (${v.url.href.length} characters)` : v.url.href
    if (!(await host.confirm(`${what}: fetch ${shown}?\n\nThis reaches ${v.host}, which is not this site. Only say yes if you asked for it.`, { yes: 'Fetch', kind: 'fetch' }))) throw new Error(`Not fetched: the user declined to let ${v.host} be reached.`)
  }
  return v.url.href
}

/** `approveHandedUrl`, then the fetch. */
export async function fetchHandedUrl(host: Pick<AppHost, 'confirm'>, url: string, what: string, init?: { accept?: string }): Promise<Response> {
  return fetch(await approveHandedUrl(host, url, what), init?.accept ? { headers: { accept: init.accept } } : undefined)
}

/**
 * The `data` fields an entity's views load by themselves: a picture (`src`, `image`, `thumbnailUrl`, `screenshotUrl`)
 * or a page shown in a frame (`url`). Writing an address there is a request made later, each time the entity is
 * shown — so it is the same as fetching it now.
 */
export const LOADED_URL_FIELDS = ['src', 'url', 'image', 'thumbnailUrl', 'screenshotUrl'] as const

/**
 * Before `create_entity` / `update_entity` write `data`: an address on another site in one of the fields a view loads
 * (`LOADED_URL_FIELDS`) goes through `approveHandedUrl`, one question per address — Third-party services and the user's
 * yes naming the host — else the write is refused. This site's own addresses, inline `data:` pictures and fields set
 * to null (removed) pass. `what` names the entity as the user would ("Saving the image “Logo”").
 */
export async function approveLoadedUrls(host: Pick<AppHost, 'confirm'>, data: Record<string, unknown> | undefined, what: string): Promise<void> {
  if (!data) return
  for (const k of LOADED_URL_FIELDS) {
    const val = data[k]
    if (typeof val !== 'string' || /^\s*data:/i.test(val) || !val.trim()) continue
    const v = classifyUrl(val.trim(), `data.${k}`)
    if (v.kind === 'own') continue
    // Not http(s) (a mailto:, a custom scheme): nothing loads it as a page or a picture; links are checked where drawn.
    if (v.kind === 'refused' && !/^\s*https?:/i.test(val)) continue
    await approveHandedUrl(host, val.trim(), `${what} with data.${k} pointing at another site, which the app loads when it shows it`)
  }
}
