import { createEntity, displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type AnyEntity, type Entity, type EntityId, type Selector } from '../../core/entity/types'
import { annotationsOf, createAnnotation, type TargetAnnotation } from '../../core/resources/annotations'
import { RESOURCE_TYPES, type AnnotationData, type VideoData } from '../../core/resources/types'
import { externalServicesAllowed } from '../account/settings'

export type VideoEntity = Entity<VideoData>
export type TimeSelector = Extract<Selector, { kind: 'time' }>
/** A box in fractions (0–1) of the frame's width and height. */
export type FrameBox = NonNullable<TimeSelector['region']>

export const isVideo = (e: AnyEntity | undefined): e is VideoEntity => !!e && !isRelationship(e) && e.type === RESOURCE_TYPES.video && typeof e.data.videoId === 'string'
export const allVideos = (store: EntityStore): VideoEntity[] => store.ofType(RESOURCE_TYPES.video).filter(isVideo)

export function extractYouTubeId(input: string): string | undefined {
  const s = input.trim()
  try {
    const u = new URL(s)
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || undefined
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) {
      const v = u.searchParams.get('v')
      if (v && /^[\w-]{11}$/.test(v)) return v
      const m = /\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname)
      if (m) return m[1]
    }
  } catch {
    if (/^[\w-]{11}$/.test(s)) return s
  }
  return undefined
}

/** Parse `?t=1m30s`, `&t=90`, or `#t=90` style start times from a YouTube URL. */
export function extractStartTime(input: string): number | undefined {
  try {
    const u = new URL(input.trim())
    const t = u.searchParams.get('t') ?? u.searchParams.get('start') ?? /[#&?]t=([^&]+)/.exec(u.hash)?.[1]
    if (!t) return undefined
    if (/^\d+$/.test(t)) return Number(t)
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t)
    if (!m) return undefined
    return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  } catch {
    return undefined
  }
}

export const youtubeUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`
export const thumbnailUrl = (videoId: string, size: 'mq' | 'hq' | 'maxres' = 'mq') => `https://i.ytimg.com/vi/${videoId}/${size}default.jpg`

/** Best-effort public metadata; no API key needed. Returns nothing when blocked — or with Third-party services off, when YouTube is not asked. */
export async function fetchOEmbed(videoId: string): Promise<{ title?: string; author_name?: string } | undefined> {
  if (!externalServicesAllowed()) return undefined
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeUrl(videoId))}&format=json`)
    if (!r.ok) return undefined
    return (await r.json()) as { title?: string; author_name?: string }
  } catch {
    return undefined
  }
}

/** Register a YouTube video from any of its URL forms. Existing entities for the same id are reused. */
export async function importYouTube(store: EntityStore, url: string, opts: { tags?: string[]; source?: string } = {}): Promise<{ entity: VideoEntity; existed: boolean; metadata: boolean }> {
  const videoId = extractYouTubeId(url)
  if (!videoId) throw new Error('Could not find a YouTube video id in that URL.')
  const existing = allVideos(store).find((v) => v.data.videoId === videoId)
  if (existing) return { entity: existing, existed: true, metadata: true }
  const meta = await fetchOEmbed(videoId)
  const e = createEntity<VideoData>({
    type: RESOURCE_TYPES.video,
    label: meta?.title ?? `YouTube video ${videoId}`,
    tags: opts.tags,
    data: { url: youtubeUrl(videoId), videoId, channel: meta?.author_name, thumbnailUrl: thumbnailUrl(videoId) },
    meta: { source: opts.source ?? 'import:youtube', accessedAt: new Date().toISOString() },
  })
  store.upsert(e)
  return { entity: e, existed: false, metadata: !!meta }
}

// ── Time annotations ───────────────────────────────────────────────────

export type VideoAnnotation = TargetAnnotation & { time: TimeSelector }

/** Annotations with a time selector, ordered by start time. */
export function timeAnnotationsOf(store: EntityStore, videoId: EntityId): VideoAnnotation[] {
  return annotationsOf(store, videoId)
    .filter((a): a is VideoAnnotation => a.selector?.kind === 'time')
    .map((a) => ({ ...a, time: a.selector as TimeSelector }))
    .sort((a, b) => a.time.start - b.time.start || a.annotation.meta.createdAt.localeCompare(b.annotation.meta.createdAt))
}

export function otherAnnotationsOf(store: EntityStore, videoId: EntityId): TargetAnnotation[] {
  return annotationsOf(store, videoId).filter((a) => a.selector?.kind !== 'time')
}

/** Clamp a frame box to 0–1 and round to 4 decimals; null if it collapses. */
export function normalizeFrameBox(b: FrameBox): FrameBox | null {
  const x1 = Math.max(0, Math.min(1, Math.min(b.x, b.x + b.width)))
  const y1 = Math.max(0, Math.min(1, Math.min(b.y, b.y + b.height)))
  const x2 = Math.max(0, Math.min(1, Math.max(b.x, b.x + b.width)))
  const y2 = Math.max(0, Math.min(1, Math.max(b.y, b.y + b.height)))
  const r = (n: number) => Math.round(n * 10000) / 10000
  if (x2 - x1 < 0.005 || y2 - y1 < 0.005) return null
  return { x: r(x1), y: r(y1), width: r(x2 - x1), height: r(y2 - y1) }
}

export function annotateVideo(
  store: EntityStore,
  video: VideoEntity,
  time: { start: number; end?: number; region?: FrameBox },
  comment: string,
  tags: string[] = [],
  source = 'user',
): Entity<AnnotationData> {
  const start = Math.max(0, Math.round(time.start * 10) / 10)
  const end = time.end != null && time.end > start ? Math.round(time.end * 10) / 10 : undefined
  const selector: TimeSelector = { kind: 'time', start, ...(end != null ? { end } : {}), ...(time.region ? { region: time.region } : {}) }
  return createAnnotation(store, video.id, selector, {
    comment,
    tags,
    label: comment.trim().slice(0, 60) || `${displayLabel(video)} @ ${clock(start)}`,
    annotationType: time.region ? 'image' : 'note',
    data: { pageUrl: `${youtubeUrl(video.data.videoId)}&t=${Math.floor(start)}s` },
    source,
  })
}

/** Is `t` inside the annotation's window? Point annotations get a small tolerance so they show while passing. */
export function isActiveAt(a: VideoAnnotation, t: number, tolerance = 1.5): boolean {
  if (a.time.end != null) return t >= a.time.start - 0.25 && t <= a.time.end
  return Math.abs(t - a.time.start) <= tolerance
}

export { clock } from '../../core/entity/ids'
import { clock } from '../../core/entity/ids'

/** `1:30`, `90`, `1h2m3s`, `1:02:03` → seconds. */
export function parseClock(input: string): number | undefined {
  const s = input.trim()
  if (!s) return undefined
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(s)
  if (hms && (hms[1] || hms[2] || hms[3])) return Number(hms[1] ?? 0) * 3600 + Number(hms[2] ?? 0) * 60 + Number(hms[3] ?? 0)
  const parts = s.split(':').map(Number)
  if (parts.some((n) => Number.isNaN(n)) || parts.length > 3) return undefined
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}
