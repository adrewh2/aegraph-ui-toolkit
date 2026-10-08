/**
 * Use case 7, "Iterate an analysis into a subset", end to end over the
 * bridge: metrics on the view → export the view as a project (the metric
 * columns become project values) → load the project as the Dataset stage
 * → filter on data.pagerank, which a filter can only read this way. Needs
 * GL=1 (sigma in headless Chrome); loads the Knowledge Infrastructure demo
 * when the view is empty. Run alone with
 * Read, not yet measured (b35): like step 6 it opens on a threshold of
 * at least twenty nodes in view, so a leftover project or filter decides
 * whether it can start at all; and its later checks compare the narrowed
 * view against that same first count, so both sides move with the scope
 * together. Expected to want the Library with a fresh view. It is also a
 * good citizen at the end — it unloads the project it made and checks
 * the Dataset stage is back to the workspace — which is why the steps
 * after it have not been poisoned by this one.
 *   GL=1 node mcp/drive.mjs mcp/smoke/7-iterate.mjs
 * or as `npm run smoke:iterate`.
 */
import { check, counted, tidied } from './lib.mjs'

export default async ({ call, evaluate, sleep }) => {
  const wasHolding = await counted(evaluate)
  await call('open', { page: '/unigraph/2d' })
  await sleep(2000)
  // A few hundred best-connected nodes: a fresh profile opens the default project (the aegraph-ui system map), and
  // the chain below reads the same whether the view is drawn or gated, so keep it light.
  const view = () => call('graph_filter', { replace: true, max_nodes: 400 })
  let f = await view()
  if (f.nodes < 20) {
    // The demo opens as a project of its own, on its own first screen: come back to the graph over it.
    await call('load_dataset', { sources: ['knowledge-infrastructure'] })
    await sleep(2500)
    await call('open', { page: '/unigraph/2d' })
    await sleep(2000)
    f = await view()
  }
  check('a graph is in view, under the budget', f.nodes >= 20 && !f.gated, `${f.nodes} nodes${f.gated ? ' (gated)' : ''}`)

  // A filter without metrics is refused with the recipe: the filter runs before the analysis.
  const refused = await call('graph_filter', { fields: [{ path: 'metric.pagerank', op: 'gte', value: 0.01 }] }).then(() => null, (e) => e.message)
  check('a filter on metric.* is refused with the export recipe', !!refused && /graph_project/.test(refused), String(refused).slice(0, 120))

  // Metrics on the whole view.
  const m = await call('graph_metrics', { metrics: ['degree', 'pagerank', 'community'] })
  check('metrics computed over the view', m.summary.nodes === f.nodes && !!m.metrics.pagerank?.top?.length, `${m.summary.nodes} nodes, ${Object.keys(m.metrics).join(',')}`)

  // Export the view as a project: members plus the metric columns as values.
  const exported = await call('graph_project', { action: 'export', name: 'Smoke ranked view' })
  check('the view exports as a project with its analysis', exported.includedAnalysis === true && exported.nodes === f.nodes, JSON.stringify(exported).slice(0, 160))
  const got = await call('graph_project', { action: 'get', id: exported.id })
  check('the project carries the metric columns as values', got.members >= f.nodes && ['degree', 'pagerank', 'community'].every((k) => got.valueKeys.includes(k)), `members ${got.members}, values ${JSON.stringify(got.valueKeys)}`)

  // Load it: the Dataset stage is the project, and its values read as data.<metric>.
  const loaded = await call('graph_project', { action: 'load', id: exported.id })
  check('loading the project offers its values as data.* fields', loaded.valueKeys.includes('data.pagerank'), JSON.stringify(loaded.valueKeys))
  await sleep(500)
  const st = await call('graph_state', { brief: false })
  check("graph_state's dataset is the project, with the chain as its breadcrumb", st.dataset?.source === 'project' && st.dataset.projectId === exported.id && Array.isArray(st.dataset.breadcrumb) && st.dataset.breadcrumb.length >= 2, JSON.stringify(st.dataset).slice(0, 200))

  // Filter on the exported PageRank: the view narrows to the top of the graph.
  // The tenth-highest PageRank (or the mean on a small graph): about ten nodes should pass.
  const ranked = m.metrics.pagerank
  const cut = ranked.top[Math.min(9, ranked.top.length - 1)]?.value ?? ranked.mean
  const narrowed = await call('graph_filter', { replace: true, max_nodes: 400, fields: [{ path: 'data.pagerank', op: 'gte', value: cut }] })
  check('a field filter on data.pagerank narrows the view', narrowed.nodes > 0 && narrowed.nodes < f.nodes, `${narrowed.nodes} of ${f.nodes} nodes at pagerank ≥ ${cut}`)
  const rows = await call('graph_query', { selector: {}, values: ['data.pagerank'], limit: 5 })
  check('the narrowed nodes read their PageRank as data', rows.rows.length > 0 && rows.rows.every((r) => Number(r.values['data.pagerank']) >= cut), JSON.stringify(rows.rows[0]).slice(0, 160))

  // Back to the workspace: the filter still names data.pagerank, which nothing carries now, so the view is empty of it.
  const un = await call('graph_project', { action: 'unload' })
  await sleep(400)
  const after = await call('graph_state', { brief: false })
  check('unloading returns the Dataset stage to the workspace', un.dataset === 'workspace' && after.dataset?.source === 'workspace', JSON.stringify(after.dataset).slice(0, 120))
  await call('graph_filter', { clear: true })
  await call('delete_entities', { ids: [exported.id] })
  await tidied(evaluate, [exported.id], wasHolding)
}
