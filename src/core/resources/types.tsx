import { FileText, GitFork, Globe, Highlighter, Image as ImageIcon, Link2, Music as Audio, StickyNote, Video } from 'lucide-react'
import { defineEntityType, type EntityTypeDef } from '../entity/schema'
import type { AnyEntity, EntityData, Selector } from '../entity/types'
import { formatDuration, formatNumber } from '../../lib/format'

/**
 * Resource types. Each is an ordinary entity `type` with a definition that
 * describes its usual fields and how to present it. Nothing here is a
 * primitive — a webpage is just an entity that happens to carry a URL.
 */

export interface WebpageData extends EntityData {
  url: string
  hasHtml?: boolean
  hasScreenshot?: boolean
  screenshotUrl?: string
  metadata?: Record<string, unknown>
}

export interface AnnotationData extends EntityData {
  /** What the annotation says. */
  comment: string
  secondaryComment?: string
  /** For text annotations: the quoted passage. */
  selectedText?: string
  /** For image/video annotations: a captured still (data: URL or remote). */
  imageUrl?: string
  imageWidth?: number
  imageHeight?: number
  /** Where the annotation was made, when the target isn't an entity yet. */
  pageUrl?: string
  annotationType: 'text' | 'image' | 'note'
}

export interface DocumentData extends EntityData {
  /** `folder` is a document that only contains other documents. */
  extension: 'md' | 'txt' | 'pdf' | 'folder' | string
  content?: string
  /** For PDFs: where the bytes live. Either a remote URL or an inline data: URL from an upload. */
  sourceUrl?: string
  dataUrl?: string
  projectId?: string
  /** Containing folder (another document entity), if any. */
  parentId?: string
}

export const DOCUMENT_EXTENSIONS = ['md', 'txt', 'pdf', 'folder'] as const

export interface AudioData extends EntityData {
  url: string
  provider: 'spotify'
  /** What the link points at. Tracks and episodes have a single timeline; albums/playlists/shows are collections. */
  spotifyType: 'track' | 'album' | 'playlist' | 'episode' | 'show' | 'artist'
  spotifyId: string
  /** `spotify:track:…` — what the embed player loads. */
  uri: string
  artist?: string
  album?: string
  thumbnailUrl?: string
  /** Seconds, once the player has reported it. */
  duration?: number
}

export interface DiagramData extends EntityData {
  format: 'dot' | 'mermaid' | 'excalidraw'
  source: string
  /** What the parser recognised (digraph, flowchart, classDiagram, …). */
  kind?: string
  /** The diagram in every format it has been shown in, each with the structure fingerprint it matched — so switching back is exact (see core/diagrams/sync). */
  sources?: Partial<Record<'dot' | 'mermaid' | 'excalidraw', { source: string; fingerprint: string }>>
  /** Mapping used by the last "export to dataset"; reused as the default next time. */
  mapping?: Record<string, unknown>
  lastImport?: { at: string; entities: number; relationships: number }
}

export interface VideoData extends EntityData {
  url: string
  videoId: string
  channel?: string
  publishedAt?: string
  /** Seconds. */
  duration?: number
  viewCount?: number
  likeCount?: number
  commentCount?: number
  thumbnailUrl?: string
}

export interface ImageData extends EntityData {
  /** What to render: a remote URL or an inline data: URL from an upload. */
  src: string
  /** Remote location when the image isn't stored inline. */
  url?: string
  width?: number
  height?: number
  mimeType?: string
  /** Approximate size in bytes. */
  bytes?: number
  /** Page or file the image came from. */
  sourceUrl?: string
}

export const RESOURCE_TYPES = {
  webpage: 'webpage',
  annotation: 'annotation',
  document: 'document',
  image: 'image',
  video: 'video',
  audio: 'audio',
  diagram: 'diagram',
  note: 'note',
} as const

export const RELATIONSHIP_TYPES = {
  annotates: 'annotates',
  references: 'references',
  contains: 'contains',
  derivedFrom: 'derived-from',
  related: 'related',
} as const

/**
 * A URL from data that the app may open or link to: http(s) and nothing else. A `javascript:` or `data:` URL in
 * an entity (a bundle, an import, the model wrote it) would run or render in a tab the app opened — `window.open`
 * is not filtered the way React filters an `href`. Every link or open made from an entity's URL goes through here.
 */
export function httpUrl(url: unknown): string | undefined {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined
}

/** Where "open" should take the user for this entity, if anywhere besides the inspector. */
export function externalHref(e: AnyEntity): string | undefined {
  return httpUrl(e.data.url ?? e.data.pageUrl)
}

export const webpageType: EntityTypeDef = defineEntityType({
  type: RESOURCE_TYPES.webpage,
  category: 'resource',
  label: 'Webpage',
  pluralLabel: 'Webpages',
  icon: Globe,
  color: '#3b82f6',
  description: 'A saved page from the web — URL, captured HTML, and screenshot.',
  fields: [
    { key: 'data.url', label: 'URL', kind: 'url', required: true, editable: true, width: 280 },
    { key: 'data.hasHtml', label: 'HTML', kind: 'availability', width: 110 },
    { key: 'data.hasScreenshot', label: 'Screenshot', kind: 'availability', width: 110 },
    { key: 'data.screenshotUrl', label: 'Preview', kind: 'image', hidden: true },
  ],
})

export const annotationType: EntityTypeDef = defineEntityType({
  type: RESOURCE_TYPES.annotation,
  category: 'resource',
  label: 'Annotation',
  pluralLabel: 'Annotations',
  icon: Highlighter,
  color: '#f59e0b',
  description: 'Information layered onto other information: a highlight, a comment, a claim about a claim.',
  fields: [
    { key: 'data.annotationType', label: 'Kind', kind: 'text', width: 90 },
    { key: 'data.selectedText', label: 'Selected text', kind: 'longtext', editable: true, width: 260 },
    { key: 'data.comment', label: 'Comment', kind: 'longtext', editable: true, required: true, width: 260 },
    { key: 'data.secondaryComment', label: 'Secondary comment', kind: 'longtext', editable: true, hidden: true },
    { key: 'data.imageUrl', label: 'Image', kind: 'image', width: 90 },
    { key: 'data.pageUrl', label: 'Page', kind: 'url', editable: true, width: 200 },
  ],
})

export const documentType: EntityTypeDef = defineEntityType({
  type: RESOURCE_TYPES.document,
  category: 'resource',
  label: 'Document',
  pluralLabel: 'Documents',
  icon: FileText,
  color: '#10b981',
  description: 'A human-readable container: Markdown, plain text, or PDF. Folders are documents too.',
  fields: [
    { key: 'data.extension', label: 'Format', kind: 'text', editable: true, required: true, width: 90 },
    { key: 'data.projectId', label: 'Project', kind: 'text', editable: true, width: 140, hidden: true },
    { key: 'data.parentId', label: 'Folder', kind: 'text', width: 160, hidden: true },
    { key: 'data.sourceUrl', label: 'Source URL', kind: 'url', editable: true, width: 220, hidden: true },
    { key: 'data.content', label: 'Content', kind: 'longtext', editable: true, hidden: true },
  ],
  validate: (e) => {
    const ext = String(e.data.extension ?? '')
    return (DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)
      ? []
      : [{ entityId: e.id, field: 'data.extension', message: `Unknown format “${ext}”`, severity: 'warning' }]
  },
})

export const imageType: EntityTypeDef = defineEntityType({
  type: RESOURCE_TYPES.image,
  label: 'Image',
  pluralLabel: 'Images',
  category: 'resource',
  icon: ImageIcon,
  color: '#ec4899',
  description: 'A picture — by URL or uploaded. Regions of it can be annotated.',
  fields: [
    { key: 'data.src', label: 'Preview', kind: 'image', width: 72 },
    { key: 'data.width', label: 'Width', kind: 'number', width: 80 },
    { key: 'data.height', label: 'Height', kind: 'number', width: 80 },
    { key: 'data.mimeType', label: 'Type', kind: 'text', width: 110 },
    { key: 'data.url', label: 'URL', kind: 'url', editable: true, width: 240, hidden: true },
    { key: 'data.sourceUrl', label: 'Source', kind: 'url', editable: true, width: 220, hidden: true },
    { key: 'data.bytes', label: 'Bytes', kind: 'number', format: formatNumber, width: 90, hidden: true },
  ],
  validate: (e) => (typeof e.data.src === 'string' && e.data.src ? [] : [{ entityId: e.id, field: 'data.src', message: 'Image has no source', severity: 'error' }]),
})

export const videoType: EntityTypeDef = defineEntityType({
  type: RESOURCE_TYPES.video,
  category: 'resource',
  label: 'Video',
  pluralLabel: 'Videos',
  icon: Video,
  color: '#ef4444',
  description: 'An imported video with its public metadata.',
  fields: [
    { key: 'data.thumbnailUrl', label: 'Thumb', kind: 'image', width: 72 },
    { key: 'data.channel', label: 'Channel', kind: 'text', width: 150 },
    { key: 'data.duration', label: 'Duration', kind: 'number', width: 90, format: formatDuration },
    { key: 'data.viewCount', label: 'Views', kind: 'number', width: 90, format: formatNumber },
    { key: 'data.likeCount', label: 'Likes', kind: 'number', width: 80, format: formatNumber },
    { key: 'data.commentCount', label: 'Comments', kind: 'number', width: 90, format: formatNumber, hidden: true },
    { key: 'data.publishedAt', label: 'Published', kind: 'date', width: 120 },
    { key: 'data.url', label: 'URL', kind: 'url', required: true, width: 220, hidden: true },
  ],
})

export const audioType: EntityTypeDef = defineEntityType({
  type: RESOURCE_TYPES.audio,
  category: 'resource',
  label: 'Audio',
  pluralLabel: 'Audio',
  icon: Audio,
  color: '#1db954',
  description: 'A Spotify track, album, playlist, or podcast episode, annotated by moment or time range.',
  fields: [
    { key: 'data.thumbnailUrl', label: 'Art', kind: 'image', width: 72 },
    { key: 'data.artist', label: 'Artist', kind: 'text', editable: true, width: 160 },
    { key: 'data.spotifyType', label: 'Kind', kind: 'text', width: 80 },
    { key: 'data.duration', label: 'Duration', kind: 'number', width: 90, format: formatDuration },
    { key: 'data.url', label: 'URL', kind: 'url', required: true, width: 220, hidden: true },
    { key: 'data.uri', label: 'URI', kind: 'text', width: 200, hidden: true },
  ],
})

export const diagramType: EntityTypeDef = defineEntityType({
  type: RESOURCE_TYPES.diagram,
  category: 'resource',
  label: 'Diagram',
  pluralLabel: 'Diagrams',
  icon: GitFork,
  color: '#0891b2',
  description: 'A Graphviz (DOT) or Mermaid diagram: source text, rendered live, and exportable into the dataset as entities.',
  fields: [
    { key: 'data.format', label: 'Format', kind: 'text', width: 90 },
    { key: 'data.kind', label: 'Kind', kind: 'text', width: 110 },
    { key: 'data.lastImport', label: 'Last export', kind: 'json', width: 150, format: (v) => (v && typeof v === 'object' ? `${(v as { entities: number }).entities} entities` : '') },
    { key: 'data.source', label: 'Source', kind: 'longtext', editable: true, hidden: true },
  ],
})

export const noteType: EntityTypeDef = defineEntityType({
  type: RESOURCE_TYPES.note,
  category: 'resource',
  label: 'Note',
  pluralLabel: 'Notes',
  icon: StickyNote,
  color: '#8b5cf6',
  description: 'The simplest entity: a label and some text.',
  fields: [{ key: 'data.text', label: 'Text', kind: 'longtext', editable: true, width: 320 }],
})

export const relationshipTypeDef: EntityTypeDef = defineEntityType({
  type: '__relationship__',
  label: 'Relationship',
  pluralLabel: 'Relationships',
  category: 'knowledge',
  icon: Link2,
  kind: 'relationship',
  fields: [],
})

export function selectorForAnnotation(d: AnnotationData): Selector | undefined {
  if (d.selectedText) return { kind: 'text', exact: d.selectedText }
  return undefined
}
