import type { EntityStore, StoreEvent } from '../entity/store'
import type { EntityId } from '../entity/types'
import type { ProjectHistory } from './history'
import { isProjectEntity } from './project'
import { isVersioningType, versioningOf } from './versioning'

/**
 * Autosave: while a project with autosave on is open, a change to its data
 * starts (or restarts) a timer; when the tree has been quiet for the
 * project's `autosaveDelay`, the working changes are committed as one
 * "Autosave" commit. Leaving the page (hidden, unload) commits at once so
 * nothing waits on a timer that will never fire. Turning autosave off in
 * the project's settings leaves the changes uncommitted until the owner
 * commits them by hand.
 *
 * The timer runs per open project; switching projects cancels the pending
 * one for the old project after committing it (the epoch remount would
 * otherwise lose it).
 *
 * An autosave that fails (the history database refused the commit) is told
 * to `onFailure`, which the app puts on screen: the changes are still in the
 * Library, but not in the project's history, and the owner should know
 * before relying on it. The next autosave that lands tells it `null`.
 */
export interface AutosaveFailure {
  project: EntityId
  message: string
}

export function startAutosave(store: EntityStore, history: ProjectHistory, { onFailure }: { onFailure?: (failure: AutosaveFailure | null) => void } = {}): () => void {
  let failed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingFor: EntityId | null = null

  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const commitNow = (project: EntityId, reason: string) => {
    cancel()
    pendingFor = null
    const p = store.get(project)
    if (!isProjectEntity(p) || !versioningOf(p).autosave) return
    history
      .commit(project, 'Autosave', { auto: true })
      .then((c) => {
        if (c) console.info(`[aegraph] autosave · ${reason} · +${c.data.stats.added} ~${c.data.stats.modified} −${c.data.stats.removed}`)
        if (failed) (failed = false), onFailure?.(null)
      })
      .catch((err) => {
        console.warn('[aegraph] autosave failed:', err)
        failed = true
        onFailure?.({ project, message: err instanceof Error ? err.message : String(err) })
      })
  }

  const schedule = (project: EntityId) => {
    const p = store.get(project)
    if (!isProjectEntity(p)) return
    const settings = versioningOf(p)
    if (!settings.autosave) return
    if (pendingFor && pendingFor !== project) commitNow(pendingFor, 'project switched')
    pendingFor = project
    cancel()
    timer = setTimeout(() => commitNow(project, 'quiet'), settings.autosaveDelay * 1000)
  }

  /** Does the event touch tracked data, rather than commits, projects or bookkeeping? */
  const touchesTree = (ev: StoreEvent): boolean => {
    switch (ev.type) {
      case 'upsert':
        return !ev.volatile && ev.entities.some((e) => !isVersioningType(e.type))
      case 'remove':
        // Ids are all we have; removing a commit is rare enough to let the timer run and find nothing to commit.
        return true
      case 'reset':
        return false
      case 'batch':
        return ev.events.some(touchesTree)
      default:
        return false
    }
  }

  const unsubscribe = store.subscribe((ev) => {
    if (ev.type === 'scope' || (ev.type === 'batch' && ev.events.some((e) => e.type === 'scope'))) {
      // The old project's pending changes: commit before the app forgets about them.
      if (pendingFor && pendingFor !== store.scope) commitNow(pendingFor, 'project switched')
      return
    }
    const project = store.scope
    if (!project || !touchesTree(ev)) return
    schedule(project)
  })

  const flush = () => {
    if (pendingFor) commitNow(pendingFor, 'leaving the page')
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flush)

  return () => {
    unsubscribe()
    cancel()
    pendingFor = null
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush)
  }
}
