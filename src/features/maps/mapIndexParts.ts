import { Globe2, PenLine, Trash2 } from 'lucide-react'
import type { MenuItem } from '../../components/ui/Menu'
import type { EntityId } from '../../core/entity/types'
import type { MapEntity } from './maps'

/** The index of maps' pieces that are not components: a map's menu, its counts, and the new-map handshake. */

/** What a map has on it and pinned to it. */
export interface MapCounts {
  n: number
  notes: number
}

/** Maps made by `/maps/new` and not yet named: the map page asks on its first look at one. */
export const unnamed = new Set<EntityId>()

/** The index's context menu, shared with the map page's picker. */
export function mapMenuItems(m: MapEntity, on: { open: (id: EntityId, globe?: boolean) => void; rename: (m: MapEntity) => void; remove: (m: MapEntity) => void; more?: MenuItem[] }): MenuItem[] {
  return [
    { kind: 'item', label: 'Open', onSelect: () => on.open(m.id) },
    { kind: 'item', label: 'Open on the globe', icon: Globe2, onSelect: () => on.open(m.id, true) },
    { kind: 'item', label: 'Rename…', icon: PenLine, onSelect: () => on.rename(m) },
    ...(on.more ?? []),
    { kind: 'sep' },
    { kind: 'item', label: 'Delete…', icon: Trash2, danger: true, onSelect: () => on.remove(m) },
  ]
}
