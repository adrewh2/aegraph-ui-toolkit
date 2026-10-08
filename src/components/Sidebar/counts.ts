import type { EntityStore } from '../../core/entity/store'
import { CONVERSATION_TYPE } from '../../features/conversations/conversation'
import { chatEntityId } from '../../features/assistant/chatIds'
import { RESOURCE_TYPES } from '../../core/resources/types'
import { SAVED_KINDS } from '../../features/analytics/kinds'

/**
 * How many of each kind the sidebar has to show beside its rows — the
 * resources, and what Analytics keeps: scenes, scripts, datasets, charts.
 * Counted through `countOfType`, which reads the store's id index without
 * building an array of entities, and through the open project's scope, so
 * the number agrees with the page the row opens rather than with the whole
 * Library. A kind with nothing in it shows nothing at all: a column of
 * zeroes says less than a blank.
 */
export const RESOURCE_ROUTES: Record<string, string[]> = {
  '/documents': [RESOURCE_TYPES.document],
  '/diagrams': [RESOURCE_TYPES.diagram],
  '/images': [RESOURCE_TYPES.image],
  '/videos': [RESOURCE_TYPES.video],
  '/audio': [RESOURCE_TYPES.audio],
  '/maps': ['map'],
}

/**
 * What each Analytics row lists, taken from the pages' own description of
 * themselves (`features/analytics/kinds.ts`), so the number beside a row is
 * the number of things the page it opens will show — the scene family, every
 * kind of script, the datasets, the charts.
 */
export const ANALYTICS_ROUTES: Record<string, string[]> = Object.fromEntries(SAVED_KINDS.map((k) => [k.route, [...k.family]]))

export interface SidebarCounts {
  /** Route → how many, only where there are any. */
  byRoute: Record<string, number>
  /** Every resource above, together: what the Resources group carries. */
  resources: number
  /** The same for the Analytics group. */
  analytics: number
}

/**
 * The rows that are whole pages of their own, each read in constant time: **Entities** is the open project's entity
 * count (relationships aside), which the store keeps as it goes; **Chats** is what the Chats page lists — the open
 * project's recorded or imported conversations (the scoped id index's size) and its open chats not yet recorded (a chat
 * is written as its conversation a second after it changes; one that has been is not counted twice). `openChats` is
 * the open chats' ids with their projects, one per line (`useOpenChatIds`): at most a dozen lookups.
 */
function pageCounts(store: Pick<EntityStore, 'entityCount' | 'get' | 'countOfType' | 'scope'>, openChats: string, byRoute: Record<string, number>) {
  const entities = store.entityCount()
  if (entities > 0) byRoute['/entities'] = entities
  // The open project's conversations (every one, in the Library), and its open chats not yet recorded.
  let chats = store.countOfType(CONVERSATION_TYPE)
  const scope = store.scope
  if (openChats)
    for (const line of openChats.split('\n')) {
      const [id, project = ''] = line.split('\t')
      if (scope && project !== scope) continue
      if (store.get(chatEntityId(id))?.type !== CONVERSATION_TYPE) chats++
    }
  if (chats > 0) byRoute['/chats'] = chats
}

export function sidebarCounts(store: Pick<EntityStore, 'countOfType' | 'entityCount' | 'get' | 'scope'>, openChats = ''): SidebarCounts {
  const byRoute: Record<string, number> = {}
  pageCounts(store, openChats, byRoute)
  const group = (routes: Record<string, string[]>) => {
    let total = 0
    for (const [route, types] of Object.entries(routes)) {
      let n = 0
      for (const type of types) n += store.countOfType(type)
      total += n
      if (n > 0) byRoute[route] = n
    }
    return total
  }
  const resources = group(RESOURCE_ROUTES)
  const analytics = group(ANALYTICS_ROUTES)
  return { byRoute, resources, analytics }
}
