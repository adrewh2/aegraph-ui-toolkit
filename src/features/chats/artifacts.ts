import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type AnyEntity, type EntityId } from '../../core/entity/types'
import { RESOURCE_TYPES } from '../../core/resources/types'
import { isGraphPart } from '../../app/routes'
import { CONVERSATION_TYPE, isConversation } from '../conversations/conversation'
import type { TranscriptItem } from '../assistant/session'

/**
 * A chat's **artifacts**: the entities the assistant made or changed while
 * the chat went on — the documents it wrote, the diagrams it drew, the maps
 * and places it laid out, the scenes it saved, the entities it created or
 * edited. They are what the Chats page shows beside the conversation, and
 * they are part of the chat's record (`ConversationData.artifacts`), so a
 * chat reopened next week still knows what it produced even though its tool
 * results were cut short when it was recorded.
 *
 * What counts is decided by the tool, not the result: a call that writes
 * (`create_*`, `write_*`, `edit_*`, `update_*`, `add_*`, `annotate_*`,
 * `set_properties`, `graph_save`, …) names its artifact in its result (`id`,
 * or `onMap` for a place put on a map) or its input (`id`, `document_id`,
 * `map_id`, `diagram_id`, the thing edited). A read — searching, inspecting,
 * reading a document — produces nothing. An annotation's own entity is not
 * the artifact; the document, image or map it annotates is — and a place, path or area put on a map (`onMap`, or a
 * `map_id` in the input) is the map's: the map is the artifact, not a chip per pin. A file the user attached to a
 * message (`attachments.ts`) is one too, under the tool name `attach`: the chat is how it came into the project.
 */

export interface ChatArtifactRef {
  id: EntityId
  /** The tool that last made or changed it. */
  tool: string
  /** When (ISO), as far as the chat knows. */
  at?: string
}

export type ArtifactKind = 'document' | 'diagram' | 'map' | 'scene' | 'image' | 'entity'

export interface ChatArtifact extends ChatArtifactRef {
  kind: ArtifactKind
  entity: AnyEntity
}

const WRITES = /^(create_|write_|edit_|update_|add_|annotate_|move_document$|set_properties$|graph_save$|define_entity_type$|diagram_to_dataset$|table_layout$|tag_entities$)/
/** Tools whose result id is a by-product (the annotation, the tag) rather than the thing worked on. */
const RESULT_IS_BYPRODUCT = /^(annotate_|tag_entities$)/
const INPUT_KEYS = ['document_id', 'map_id', 'diagram_id', 'image_id', 'video_id', 'audio_id', 'id'] as const

export const isWriterTool = (name: string) => WRITES.test(name)

function parse(result: string | undefined): Record<string, unknown> | undefined {
  if (!result) return undefined
  try {
    const v = JSON.parse(result)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The ids one finished tool call made or changed, in the order they matter (the result's first). */
export function idsOfCall(name: string, input: unknown, result: string | undefined): EntityId[] {
  if (!isWriterTool(name)) return []
  const out: EntityId[] = []
  const push = (v: unknown) => {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v)
  }
  const r = parse(result)
  const i = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  // A place, a path or an area put on a map is part of that map: the map is what was made, not a chip per pin.
  const map = (r && typeof r.onMap === 'string' && r.onMap) || (typeof i.map_id === 'string' && i.map_id) || undefined
  if (map) return [map]
  if (r && !RESULT_IS_BYPRODUCT.test(name)) push(r.id)
  for (const k of INPUT_KEYS) push(i[k])
  return out
}

/**
 * The artifacts a transcript names, newest touch last: every finished writing call's ids, each kept once at its
 * latest touch. Pure — no store — so it runs over a live chat and over a rebuilt one alike.
 */
export function artifactRefsOf(items: readonly TranscriptItem[]): ChatArtifactRef[] {
  const byId = new Map<EntityId, ChatArtifactRef>()
  for (const it of items) {
    if (it.kind === 'user') {
      for (const a of it.attachments ?? []) {
        byId.delete(a.id)
        byId.set(a.id, { id: a.id, tool: 'attach' })
      }
      continue
    }
    if (it.kind !== 'tool' || it.status !== 'done') continue
    const at = it.startedAt ? new Date(it.startedAt).toISOString() : undefined
    for (const id of idsOfCall(it.name, it.input, it.result)) {
      byId.delete(id)
      byId.set(id, { id, tool: it.name, ...(at ? { at } : {}) })
    }
  }
  return [...byId.values()]
}

/** Two lists of refs as one: `later` wins for an id both hold, and moves it to the end. */
export function mergeRefs(earlier: readonly ChatArtifactRef[], later: readonly ChatArtifactRef[]): ChatArtifactRef[] {
  const byId = new Map<EntityId, ChatArtifactRef>()
  for (const r of earlier) byId.set(r.id, r)
  for (const r of later) {
    byId.delete(r.id)
    byId.set(r.id, r)
  }
  return [...byId.values()]
}

export function artifactKind(e: AnyEntity): ArtifactKind {
  if (e.type === RESOURCE_TYPES.document) return 'document'
  if (e.type === RESOURCE_TYPES.diagram) return 'diagram'
  if (e.type === RESOURCE_TYPES.image) return 'image'
  if (e.type === 'map') return 'map'
  if (isGraphPart(e)) return 'scene'
  return 'entity'
}

/**
 * The refs as artifacts that still exist in the store, newest first. Relationships and conversations are left
 * out — a link is shown with its ends, and a chat is not its own artifact.
 */
export function resolveArtifacts(refs: readonly ChatArtifactRef[], store: Pick<EntityStore, 'get'>): ChatArtifact[] {
  const out: ChatArtifact[] = []
  for (let i = refs.length - 1; i >= 0; i--) {
    const e = store.get(refs[i].id)
    if (!e || isRelationship(e) || e.type === CONVERSATION_TYPE) continue
    out.push({ ...refs[i], kind: artifactKind(e), entity: e })
  }
  return out
}

/** The refs a recorded chat keeps (`data.artifacts`), read defensively: a bundle may carry anything. */
export function recordedRefs(e: AnyEntity | undefined): ChatArtifactRef[] {
  if (!isConversation(e) || !Array.isArray(e.data.artifacts)) return []
  return e.data.artifacts.filter((r): r is ChatArtifactRef => !!r && typeof r === 'object' && typeof (r as ChatArtifactRef).id === 'string' && typeof (r as ChatArtifactRef).tool === 'string')
}

