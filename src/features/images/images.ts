import { allowRemoteImage } from '../../components/imageGate'
import { createEntity, displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type AnyEntity, type Entity, type EntityId, type Selector } from '../../core/entity/types'
import { annotationsOf, createAnnotation, type TargetAnnotation } from '../../core/resources/annotations'
import { RESOURCE_TYPES, type AnnotationData, type ImageData } from '../../core/resources/types'
import { dataImageSrc, isRemoteUrl } from '../../lib/markdown'
import { externalServicesAllowed } from '../account/settings'

export type ImageEntity = Entity<ImageData>
export type Region = Extract<Selector, { kind: 'region' }>
export type Box = { x: number; y: number; width: number; height: number }

export const isImage = (e: AnyEntity | undefined): e is ImageEntity => !!e && !isRelationship(e) && e.type === RESOURCE_TYPES.image && typeof e.data.src === 'string'
export const allImages = (store: EntityStore): ImageEntity[] => store.ofType(RESOURCE_TYPES.image).filter(isImage)
export const isInline = (e: ImageEntity) => e.data.src.startsWith('data:')

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif,.png,.jpg,.jpeg,.gif,.webp,.svg,.avif'
/** Inline images are data: URLs in the entity, so keep them modest. */
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024

export function createImage(
  store: EntityStore,
  init: { label?: string; src: string; url?: string; width?: number; height?: number; mimeType?: string; bytes?: number; sourceUrl?: string; tags?: string[]; source?: string },
): ImageEntity {
  const e = createEntity<ImageData>({
    type: RESOURCE_TYPES.image,
    label: init.label?.trim() || labelFromUrl(init.url ?? init.src) || 'Untitled image',
    tags: init.tags,
    data: {
      src: init.src,
      ...(init.url ? { url: init.url } : {}),
      ...(init.width ? { width: init.width } : {}),
      ...(init.height ? { height: init.height } : {}),
      ...(init.mimeType ? { mimeType: init.mimeType } : {}),
      ...(init.bytes ? { bytes: init.bytes } : {}),
      ...(init.sourceUrl ? { sourceUrl: init.sourceUrl } : {}),
    },
    meta: { source: init.source ?? 'user', accessedAt: new Date().toISOString() },
  })
  store.upsert(e)
  return e
}

export function labelFromUrl(u: string): string {
  if (u.startsWith('data:')) return ''
  try {
    const name = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() ?? '')
    return name.replace(/\.[a-z0-9]{2,5}$/i, '')
  } catch {
    return ''
  }
}

/** Natural size of an image, resolved by loading it. */
export function probeImage(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('The image could not be loaded.'))
    img.referrerPolicy = 'no-referrer'
    img.src = src
  })
}

export async function importImageFile(store: EntityStore, file: File): Promise<ImageEntity> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`)
  if (file.size > MAX_INLINE_IMAGE_BYTES) throw new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; inline images are capped at ${MAX_INLINE_IMAGE_BYTES / 1024 / 1024} MB. Add it by URL instead.`)
  const src = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('Could not read file'))
    r.readAsDataURL(file)
  })
  const dims = await probeImage(src).catch(() => ({ width: undefined, height: undefined }))
  const label = file.name.replace(/\.[a-z0-9]{2,5}$/i, '')
  return createImage(store, { label, src, width: dims.width, height: dims.height, mimeType: file.type, bytes: file.size, source: 'import:file' })
}

/** Bytes a base64 data: URL holds, without decoding it. */
export const dataUrlBytes = (u: string) => {
  const comma = u.indexOf(',')
  const body = comma < 0 ? '' : u.slice(comma + 1)
  return /;base64$/i.test(u.slice(0, comma)) ? Math.floor((body.length * 3) / 4) - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0) : body.length
}

/**
 * An image by address — or, given a `data:image/…` URL, the picture itself, kept inline like a file added from disk
 * (same cap), so a file can come in where there is no file picker: a tool call over MCP.
 */
export async function importImageUrl(store: EntityStore, url: string, label?: string, { approved = false }: { approved?: boolean } = {}): Promise<ImageEntity> {
  const trimmed = url.trim()
  if (/^data:/i.test(trimmed)) {
    const m = /^data:(image\/[a-z0-9.+-]+)[;,]/i.exec(trimmed)
    if (!m) throw new Error('A data: URL here must hold an image (data:image/png;base64,…).')
    const bytes = dataUrlBytes(trimmed)
    if (bytes > MAX_INLINE_IMAGE_BYTES) throw new Error(`The image is ${(bytes / 1024 / 1024).toFixed(1)} MB; inline images are capped at ${MAX_INLINE_IMAGE_BYTES / 1024 / 1024} MB. Add it by URL instead.`)
    const dims = await probeImage(trimmed).catch(() => ({ width: undefined, height: undefined }))
    return createImage(store, { label, src: trimmed, width: dims.width, height: dims.height, mimeType: m[1].toLowerCase(), bytes, source: 'import:file' })
  }
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('An image address here is http(s), or a data:image/… URL.')
  const src = parsed.toString()
  // Reading the size loads the picture, which is a request to its host: made only for an address the user typed or
  // said yes to (`approved`), and only with Third-party services on. Otherwise the entity is made without a size and
  // its viewer asks before loading, as for any image from data. Dimensions are best-effort either way: hosts that
  // block cross-origin loads still get an entity.
  const remote = isRemoteUrl(src)
  if (approved && remote) allowRemoteImage(src)
  const probe = !remote || (approved && externalServicesAllowed())
  const dims = probe ? await probeImage(src).catch(() => ({ width: undefined, height: undefined })) : { width: undefined, height: undefined }
  return createImage(store, { label, src, url: src, width: dims.width, height: dims.height, source: 'import:url' })
}

export function downloadImage(e: ImageEntity) {
  // The address is data: only an image URL (a `data:` picture, this origin, http(s)) is ever a link's target.
  const src = dataImageSrc(e.data.src)
  if (!src) return
  const a = document.createElement('a')
  a.href = src
  a.download = `${displayLabel(e).replace(/[\\/:*?"<>|]+/g, '-') || 'image'}${extensionFor(e)}`
  a.target = '_blank'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function extensionFor(e: ImageEntity): string {
  const m = /^data:image\/([a-z0-9+]+)/i.exec(e.data.src)
  const type = m?.[1] ?? e.data.mimeType?.split('/')[1] ?? ''
  if (type === 'jpeg') return '.jpg'
  if (type === 'svg+xml') return '.svg'
  return type ? `.${type}` : ''
}

// ── Region annotations ─────────────────────────────────────────────────

export type ImageAnnotation = TargetAnnotation & { region: Region }

/** Annotations on the image whose selector is a box, in creation order. */
export function regionAnnotationsOf(store: EntityStore, imageId: EntityId): ImageAnnotation[] {
  return annotationsOf(store, imageId).filter((a): a is ImageAnnotation => !!a.region)
}

/** Whole-image annotations (no selector, or a non-region one). */
export function otherAnnotationsOf(store: EntityStore, imageId: EntityId): TargetAnnotation[] {
  return annotationsOf(store, imageId).filter((a) => !a.region)
}

/** Clamp a box to the image and round to whole pixels. Returns null if it collapses. */
export function normalizeBox(b: Box, width: number, height: number): Box | null {
  let x1 = Math.max(0, Math.min(b.x, b.x + b.width))
  let y1 = Math.max(0, Math.min(b.y, b.y + b.height))
  let x2 = Math.min(width, Math.max(b.x, b.x + b.width))
  let y2 = Math.min(height, Math.max(b.y, b.y + b.height))
  x1 = Math.round(x1)
  y1 = Math.round(y1)
  x2 = Math.round(x2)
  y2 = Math.round(y2)
  if (x2 - x1 < 2 || y2 - y1 < 2) return null
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

export function annotateImage(store: EntityStore, image: ImageEntity, box: Box, comment: string, tags: string[] = [], source = 'user'): Entity<AnnotationData> {
  const region: Region = { kind: 'region', x: box.x, y: box.y, width: box.width, height: box.height }
  return createAnnotation(store, image.id, region, {
    comment,
    tags,
    label: comment.trim().slice(0, 60) || `Region ${box.width}×${box.height} @ ${box.x},${box.y}`,
    annotationType: 'image',
    data: { imageUrl: isInline(image) ? undefined : image.data.src },
    source,
  })
}
