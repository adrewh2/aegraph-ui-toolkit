import type { EntityId } from '../../core/entity/types'

/**
 * "Show this artifact beside that chat", from outside the Chats page — the `chat` tool's `show`. A mounted page
 * listens and opens the artifact in its panel; with no page listening, the tool navigates to
 * `/chats/<chat>?artifact=<id>`, which the page reads when it mounts.
 */
/** Each chat's artifact tabs are remembered under their own key (the panel's pane host). */
export const artifactsHostKey = (chatId: string) => `aegraph:chats:artifacts:${chatId}`

type Listener = (chatId: string, artifact: EntityId) => boolean | void

const listeners = new Set<Listener>()

export function onShowArtifact(l: Listener): () => void {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** Whether a mounted Chats page took it. */
export function showArtifact(chatId: string, artifact: EntityId): boolean {
  let taken = false
  for (const l of listeners) if (l(chatId, artifact)) taken = true
  return taken
}
