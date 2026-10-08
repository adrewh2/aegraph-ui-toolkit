import { Sparkles } from 'lucide-react'
import type { MenuItem } from '../../components/ui/Menu'
import { displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type AnyEntity, type EntityId } from '../../core/entity/types'

/**
 * "Ask about this" from anywhere: open the assistant and send it a question
 * about what was right-clicked. The question names the thing by label and
 * id so the assistant can look it up instead of guessing from the screen.
 *
 * The event opens the panel (AppLayout listens); the prompt is queued here
 * and the session picks it up when it attaches — or at once when it is
 * already open. Kept apart from the panel so any view can call it.
 */
export interface AskEvent {
  open?: boolean
  prompt?: string
}

let pending: string | null = null
let drain: ((text: string) => void) | null = null

export function askAssistant(prompt: string) {
  const text = prompt.trim()
  if (!text) return
  pending = text
  window.dispatchEvent(new CustomEvent<AskEvent>('aegraph:assistant', { detail: { open: true, prompt: text } }))
  flush()
}

/** The session registers how to take a prompt (null when it detaches); anything waiting goes out. */
export function onAsk(f: ((text: string) => void) | null) {
  drain = f
  flush()
}

function flush() {
  if (!pending || !drain) return
  const text = pending
  pending = null
  // After the panel has mounted and attached, not in the middle of its render.
  setTimeout(() => drain?.(text), 0)
}

/** A short handle for a prompt: the label with its id, so lookups are exact. */
export function describeForAsk(store: EntityStore, e: AnyEntity): string {
  if (isRelationship(e)) {
    const s = store.get(e.source.id)
    const t = store.get(e.target.id)
    return `the ${e.type} relationship "${s ? displayLabel(s) : e.source.id}" → "${t ? displayLabel(t) : e.target.id}" (id=${e.id})`
  }
  return `"${displayLabel(e)}" (${e.type}, id=${e.id})`
}

/** The stock question for an entity, or for several. */
export function askAboutEntities(store: EntityStore, ids: EntityId[]) {
  const ents = ids.map((id) => store.get(id)).filter((e): e is AnyEntity => !!e)
  if (!ents.length) return
  if (ents.length === 1) {
    askAssistant(`Tell me about ${describeForAsk(store, ents[0])}: what it is, what it is connected to, and anything notable. Look it up first.`)
    return
  }
  const shown = ents.slice(0, 20).map((e) => `- ${describeForAsk(store, e)}`)
  const more = ents.length > 20 ? `\n- …and ${ents.length - 20} more (ids: ${ents.slice(20).map((e) => e.id).join(', ')})` : ''
  askAssistant(`Tell me about these ${ents.length} entities: what they have in common, how they are connected, and anything that stands out.\n${shown.join('\n')}${more}`)
}

/** The context-menu item: "Ask about this", or about the selection when the row is part of one. */
export function askItem(store: EntityStore, ids: EntityId[]): MenuItem {
  const n = ids.length
  return { kind: 'item', label: n > 1 ? `Ask about these ${n}` : 'Ask about this', icon: Sparkles, onSelect: () => askAboutEntities(store, ids) }
}
