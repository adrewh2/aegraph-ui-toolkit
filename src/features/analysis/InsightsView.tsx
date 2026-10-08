import { BarChart3, Bookmark, BookmarkCheck, ChevronDown, ChevronRight, Play, RefreshCw, Sparkles, Table2, Users, Waypoints } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/Layout/PageHeader'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import { datasetGraph } from '../../core/graph/dataset'
import { ANALYSES, analysisInfo, type AnalysisId, type Finding, type Report } from '../../analysis/types'
import { entityHref } from '../../app/routes'
import { browserHref } from '../../app/openIn'
import { askAssistant } from '../assistant/ask'
import { claimFor, communityMembers, saveFindingAsClaim } from '../knowledge/claims'
import { requestNameCommunity } from '../knowledge/nameCommunity'
import { useLatestAnalysis } from './latest'
import { showFinding } from './materialize'
import { cancelInsights, runInsights } from './runInsights'
import { scrollBehavior } from '../../lib/motion'
import './insights.css'

/**
 * Insights: the analytics harness as a page. Run the five analyses over the
 * open dataset, read the findings best first, and put any of them on screen
 * as a plot, a styled graph, or a table.
 */
export function InsightsView() {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const { latest, running, error } = useLatestAnalysis()
  const [which, setWhich] = useState<Set<AnalysisId>>(() => new Set(ANALYSES.map((a) => a.id)))
  const report = latest?.report ?? null
  const wanted = params.get('finding')
  const [open, setOpen] = useState<string | null>(wanted)
  const scopeLabel = store.scope ? displayLabel(store.get(store.scope)!) : 'the Library'
  const version = useStoreVersion(store)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const counts = useMemo(() => { const g = datasetGraph(store, registry); return { nodes: g.nodes.length, edges: g.edges.length } }, [store, registry, version])
  const stale = report ? report.nodes !== counts.nodes || report.edges !== counts.edges : false

  const run = useCallback(
    (force = false) => {
      runInsights(store, registry, [...which], {}, { force }).catch((e) => {
        if ((e as Error).name !== 'AbortError') toast(`Analysis failed: ${e instanceof Error ? e.message : String(e)}`)
      })
    },
    [store, registry, which, toast],
  )

  const show = useCallback(
    async (f: Finding) => {
      if (f.visual?.kind === 'table' || !f.visual) {
        setOpen(f.id)
        return
      }
      try {
        await showFinding(f, { store, navigate })
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e))
      }
    },
    [store, navigate, toast],
  )

  // A deep link to a finding scrolls to it once the report is there.
  const scrolled = useRef<string | null>(null)
  useEffect(() => {
    if (!wanted || !report || scrolled.current === wanted) return
    scrolled.current = wanted
    setOpen(wanted)
    requestAnimationFrame(() => document.getElementById(`finding-${wanted}`)?.scrollIntoView({ block: 'center', behavior: scrollBehavior() }))
  }, [wanted, report])

  const toggle = (id: AnalysisId) =>
    setWhich((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n.size ? n : s
    })

  const progress = running ? `${stageLabel(running.stage)}${running.total > 1 ? ` · ${Math.round((running.done / running.total) * 100)}%` : ''}` : null

  return (
    <div className="ins">
      <PageHeader
        title="Insights"
        subtitle={`Five analyses over ${scopeLabel}, ranked by how much they stand out. Ask the assistant to “show me interesting things about this dataset” for the same run, narrated.`}
        actions={
          running ? (
            <button className="btn" onClick={cancelInsights}>
              Cancel · {progress}
            </button>
          ) : (
            <button className="btn btn--primary" onClick={() => run(!!report)} disabled={!counts.nodes}>
              {report ? <RefreshCw size={14} /> : <Play size={14} />} {report ? 'Run again' : 'Run analyses'}
            </button>
          )
        }
      />
      <div className="ins__picks">
        {ANALYSES.map((a) => (
          <label key={a.id} className={`ins__pick ${which.has(a.id) ? 'is-on' : ''}`} title={a.question}>
            <input type="checkbox" checked={which.has(a.id)} onChange={() => toggle(a.id)} />
            {a.label}
          </label>
        ))}
        {report && (
          <span className="muted ins__meta">
            {report.nodes.toLocaleString()} entities · {report.edges.toLocaleString()} relationships · {(report.ms / 1000).toFixed(1)} s · {new Date(report.computedAt).toLocaleTimeString()}
            {stale ? ' · the dataset has changed since' : ''}
          </span>
        )}
      </div>
      {error && <div className="ins__error">{error}</div>}
      {!report ? (
        <EmptyState running={!!running} progress={progress} onRun={() => run()} canRun={!!counts.nodes} />
      ) : (
        <ReportView report={report} open={open} setOpen={(id) => { setOpen(id); if (params.get('finding')) setParams({}, { replace: true }) }} show={show} entityLabel={(id) => { const e = store.get(id); return e ? displayLabel(e) : id }} entityLink={(id) => { const e = store.get(id); return e ? entityHref(e, registry) : undefined }} />
      )}
    </div>
  )
}

function EmptyState({ running, progress, onRun, canRun }: { running: boolean; progress: string | null; onRun: () => void; canRun: boolean }) {
  return (
    <div className="ins__empty">
      <div className="ins__catalog">
        {ANALYSES.map((a) => (
          <div key={a.id} className="ins__card">
            <h3>{a.label}</h3>
            <p className="ins__question">{a.question}</p>
            <p className="muted">{a.description}</p>
          </div>
        ))}
      </div>
      <div className="ins__cta">
        {running ? (
          <span className="muted">
            <Sparkles size={14} /> Analysing… {progress}
          </span>
        ) : (
          <button className="btn btn--primary" onClick={onRun} disabled={!canRun}>
            <Play size={14} /> Run analyses
          </button>
        )}
        {!canRun && <span className="muted">Load a dataset first.</span>}
      </div>
    </div>
  )
}

function ReportView({ report, open, setOpen, show, entityLabel, entityLink }: { report: Report; open: string | null; setOpen: (id: string | null) => void; show: (f: Finding) => void; entityLabel: (id: string) => string; entityLink: (id: string) => string | undefined }) {
  const top = useMemo(() => report.findings.slice(0, 5), [report])
  const row = (f: Finding, rank?: number) => <FindingRow key={f.id} f={f} rank={rank} open={open === f.id} onToggle={() => setOpen(open === f.id ? null : f.id)} onShow={() => show(f)} entityLabel={entityLabel} entityLink={entityLink} />
  return (
    <>
      {top.length > 0 && (
        <section className="ins__section">
          <h2>
            <Sparkles size={15} /> Most interesting
          </h2>
          <div className="ins__list">{top.map((f, i) => row(f, i + 1))}</div>
        </section>
      )}
      {report.runs.map((r) => {
        const info = analysisInfo(r.id)
        return (
          <section key={r.id} className="ins__section">
            <h2>{info.label}</h2>
            <p className="ins__question">{info.question}</p>
            {r.findings.length ? <div className="ins__list">{r.findings.map((f) => row(f))}</div> : <p className="muted">{r.note ?? 'Nothing stood out.'}</p>}
          </section>
        )
      })}
    </>
  )
}

/** The stock question for a finding: what it says, the entities behind it, and where to look next. */
function askAboutFinding(f: Finding, entityLabel: (id: string) => string) {
  const ents = (f.entities ?? []).slice(0, 15).map((id) => `- ${entityLabel(id)} (id=${id})`)
  const more = (f.entities?.length ?? 0) > 15 ? `\n- …and ${f.entities!.length - 15} more` : ''
  askAssistant(`Explain this finding from the Insights run (${analysisInfo(f.analysis).label}): "${f.title}" — ${f.detail}${ents.length ? `\nEntities involved:\n${ents.join('\n')}${more}` : ''}\nWhat does it mean for this dataset, and what should I look at next? Show it in the graph or a chart if that helps.`)
}

/** A community as a finding describes it (see `brief` in the communities analysis). */
interface CommunityBrief {
  id: number
  label: string
  size: number
  types?: string[]
  tags?: string[]
}

/** The communities a finding's rows describe, in the order they appear. */
function communitiesIn(f: Finding): CommunityBrief[] {
  if (f.analysis !== 'communities' || !f.data) return []
  const out = new Map<number, CommunityBrief>()
  const take = (v: unknown) => {
    if (v && typeof v === 'object' && typeof (v as CommunityBrief).id === 'number' && typeof (v as CommunityBrief).label === 'string' && !out.has((v as CommunityBrief).id)) out.set((v as CommunityBrief).id, v as CommunityBrief)
  }
  for (const v of Object.values(f.data)) {
    if (Array.isArray(v)) v.forEach(take)
    else take(v)
  }
  return [...out.values()]
}

function FindingRow({ f, rank, open, onToggle, onShow, entityLabel, entityLink }: { f: Finding; rank?: number; open: boolean; onToggle: () => void; onShow: () => void; entityLabel: (id: string) => string; entityLink: (id: string) => string | undefined }) {
  const navigate = useNavigate()
  const store = useEntityStore()
  const toast = useToast()
  const version = useStoreVersion(store)
  const { latest } = useLatestAnalysis()
  const v = f.visual
  const Icon = v?.kind === 'plot' ? BarChart3 : v?.kind === 'graph' ? Waypoints : Table2
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const claim = useMemo(() => claimFor(store, f), [store, f, version])
  const communities = useMemo(() => communitiesIn(f), [f])
  const saveClaim = () => {
    if (!latest) return
    const r = saveFindingAsClaim(store, f, latest.report, analysisInfo(f.analysis).label)
    toast(r.created ? `Saved as a claim${r.evidence ? ` with ${r.evidence} supporting entit${r.evidence === 1 ? 'y' : 'ies'}` : ''}` : 'Claim updated')
  }
  const name = (c: CommunityBrief) => {
    if (!latest) return
    const members = communityMembers(latest.metrics, c.id)
    if (!members.length) {
      toast('This run no longer has the community’s members — run the analyses again')
      return
    }
    requestNameCommunity({ community: c.id, metricsKey: latest.metrics.sliceKey, members, suggested: c.label, profile: [c.types?.slice(0, 2).join(', '), c.tags?.length ? `#${c.tags.slice(0, 2).join(' #')}` : ''].filter(Boolean).join(' · ') })
  }
  return (
    <article id={`finding-${f.id}`} className={`ins__finding ${open ? 'is-open' : ''}`}>
      <button className="ins__toggle" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      <div className="ins__body">
        <div className="ins__head">
          {rank && <span className="ins__rank">{rank}</span>}
          <h3 className="ins__title">{f.title}</h3>
          <span className="ins__score" title={`Interestingness ${(f.score * 100).toFixed(0)}%`}>
            <span style={{ width: `${Math.round(f.score * 100)}%` }} />
          </span>
        </div>
        <p className="ins__detail">{f.detail}</p>
        {open && (
          <div className="ins__more">
            {f.entities?.length ? (
              <div className="ins__entities">
                {f.entities.slice(0, 12).map((id) => {
                  const href = entityLink(id)
                  return href ? (
                    <a key={id} className="chip" href={href} onClick={(e) => { e.preventDefault(); navigate(href) }}>
                      {entityLabel(id)}
                    </a>
                  ) : (
                    <span key={id} className="chip">{entityLabel(id)}</span>
                  )
                })}
                {f.entities.length > 12 && <span className="muted">+{f.entities.length - 12} more</span>}
              </div>
            ) : null}
            {communities.length > 0 && (
              <div className="ins__entities">
                <span className="muted" style={{ fontSize: 12 }}>Name a community:</span>
                {communities.slice(0, 8).map((c) => (
                  <button key={c.id} className="chip" onClick={() => name(c)} title={`Make “${c.label}” (${c.size.toLocaleString()} members) an entity its members belong to`}>
                    <Users size={11} /> {c.label.replace(/^["“](.*?)["”]/, '$1')} · {c.size.toLocaleString()}
                  </button>
                ))}
              </div>
            )}
            {v?.kind === 'table' && (
              <div className="ins__table">
                <table>
                  <thead>
                    <tr>
                      {v.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {v.rows.map((r, i) => (
                      <tr key={i}>
                        {r.map((c, j) => (
                          <td key={j} className={typeof c === 'number' ? 'num' : ''}>
                            {typeof c === 'number' ? c.toLocaleString() : c}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="ins__actions">
        {claim ? (
          <button className="btn btn--sm" onClick={() => navigate(browserHref(claim))} title="Saved as a claim — open it">
            <BookmarkCheck size={13} /> Claim
          </button>
        ) : (
          <button className="btn btn--sm" onClick={saveClaim} title="Keep this finding as a claim entity, with the entities it names as its evidence">
            <Bookmark size={13} /> Save as claim
          </button>
        )}
        <button className="btn btn--sm" onClick={() => askAboutFinding(f, entityLabel)} title="Ask the assistant to explain this finding and what to look at next">
          <Sparkles size={13} /> Ask
        </button>
        {v && v.kind !== 'table' ? (
          <button className="btn btn--sm" onClick={onShow} title={v.title}>
            <Icon size={13} /> {v.kind === 'plot' ? 'Show plot' : 'Show graph'}
          </button>
        ) : v ? (
          <button className="btn btn--sm" onClick={onToggle} title={v.title}>
            <Icon size={13} /> {open ? 'Hide table' : 'Show table'}
          </button>
        ) : null}
      </div>
    </article>
  )
}

const stageLabel = (s: string) => {
  const a = ANALYSES.find((x) => x.id === s)
  if (a) return a.label
  const m: Record<string, string> = { metrics: 'Metrics', build: 'Building graph', components: 'Components', clustering: 'Clustering', pagerank: 'PageRank', betweenness: 'Betweenness', community: 'Communities', closeness: 'Closeness', paths: 'Paths' }
  return m[s] ?? s
}
