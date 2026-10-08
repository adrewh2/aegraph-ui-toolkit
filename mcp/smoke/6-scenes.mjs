/**
 * Scenes and physics over the bridge: a save while the simulation runs keeps
 * the picture on screen, a store write mid-physics does not reset it, loading
 * the scene restores exactly what was saved with physics off, and physics
 * resumes from there. Needs GL=1 (sigma in headless Chrome) and a project with
 * a graph in it — the step loads the Knowledge Infrastructure demo when the
 * view is empty. Run alone with
 * Read, not yet measured (b35): it opens by asking for at least twenty
 * nodes in view, which is a threshold over whatever scope is open — a
 * project another step left open, or a filter left in the explorer,
 * takes the slice below it and everything after depends on that slice.
 * So it is expected to want the Library with a fresh view; no
 * declaration has been put on it, because that expectation has not been
 * run against a profile dirtied on purpose and an unearned declaration
 * reads as evidence the step was understood.
 *   GL=1 node mcp/drive.mjs mcp/smoke/6-scenes.mjs
 * or as `npm run smoke:scenes`.
 */
import { check, counted, tidied } from './lib.mjs'

const dist = (ids, a, b) => ids.reduce((m, id) => Math.max(m, a?.[id] && b?.[id] ? Math.hypot(a[id].x - b[id].x, a[id].y - b[id].y) : 0), 0)

export default async ({ call, evaluate, sleep }) => {
  const wasHolding = await counted(evaluate)
  // The ids that were here before anything was made: the scene's parts may be older than this run (a saved layout
  // the demo ships, a filter left by a previous one), and a tidy that deletes them takes away what it did not make.
  const had = new Set(await evaluate(`window.__aegraph.store.library.all().map((e) => e.id)`))
  const positions = async () => (await call('graph_positions', { action: 'get' })).positions
  await call('open', { page: '/unigraph/2d' })
  await sleep(2000)
  // A few hundred best-connected nodes: enough for physics to have work, small enough to stay under the view budget
  // (a gated view has no renderer, so physics would have nothing to move).
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
  await call('graph_layout', { algorithm: 'force', recompute: true, fit: false })
  await sleep(1500)
  const p0 = await positions()
  const ids = Object.keys(p0)
  const span = Math.max(1, ...ids.map((i) => Math.abs(p0[i].x)))

  // Physics on, then a save: the layout entity holds the running picture, not the pre-physics one.
  await call('graph_layout', { physics: true })
  await sleep(2500)
  const scene = await call('graph_save', { kind: 'scene', name: 'Smoke physics scene' })
  const st = await call('graph_state', { brief: true })
  const saved = (await call('get_entity', { id: st.layoutId })).data.positions
  const movedAtSave = dist(ids, saved, p0)
  check('scene saved during physics keeps the running picture', movedAtSave > span * 0.01, `moved ${movedAtSave.toFixed(0)} of span ${span.toFixed(0)}`)

  // A store write while physics runs (saving a filter) must not snap the picture back to the held positions.
  const before = await positions()
  const savedFilter = await call('graph_save', { kind: 'filter', name: 'Smoke physics filter' })
  await sleep(600)
  const after = await positions()
  check('a store write mid-physics does not reset the picture', dist(ids, after, p0) >= dist(ids, before, p0) * 0.5, `before ${dist(ids, before, p0).toFixed(0)} after ${dist(ids, after, p0).toFixed(0)}`)
  await call('graph_layout', { physics: false })
  await sleep(500)

  // Perturb, then load the scene: exactly the saved positions, physics off.
  await call('graph_layout', { algorithm: 'random', recompute: true, fit: false })
  await sleep(1000)
  await call('open', { page: `/unigraph/2d?scene=${scene.id}` })
  await sleep(2500)
  const loaded = await positions()
  const st2 = await call('graph_state', { brief: true })
  check('loading the scene restores the saved positions', dist(ids, loaded, saved) < 1e-6, `max diff ${dist(ids, loaded, saved)}`)
  check('the scene loads with physics off and its algorithm', st2.physics === false && st2.algorithm === 'force', `physics ${st2.physics} algorithm ${st2.algorithm}`)

  // Physics resumes from there: nodes move, continuously, from the loaded positions.
  await call('graph_layout', { physics: true })
  await sleep(500)
  const resumed = await positions()
  await call('graph_layout', { physics: false })
  const drift = dist(ids, resumed, saved)
  check('physics resumes from the loaded positions', drift > 0, `moved ${drift.toFixed(0)} in 0.5 s`)

  // Tidy: the entities this step made.
  // (delete_entities asks the user to confirm in the tab; the driver auto-accepts that dialog.)
  // The filter saved mid-physics is its own entity: it is not the one the scene points at, and leaving it out
  // of this list is how the step grew the shared profile by one filter every run it ever made.
  const mine = [scene.id, savedFilter.id, st.layoutId, st.filterId, st.renderingId].filter((id) => id && !had.has(id))
  await call('delete_entities', { ids: mine })
  await tidied(evaluate, mine, wasHolding)
}
