import { useEffect, useMemo, useState } from 'react'
import { useEntityStore, useStoreDataVersion, useStoreVersion } from '../../../core/entity/hooks'
import type { EntityId } from '../../../core/entity/types'
import { getProjectHistory, type CommitView, type WorkingChanges } from '../../../core/projects/history'
import { isProjectEntity } from '../../../core/projects/project'
import { listCommits, type CommitEntity } from '../../../core/projects/versioning'

/** The store's history service. */
export function useProjectHistory() {
  const store = useEntityStore()
  return useMemo(() => getProjectHistory(store), [store])
}

/** A project's commits, newest first, live. */
export function useCommits(project: EntityId | null): CommitEntity[] {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (project ? listCommits(store, project) : []), [store, project, version])
}

/**
 * The working tree against HEAD, recomputed a moment after the store
 * changes (hashing is cached per entity object, so the recompute is a walk
 * of the scope, not a re-serialisation). `null` until the first result.
 */
export function useWorkingChanges(project: EntityId | null, { delay = 300 }: { delay?: number } = {}): { changes: WorkingChanges | null; error: string | null; refresh: () => void } {
  const store = useEntityStore()
  const history = useProjectHistory()
  const version = useStoreVersion(store)
  const [state, setState] = useState<{ project: EntityId; changes: WorkingChanges | null; error: string | null } | null>(null)
  const [tick, setTick] = useState(0)
  const valid = !!project && isProjectEntity(store.get(project))
  useEffect(() => {
    if (!valid) return
    let cancelled = false
    const t = setTimeout(() => {
      history
        .changes(project)
        .then((changes) => !cancelled && setState({ project, changes, error: null }))
        .catch((err) => !cancelled && setState({ project, changes: null, error: err instanceof Error ? err.message : String(err) }))
    }, delay)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [history, project, valid, version, tick, delay])
  // A result for another project is stale the moment the id changes.
  const current = valid && state && state.project === project ? state : null
  return { changes: current?.changes ?? null, error: current?.error ?? null, refresh: () => setTick((n) => n + 1) }
}

/**
 * Just the number of unsaved changes, for a badge. Same cadence as `useWorkingChanges`, but on the data version: a
 * bookkeeping write (a map's saved view) is not a change autosave would wake for, and the diff walks the whole project.
 */
export function useChangeCount(project: EntityId | null): number | null {
  const store = useEntityStore()
  const history = useProjectHistory()
  const version = useStoreDataVersion(store)
  const [n, setN] = useState<{ project: EntityId; total: number } | null>(null)
  const valid = !!project && isProjectEntity(store.get(project))
  useEffect(() => {
    if (!valid) return
    let cancelled = false
    const run = () =>
      history
        .count(project)
        .then((c) => !cancelled && setN({ project, total: c.total }))
        .catch(() => !cancelled && setN(null))
    // The first count of a project is a diff of all of it (0.8 s on the million-entity atlas), and it came due in the
    // middle of the first picture; it waits for the page to be idle (15 s at most). The counts after it re-place only
    // what changed.
    const first = !history.hasCount(project)
    const t = first && typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 15000 }) : setTimeout(run, 500)
    return () => {
      cancelled = true
      if (first && typeof cancelIdleCallback === 'function') cancelIdleCallback(t as number)
      else clearTimeout(t as ReturnType<typeof setTimeout>)
    }
  }, [history, project, valid, version])
  return valid && n && n.project === project ? n.total : null
}

/** One commit's content, loaded once (a commit's content never changes; it reloads only if the commit comes or goes). */
export function useCommitView(commitId: EntityId | null): { view: CommitView | null; error: string | null } {
  const history = useProjectHistory()
  const store = useEntityStore()
  useStoreVersion(store)
  const exists = !!commitId && store.has(commitId)
  const [state, setState] = useState<{ view: CommitView | null; error: string | null }>({ view: null, error: null })
  useEffect(() => {
    if (!commitId || !exists) return
    let cancelled = false
    history
      .view(commitId)
      .then((view) => !cancelled && setState({ view, error: null }))
      .catch((err) => !cancelled && setState({ view: null, error: err instanceof Error ? err.message : String(err) }))
    return () => {
      cancelled = true
    }
  }, [history, commitId, exists])
  if (!commitId || !exists) return { view: null, error: commitId ? 'No such commit.' : null }
  return state.view && state.view.commit.id !== commitId ? { view: null, error: null } : state
}
