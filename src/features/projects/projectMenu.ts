import { FolderMinus, FolderPlus } from 'lucide-react'
import type { MenuItem } from '../../components/ui/Menu'
import { displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import type { EntityId } from '../../core/entity/types'
import { listProjects } from '../../core/projects/project'

/**
 * "Add to / Remove from <project>" for a set of entities — the row menu and
 * the selection bar share it. A project the whole set is already in offers
 * removal; any other offers adding.
 */
export function projectMenuItems(store: EntityStore, ids: EntityId[], toast: (m: string) => void): MenuItem[] {
  const projects = listProjects(store)
  if (!projects.length) return [{ kind: 'item', label: 'No projects yet — create one in the sidebar', disabled: true, onSelect: () => {} }]
  const n = ids.length
  const suffix = n > 1 ? ` · ${n}` : ''
  return projects.map<MenuItem>((p) => {
    const inAll = ids.every((id) => store.projectsOf(id).includes(p.id))
    return inAll
      ? { kind: 'item', label: `Remove from ${displayLabel(p)}${suffix}`, icon: FolderMinus, onSelect: () => toast(`Removed ${store.unmark(ids, p.id)} from “${displayLabel(p)}”`) }
      : { kind: 'item', label: `Add to ${displayLabel(p)}${suffix}`, icon: FolderPlus, onSelect: () => toast(`Added ${store.mark(ids, p.id)} to “${displayLabel(p)}”`) }
  })
}
