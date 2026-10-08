import { ChevronDown, ChevronRight, CircleDot, Palette, Play, RotateCcw, Save, Square, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import { sampleDataKeys } from '../../core/graph/fields'
import { categoryCounts, columnStats, createAnalysisEntity, DEFAULT_METRICS, histogram, METRICS, metricInfo, topK, writeMetricsToEntities, type NodeMetricId } from '../../core/graph/metrics'
import { useExplorer } from './explorerState'
import { Histogram } from './Histogram'

const fmt = (v: number | undefined, d = 3) => (v === undefined || !Number.isFinite(v) ? '—' : Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number.isInteger(v) ? String(v) : v.toFixed(d))

/** The catalogue's groups, in the order they are listed, named for what they answer. */
const GROUPS = [
  { id: 'degree', label: 'Connections' },
  { id: 'centrality', label: 'Importance' },
  { id: 'structure', label: 'Structure' },
  { id: 'community', label: 'Communities' },
] as const

/**
 * The statistics panel, laid out in the order it is used: the run bar (what will be measured, and Run), then the
 * results — the whole view in a few figures, and each measure per node, with what it colours or sizes lit — then what
 * to keep. The list of measures to choose from is folded away once there are results, so the answers come first.
 */
export function StatsPanel() {
  const store = useEntityStore()
  const toast = useToast()
  const { state, dispatch, slice, runMetrics, cancelMetrics, metricsStale } = useExplorer()
  const [chosen, setChosen] = useState<Set<NodeMetricId>>(() => new Set(state.metrics ? (Object.keys(state.metrics.columns) as NodeMetricId[]) : DEFAULT_METRICS))
  const [weightField, setWeightField] = useState(state.metrics?.options.weightField ?? '')
  const [picking, setPicking] = useState(!state.metrics)
  const [prefix, setPrefix] = useState('')
  const [writing, setWriting] = useState(false)
  const [confirmWrite, setConfirmWrite] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const edgeKeys = useMemo(() => sampleDataKeys(slice.edges).filter((k) => k.startsWith('data.')), [slice.edges])
  const m = state.metrics
  const job = state.metricsJob
  const heavy = [...chosen].some((id) => metricInfo(id).cost === 'quadratic') && slice.nodes.length > 3000

  const setMany = (ids: NodeMetricId[], on: boolean) =>
    setChosen((s) => {
      const n = new Set(s)
      for (const id of ids) on ? n.add(id) : n.delete(id)
      return n
    })
  const run = () => {
    if (!chosen.size || !slice.nodes.length) return
    setPicking(false)
    runMetrics({ metrics: [...chosen], weightField: weightField || undefined }).catch(() => {})
  }
  const nd = state.rendering.nodes.default
  const colouring = nd.color.mode !== 'constant' && nd.color.attr.kind === 'metric' ? nd.color.attr.key : undefined
  const sizing = nd.size.mode === 'ranking' && nd.size.attr.kind === 'metric' ? nd.size.attr.key : undefined
  const colourBy = (id: NodeMetricId) => {
    const categorical = !!metricInfo(id).categorical
    dispatch({ type: 'patchRendering', patch: { nodes: { ...state.rendering.nodes, default: { ...nd, color: categorical ? { mode: 'partition', attr: { kind: 'metric', key: id }, palette: 'tableau10' } : { mode: 'ranking', attr: { kind: 'metric', key: id }, palette: 'viridis' } } } } })
    dispatch({ type: 'setLegend', on: true })
  }
  const sizeBy = (id: NodeMetricId) => {
    const prev = nd.size.mode === 'ranking' ? nd.size : { min: 3, max: 14 }
    dispatch({ type: 'patchRendering', patch: { nodes: { ...state.rendering.nodes, default: { ...nd, size: { mode: 'ranking', attr: { kind: 'metric', key: id }, min: prev.min, max: prev.max } } } } })
  }
  const pct = job && job.total > 1 ? Math.round((job.done / job.total) * 100) : undefined

  return (
    <div className="gx-panel gx-metrics">
      {/* ── Run bar: what will be measured, and Run ── */}
      <section className="gx-layout__run">
        <div className="gx-layout__bar">
          <button className="btn btn--sm gx-picker gx-layout__pick" aria-expanded={picking} title="Choose what to measure" onClick={() => setPicking((p) => !p)}>
            <span className="gx-picker__label">
              {chosen.size} of {METRICS.length} measures
            </span>
            {picking ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {job ? (
            <button className="btn btn--sm" onClick={cancelMetrics}>
              <Square size={12} /> Cancel
            </button>
          ) : (
            <button className="btn btn--sm btn--primary" disabled={!chosen.size || !slice.nodes.length} title={`Measure the ${slice.nodes.length.toLocaleString()} nodes and ${slice.edges.length.toLocaleString()} edges in view`} onClick={run}>
              <Play size={13} /> {m ? 'Run again' : 'Run'}
            </button>
          )}
        </div>
        {job ? (
          <div className="gx-progress" title={job.stage}>
            <div className="gx-progress__bar" style={{ width: `${pct ?? 100}%` }} />
            <span className="gx-progress__label">
              {job.stage}
              {pct !== undefined ? ` ${pct}%` : '…'}
            </span>
          </div>
        ) : m && metricsStale ? (
          <p className="gx-metrics__status gx-panel__warn">
            <TriangleAlert size={12} /> The view has changed since these were measured — run again to bring them up to date.
          </p>
        ) : m ? (
          <p className="gx-metrics__status">
            Measured {m.summary.nodes.toLocaleString()} nodes in {m.summary.durations.total ?? 0} ms
            {m.cached ? ' (reused)' : ''}
            <button className="gx-metrics__clear" onClick={() => dispatch({ type: 'clearMetrics' })} title="Forget these results (the picture stops using them)">
              <RotateCcw size={11} /> Clear
            </button>
          </p>
        ) : (
          <p className="gx-panel__note">Measure every node in the view — how connected, how central, which community — then colour or size the picture by any measure.</p>
        )}
        {state.metricsError && <p className="gx-panel__note gx-panel__warn">{state.metricsError}</p>}
        <label className="gx-metrics__auto" title="Re-run these measures whenever the filter changes what is in view (small views only)">
          <Switch on={state.analysisAuto} onChange={(on) => (dispatch({ type: 'setAnalysisAuto', on }), dispatch({ type: 'setAnalysisOptions', options: { metrics: [...chosen], weightField: weightField || undefined } }))} />
          <span>Keep up to date as the view changes</span>
        </label>
      </section>

      {/* ── What to measure (folded once there are results) ── */}
      {picking && (
        <section className="gx-metrics__pick">
          <div className="gx-metrics__presets">
            <span className="faint">Choose</span>
            <button className="gx-link-btn" onClick={() => setChosen(new Set(DEFAULT_METRICS))}>
              the usual
            </button>
            <button className="gx-link-btn" onClick={() => setChosen(new Set(METRICS.map((x) => x.id)))}>
              all
            </button>
            <button className="gx-link-btn" onClick={() => setChosen(new Set())}>
              none
            </button>
          </div>
          {GROUPS.map((g) => {
            const items = METRICS.filter((x) => x.group === g.id)
            const on = items.filter((x) => chosen.has(x.id)).length
            return (
              <div key={g.id} className="gx-metrics__group">
                <div className="gx-metrics__group-head">
                  <span className="gx-metrics__group-label">{g.label}</span>
                  <button className="gx-link-btn" onClick={() => setMany(items.map((x) => x.id), on < items.length)}>
                    {on < items.length ? 'all' : 'none'}
                  </button>
                </div>
                {items.map((x) => (
                  <label key={x.id} className={`gx-metrics__opt ${chosen.has(x.id) ? '' : 'is-off'}`}>
                    <input type="checkbox" checked={chosen.has(x.id)} onChange={(e) => setMany([x.id], e.target.checked)} />
                    <span className="gx-metrics__opt-text">
                      <span className="gx-metrics__opt-label">
                        {x.label}
                        {x.cost === 'quadratic' && (
                          <span className="gx-metrics__slow" title="Its cost grows with the square of the nodes: estimated from samples above 3,000">
                            slow
                          </span>
                        )}
                      </span>
                      <span className="gx-metrics__opt-desc">{x.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            )
          })}
          {heavy && <p className="gx-panel__note gx-panel__warn">Betweenness and closeness are estimated from samples above 3,000 nodes.</p>}
          <label className="gx-row gx-metrics__weight" title="A number on each relationship to count it by (weighted degree); empty counts every link once">
            <span>Weigh links by</span>
            <input className="input" list="gx-stats-edge-keys" placeholder="none (each link counts 1)" value={weightField} onChange={(e) => setWeightField(e.target.value)} />
            <datalist id="gx-stats-edge-keys">
              {edgeKeys.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </label>
        </section>
      )}

      {m && (
        <>
          {/* ── The view in a few figures ── */}
          <section>
            <h4>
              The view
              <span className="gx-panel__hint">
                {m.summary.nodes.toLocaleString()} nodes · {m.summary.edges.toLocaleString()} links
              </span>
            </h4>
            <div className="gx-figures">
              <Figure label="Links per node" value={fmt(m.summary.averageDegree, 2)} title="Average degree: links touching a node, on average" />
              <Figure label="Density" value={fmt(m.summary.density, 4)} title="The share of every possible link that exists (0–1)" />
              <Figure label="Pieces" value={m.summary.componentCount.toLocaleString()} sub={m.summary.componentCount > 1 ? `largest ${m.summary.giantComponentSize.toLocaleString()}` : 'all connected'} title="Connected components: groups with no link between them" />
              {m.summary.modularity !== undefined && <Figure label="Communities" value={String(m.summary.communityCount)} sub={`modularity ${fmt(m.summary.modularity, 2)}`} title="Louvain communities; modularity above ~0.3 means the groups are real" />}
              {m.summary.averageClustering !== undefined && <Figure label="Clustering" value={fmt(m.summary.averageClustering, 2)} title="How often a node's neighbours are linked to each other (0–1), on average" />}
              {m.summary.diameter !== undefined && <Figure label="Widest distance" value={`${m.summary.pathsExact ? '' : '≥ '}${m.summary.diameter}`} sub={`${fmt(m.summary.averagePathLength, 1)} links on average${m.summary.pathsExact ? '' : ' (sampled)'}`} title="Diameter: the most links between two connected nodes; the average is over every pair" />}
            </div>
            {m.summary.centralitySources && <p className="gx-panel__note">Centrality estimated from {m.summary.centralitySources} sampled starting nodes.</p>}
            {m.summary.warnings.map((w) => (
              <p key={w} className="gx-panel__note gx-panel__warn">
                {w}
              </p>
            ))}
          </section>

          {/* ── Each measure, per node ── */}
          <section>
            <h4>
              Per node
              <span className="gx-panel__hint">colour or size the picture by one</span>
            </h4>
            <div className="gx-measures">
              {(Object.keys(m.columns) as NodeMetricId[]).map((id) => (
                <MetricRow key={id} id={id} colouring={colouring === id} sizing={sizing === id} onColour={() => colourBy(id)} onSize={() => sizeBy(id)} />
              ))}
            </div>
          </section>

          {/* ── What to keep ── */}
          <section>
            <h4>Keep the results</h4>
            <div className="gx-actions">
              <button className="btn btn--sm" onClick={() => (setName(''), setNaming(true))} title="Save the whole result as an analysis you can load again from the scene or the picker">
                <Save size={12} /> Save analysis…
              </button>
              <button className="btn btn--sm" onClick={() => (setPrefix(''), setWriting(true))} title="Copy the values into each entity's data, so tables and filters can use them">
                Write to entities…
              </button>
            </div>
          </section>
          <Dialog
            open={writing}
            title="Write the measures to the entities"
            onClose={() => setWriting(false)}
            footer={
              <>
                <button className="btn" onClick={() => setWriting(false)}>
                  Cancel
                </button>
                <button className="btn btn--primary" onClick={() => (setWriting(false), setConfirmWrite(true))}>
                  Continue
                </button>
              </>
            }
          >
            <p className="muted">Each of the {m.ids.length.toLocaleString()} nodes in view gets its values as fields — {`data.${prefix}pagerank`} and so on — which tables, filters and scripts can then read.</p>
            <div className="field">
              <label>Key prefix (optional)</label>
              <input className="input" autoFocus placeholder="e.g. m_" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
            </div>
          </Dialog>
          <ConfirmDialog
            open={confirmWrite}
            title="Write metrics to entities?"
            message={`Sets data.${prefix}<metric> on ${m.ids.length.toLocaleString()} entities (their updatedAt changes).`}
            confirmLabel="Write"
            onConfirm={() => {
              const n = writeMetricsToEntities(store, m, undefined, prefix)
              toast(`Wrote metrics to ${n} entities`)
              setConfirmWrite(false)
            }}
            onCancel={() => setConfirmWrite(false)}
          />
          <Dialog
            open={naming}
            title="Save analysis"
            onClose={() => setNaming(false)}
            footer={
              <>
                <button className="btn" onClick={() => setNaming(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn--primary"
                  disabled={!name.trim()}
                  onClick={() => {
                    const e = createAnalysisEntity(store, name.trim(), m, { filterId: state.filterId, filter: state.filter })
                    dispatch({ type: 'markAnalysisSaved', id: e.id })
                    toast('Analysis saved')
                    setNaming(false)
                  }}
                >
                  Save
                </button>
              </>
            }
          >
            <div className="field">
              <label>Name</label>
              <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </Dialog>
        </>
      )}
    </div>
  )
}

/** One figure of the view: the number large, what it is small under it; the definition on hover. */
function Figure({ label, value, sub, title }: { label: string; value: string; sub?: string; title: string }) {
  return (
    <div className="gx-figure" title={title}>
      <span className="gx-figure__value">{value}</span>
      <span className="gx-figure__label">{label}</span>
      {sub && <span className="gx-figure__sub">{sub}</span>}
    </div>
  )
}

/** A switch, as the Style panel draws one. */
function Switch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className={`gx-st__switch ${on ? 'is-on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span />
    </button>
  )
}

/**
 * One measure per node: its name, its range (or how many groups), and the two things to do with it — colour the
 * picture by it, size the nodes by it — lit while the style uses it. Opens to its distribution, what it means, and
 * the nodes that score highest (a click selects one).
 */
function MetricRow({ id, colouring, sizing, onColour, onSize }: { id: NodeMetricId; colouring: boolean; sizing: boolean; onColour: () => void; onSize: () => void }) {
  const store = useEntityStore()
  const { state, dispatch } = useExplorer()
  const m = state.metrics!
  const info = metricInfo(id)
  const col = m.columns[id]!
  const stats = useMemo(() => columnStats(col), [col])
  const [open, setOpen] = useState(false)
  const dist = useMemo(() => (open && info.categorical ? categoryCounts(col).slice(0, 24) : null), [open, col, info.categorical])
  const groups = useMemo(() => (info.categorical ? new Set(col as Iterable<number>).size : 0), [col, info.categorical])
  const hist = useMemo(() => (open && !info.categorical ? histogram(col, 24, stats.min > 0 && stats.max / stats.min > 1000) : null), [open, col, info.categorical, stats])
  const top = useMemo(() => (open && !info.categorical ? topK(m, id, 5) : []), [open, m, id, info.categorical])
  return (
    <div className={`gx-measure ${open ? 'is-open' : ''}`}>
      <div className="gx-measure__row">
        <button className="gx-measure__name" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={info.description}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="gx-measure__label">{info.label}</span>
          <span className="gx-measure__range">{info.categorical ? `${groups.toLocaleString()} group${groups === 1 ? '' : 's'}` : `${fmt(stats.min, 2)} – ${fmt(stats.max, 2)}`}</span>
        </button>
        <button className={`gx-measure__use ${colouring ? 'is-on' : ''}`} aria-pressed={colouring} title={colouring ? `The picture is coloured by ${info.label}` : `Colour the nodes by ${info.label}${info.categorical ? ' (one colour per group)' : ' (low to high)'}`} onClick={onColour}>
          <Palette size={13} />
        </button>
        <button className={`gx-measure__use ${sizing ? 'is-on' : ''}`} aria-pressed={sizing} disabled={!!info.categorical} title={info.categorical ? 'Groups have no size order' : sizing ? `Node size follows ${info.label}` : `Size the nodes by ${info.label}`} onClick={onSize}>
          <CircleDot size={13} />
        </button>
      </div>
      {open && (
        <div className="gx-measure__body">
          <p className="gx-measure__desc">{info.description}</p>
          {dist ? <Histogram counts={dist.map((d) => d.count)} labels={dist.map((d) => `${info.label} ${d.key}`)} /> : hist ? <Histogram counts={hist.counts} labels={hist.edges.slice(0, -1).map((e, i) => `${fmt(e)}–${fmt(hist.edges[i + 1])}`)} /> : null}
          {top.length > 0 && (
            <>
              <span className="gx-measure__top-head">Highest</span>
              <ol className="gx-toplist">
                {top.map((t) => {
                  const e = store.get(t.id)
                  return (
                    <li key={t.id} onClick={() => dispatch({ type: 'select', ids: [t.id], mode: 'replace' })} title="Select it">
                      <span className="gx-list__label">{e ? displayLabel(e) : t.id}</span>
                      <span className="count">{fmt(t.value, 3)}</span>
                    </li>
                  )
                })}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  )
}
