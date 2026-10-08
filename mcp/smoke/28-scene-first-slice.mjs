/**
 * A tab opened on a scene builds the scene's picture first, not the whole
 * project's. `?scene=<id>` used to be loaded by an effect after the first
 * render, so the explorer first filtered, styled and seeded positions for
 * whatever its remembered filter kept — on a fresh tab, everything — and
 * threw it away a moment later: for the million-entity WildChat atlas demo,
 * a million nodes and a million edges built for a scene of four thousand,
 * three seconds of main thread and most of a 4 GB heap peak. The scene's
 * filter, project and style now go into the state before the first render.
 *   Here: a wide remembered filter, a scene over twenty nodes, and the
 * page opened on the scene; every filter pass the explorer measures
 * (`gx:filter`) must be the scene's size.
 *   GL=1 node mcp/drive.mjs mcp/smoke/28-scene-first-slice.mjs
 * or `npm run smoke:scene-first-slice`.
 */
import { check, counted, startFrom, tidied } from './lib.mjs'

export default async ({ call, evaluate, sleep }) => {
  await startFrom({ call, evaluate, sleep }, 'fresh')
  await call('open', { page: '/unigraph/2d' })
  await sleep(2000)
  let all = await call('graph_filter', { replace: true })
  if (all.nodes < 50) {
    // The demo opens as a project of its own, on its own first screen: come back to the graph over it.
    await call('load_dataset', { sources: ['knowledge-infrastructure'] })
    await sleep(2500)
    await call('open', { page: '/unigraph/2d' })
    await sleep(2000)
    all = await call('graph_filter', { replace: true })
  }
  check('a graph to begin with', all.nodes >= 50, `${all.nodes} nodes`)
  // Counted once the graph is there: the dataset a fresh profile loads is borrowed, not made by this step.
  const wasHolding = await counted(evaluate)
  const had = new Set(await evaluate(`window.__aegraph.store.library.all().map((e) => e.id)`))
  // The scene: the twenty best-connected nodes, far fewer than everything.
  const narrow = await call('graph_filter', { replace: true, max_nodes: 20 })
  const scene = await call('graph_save', { kind: 'scene', name: 'Smoke first-slice scene' })
  const st = await call('graph_state', { brief: true })
  // Leave the explorer remembering the whole graph, as a fresh tab would, then open the page on the scene.
  await call('graph_filter', { replace: true })
  await sleep(1000)
  await evaluate(`location.assign('/unigraph/2d?scene=' + encodeURIComponent(${JSON.stringify(scene.id)})); 1`)
  await sleep(5000)
  const passes = await evaluate(`performance.getEntriesByType('measure').filter((m) => m.name === 'gx:filter').map((m) => m.detail?.nodes ?? -1)`)
  check('the page opened on the scene filters to the scene, never the whole graph first', passes.length > 0 && passes.every((k) => k === narrow.nodes), `scene ${narrow.nodes} nodes, whole graph ${all.nodes}; filter passes: ${passes.join(', ')}`)
  const mine = [scene.id, st.filterId, st.layoutId, st.renderingId].filter((id) => id && !had.has(id))
  // After the reload the bridge reconnects, and a tool call made while it does can hang with nobody to answer it; the
  // tidy goes through the page instead — the store the tools would have written to — and is checked the same way.
  await evaluate(`window.__aegraph.store.remove(${JSON.stringify(mine)}); 1`)
  await tidied(evaluate, mine, wasHolding)
}
