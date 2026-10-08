import { AreaChart, BarChart3, BarChartBig, ChartCandlestick, Grid3x3, Lightbulb, LineChart, PieChart, Plus, ScatterChart, Trash2 } from 'lucide-react'
import { useMemo, useState, type ComponentType } from 'react'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity } from '../../core/entity/types'
import type { Agg, PlotSpec, PlotTrace, TimeUnit, TraceKind } from '../../core/graph/plot'
import { paletteIds } from '../../core/graph/palettes'
import type { ValueRefInfo } from '../../core/graph/values'
import { RefPicker } from './RefPicker'
import { datasetsIn } from '../../core/datasets/dataset'
import { Select } from '../../components/ui/Select'

/** The chart kinds, in the order a picker shows them, each with the words the form uses for its axes. */
const KINDS: { kind: TraceKind; label: string; icon: ComponentType<{ size?: number }>; hint: string }[] = [
  { kind: 'bar', label: 'Bars', icon: BarChart3, hint: 'A bar per category or period' },
  { kind: 'line', label: 'Line', icon: LineChart, hint: 'Points joined in order of X' },
  { kind: 'area', label: 'Area', icon: AreaChart, hint: 'A line, filled to zero' },
  { kind: 'scatter', label: 'Scatter', icon: ScatterChart, hint: 'One point per entity' },
  { kind: 'histogram', label: 'Histogram', icon: BarChartBig, hint: 'How a number is distributed' },
  { kind: 'box', label: 'Box', icon: ChartCandlestick, hint: 'Spread of a number, per category' },
  { kind: 'heatmap', label: 'Heatmap', icon: Grid3x3, hint: 'Counts in X × Y cells' },
  { kind: 'pie', label: 'Pie', icon: PieChart, hint: 'Share of rows per value' },
]
const AGGS: { agg: Agg; label: string }[] = [
  { agg: 'count', label: 'Count of rows' },
  { agg: 'sum', label: 'Sum of…' },
  { agg: 'mean', label: 'Average of…' },
  { agg: 'median', label: 'Median of…' },
  { agg: 'min', label: 'Minimum of…' },
  { agg: 'max', label: 'Maximum of…' },
  { agg: 'distinct', label: 'Distinct values of…' },
]
const UNITS: TimeUnit[] = ['hour', 'day', 'week', 'month', 'quarter', 'year']
/** Refs the plot reads as dates (the same rule the builder applies): meta stamps, and properties named like one. */
const isTemporalRef = (ref: string | undefined) => !!ref && (/^meta\.(createdAt|updatedAt)$/.test(ref) || /(created|updated|ended|_ts|timestamp|date|time|At$|_at$)/i.test(ref))

interface Props {
  spec: PlotSpec
  onChange: (spec: PlotSpec) => void
  refs: ValueRefInfo[]
  /** The rows the selector picks (a sample is enough): what the suggestions look at. */
  rows?: AnyEntity[]
  stats?: { rows: number; traces: number; missing: number }
  error?: string | null
}

/**
 * The plot's spec as a guided form: which entities, then for each trace the
 * kind of chart (a row of icons) and the few fields that kind needs, in
 * plain words — "across", "measure", "split by" — then the layout. Ready-made
 * charts for the chosen rows sit at the top for a first picture in one
 * click. A JSON view of the same spec is one toggle away for power use.
 */
export function PlotPanel({ spec, onChange, refs, rows, stats, error }: Props) {
  const store = useEntityStore()
  useStoreVersion(store)
  const registry = useTypeRegistry()
  const [json, setJson] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [ideasOpen, setIdeasOpen] = useState(true)

  const types = useMemo(
    () =>
      [...store.countByTypeAndKind().entities.entries()]
        .filter(([t]) => !t.startsWith('schema:') && registry.get(t).category !== 'project')
        .sort((a, b) => b[1] - a[1]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, registry, store.size()],
  )
  const patch = (p: Partial<PlotSpec>) => onChange(clean({ ...spec, ...p }) as PlotSpec)
  const datasets = datasetsIn(store)
  const patchTrace = (i: number, p: Partial<PlotTrace>) => patch({ traces: spec.traces.map((t, j) => (j === i ? clean({ ...t, ...p }) : t)) })
  const selTypes = spec.selector?.types ?? []
  const toggleType = (t: string) => patch({ selector: { ...spec.selector, types: selTypes.includes(t) ? selTypes.filter((x) => x !== t) : [...selTypes, t] } })
  const ideas = useMemo(() => suggestions(rows ?? [], refs, registry.get), [rows, refs, registry])
  const labelOf = (ref: string | undefined) => (ref ? (refs.find((r) => r.ref === ref)?.label ?? ref) : '')

  const openJson = () => {
    setJsonText(JSON.stringify(spec, null, 2))
    setJsonError(null)
    setJson(true)
  }
  const applyJson = () => {
    try {
      const next = JSON.parse(jsonText) as PlotSpec
      if (!Array.isArray(next.traces)) throw new Error('spec.traces must be an array')
      setJsonError(null)
      onChange(next)
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : String(e))
    }
  }
  /** Switching the kind keeps what still applies and gives the new kind what it needs. */
  const setKind = (i: number, kind: TraceKind) => {
    const t = spec.traces[i]
    const next: PlotTrace = { ...t, kind }
    if (kind === 'pie') Object.assign(next, { y: undefined, agg: undefined, bin: undefined, group: undefined, color: undefined, size: undefined, mode: undefined, cumulative: undefined })
    else if (kind === 'histogram') Object.assign(next, { y: undefined, agg: undefined, bin: undefined, color: undefined, size: undefined, mode: undefined, cumulative: undefined })
    else if (kind === 'box') Object.assign(next, { agg: undefined, bin: undefined, color: undefined, size: undefined, mode: undefined, cumulative: undefined, y: t.y ?? (t.x && refs.find((r) => r.ref === t.x)?.kind === 'numeric' ? t.x : undefined) })
    else if (kind === 'heatmap') Object.assign(next, { agg: undefined, group: undefined, size: undefined, mode: undefined, cumulative: undefined })
    else if (kind === 'scatter') Object.assign(next, { mode: undefined })
    else if (kind === 'bar' || kind === 'line' || kind === 'area') {
      // A summary chart: count rows unless a measure is already chosen.
      if (!t.agg && !t.y) next.agg = 'count'
      if (t.x && isTemporalRef(t.x) && !t.bin) next.bin = 'month'
      Object.assign(next, { mode: undefined })
    }
    patchTrace(i, next)
  }

  return (
    <div className="plotp">
      <div className="plotp__head">
        <span className="plotp__stats">{stats ? `${stats.rows.toLocaleString()} rows · ${stats.traces} ${stats.traces === 1 ? 'trace' : 'traces'}${stats.missing ? ` · ${stats.missing.toLocaleString()} without a value` : ''}` : 'no data yet'}</span>
        <button className={`btn btn--sm ${json ? 'is-on' : ''}`} onClick={() => (json ? setJson(false) : openJson())} title="The plot as a spec, to edit or copy">
          JSON
        </button>
      </div>
      {error && <div className="plotp__error">{error}</div>}

      {json ? (
        <div className="plotp__json">
          <textarea className="input plotp__textarea" value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
          {jsonError && <div className="plotp__error">{jsonError}</div>}
          <div className="plotp__row">
            <button className="btn btn--sm btn--primary" onClick={applyJson}>
              Apply
            </button>
            <button className="btn btn--sm" onClick={() => setJsonText(JSON.stringify(spec, null, 2))}>
              Reset
            </button>
          </div>
        </div>
      ) : (
        <>
          <section className="plotp__section">
            <h3>
              <span className="plotp__step">1</span> Which rows
            </h3>
            {datasets.length > 0 && (
              <label className="plotp__source">
                Rows from
                <Select className="input" value={spec.dataset ?? ''} onChange={(e) => (e.target.value ? patch({ dataset: e.target.value, selector: undefined }) : patch({ dataset: undefined }))} title="Entities, or the rows of a dataset — a table of counts per type, a script's table">
                  <option value="">Entities</option>
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      Dataset · {d.label} ({d.data.rows.length.toLocaleString()} rows)
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {spec.dataset ? (
              <p className="muted plotp__hint">{datasets.some((d) => d.id === spec.dataset) ? 'One point or bar per row of the dataset; the pickers below offer its columns.' : 'That dataset is gone — choose another, or Entities.'}</p>
            ) : (
              <>
            <div className="plotp__types">
              {spec.selector?.ids?.length ? (
                <label className="plotp__chip is-on" title="A list handed over from the Entities page; remove it to choose by type">
                  <input type="checkbox" checked onChange={() => patch({ selector: { ...spec.selector, ids: undefined } })} />
                  {spec.selector.ids.length.toLocaleString()} picked entities <span className="faint">×</span>
                </label>
              ) : null}
              {types.map(([t, n]) => (
                <label key={t} className={`plotp__chip ${selTypes.includes(t) ? 'is-on' : ''}`} title={`${n.toLocaleString()} ${(registry.get(t).pluralLabel ?? registry.get(t).label).toLowerCase()}`}>
                  <input type="checkbox" checked={selTypes.includes(t)} onChange={() => toggleType(t)} />
                  <span className="plotp__swatch" style={{ background: registry.colorOf(t) }} />
                  {registry.get(t).label} <span className="faint">{n.toLocaleString()}</span>
                </label>
              ))}
            </div>
            <div className="plotp__grid">
              <label>
                With any of these tags
                <input className="input" value={(spec.selector?.tags ?? []).join(', ')} placeholder="tag, tag…" onChange={(e) => patch({ selector: { ...spec.selector, tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })} />
              </label>
              <label>
                Matching text
                <input className="input" value={spec.selector?.text ?? ''} placeholder="in the label or data" onChange={(e) => patch({ selector: { ...spec.selector, text: e.target.value || undefined } })} />
              </label>
            </div>
            <p className="muted plotp__hint">{selTypes.length || spec.selector?.ids?.length || spec.selector?.tags?.length || spec.selector?.text ? 'Untick everything to plot the whole dataset.' : 'Nothing chosen: the whole dataset. Pick types to narrow it.'}</p>
              </>
            )}
          </section>

          {ideas.length > 0 && (
            <section className="plotp__section plotp__ideas">
              <h3>
                <button type="button" className="plotp__fold" onClick={() => setIdeasOpen((v) => !v)} aria-expanded={ideasOpen}>
                  <Lightbulb size={12} /> Ready-made charts for these rows <span className="faint">{ideasOpen ? '▾' : '▸'}</span>
                </button>
              </h3>
              {ideasOpen && (
                <div className="plotp__idea-list">
                  {ideas.map((s) => {
                    const K = KINDS.find((k) => k.kind === (s.trace.kind ?? 'scatter'))!
                    return (
                      <button key={`${s.label}|${s.trace.x ?? ''}|${s.trace.y ?? ''}`} type="button" className="plotp__idea" title={s.why} onClick={() => patch({ traces: [s.trace], layout: { ...spec.layout, title: s.label, barmode: undefined, xaxis: undefined, yaxis: undefined } })}>
                        <K.icon size={14} />
                        <span>{s.label}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          <section className="plotp__section">
            <h3>
              <span className="plotp__step">2</span> Chart
            </h3>
            {spec.traces.map((t, i) => {
              const kind = t.kind ?? 'scatter'
              const summary = kind === 'bar' || kind === 'line' || kind === 'area'
              const agg: Agg | undefined = t.agg ?? (t.y ? undefined : summary ? 'count' : undefined)
              const xTemporal = isTemporalRef(t.x)
              const xNumeric = !xTemporal && refs.find((r) => r.ref === t.x)?.kind === 'numeric'
              const yTemporal = isTemporalRef(t.y)
              const yNumeric = !yTemporal && refs.find((r) => r.ref === t.y)?.kind === 'numeric'
              const binField = (label: string, value: PlotTrace['bin'], temporal: boolean, numeric: boolean, set: (b: PlotTrace['bin']) => void) =>
                temporal ? (
                  <label>
                    {label}
                    <Select className="gx-select" value={typeof value === 'string' ? value : 'none'} onChange={(e) => set(e.target.value === 'none' ? undefined : (e.target.value as TimeUnit))}>
                      <option value="none">each value</option>
                      {UNITS.map((u) => (
                        <option key={u} value={u}>
                          per {u}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : numeric ? (
                  <label>
                    {label}
                    <span className="plotp__bucket">
                      <Select className="gx-select" value={typeof value === 'number' ? 'width' : 'none'} onChange={(e) => set(e.target.value === 'none' ? undefined : 10)}>
                        <option value="none">each value</option>
                        <option value="width">buckets of…</option>
                      </Select>
                      {typeof value === 'number' && <input className="input" type="number" value={value} min={0} onChange={(e) => set(Number(e.target.value) || 1)} title="Bucket width" />}
                    </span>
                  </label>
                ) : null
              return (
                <div key={i} className="plotp__trace">
                  <div className="plotp__kinds" role="radiogroup" aria-label="Chart kind">
                    {KINDS.map((k) => (
                      <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} className={`plotp__kind ${kind === k.kind ? 'is-on' : ''}`} title={`${k.label} — ${k.hint}`} onClick={() => setKind(i, k.kind)}>
                        <k.icon size={16} />
                        <span>{k.label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="plotp__grid">
                    {kind === 'pie' && (
                      <label>
                        Slices by
                        <RefPicker value={t.x} refs={refs} none="type" onChange={(v) => patchTrace(i, { x: v })} />
                      </label>
                    )}
                    {kind === 'histogram' && (
                      <label>
                        Values
                        <RefPicker value={t.x} refs={refs} only="numeric" none="choose a number" onChange={(v) => patchTrace(i, { x: v })} />
                      </label>
                    )}
                    {kind === 'box' && (
                      <>
                        <label>
                          Values
                          <RefPicker value={t.y} refs={refs} only="numeric" none="choose a number" onChange={(v) => patchTrace(i, { y: v })} />
                        </label>
                        <label>
                          One box per
                          <RefPicker value={t.x} refs={refs} only="categorical" none="all rows together" onChange={(v) => patchTrace(i, { x: v })} />
                        </label>
                      </>
                    )}
                    {kind === 'heatmap' && (
                      <>
                        <label>
                          X
                          <RefPicker value={t.x} refs={refs} none="choose what X reads" onChange={(v) => patchTrace(i, { x: v, bin: binFor(v, t.bin, refs) })} />
                        </label>
                        <label>
                          Y
                          <RefPicker value={t.y} refs={refs} none="choose what Y reads" onChange={(v) => patchTrace(i, { y: v, ybin: binFor(v, t.ybin, refs) })} />
                        </label>
                        {binField('X cells', t.bin, xTemporal, !!xNumeric, (b) => patchTrace(i, { bin: b }))}
                        {binField('Y cells', t.ybin, yTemporal, !!yNumeric, (b) => patchTrace(i, { ybin: b }))}
                        <label>
                          Palette
                          <Select className="gx-select" value={t.palette ?? 'viridis'} onChange={(e) => patchTrace(i, { palette: e.target.value as PlotTrace['palette'] })}>
                            {paletteIds('sequential').map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </Select>
                        </label>
                      </>
                    )}
                    {summary && (
                      <>
                        <label>
                          Across
                          <RefPicker value={t.x} refs={refs} none="choose what X reads" onChange={(v) => patchTrace(i, { x: v, bin: isTemporalRef(v) && !isTemporalRef(t.x) ? 'month' : binFor(v, t.bin, refs) })} />
                        </label>
                        {binField('Grouped', t.bin, xTemporal, !!xNumeric, (b) => patchTrace(i, { bin: b }))}
                        <label>
                          Measure
                          <Select className="gx-select" value={agg ?? 'none'} onChange={(e) => patchTrace(i, { agg: e.target.value === 'none' ? undefined : (e.target.value as Agg), y: e.target.value === 'count' ? undefined : t.y })}>
                            {AGGS.map((a) => (
                              <option key={a.agg} value={a.agg}>
                                {a.label}
                              </option>
                            ))}
                            <option value="none">Each row's own value of…</option>
                          </Select>
                        </label>
                        {agg !== 'count' && (
                          <label>
                            {agg ? 'Of' : 'Y'}
                            <RefPicker value={t.y} refs={refs} only="numeric" none="choose a number" onChange={(v) => patchTrace(i, { y: v })} />
                          </label>
                        )}
                        <label>
                          Split into series by
                          <RefPicker value={t.group} refs={refs} only="categorical" none="don't split" onChange={(v) => patchTrace(i, { group: v })} />
                        </label>
                      </>
                    )}
                    {kind === 'scatter' && (
                      <>
                        <label>
                          X
                          <RefPicker value={t.x} refs={refs} none="choose what X reads" onChange={(v) => patchTrace(i, { x: v, bin: binFor(v, t.bin, refs) })} />
                        </label>
                        <label>
                          Y
                          <RefPicker value={t.y} refs={refs} only="numeric" none={agg === 'count' ? '(count of rows)' : 'choose a number'} onChange={(v) => patchTrace(i, { y: v })} />
                        </label>
                        <label>
                          Points
                          <Select className="gx-select" value={agg ?? 'none'} onChange={(e) => patchTrace(i, { agg: e.target.value === 'none' ? undefined : (e.target.value as Agg) })}>
                            <option value="none">one per entity</option>
                            {AGGS.map((a) => (
                              <option key={a.agg} value={a.agg}>
                                one per X: {a.label.toLowerCase().replace('…', ' Y')}
                              </option>
                            ))}
                          </Select>
                        </label>
                        {agg && binField('Grouped', t.bin, xTemporal, !!xNumeric, (b) => patchTrace(i, { bin: b }))}
                        <label>
                          Split into series by
                          <RefPicker value={t.group} refs={refs} only="categorical" none="don't split" onChange={(v) => patchTrace(i, { group: v })} />
                        </label>
                        {!agg && (
                          <>
                            <label>
                              Colour by
                              <RefPicker value={t.color} refs={refs} only="numeric" none="one colour" onChange={(v) => patchTrace(i, { color: v })} />
                            </label>
                            <label>
                              Size by
                              <RefPicker value={t.size} refs={refs} only="numeric" none="one size" onChange={(v) => patchTrace(i, { size: v })} />
                            </label>
                          </>
                        )}
                      </>
                    )}
                    {(kind === 'histogram' || kind === 'box') && (
                      <label>
                        Split into series by
                        <RefPicker value={t.group} refs={refs} only="categorical" none="don't split" onChange={(v) => patchTrace(i, { group: v })} />
                      </label>
                    )}
                    {t.color && kind === 'scatter' && !agg && (
                      <label>
                        Palette
                        <Select className="gx-select" value={t.palette ?? 'viridis'} onChange={(e) => patchTrace(i, { palette: e.target.value as PlotTrace['palette'] })}>
                          {paletteIds('sequential').map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </Select>
                      </label>
                    )}
                    {(kind === 'scatter' || kind === 'line') && (
                      <label>
                        Draw as
                        <Select className="gx-select" value={t.mode ?? (kind === 'scatter' ? 'markers' : 'lines')} onChange={(e) => patchTrace(i, { mode: e.target.value as PlotTrace['mode'] })}>
                          <option value="markers">points</option>
                          <option value="lines">lines</option>
                          <option value="lines+markers">lines and points</option>
                        </Select>
                      </label>
                    )}
                    {kind !== 'pie' && kind !== 'heatmap' && !t.group && (
                      <label>
                        Colour
                        <input className="input" type="color" value={t.fill ?? '#0f766e'} onChange={(e) => patchTrace(i, { fill: e.target.value })} />
                      </label>
                    )}
                    <label>
                      Name in the legend
                      <input className="input" value={t.name ?? ''} placeholder={t.group ? 'per series' : describeTrace(t, labelOf)} onChange={(e) => patchTrace(i, { name: e.target.value || undefined })} />
                    </label>
                  </div>
                  <div className="plotp__row plotp__trace-foot">
                    {agg && kind !== 'pie' && kind !== 'histogram' && kind !== 'box' && kind !== 'heatmap' && (
                      <label className="plotp__inline">
                        <input type="checkbox" checked={!!t.cumulative} onChange={(e) => patchTrace(i, { cumulative: e.target.checked || undefined })} /> running total
                      </label>
                    )}
                    <span className="spacer" />
                    {spec.traces.length > 1 && (
                      <button className="btn btn--sm btn--ghost btn--danger" title="Remove this trace" onClick={() => patch({ traces: spec.traces.filter((_, j) => j !== i) })}>
                        <Trash2 size={13} /> Remove
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            <button className="btn btn--sm" title="Another trace on the same axes — a second measure, or a running total beside the bars" onClick={() => patch({ traces: [...spec.traces, { ...spec.traces[spec.traces.length - 1], name: undefined, fill: undefined }] })}>
              <Plus size={13} /> Add a trace
            </button>
          </section>

          <section className="plotp__section">
            <h3>
              <span className="plotp__step">3</span> Titles and axes
            </h3>
            <div className="plotp__grid">
              <label>
                Title
                <input className="input" value={spec.layout?.title ?? ''} placeholder={describeTrace(spec.traces[0] ?? {}, labelOf)} onChange={(e) => patch({ layout: { ...spec.layout, title: e.target.value || undefined } })} />
              </label>
              {spec.traces.some((t) => t.kind === 'bar') && (
                <label>
                  Several bar series
                  <Select className="gx-select" value={spec.layout?.barmode ?? 'auto'} onChange={(e) => patch({ layout: { ...spec.layout, barmode: e.target.value === 'auto' ? undefined : (e.target.value as 'stack' | 'group' | 'overlay') } })}>
                    <option value="auto">stacked</option>
                    <option value="group">side by side</option>
                    <option value="overlay">overlaid</option>
                  </Select>
                </label>
              )}
              <label>
                X axis
                <Select className="gx-select" value={spec.layout?.xaxis?.type ?? 'auto'} onChange={(e) => patch({ layout: { ...spec.layout, xaxis: { ...spec.layout?.xaxis, type: e.target.value === 'auto' ? undefined : (e.target.value as 'linear' | 'log' | 'date' | 'category') } } })}>
                  <option value="auto">auto</option>
                  <option value="linear">linear</option>
                  <option value="log">log</option>
                  <option value="date">date</option>
                  <option value="category">category</option>
                </Select>
              </label>
              <label>
                Y axis
                <Select className="gx-select" value={spec.layout?.yaxis?.type ?? 'auto'} onChange={(e) => patch({ layout: { ...spec.layout, yaxis: { ...spec.layout?.yaxis, type: e.target.value === 'auto' ? undefined : (e.target.value as 'linear' | 'log' | 'date' | 'category') } } })}>
                  <option value="auto">auto</option>
                  <option value="linear">linear</option>
                  <option value="log">log</option>
                  <option value="date">date</option>
                  <option value="category">category</option>
                </Select>
              </label>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

/** What a trace draws, in words — the default legend name and title. */
function describeTrace(t: PlotTrace, labelOf: (ref: string | undefined) => string): string {
  const kind = t.kind ?? 'scatter'
  if (kind === 'pie') return `Share by ${labelOf(t.x) || 'type'}`
  if (kind === 'histogram') return `Distribution of ${labelOf(t.x) || '…'}`
  if (kind === 'box') return `${labelOf(t.y) || '…'}${t.x ? ` per ${labelOf(t.x)}` : ''}`
  if (kind === 'heatmap') return `${labelOf(t.x) || '…'} × ${labelOf(t.y) || '…'}`
  const agg = t.agg ?? (t.y ? undefined : kind === 'scatter' ? undefined : 'count')
  const measure = agg === 'count' ? 'Count' : agg ? `${agg === 'mean' ? 'Average' : agg.charAt(0).toUpperCase() + agg.slice(1)} of ${labelOf(t.y) || '…'}` : labelOf(t.y) || '…'
  const across = t.x ? (typeof t.bin === 'string' ? `per ${t.bin} of ${labelOf(t.x)}` : `by ${labelOf(t.x)}`) : ''
  return `${measure}${across ? ` ${across}` : ''}`.trim()
}

/** Properties that are presentation or identity, not something to count by. */
const SKIP = /^(color|colour|fill|icon|size|url|href|image|thumbnail|id|_id|uuid|key|slug|x|y|z)$|(_id|Id|_url|Url)$/

interface Suggestion {
  label: string
  why: string
  trace: PlotTrace
}

/**
 * A few charts worth drawing for these rows, from what they carry: activity
 * over any date they have, counts over properties with a handful of values,
 * the spread of each number, and the first two numbers against each other.
 */
function suggestions(rows: AnyEntity[], refs: ValueRefInfo[], typeOf: (t: string) => { label: string }): Suggestion[] {
  const out: Suggestion[] = []
  const sample = rows.slice(0, 500)
  if (!sample.length) return out
  const typesInRows = new Set(sample.map((r) => r.type))
  if (typesInRows.size > 1) out.push({ label: 'Count by type', why: `${typesInRows.size} types among these rows`, trace: { kind: 'bar', x: 'type', agg: 'count' } })
  const dataRefs = refs.filter((r) => r.group === 'Data' && r.available)
  // Dates the rows carry themselves come first; the workspace's own stamp is the fallback (and reads as "added").
  const ownDates = dataRefs.filter((r) => isTemporalRef(r.ref) && !SKIP.test(r.ref.slice(5))).map((r) => r.ref)
  const temporal = [...ownDates.slice(0, 2), ...(sample.some((r) => r.meta.createdAt) ? ['meta.createdAt'] : [])]
  for (const ref of temporal) {
    const label = ref === 'meta.createdAt' ? 'added to the workspace' : ref.slice(5)
    out.push({ label: `Per month of ${label}`, why: `How many rows fall in each month of ${label}`, trace: { kind: 'bar', x: ref, bin: 'month', agg: 'count' } })
  }
  // Categorical properties with a handful of values: a bar per value.
  const cats: { ref: string; n: number }[] = []
  for (const r of dataRefs) {
    if (r.kind !== 'categorical' || isTemporalRef(r.ref)) continue
    const key = r.ref.slice(5)
    if (SKIP.test(key)) continue
    const seen = new Set<string>()
    let filled = 0
    for (const row of sample) {
      const v = row.data[key]
      if (v === undefined || v === null || v === '') continue
      filled++
      seen.add(typeof v === 'string' ? v : JSON.stringify(v))
      if (seen.size > 40) break
    }
    if (seen.size >= 2 && seen.size <= 40 && filled >= sample.length / 2) cats.push({ ref: r.ref, n: seen.size })
  }
  for (const c of cats.sort((a, b) => a.n - b.n).slice(0, 4)) out.push({ label: `Count by ${c.ref.slice(5)}`, why: `${c.n} distinct values`, trace: { kind: 'bar', x: c.ref, agg: 'count' } })
  const nums = dataRefs.filter((r) => r.kind === 'numeric' && !isTemporalRef(r.ref) && !SKIP.test(r.ref.slice(5)))
  for (const r of nums.slice(0, 2)) out.push({ label: `Distribution of ${r.label}`, why: 'How the values spread', trace: { kind: 'histogram', x: r.ref } })
  if (nums.length >= 2) out.push({ label: `${nums[0].label} vs ${nums[1].label}`, why: 'One point per row', trace: { kind: 'scatter', x: nums[0].ref, y: nums[1].ref } })
  if (temporal.length && cats.length) out.push({ label: `Per month, split by ${cats[0].ref.slice(5)}`, why: 'Stacked bars, one series per value', trace: { kind: 'bar', x: temporal[0], bin: 'month', agg: 'count', group: cats[0].ref } })
  void typeOf
  return out.slice(0, 10)
}

/** A bin only makes sense for what X now reads: time units on a date, a width on a number, nothing on a category. */
function binFor(x: string | undefined, bin: PlotTrace['bin'], refs: ValueRefInfo[]): PlotTrace['bin'] {
  if (bin === undefined || !x) return undefined
  if (typeof bin === 'string') return isTemporalRef(x) ? bin : undefined
  return refs.find((r) => r.ref === x)?.kind === 'numeric' ? bin : undefined
}

/** Drop undefined keys so the saved spec stays small. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}
