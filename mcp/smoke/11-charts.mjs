/**
 * Use case 8, "Chart it, or script it", the charts half over the bridge
 * (5-scripts.mjs covers the scripts): a preview from a selector with bins
 * and an aggregate, a scatter, a chart shown on the Scenes page, saved as
 * a plot entity and reopened, and metric columns lent to a chart — from a
 * Stats run over the whole dataset and from an Insights run. Runs on the
 * demo a fresh profile seeds (incidents with startedAt / duration_min).
 * Starts from the Library: it counts the whole dataset, so a project
 * another step left open scopes it to a few dozen entities and every
 * figure it checks comes out zero (backlog b35). The remembered view is
 * left as the profile has it. Needs GL=1 (sigma). Run alone with
 *   GL=1 node mcp/drive.mjs mcp/smoke/11-charts.mjs
 * or as `npm run smoke:charts`.
 */
import { check, counted, startFrom, tidied } from './lib.mjs'

export default async ({ call, evaluate, sleep }) => {
  await startFrom({ call, evaluate, sleep }, 'library')
  const wasHolding = await counted(evaluate)
  const ctx = await call('get_app_context')
  const incidents = await call('search_entities', { type: 'incident', limit: 1, library: true })
  check('the seeded demo has incidents to chart', incidents.results.length === 1 && !!incidents.results[0].id, `${ctx.project?.label ?? 'Library'}: ${incidents.total ?? incidents.results.length} incident(s)`)

  // A bar of incidents per month, and the median duration per severity.
  const perMonth = await call('plot', { action: 'preview', spec: { selector: { types: ['incident'] }, traces: [{ kind: 'bar', x: 'data.startedAt', bin: 'month' }], layout: { title: 'Incidents per month' } }, points: 50 })
  const months = perMonth.traces?.[0]
  check('a bar chart bins rows by month and counts them', perMonth.stats.rows > 50 && months && months.x.length >= 6 && months.y.reduce((a, b) => a + b, 0) === perMonth.stats.rows, `${perMonth.stats.rows} rows over ${months?.x.length} months: ${perMonth.summary}`)
  const bySeverity = await call('plot', { action: 'preview', spec: { selector: { types: ['incident'] }, traces: [{ kind: 'bar', x: 'data.severity', y: 'data.duration_min', agg: 'median' }] } })
  const sev = bySeverity.traces?.[0]
  check('an aggregate folds a value per category', sev && sev.x.length >= 2 && sev.y.every((v) => typeof v === 'number' && v > 0), `${sev?.x.join('/')} → ${sev?.y.map((v) => Math.round(v)).join('/')}`)
  const scatter = await call('plot', { action: 'preview', spec: { selector: { types: ['incident'] }, traces: [{ kind: 'scatter', x: 'data.time_to_detect_min', y: 'data.duration_min', color: 'data.severity' }] }, points: 500 })
  check('a scatter takes two values and a colour per row', scatter.stats.rows > 50 && scatter.traces.length >= 1 && scatter.traces.reduce((n, t) => n + t.x.length, 0) === scatter.stats.rows, `${scatter.stats.rows} rows in ${scatter.traces.length} trace(s) by severity`)

  // Shown on the Scenes page, then saved and reopened as an entity.
  const shown = await call('plot', { action: 'show', spec: { selector: { types: ['incident'] }, traces: [{ kind: 'bar', x: 'data.startedAt', bin: 'month' }], layout: { title: 'Incidents per month' } } })
  check('a chart is drawn on the Scenes page', shown.shown === true && !shown.id, JSON.stringify(shown).slice(0, 120))
  const saved = await call('plot', { action: 'save', name: 'Smoke incidents per month', spec: { selector: { types: ['incident'] }, traces: [{ kind: 'bar', x: 'data.startedAt', bin: 'month' }], layout: { title: 'Incidents per month' } } })
  check('a chart saves as a plot entity with its row count', !!saved.id && saved.stats.rows === perMonth.stats.rows, JSON.stringify(saved).slice(0, 140))
  const listed = await call('plot', { action: 'list' })
  const opened = await call('plot', { action: 'open', id: saved.id })
  await sleep(800)
  const got = await call('plot', { action: 'get', id: saved.id, points: 3 })
  check('the saved chart lists, opens and reads back with its spec', listed.plots.some((p) => p.id === saved.id) && opened.opened === saved.id && got.spec.traces[0].bin === 'month' && got.traces[0].x.length === 3, `${listed.plots.length} plot(s); ${got.summary}`)
  const updated = await call('plot', { action: 'save', id: saved.id, spec: { selector: { types: ['incident'] }, traces: [{ kind: 'line', x: 'data.startedAt', bin: 'week' }] } })
  check('saving with an id updates the same entity', updated.id === saved.id && updated.updated === true && /week/.test(updated.summary), updated.summary)

  // Metrics lent to a chart: from the explorer's Stats over the whole dataset, then from Insights.
  await call('open', { page: '/unigraph/2d' })
  await sleep(1500)
  await call('graph_filter', { clear: true, accept_large: true })
  const m = await call('graph_metrics', { metrics: ['degree', 'pagerank'] })
  const lent = await call('plot', { action: 'preview', spec: { traces: [{ kind: 'scatter', x: 'degree', y: 'metric.pagerank' }] }, points: 20 })
  check('a Stats run over the whole dataset lends metric.pagerank to a chart', m.summary.nodes > 0 && lent.stats.rows === m.summary.nodes && lent.stats.missing === 0 && lent.traces[0].y.length === 20, `${lent.stats.rows} rows, ${lent.stats.missing} missing`)
  const filtered = await call('graph_filter', { replace: true, types: ['incident'] })
  const m2 = await call('graph_metrics', { metrics: ['degree', 'betweenness'] })
  const notLent = await call('plot', { action: 'preview', spec: { traces: [{ kind: 'scatter', x: 'degree', y: 'metric.betweenness' }] } })
  check('a Stats run over a filtered view lends nothing to a whole-dataset chart', filtered.nodes < m.summary.nodes && m2.summary.nodes === filtered.nodes && notLent.stats.missing === notLent.stats.rows, `${notLent.stats.missing} of ${notLent.stats.rows} missing`)
  await call('graph_filter', { clear: true })
  const ran = await call('analyze', { action: 'run', analyses: ['centrality'], top: 1 })
  const viaInsights = await call('plot', { action: 'preview', spec: { traces: [{ kind: 'scatter', x: 'degree', y: 'metric.betweenness' }] }, points: 5 })
  check('an Insights run lends its columns too', ran.nodes > 0 && viaInsights.stats.missing === 0 && viaInsights.stats.rows === ran.nodes, `${viaInsights.stats.rows} rows, ${viaInsights.stats.missing} missing`)

  await call('plot', { action: 'delete', id: saved.id })
  await tidied(evaluate, [saved.id], wasHolding)
}
