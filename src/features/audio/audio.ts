import { createEntity, displayLabel } from '../../core/entity/entity'
import { clock } from '../../core/entity/ids'
import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type AnyEntity, type Entity, type EntityId, type Selector } from '../../core/entity/types'
import { annotationsOf, createAnnotation, updateAnnotationSelector, type TargetAnnotation } from '../../core/resources/annotations'
import { RESOURCE_TYPES, type AnnotationData, type AudioData } from '../../core/resources/types'
import { externalServicesAllowed } from '../account/settings'

export type AudioEntity = Entity<AudioData>
export type TimeSelector = Extract<Selector, { kind: 'time' }>
export type SpotifyKind = AudioData['spotifyType']

export const isAudio = (e: AnyEntity | undefined): e is AudioEntity => !!e && !isRelationship(e) && e.type === RESOURCE_TYPES.audio && typeof e.data.spotifyId === 'string'
export const allAudio = (store: EntityStore): AudioEntity[] => store.ofType(RESOURCE_TYPES.audio).filter(isAudio)

const KINDS: SpotifyKind[] = ['track', 'album', 'playlist', 'episode', 'show', 'artist']
const ID = /^[0-9A-Za-z]{22}$/

/**
 * Accepts every Spotify link shape: open.spotify.com/track/<id>, with an
 * intl-xx segment, share links with ?si=, embed links, and spotify:track:<id>
 * URIs. Returns the kind and the 22-character id.
 */
export function parseSpotify(input: string): { kind: SpotifyKind; id: string } | undefined {
  const s = input.trim()
  const uri = /^spotify:(track|album|playlist|episode|show|artist):([0-9A-Za-z]{22})$/.exec(s)
  if (uri) return { kind: uri[1] as SpotifyKind, id: uri[2] }
  try {
    const u = new URL(s)
    if (!/(^|\.)spotify\.com$/.test(u.hostname)) return undefined
    const parts = u.pathname.split('/').filter(Boolean)
    // Drop leading `intl-xx` and `embed` segments.
    while (parts.length && (/^intl-[a-z]{2}(-[a-z]{2})?$/i.test(parts[0]) || parts[0] === 'embed' || parts[0] === 'embed-podcast')) parts.shift()
    const [kind, id] = parts
    if (KINDS.includes(kind as SpotifyKind) && ID.test(id ?? '')) return { kind: kind as SpotifyKind, id }
  } catch {
    /* not a URL */
  }
  return undefined
}

export const spotifyUrl = (kind: SpotifyKind, id: string) => `https://open.spotify.com/${kind}/${id}`
export const spotifyUri = (kind: SpotifyKind, id: string) => `spotify:${kind}:${id}`
/** Height Spotify's embed uses for each kind (px). Tracks are compact; collections show a list. */
export const embedHeight = (kind: SpotifyKind) => (kind === 'track' || kind === 'episode' ? 152 : 352)
/** Kinds with a single continuous timeline that time selectors can address. */
export const isTimed = (kind: SpotifyKind) => kind === 'track' || kind === 'episode'

/** Best-effort public metadata (title, artwork); no auth needed. Returns nothing when blocked — or with Third-party services off, when Spotify is not asked. */
export async function fetchSpotifyOEmbed(url: string): Promise<{ title?: string; thumbnail_url?: string } | undefined> {
  if (!externalServicesAllowed()) return undefined
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`)
    if (!r.ok) return undefined
    return (await r.json()) as { title?: string; thumbnail_url?: string }
  } catch {
    return undefined
  }
}

/** Register a Spotify link from any of its forms. Existing entities for the same id are reused. */
export async function importSpotify(store: EntityStore, input: string, opts: { tags?: string[]; source?: string } = {}): Promise<{ entity: AudioEntity; existed: boolean; metadata: boolean }> {
  const parsed = parseSpotify(input)
  if (!parsed) throw new Error('That doesn’t look like a Spotify link. Try an open.spotify.com URL or a spotify: URI.')
  const existing = allAudio(store).find((m) => m.data.spotifyId === parsed.id && m.data.spotifyType === parsed.kind)
  if (existing) return { entity: existing, existed: true, metadata: true }
  const url = spotifyUrl(parsed.kind, parsed.id)
  const meta = await fetchSpotifyOEmbed(url)
  // oEmbed titles come as "Song · Artist" for tracks; keep the split when it's there.
  const [title, artist] = splitTitle(meta?.title)
  const e = createEntity<AudioData>({
    type: RESOURCE_TYPES.audio,
    label: title ?? `Spotify ${parsed.kind} ${parsed.id.slice(0, 6)}…`,
    tags: opts.tags,
    data: { url, provider: 'spotify', spotifyType: parsed.kind, spotifyId: parsed.id, uri: spotifyUri(parsed.kind, parsed.id), artist, thumbnailUrl: meta?.thumbnail_url },
    meta: { source: opts.source ?? 'import:spotify', accessedAt: new Date().toISOString() },
  })
  store.upsert(e)
  return { entity: e, existed: false, metadata: !!meta }
}

function splitTitle(t: string | undefined): [string | undefined, string | undefined] {
  if (!t) return [undefined, undefined]
  const m = /^(.*?)\s+[·•]\s+(.*)$/.exec(t)
  return m ? [m[1], m[2]] : [t, undefined]
}

// ── Time annotations ───────────────────────────────────────────────────

export type AudioAnnotation = TargetAnnotation & { time: TimeSelector }

/** Annotations with a time selector, ordered by start time. */
export function timeAnnotationsOf(store: EntityStore, audioId: EntityId): AudioAnnotation[] {
  return annotationsOf(store, audioId)
    .filter((a): a is AudioAnnotation => a.selector?.kind === 'time')
    .map((a) => ({ ...a, time: a.selector as TimeSelector }))
    .sort((a, b) => a.time.start - b.time.start || (a.time.end ?? a.time.start) - (b.time.end ?? b.time.start))
}

export function otherAnnotationsOf(store: EntityStore, audioId: EntityId): TargetAnnotation[] {
  return annotationsOf(store, audioId).filter((a) => a.selector?.kind !== 'time')
}

export interface TimeRange {
  start: number
  end?: number
}

/** Tenth-of-a-second precision, start ≥ 0, end only when it's after start. */
export function normalizeRange(r: TimeRange, duration?: number): TimeRange {
  const clamp = (t: number) => Math.max(0, duration ? Math.min(duration, t) : t)
  const start = Math.round(clamp(Math.min(r.start, r.end ?? r.start)) * 10) / 10
  const rawEnd = r.end != null ? Math.round(clamp(Math.max(r.start, r.end)) * 10) / 10 : undefined
  return rawEnd != null && rawEnd > start + 0.1 ? { start, end: rawEnd } : { start }
}

export function annotateAudio(store: EntityStore, audio: AudioEntity, range: TimeRange, comment: string, tags: string[] = [], source = 'user'): Entity<AnnotationData> {
  const r = normalizeRange(range, audio.data.duration)
  const selector: TimeSelector = { kind: 'time', start: r.start, ...(r.end != null ? { end: r.end } : {}) }
  return createAnnotation(store, audio.id, selector, {
    comment,
    tags,
    label: comment.trim().slice(0, 60) || `${displayLabel(audio)} @ ${rangeLabel(r)}`,
    annotationType: 'note',
    data: { pageUrl: audio.data.url },
    source,
  })
}

/** Move/resize an existing time annotation. */
export function retimeAnnotation(store: EntityStore, a: AudioAnnotation, range: TimeRange, duration?: number) {
  const r = normalizeRange(range, duration)
  updateAnnotationSelector(store, a.relationshipId, { kind: 'time', start: r.start, ...(r.end != null ? { end: r.end } : {}) })
}

export const rangeLabel = (r: TimeRange) => (r.end != null ? `${clock(r.start)}–${clock(r.end)}` : clock(r.start))
export const rangeSeconds = (r: TimeRange) => (r.end != null ? r.end - r.start : 0)

/** Is `t` inside the annotation's window? Point annotations get a small tolerance so they show while passing. */
export function isActiveAt(a: AudioAnnotation, t: number, tolerance = 1.5): boolean {
  if (a.time.end != null) return t >= a.time.start - 0.25 && t <= a.time.end
  return Math.abs(t - a.time.start) <= tolerance
}

/**
 * Pack ranges into lanes so overlapping spans stack instead of hiding each
 * other. Greedy: each annotation takes the first lane that is free at its
 * start. Points occupy a zero-width slot.
 */
export function assignLanes(annotations: AudioAnnotation[], minGap = 0): { lane: number; a: AudioAnnotation }[] {
  const laneEnds: number[] = []
  return annotations.map((a) => {
    const start = a.time.start
    const end = a.time.end ?? a.time.start
    let lane = laneEnds.findIndex((e) => e + minGap <= start)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(end)
    } else laneEnds[lane] = end
    return { lane, a }
  })
}

export { clock }
export { parseClock } from '../videos/videos'
