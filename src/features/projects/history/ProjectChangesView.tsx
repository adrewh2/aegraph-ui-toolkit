import { GitCommitHorizontal, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../../../components/Layout/PageHeader'
import { ConfirmDialog } from '../../../components/ui/Dialog'
import { useToast } from '../../../components/ui/useToast'
import { displayLabel } from '../../../core/entity/entity'
import { useEntityStore } from '../../../core/entity/hooks'
import type { EntityId } from '../../../core/entity/types'
import { useProjects } from '../../../core/projects/hooks'
import { isProjectEntity } from '../../../core/projects/project'
import { shortId, versioningOf } from '../../../core/projects/versioning'
import { formatDate, formatNumber } from '../../../lib/format'
import { ChangeCounts, ChangeList, changeId, toChanges, type EntityChange } from './ChangeList'
import { ProjectNav } from './ProjectNav'
import { useProjectHistory, useWorkingChanges } from './useHistory'
import '../Projects.css'
import './history.css'

/**
 * `/projects/:id/changes` — what the project holds now against its last
 * commit: the entities added, modified (property by property) and removed.
 * Commit them with a message, revert one, or discard them all.
 */
export function ProjectChangesView({ id }: { id: EntityId }) {
  const store = useEntityStore()
  const history = useProjectHistory()
  const { activeId } = useProjects()
  const toast = useToast()
  const { changes, error, refresh } = useWorkingChanges(id)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const project = store.get(id)
  const list = useMemo(() => (changes ? toChanges({ added: changes.added, modified: changes.modified.map((e) => ({ before: changes.before.get(e.id), after: e })), removed: changes.removed }) : []), [changes])
  if (!isProjectEntity(project)) return <div className="projects">No such project.</div>
  const settings = versioningOf(project)
  const total = list.length
  const head = changes?.head

  const commit = async () => {
    setBusy(true)
    try {
      const c = await history.commit(id, message)
      if (!c) toast('Nothing to commit.')
      else {
        toast(`Committed ${shortId(c.id)} · +${c.data.stats.added} ~${c.data.stats.modified} −${c.data.stats.removed}`)
        setMessage('')
      }
      refresh()
    } catch (err) {
      toast(`Could not commit: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }
  const revert = async (c: EntityChange) => {
    try {
      const r = await history.revertEntity(id, changeId(c))
      toast(r === 'restored' ? 'Put back the committed version' : r === 'removed' ? 'Deleted (it was in no other project)' : r === 'unmarked' ? 'Taken out of the project (it stays in the Library)' : 'Already as committed')
      refresh()
    } catch (err) {
      toast(`Could not revert: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const discard = async () => {
    setDiscarding(false)
    if (!head) return
    setBusy(true)
    try {
      const r = await history.restore(id, head.id, { message: 'Discard changes' })
      toast(`Discarded · ${formatNumber(r.upserted)} put back, ${formatNumber(r.removed + r.unmarked)} taken out${r.skipped ? `, ${r.skipped} from included projects left alone` : ''}`)
      refresh()
    } catch (err) {
      toast(`Could not discard: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="projects vh-page">
      <PageHeader
        title={displayLabel(project)}
        subtitle={
          head ? (
            <>
              Last commit <Link to={`/projects/${encodeURIComponent(id)}/history/${encodeURIComponent(head.id)}`}>{shortId(head.id)}</Link> “{head.data.message}” · {formatDate(head.data.at)} · {settings.autosave ? `autosave on (${settings.autosaveDelay}s after the last change)` : 'autosave off'}
            </>
          ) : (
            'No commits yet — the first commit records everything in the project.'
          )
        }
        actions={
          <>
            {activeId !== id && (
              <span className="vh-hint" title="Changes are computed for any project; edits happen in the open one.">
                not the open project
              </span>
            )}
            <button className="btn" disabled={busy || !head || total === 0} onClick={() => setDiscarding(true)} title="Put the project back the way the last commit has it. The unsaved changes are lost.">
              <RotateCcw size={14} /> Discard all…
            </button>
          </>
        }
      />
      <ProjectNav id={id} />
      <div className="vh-commitbar">
        <input
          className="input"
          placeholder={total ? `Describe ${formatNumber(total)} change${total === 1 ? '' : 's'}…` : 'Nothing to commit'}
          value={message}
          disabled={busy || total === 0}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && total > 0 && void commit()}
        />
        <button className="btn btn--primary" disabled={busy || total === 0} onClick={() => void commit()}>
          <GitCommitHorizontal size={14} /> {busy ? 'Working…' : `Commit${total ? ` ${formatNumber(total)}` : ''}`}
        </button>
        {changes && <ChangeCounts added={changes.added.length} modified={changes.modified.length} removed={changes.removed.length} className="vh-commitbar__counts" />}
      </div>
      {changes?.missing ? <p className="vh-warn">{changes.missing} commit{changes.missing === 1 ? '' : 's'} in this project's history have no content on this device, so the comparison is against what is known. Commit once to start a complete history from here.</p> : null}
      {error && <p className="vh-warn">{error}</p>}
      {!changes && !error ? (
        <p className="vh-empty">Comparing with the last commit…</p>
      ) : (
        <ChangeList changes={list} resolveBefore={(eid) => history.entityAt(head?.id ?? null, eid)} onRevert={head ? revert : undefined} emptyText={head ? 'Everything is committed. Edits made from here on show up as unsaved changes.' : 'The project is empty.'} />
      )}
      <ConfirmDialog open={discarding} title="Discard all unsaved changes?" message={`${formatNumber(total)} change${total === 1 ? '' : 's'} since “${head?.data.message ?? ''}” will be undone: edits put back, added entities taken out of the project (deleted when in no other project), removed ones restored. Unlike restoring an older commit, this leaves no trace: the changes are gone. Commit them first if you might want them back.`} confirmLabel="Discard changes" danger onConfirm={() => void discard()} onCancel={() => setDiscarding(false)} />
    </div>
  )
}
