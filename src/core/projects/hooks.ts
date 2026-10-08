import { useSyncExternalStore } from 'react'
import { useEntityStore, useStoreVersion } from '../entity/hooks'
import { projectEpoch } from './active'
import { isProjectEntity, listProjects, type ProjectEntity } from './project'

/** The active project (null = Library) and every project, live. */
export function useProjects(): { activeId: string | null; active: ProjectEntity | null; projects: ProjectEntity[] } {
  const store = useEntityStore()
  useStoreVersion(store)
  const activeId = store.scope
  const e = activeId ? store.get(activeId) : undefined
  return { activeId, active: isProjectEntity(e) ? e : null, projects: listProjects(store) }
}

/** Changes whenever the active project changes; key the app on it so pages re-read their state. */
export function useProjectEpoch(): number {
  return useSyncExternalStore(projectEpoch.subscribe, projectEpoch.get, projectEpoch.get)
}
