import { ArrowLeft, GitCommitHorizontal, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { PageHeader } from '../../../components/Layout/PageHeader'
import { ConfirmDialog } from '../../../components/ui/Dialog'
import { useToast } from '../../../components/ui/useToast'
import { displayLabel } from '../../../core/entity/entity'
import { useEntityStore } from '../../../core/entity/hooks'
import type { EntityId } from '../../../core/entity/types'
import { isProjectEntity } from '../../../core/projects/project'
import { shortId, type CommitEntity } from '../../../core/projects/versioning'
import { formatDate, formatNumber } from '../../../lib/format'
import { ChangeCounts, ChangeList, toChanges } from './ChangeList'
import { ProjectNav } from './ProjectNav'
import { useCommits, useCommitView, useProjectHistory } from './useHistory'
import '../Projects.css'
import './history.css'

/** `/projects/:id/history` — the commit log, newest first, by day; `/projects/:id/history/:commit` — one commit's diff. */
export function ProjectHistoryView({ id, commit }: { id: EntityId; commit?: EntityId }) {
  const store = useEntityStore()
  const project = store.get(id)
  if (!isProjectEntity(project)) return <div className="projects">No such project.</div>
  return commit ? <CommitPage project={id} projectLabel={displayLabel(project)} commitId={commit} /> : <CommitLog project={id} projectLabel={displayLabel(project)} />
}

function CommitLog({ project, projectLabel }: { project: EntityId; projectLabel: string }) {
  const commits = useCommits(project)
  const history = useProjectHistory()
  const toast = useToast()
  const [forgetting, setForgetting] = useState(false)
  const head = commits[0]
  // The same action as Project settings, on the page where a person looks for it. One behaviour, two doors: both
  // call history.forget, both say the same thing in the same words, and neither touches an entity.
  const forget = async () => {
    setForgetting(false)
    const n = await history.forget(project)
    toast(`Forgot ${formatNumber(n)} commit${n === 1 ? '' : 's'}. The project's entities are untouched.`)
  }
  const days = useMemo(() => {
    const groups: { day: string; items: CommitEntity[] }[] = []
    for (const c of commits) {
      // Local calendar day, so an evening commit does not land under the next UTC date.
      const day = new Date(c.data.at).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      const g = groups[groups.length - 1]
      if (g && g.day === day) g.items.push(c)
      else groups.push({ day, items: [c] })
    }
    return groups
  }, [commits])
  return (
    <div className="projects vh-page">
      <PageHeader
        title={projectLabel}
        subtitle={commits.length ? `${formatNumber(commits.length)} commit${commits.length === 1 ? '' : 's'} · HEAD ${shortId(head.id)} · ${formatNumber(head.data.size)} entities at HEAD` : 'No commits yet. Commit from the Changes tab, or let autosave make the first one.'}
        actions={
          <button className="btn btn--ghost btn--danger" disabled={!commits.length} onClick={() => setForgetting(true)} title="Delete every commit and its content. The project and its entities stay as they are.">
            Forget history…
          </button>
        }
      />
      <ProjectNav id={project} />
      <ConfirmDialog
        open={forgetting}
        title="Forget this project's history?"
        message={`${formatNumber(commits.length)} commit${commits.length === 1 ? '' : 's'} and their content are deleted. The project and its entities stay as they are; the next commit starts a fresh history.`}
        confirmLabel="Forget history"
        danger
        onConfirm={() => void forget()}
        onCancel={() => setForgetting(false)}
      />
      {days.map((g) => (
        <section key={g.day} className="vh-day">
          <h3 className="vh-day__head">{g.day}</h3>
          <ol className="vh-log">
            {g.items.map((c) => (
              <li key={c.id} className={`vh-commit ${c.data.auto ? 'is-auto' : ''}`}>
                <div className="vh-commit__main">
                  <Link className="vh-commit__msg" to={`/projects/${encodeURIComponent(project)}/history/${encodeURIComponent(c.id)}`}>
                    {c.data.message}
                  </Link>
                  <div className="vh-commit__meta">
                    {c.data.auto ? 'autosave' : (c.meta.createdBy ?? 'you')} · {formatDate(c.data.at)}
                    {c.data.restoredFrom && (
                      <>
                        {' '}
                        · restores <Link to={`/projects/${encodeURIComponent(project)}/history/${encodeURIComponent(c.data.restoredFrom)}`}>{shortId(c.data.restoredFrom)}</Link>
                      </>
                    )}
                    {c.id === head?.id && <span className="badge badge--ok vh-commit__head">HEAD</span>}
                  </div>
                </div>
                <ChangeCounts added={c.data.stats.added} modified={c.data.stats.modified} removed={c.data.stats.removed} />
                <Link className="vh-commit__sha" to={`/projects/${encodeURIComponent(project)}/history/${encodeURIComponent(c.id)}`} title={c.id}>
                  {shortId(c.id)}
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}

function CommitPage({ project, projectLabel, commitId }: { project: EntityId; projectLabel: string; commitId: EntityId }) {
  const history = useProjectHistory()
  const navigate = useNavigate()
  const toast = useToast()
  const commits = useCommits(project)
  const { view, error } = useCommitView(commitId)
  const [restoring, setRestoring] = useState(false)
  const [busy, setBusy] = useState(false)
  const commit = view?.commit ?? commits.find((c) => c.id === commitId)
  const isHead = commits[0]?.id === commitId
  const list = useMemo(() => (view ? toChanges({ added: view.added, modified: view.modified, removed: view.removed }) : []), [view])
  const restore = async () => {
    setRestoring(false)
    setBusy(true)
    try {
      // What has not been committed is committed first, so the current state really is in the history — as the dialog
      // says, and as the assistant's restore does. Without it, up to the autosave delay's work (or everything since the
      // last commit, with autosave off) was overwritten and gone.
      const unsaved = (await history.count(project)).total
      const saved = unsaved ? await history.commit(project, `Before restoring ${shortId(commitId)}`) : undefined
      const r = await history.restore(project, commitId)
      const kept = saved ? ` · your ${formatNumber(unsaved)} unsaved change${unsaved === 1 ? '' : 's'} kept as ${shortId(saved.id)}` : ''
      toast(r.commit ? `Restored ${shortId(commitId)} as ${shortId(r.commit.id)} · ${formatNumber(r.upserted)} put back, ${formatNumber(r.removed + r.unmarked)} taken out${kept}` : 'The project already matches that commit.')
      navigate(`/projects/${encodeURIComponent(project)}/history`)
    } catch (err) {
      toast(`Could not restore: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="projects vh-page">
      <PageHeader
        title={
          <span className="vh-title">
            <GitCommitHorizontal size={18} /> {commit?.data.message ?? shortId(commitId)}
          </span>
        }
        subtitle={commit ? `${projectLabel} · ${shortId(commit.id)} · ${commit.data.auto ? 'autosave' : (commit.meta.createdBy ?? 'you')} · ${formatDate(commit.data.at)} · ${formatNumber(commit.data.size)} entities after it${commit.data.parent ? '' : ' · first commit'}` : projectLabel}
        actions={
          <>
            <Link className="btn" to={`/projects/${encodeURIComponent(project)}/history`}>
              <ArrowLeft size={14} /> History
            </Link>
            {commit?.data.parent && (
              <Link className="btn" to={`/projects/${encodeURIComponent(project)}/history/${encodeURIComponent(commit.data.parent)}`}>
                Parent {shortId(commit.data.parent)}
              </Link>
            )}
            <button className="btn" disabled={busy || isHead || !view || view.missing} onClick={() => setRestoring(true)} title={isHead ? 'This is HEAD already' : 'Make the project what it was after this commit — recorded as a new commit'}>
              <RotateCcw size={14} /> Restore this version…
            </button>
          </>
        }
      />
      <ProjectNav id={project} />
      {commit && <ChangeCounts added={commit.data.stats.added} modified={commit.data.stats.modified} removed={commit.data.stats.removed} className="vh-page__counts" />}
      {error && <p className="vh-warn">{error}</p>}
      {view?.missing && <p className="vh-warn">This commit's content is not on this device (its blob is missing from the history store); only its message and counts are known.</p>}
      {!view && !error ? <p className="vh-empty">Loading the commit…</p> : <ChangeList changes={list} emptyText="This commit changed nothing." />}
      <ConfirmDialog open={restoring} title={`Restore “${commit?.data.message ?? shortId(commitId)}”?`} message="The project is put back the way it was after this commit: edits since are undone, entities added since are taken out (deleted when they are in no other project), entities removed since come back. Changes not yet committed are committed first, and the step is recorded as a new commit, so the current state stays in the history and can be restored in turn." confirmLabel="Restore" onConfirm={() => void restore()} onCancel={() => setRestoring(false)} />
    </div>
  )
}
