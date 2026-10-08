import { HOSTS } from '../workstation/hosts'
import { WorkstationView } from '../workstation/WorkstationView'

/**
 * `/unigraph`: the graph explorer — the sidebar's Unigraph page. A pane host whose
 * tabs are Unigraph sessions in 2D (`/unigraph/2d`) or 3D (`/unigraph/3d`),
 * each with its own filter, layout and selection, drawn by the engine.
 */
export function UnigraphWorkspace() {
  return <WorkstationView storageKey={HOSTS.unigraph.key} initialWorkstation={HOSTS.unigraph.initial} chrome="tabs" syncUrl={(p) => p.startsWith('/unigraph')} newTabWhen={(p) => /[?&](setup|fresh)=/.test(p)} views={['unigraph2d', 'unigraph3d']} />
}
