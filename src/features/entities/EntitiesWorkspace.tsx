import { HOSTS } from '../workstation/hosts'
import { WorkstationView } from '../workstation/WorkstationView'

/**
 * `/entities` at the top level: the Entities browser inside a pane host, so
 * a filtered view (related entities, a pick from a plot) opens as another
 * tab beside the one you came from instead of replacing it. Splitting and
 * dragging tabs work like the workstation; the address bar follows the
 * active tab.
 */
export function EntitiesWorkspace() {
  return <WorkstationView storageKey={HOSTS.entities.key} initialWorkstation={HOSTS.entities.initial} chrome="tabs" syncUrl={(p) => p.startsWith('/entities')} newTabWhen={(p) => /[?&]pick=/.test(p)} />
}

