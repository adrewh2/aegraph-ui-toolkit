import { HOSTS, type HostName } from './hosts'
import { WorkstationView } from './WorkstationView'

/**
 * A section of the app as a pane host: its list as a tab that stays at the front (the default, never closed), and
 * whatever is opened from the list — a document, an image, a map, a type — as a tab of its own beside it, to close
 * when done with. Split and dragged like any pane's tabs; the address bar follows the tab in front.
 */
export function SectionHost({ name }: { name: HostName }) {
  const def = HOSTS[name]
  // Keyed by the section: two sections on one kept page (Scripts, Datasets and Charts share `/analytics`) are two hosts, never one reused.
  return <WorkstationView key={def.key} storageKey={def.key} initialWorkstation={def.initial} chrome="tabs" syncUrl={def.keeps} lists={def.lists} />
}
