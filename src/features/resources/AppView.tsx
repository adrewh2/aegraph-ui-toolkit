import { lazy, Suspense, type ComponentType } from 'react'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { RESOURCE_TYPES } from '../../core/resources/types'
import { isDatasetType } from '../../core/datasets/dataset'
import { isAudio } from '../audio/audio'
import { isDiagram } from '../diagrams/diagrams'
import { isDocument } from '../documents/documents'
import { isImage } from '../images/images'
import { isVideo } from '../videos/videos'
import { isConversation } from '../conversations/conversation'
import type { EntityStore } from '../../core/entity/store'
import { isGeo, isGeoIn, isMap } from '../maps/maps'
import { isGraphPart } from '../../app/routes'

// Each embed pulls in its feature's editor/player and CSS, so they load on demand.
const DocumentEmbed = lazy(() => import('../documents/DocumentEmbed'))
const ImageEmbed = lazy(() => import('../images/ImageEmbed'))
const VideoEmbed = lazy(() => import('../videos/VideoEmbed'))
const AudioEmbed = lazy(() => import('../audio/AudioEmbed'))
const DiagramEmbed = lazy(() => import('../diagrams/DiagramEmbed'))
const WebpageEmbed = lazy(() => import('./WebpageEmbed'))
const ConversationEmbed = lazy(() => import('../conversations/ConversationEmbed'))
const MapEmbed = lazy(() => import('../maps/MapEmbed'))
const PlaceEmbed = lazy(() => import('../maps/PlaceEmbed'))
const GraphPartEmbed = lazy(() => import('../graph/GraphPartEmbed'))
const AnalyticsEmbed = lazy(() => import('../analytics/AnalyticsEmbed'))

interface AppView {
  /** Tab label, e.g. "Editor", "Player". */
  label: string
  Component: ComponentType<{ entity: AnyEntity; onOpen: (id: EntityId) => void }>
}

/**
 * The interactive form of a resource — the same editor, annotator, player,
 * or renderer its dedicated page uses — for the inspector's first tab.
 * Returns undefined for types that are just fields (notes, annotations).
 */
export function appViewFor(e: AnyEntity, store?: EntityStore): AppView | undefined {
  if (isDocument(e)) return { label: e.data.extension === 'folder' ? 'Contents' : e.data.extension === 'pdf' ? 'PDF' : 'Editor', Component: DocumentApp }
  if (isImage(e)) return { label: 'Image', Component: ImageApp }
  if (isVideo(e)) return { label: 'Player', Component: VideoApp }
  if (isAudio(e)) return { label: 'Player', Component: AudioApp }
  if (isDiagram(e)) return { label: 'Diagram', Component: DiagramApp }
  if (isConversation(e)) return { label: 'Chat', Component: ConversationApp }
  if (isMap(e)) return { label: 'Map', Component: MapApp }
  if (store ? isGeoIn(store, e) : isGeo(e)) return { label: 'Map', Component: PlaceApp }
  if (e.kind === 'entity' && e.type === RESOURCE_TYPES.webpage && typeof e.data.url === 'string') return { label: 'Page', Component: WebpageApp }
  if (isGraphPart(e)) return { label: 'Graph', Component: GraphPartApp }
  if (e.kind === 'entity' && (e.type === 'plot' || e.type === 'script' || e.type.startsWith('script:') || isDatasetType(e.type))) return { label: e.type === 'plot' ? 'Chart' : isDatasetType(e.type) ? 'Dataset' : 'Script', Component: AnalyticsApp }
  return undefined
}

const Loading = () => <div className="insp__empty">Loading…</div>

function DocumentApp({ entity, onOpen }: { entity: AnyEntity; onOpen: (id: EntityId) => void }) {
  return (
    <Suspense fallback={<Loading />}>
      <DocumentEmbed doc={entity as Parameters<typeof DocumentEmbed>[0]['doc']} onOpen={onOpen} />
    </Suspense>
  )
}
function ImageApp({ entity }: { entity: AnyEntity }) {
  return (
    <Suspense fallback={<Loading />}>
      <ImageEmbed image={entity as Parameters<typeof ImageEmbed>[0]['image']} />
    </Suspense>
  )
}
function VideoApp({ entity, onOpen }: { entity: AnyEntity; onOpen: (id: EntityId) => void }) {
  return (
    <Suspense fallback={<Loading />}>
      <VideoEmbed video={entity as Parameters<typeof VideoEmbed>[0]['video']} onOpen={onOpen} />
    </Suspense>
  )
}
function AudioApp({ entity }: { entity: AnyEntity }) {
  return (
    <Suspense fallback={<Loading />}>
      <AudioEmbed audio={entity as Parameters<typeof AudioEmbed>[0]['audio']} />
    </Suspense>
  )
}
function DiagramApp({ entity }: { entity: AnyEntity }) {
  return (
    <Suspense fallback={<Loading />}>
      <DiagramEmbed diagram={entity as Parameters<typeof DiagramEmbed>[0]['diagram']} />
    </Suspense>
  )
}

function MapApp({ entity, onOpen }: { entity: AnyEntity; onOpen: (id: EntityId) => void }) {
  return (
    <Suspense fallback={<Loading />}>
      <MapEmbed map={entity as Parameters<typeof MapEmbed>[0]['map']} onOpen={onOpen} />
    </Suspense>
  )
}
function PlaceApp({ entity }: { entity: AnyEntity }) {
  return (
    <Suspense fallback={<Loading />}>
      <PlaceEmbed place={entity as Parameters<typeof PlaceEmbed>[0]['place']} />
    </Suspense>
  )
}

function ConversationApp({ entity }: { entity: AnyEntity }) {
  return (
    <Suspense fallback={<Loading />}>
      <ConversationEmbed conversation={entity as Parameters<typeof ConversationEmbed>[0]['conversation']} />
    </Suspense>
  )
}

function WebpageApp({ entity }: { entity: AnyEntity }) {
  return (
    <Suspense fallback={<Loading />}>
      <WebpageEmbed page={entity as Parameters<typeof WebpageEmbed>[0]['page']} />
    </Suspense>
  )
}
function AnalyticsApp({ entity }: { entity: AnyEntity; onOpen: (id: EntityId) => void }) {
  return (
    <Suspense fallback={<Loading />}>
      <AnalyticsEmbed entity={entity} />
    </Suspense>
  )
}

function GraphPartApp({ entity, onOpen }: { entity: AnyEntity; onOpen: (id: EntityId) => void }) {
  return (
    <Suspense fallback={<Loading />}>
      <GraphPartEmbed entity={entity} onOpen={onOpen} />
    </Suspense>
  )
}
