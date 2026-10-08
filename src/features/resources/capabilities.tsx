import { ArrowUpRight, Box, ClipboardPaste, Copy, Download, ExternalLink, FilePlus, FileText, Folder, FolderPlus, GitFork, Image as ImageIcon, Link, Map as MapIcon, Music, PenLine, Upload, Video, Waypoints } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import type { MenuItem } from '../../components/ui/Menu'
import { displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { httpUrl, RESOURCE_TYPES } from '../../core/resources/types'
import { pickFile } from '../../lib/download'
import { AudioAddDialog } from '../audio/AudioView'
import { importSpotify, isAudio } from '../audio/audio'
import { DiagramNewDialog } from '../diagrams/DiagramsView'
import { createDiagram, DIAGRAM_ACCEPT, importDiagramFile, isDiagram } from '../diagrams/diagrams'
import { detectDiagramFormat } from '../../core/diagrams'
import { MoveDialog } from '../documents/dialogs'
import { allDocuments, createDocument, deleteDocument, downloadDocument, duplicateDocument, extOf, FOLDER, IMPORT_ACCEPT, importFile, isDocument, isFolder, isPdf, moveDocument } from '../documents/documents'
import { ImageUrlDialog } from '../images/ImagesView'
import { downloadImage, IMAGE_ACCEPT, importImageFile, importImageUrl, isImage } from '../images/images'
import { VideoAddDialog } from '../videos/VideosView'
import { importYouTube, isVideo, youtubeUrl } from '../videos/videos'
import { CONVERSATION_TYPE } from '../conversations/conversation'
import { createMap, importFeatures, isMap, MAP_ACCEPT, MAP_TYPE, parseMapFile, placesOf, placesToGeoJson, placesToKml, geoAnnotationsOf } from '../maps/maps'
import { MapNewDialog } from '../maps/MapNewDialog'
import { downloadText } from '../../lib/download'
import type { CreateKind } from './CreateDialogs'
import { graphHref, isGraphPart } from '../../app/routes'
import { GRAPH_TYPES } from '../../core/graph/types'
import { EXPLORER_SCENE_TYPE, SCENE_TYPE, UNIGRAPH_SCENE_TYPE } from '../../core/graph/scene'

/** What the Library page can do on behalf of a type's dedicated page. */
export interface ActionContext {
  store: EntityStore
  navigate: (to: string) => void
  toast: (message: string) => void
  /** Select an entity in the table (opening the inspector). */
  openById: (id: EntityId) => void
  /** Open one of the Library's own create dialogs. */
  create: (kind: CreateKind) => void
  /** Show a feature-owned dialog; `close` dismisses it. */
  showDialog: (render: (close: () => void) => ReactNode) => void
  /** Start editing an entity's label inline. */
  /** Ask for confirmation, then delete. */
  requestDelete: (ids: EntityId[]) => void
}

export interface TypeAction {
  id: string
  label: string
  icon?: ComponentType<{ size?: number }>
  /** Shown as a toolbar button on the type's tab; others live in the New menu. */
  primary?: boolean
  run: (ctx: ActionContext) => void
}

export interface TypeCapabilities {
  /** Create / import actions, in menu order. */
  actions: TypeAction[]
  /** Row context-menu items for entities of this type (before the shared ones). */
  rowItems?: (e: AnyEntity, ctx: ActionContext) => MenuItem[]
  /** Dropped files this type takes. */
  drop?: { accepts: (file: File) => boolean; importFile: (store: EntityStore, file: File) => Promise<AnyEntity> }
  /** Type-aware deletion (e.g. folders cascade); returns every id removed. */
  deleteMany?: (store: EntityStore, ids: EntityId[]) => EntityId[]
}

const pageHref = (e: AnyEntity) => {
  if (isDocument(e)) return `/documents/${e.id}`
  if (isMap(e)) return `/maps/${e.id}`
  if (isImage(e)) return `/images/${e.id}`
  if (isVideo(e)) return `/videos/${e.id}`
  if (isAudio(e)) return `/audio/${e.id}`
  if (isDiagram(e)) return `/diagrams/${e.id}`
  return undefined
}

/** "Open page" for types that have one, then Rename — the two items every dedicated page starts with. */
export function commonRowItems(e: AnyEntity, ctx: ActionContext): MenuItem[] {
  const href = pageHref(e)
  return [
    ...(href ? [{ kind: 'item', label: 'Open page', icon: ArrowUpRight, onSelect: () => ctx.navigate(href) } as MenuItem] : []),
  ]
}

const addedToast = (ctx: ActionContext, e: AnyEntity, existed = false, metadata = true) => {
  ctx.toast(existed ? 'Already in the Library' : metadata ? `Added ${displayLabel(e)}` : 'Added without metadata (oEmbed unavailable)')
  ctx.openById(e.id)
}

const pickMany = (accept: string): Promise<File[]> =>
  new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = true
    input.onchange = () => resolve([...(input.files ?? [])])
    input.oncancel = () => resolve([])
    input.click()
  })

const hasExt = (file: File, exts: string[]) => exts.includes(file.name.split('.').pop()?.toLowerCase() ?? '')

/** A saved graph picture or part opens in Unigraph — 2D, or 3D. */
const graphRowItems = (e: AnyEntity, ctx: ActionContext): MenuItem[] =>
  isGraphPart(e)
    ? [
        { kind: 'item', label: 'Open in Unigraph · 2D', icon: Waypoints, onSelect: () => ctx.navigate(graphHref(e, 2)) },
        { kind: 'item', label: 'Open in Unigraph · 3D', icon: Box, onSelect: () => ctx.navigate(graphHref(e, 3)) },
      ]
    : []
const graphPart: TypeCapabilities = { actions: [], rowItems: graphRowItems }
/** Scenes, filters, layouts, styles and analyses: nothing to create from the Library, but each opens in the explorer. */
export const GRAPH_CAPABILITIES: Record<string, TypeCapabilities> = {
  [SCENE_TYPE]: graphPart,
  [EXPLORER_SCENE_TYPE]: graphPart,
  [UNIGRAPH_SCENE_TYPE]: graphPart,
  [GRAPH_TYPES.filter]: graphPart,
  [GRAPH_TYPES.layout]: graphPart,
  [GRAPH_TYPES.rendering]: graphPart,
  [GRAPH_TYPES.analysis]: graphPart,
}

/**
 * Everything each dedicated page (Documents, Diagrams, Images, Videos, Audio)
 * offers, expressed so the Library can offer it too. Simple types (notes,
 * webpages, annotations) route to the Library's own dialogs.
 */
export const RESOURCE_CAPABILITIES: Record<string, TypeCapabilities> = {
  [RESOURCE_TYPES.note]: {
    actions: [{ id: 'note', label: 'New note', icon: FileText, primary: true, run: (ctx) => ctx.create('note') }],
  },
  [RESOURCE_TYPES.webpage]: {
    actions: [{ id: 'webpage', label: 'Save URL', icon: Link, primary: true, run: (ctx) => ctx.create('webpage') }],
  },
  [RESOURCE_TYPES.annotation]: {
    actions: [{ id: 'annotation', label: 'New annotation', icon: PenLine, primary: true, run: (ctx) => ctx.create('annotation') }],
  },

  [RESOURCE_TYPES.document]: {
    actions: [
      { id: 'md', label: 'New document', icon: FilePlus, primary: true, run: (ctx) => ctx.openById(createDocument(ctx.store, { extension: 'md' }).id) },
      { id: 'txt', label: 'Plain text', icon: FileText, run: (ctx) => ctx.openById(createDocument(ctx.store, { extension: 'txt' }).id) },
      { id: 'pdf', label: 'PDF from URL', icon: FileText, run: (ctx) => ctx.create('pdf') },
      { id: 'folder', label: 'New folder', icon: FolderPlus, run: (ctx) => ctx.openById(createDocument(ctx.store, { extension: FOLDER }).id) },
      {
        id: 'import',
        label: 'Import .md / .txt / .pdf…',
        icon: Upload,
        primary: true,
        run: async (ctx) => {
          const files = await pickMany(IMPORT_ACCEPT)
          let last: AnyEntity | undefined
          for (const f of files) {
            try {
              last = await importFile(ctx.store, f)
            } catch (err) {
              ctx.toast(err instanceof Error ? err.message : String(err))
            }
          }
          if (last) ctx.toast(files.length === 1 ? `Imported ${displayLabel(last)}` : `Imported ${files.length} files`)
          if (last) ctx.openById(last.id)
        },
      },
    ],
    rowItems: (e, ctx) => {
      if (!isDocument(e)) return []
      const folder = isFolder(e)
      const items: MenuItem[] = []
      if (folder) {
        items.push({ kind: 'item', label: 'New document here', icon: FilePlus, onSelect: () => ctx.openById(createDocument(ctx.store, { extension: 'md', parentId: e.id }).id) })
        items.push({ kind: 'item', label: 'New folder here', icon: FolderPlus, onSelect: () => ctx.openById(createDocument(ctx.store, { extension: FOLDER, parentId: e.id }).id) })
        items.push({
          kind: 'item',
          label: 'Import file here…',
          icon: Upload,
          onSelect: async () => {
            const file = await pickFile(IMPORT_ACCEPT)
            if (!file) return
            try {
              const d = await importFile(ctx.store, file, e.id)
              ctx.toast(`Imported ${displayLabel(d)}`)
              ctx.openById(d.id)
            } catch (err) {
              ctx.toast(err instanceof Error ? err.message : String(err))
            }
          },
        })
        items.push({ kind: 'sep' })
      }
      items.push({ kind: 'item', label: 'Duplicate', icon: Copy, onSelect: () => ctx.openById(duplicateDocument(ctx.store, e).id) })
      items.push({
        kind: 'item',
        label: 'Move to…',
        icon: Folder,
        onSelect: () =>
          ctx.showDialog((close) => (
            <MoveDialog
              id={e.id}
              docs={allDocuments(ctx.store)}
              onClose={close}
              onMove={(parent) => {
                if (!moveDocument(ctx.store, e.id, parent)) ctx.toast("Can't move a folder into itself")
                close()
              }}
            />
          )),
      })
      if (!folder) items.push({ kind: 'item', label: 'Download', icon: Download, disabled: isPdf(e) && !e.data.dataUrl && !e.data.sourceUrl, onSelect: () => downloadDocument(e) })
      if (!folder && !isPdf(e)) {
        const next = extOf(e) === 'md' ? 'txt' : 'md'
        items.push({ kind: 'item', label: `Convert to .${next}`, onSelect: () => ctx.store.update(e.id, { data: { ...e.data, extension: next } }) })
      }
      return items
    },
    drop: { accepts: (f) => hasExt(f, ['md', 'markdown', 'txt', 'text', 'pdf']) || f.type === 'application/pdf' || f.type.startsWith('text/'), importFile: (store, f) => importFile(store, f) },
    // Folders take their contents with them, as on the Documents page.
    deleteMany: (store, ids) => store.transaction(() => ids.flatMap((id) => (store.has(id) ? deleteDocument(store, id) : []))),
  },

  [RESOURCE_TYPES.diagram]: {
    actions: [
      {
        id: 'new',
        label: 'New diagram',
        icon: GitFork,
        primary: true,
        run: (ctx) =>
          ctx.showDialog((close) => (
            <DiagramNewDialog
              onClose={close}
              onSubmit={(label, source, format) => {
                const e = createDiagram(ctx.store, { label, source, format })
                close()
                ctx.openById(e.id)
              }}
            />
          )),
      },
      {
        id: 'import',
        label: 'Import .dot / .mmd / .excalidraw…',
        icon: Upload,
        primary: true,
        run: async (ctx) => {
          const file = await pickFile(DIAGRAM_ACCEPT)
          if (!file) return
          const e = await importDiagramFile(ctx.store, file)
          addedToast(ctx, e)
        },
      },
      {
        id: 'paste',
        label: 'From clipboard',
        icon: ClipboardPaste,
        primary: true,
        run: async (ctx) => {
          let text = ''
          try {
            text = (await navigator.clipboard.readText()).trim()
          } catch {
            ctx.toast('Clipboard access was refused — paste into New diagram instead')
            return
          }
          if (!text) {
            ctx.toast('The clipboard has no text')
            return
          }
          const format = detectDiagramFormat(text)
          const title = /^\s*(?:strict\s+)?(?:di)?graph\s+"?([A-Za-z0-9_\- ]+)"?/i.exec(text)?.[1] ?? /^\s*(?:%%.*\n)*\s*(?:title\s*:?\s*|---\s*\n\s*title:\s*)([^\n]+)/i.exec(text)?.[1]
          const e = createDiagram(ctx.store, { label: title?.trim() || `Pasted ${format === 'dot' ? 'Graphviz' : 'Mermaid'} diagram`, source: text, format })
          ctx.toast(`Added ${displayLabel(e)} (${format === 'dot' ? 'Graphviz' : 'Mermaid'})`)
          ctx.openById(e.id)
        },
      },
    ],
    rowItems: (e, ctx) => (isDiagram(e) ? [{ kind: 'item', label: 'Export to dataset…', icon: Upload, onSelect: () => ctx.navigate(`/diagrams/${e.id}?export=1`) }] : []),
    drop: { accepts: (f) => hasExt(f, ['dot', 'gv', 'mmd', 'mermaid', 'excalidraw']), importFile: importDiagramFile },
  },

  [RESOURCE_TYPES.image]: {
    actions: [
      {
        id: 'upload',
        label: 'Upload images',
        icon: Upload,
        primary: true,
        run: async (ctx) => {
          const files = await pickMany(IMAGE_ACCEPT)
          let last: AnyEntity | undefined
          let failed = 0
          for (const f of files) {
            try {
              last = await importImageFile(ctx.store, f)
            } catch (err) {
              failed++
              ctx.toast(err instanceof Error ? err.message : String(err))
            }
          }
          if (last) {
            ctx.toast(files.length - failed === 1 ? `Added ${displayLabel(last)}` : `Added ${files.length - failed} images`)
            ctx.openById(last.id)
          }
        },
      },
      {
        id: 'url',
        label: 'Image from URL',
        icon: ImageIcon,
        primary: true,
        run: (ctx) =>
          ctx.showDialog((close) => (
            <ImageUrlDialog
              onClose={close}
              onSubmit={async (url, label) => {
                try {
                  const e = await importImageUrl(ctx.store, url, label, { approved: true })
                  close()
                  addedToast(ctx, e)
                } catch {
                  ctx.toast('Enter a full image URL including https://')
                }
              }}
            />
          )),
      },
    ],
    rowItems: (e) =>
      isImage(e)
        ? [
            ...(httpUrl(e.data.url) ? [{ kind: 'item', label: 'Open original', icon: ExternalLink, onSelect: () => window.open(httpUrl(e.data.url), '_blank', 'noopener') } as MenuItem] : []),
            { kind: 'item', label: 'Download', icon: Download, onSelect: () => downloadImage(e) },
          ]
        : [],
    drop: { accepts: (f) => f.type.startsWith('image/'), importFile: importImageFile },
  },

  [RESOURCE_TYPES.video]: {
    actions: [
      {
        id: 'youtube',
        label: 'Add from YouTube URL',
        icon: Video,
        primary: true,
        run: (ctx) =>
          ctx.showDialog((close) => (
            <VideoAddDialog
              onClose={close}
              onSubmit={async (url) => {
                try {
                  const { entity, existed, metadata } = await importYouTube(ctx.store, url)
                  close()
                  addedToast(ctx, entity, existed, metadata)
                } catch (err) {
                  ctx.toast(err instanceof Error ? err.message : String(err))
                }
              }}
            />
          )),
      },
    ],
    rowItems: (e) => (isVideo(e) ? [{ kind: 'item', label: 'Watch on YouTube', icon: ExternalLink, onSelect: () => window.open(youtubeUrl(e.data.videoId), '_blank', 'noopener') }] : []),
  },

  [MAP_TYPE]: {
    actions: [
      {
        id: 'new',
        label: 'New map',
        icon: MapIcon,
        primary: true,
        run: (ctx) =>
          ctx.showDialog((close) => (
            <MapNewDialog
              onClose={close}
              onSubmit={(label) => {
                const m = createMap(ctx.store, { label })
                close()
                ctx.openById(m.id)
              }}
            />
          )),
      },
      {
        id: 'import',
        label: 'Import KML / GeoJSON as a map…',
        icon: Upload,
        primary: true,
        run: async (ctx) => {
          const file = await pickFile(MAP_ACCEPT)
          if (!file) return
          try {
            const { name, features, source } = await parseMapFile(file)
            const m = createMap(ctx.store, { label: name ?? file.name.replace(/\.[^.]+$/, ''), source: file.name })
            const added = importFeatures(ctx.store, m, features, source, ['from-' + source])
            if (added[0]) ctx.store.update(m.id, { data: { ...m.data, center: { lat: added[0].data.lat, lng: added[0].data.lng }, zoom: 10 } })
            ctx.toast(`Map with ${added.length} on it`)
            ctx.openById(m.id)
          } catch (err) {
            ctx.toast(err instanceof Error ? err.message : String(err))
          }
        },
      },
    ],
    rowItems: (e, ctx) =>
      isMap(e)
        ? [
            { kind: 'item', label: 'Export GeoJSON', icon: Download, onSelect: () => downloadText(`${(e.label ?? 'map').replace(/[^\w.-]+/g, '_')}.geojson`, placesToGeoJson(placesOf(ctx.store, e), geoAnnotationsOf(ctx.store, e.id)), 'application/geo+json') },
            { kind: 'item', label: 'Export KML (Google Earth)', icon: Download, onSelect: () => downloadText(`${(e.label ?? 'map').replace(/[^\w.-]+/g, '_')}.kml`, placesToKml(e.label ?? 'Map', placesOf(ctx.store, e), geoAnnotationsOf(ctx.store, e.id)), 'application/vnd.google-earth.kml+xml') },
          ]
        : [],
    drop: { accepts: (f) => hasExt(f, ['kml', 'geojson']), importFile: async (store, f) => { const { name, features, source } = await parseMapFile(f); const m = createMap(store, { label: name ?? f.name.replace(/\.[^.]+$/, ''), source: f.name }); const added = importFeatures(store, m, features, source, ['from-' + source]); if (added[0]) store.update(m.id, { data: { ...m.data, center: { lat: added[0].data.lat, lng: added[0].data.lng }, zoom: 10 } }); return store.get(m.id)! } },
  },

  [CONVERSATION_TYPE]: {
    // Conversations come from exports, loaded locally through the Projects dialog.
    actions: [{ id: 'load', label: 'Load ChatGPT export…', icon: Upload, primary: true, run: (ctx) => ctx.navigate('/datasets') }],
  },

  [RESOURCE_TYPES.audio]: {
    actions: [
      {
        id: 'spotify',
        label: 'Add from Spotify URL',
        icon: Music,
        primary: true,
        run: (ctx) =>
          ctx.showDialog((close) => (
            <AudioAddDialog
              onClose={close}
              onSubmit={async (url) => {
                try {
                  const { entity, existed, metadata } = await importSpotify(ctx.store, url)
                  close()
                  addedToast(ctx, entity, existed, metadata)
                } catch (err) {
                  ctx.toast(err instanceof Error ? err.message : String(err))
                }
              }}
            />
          )),
      },
    ],
    rowItems: (e) => (isAudio(e) && httpUrl(e.data.url) ? [{ kind: 'item', label: 'Open in Spotify', icon: ExternalLink, onSelect: () => window.open(httpUrl(e.data.url), '_blank', 'noopener') }] : []),
  },
}

/** Which type takes a dropped file, if any. */
export function dropTargetFor(file: File, capabilities: Record<string, TypeCapabilities>, preferred?: string): string | undefined {
  if (preferred && capabilities[preferred]?.drop?.accepts(file)) return preferred
  return Object.keys(capabilities).find((t) => capabilities[t].drop?.accepts(file))
}
