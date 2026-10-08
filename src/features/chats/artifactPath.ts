import { Box, FileText, GitFork, Image as ImageIcon, Map as MapIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import { graphHref } from '../../app/routes'
import { UnigraphIcon } from '../../components/icons/UnigraphIcon'
import type { ArtifactKind, ChatArtifact } from './artifacts'

/** Where an artifact opens in the Chats page's panel: a scene in Unigraph itself, anything else in its artifact view (`/artifact/:id`). */
export function artifactPath(a: Pick<ChatArtifact, 'id' | 'kind' | 'entity'>): string {
  return a.kind === 'scene' ? graphHref(a.entity, 2) : `/artifact/${encodeURIComponent(a.id)}`
}

export const ARTIFACT_ICONS: Record<ArtifactKind, ComponentType<{ size?: number; className?: string }>> = {
  document: FileText,
  diagram: GitFork,
  map: MapIcon,
  scene: UnigraphIcon,
  image: ImageIcon,
  entity: Box,
}

export { artifactsHostKey } from './show'
