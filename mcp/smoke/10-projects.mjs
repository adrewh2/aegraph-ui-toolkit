/**
 * Use case 9, "Keep several bodies of work apart, and together", end to end
 * over the bridge: two projects with entities of their own; search and the
 * explorer scoped to the open one; a project that includes the other seeing
 * both; the explorer's remembered state (filter, scene) swapped on a switch;
 * a bundle saved (a browser download into DOWNLOADS) and opened again,
 * merging by id without duplicating. Needs GL=1 (sigma). Run alone with
 * Read, not yet measured (b35). What it needs on the way IN is little: it
 * makes both projects it measures and opens them itself, so a project
 * another step left behind is closed by its own first `project_create
 * {open: true}`, and its library-wide checks (the dedupe search asks for
 * `library: true`) do not care what is in scope. Expected to pass the
 * dirt; whether it passes for the right reasons is the thing to find out,
 * since several of its counts are read from `project_list` rows and move
 * with the scope together.
 *
 * What it does NOT do is say what it leaves behind, and that has cost
 * more than anything else in the suite: when this step fails partway its
 * project stays open, and every step after it is scoped to two notes —
 * thirteen false failures in step 11 at wake-up 141 came from exactly
 * that. Step 7 is the model to copy: it unloads the project it made and
 * *checks* the Dataset stage is back to the workspace, which is why
 * nothing after it was ever poisoned. This one deletes its two projects
 * and then asserts nothing about the scope. The fix is one check at the
 * end — that the app is back on the Library — and it is worth more than
 * a declaration at the top.
 *
 * Two of its checks fail for reasons of their own, both filed: `entities
 * made while a project is open belong to it` on b33 (the count from
 * project_list, not the marking) and `coming back restores the reading
 * group's own explorer state` on b34 (a Unigraph tab's state is keyed by
 * session, so the per-project swap never sees it).
 *   GL=1 node mcp/drive.mjs mcp/smoke/10-projects.mjs
 * or as `npm run smoke:projects`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, counted, tidied } from './lib.mjs'

export default async ({ call, evaluate, sleep }) => {
  const wasHolding = await counted(evaluate)
  // Two projects, each with its own entities and a link.
  const thesis = (await call('project_create', { label: 'Smoke thesis', open: true })).created
  const t1 = await call('create_entity', { type: 'note', label: 'Thesis chapter one', tags: ['smoke-thesis'] })
  const t2 = await call('create_entity', { type: 'note', label: 'Thesis chapter two', tags: ['smoke-thesis'] })
  await call('create_relationship', { source_id: t1.id, target_id: t2.id, type: 'precedes' })
  const reading = (await call('project_create', { label: 'Smoke reading group', open: true })).created
  const r1 = await call('create_entity', { type: 'note', label: 'Reading: chapter notes', tags: ['smoke-reading'] })
  check('entities made while a project is open belong to it', (await call('project_list')).projects.find((p) => p.id === reading.id)?.entities === 1 && (await call('get_entity', { id: t1.id })).meta.projects?.includes(thesis.id), `${thesis.id} / ${reading.id}`)

  // Search and the explorer see only the open project; library: true sees everything.
  const scoped = await call('search_entities', { query: 'chapter' })
  const all = await call('search_entities', { query: 'chapter', library: true })
  check('search is scoped to the open project unless asked for the Library', scoped.results.every((e) => e.id === r1.id) && scoped.results.length === 1 && all.results.length === 3, `${scoped.results.length} scoped, ${all.results.length} in the Library`)
  await call('open', { page: '/unigraph/2d' })
  await sleep(1500)
  const readingView = await call('graph_filter', { replace: true, types: ['note'] })
  check('the explorer shows the open project only', readingView.nodes === 1, `${readingView.nodes} notes in the reading group`)
  const scene = await call('graph_save', { kind: 'scene', name: 'Reading notes' })

  // Switch to the thesis: its own view; the reading group's scene is not in its list.
  await call('project_open', { id: thesis.id, route: '/unigraph/2d' })
  await sleep(2000)
  const thesisView = await call('graph_filter', { replace: true, types: ['note'] })
  check('switching projects swaps the explorer to the other body of work', thesisView.nodes === 2 && thesisView.edges === 1, `${thesisView.nodes} notes, ${thesisView.edges} links`)
  const thesisScenes = await call('search_entities', { type: 'scene' })
  check('the other project\'s scene is not part of this one', !thesisScenes.results.some((s) => s.id === scene.id), thesisScenes.results.map((s) => s.label).join(', ') || '(none)')
  await call('graph_filter', { replace: true, types: ['note'], text: 'two' })
  const st1 = await call('graph_state', { brief: true })
  check('a filter set in the thesis narrows its view', st1.nodes === 1, `${st1.nodes} node`)

  // Back to the reading group: its remembered state comes back; the thesis keeps its own.
  await call('project_open', { id: reading.id, route: '/unigraph/2d' })
  await sleep(2000)
  const back = await call('graph_state', { brief: true })
  check('coming back restores the reading group\'s own explorer state', back.nodes === 1 && !JSON.stringify(back.filter ?? {}).includes('two'), JSON.stringify(back).slice(0, 160))
  await call('project_open', { id: thesis.id, route: '/unigraph/2d' })
  await sleep(2000)
  const again = await call('graph_state', { brief: true })
  check('and the thesis keeps the filter it had', again.nodes === 1 && JSON.stringify(again.filter ?? {}).includes('two'), JSON.stringify(again.filter).slice(0, 120))
  await call('graph_filter', { clear: true })

  // Together: the thesis includes the reading group and sees both.
  const inc = await call('project_update', { id: thesis.id, includes: [reading.id] })
  await sleep(800)
  const both = await call('search_entities', { query: 'chapter' })
  const bothView = await call('graph_filter', { replace: true, types: ['note'] })
  check('a project that includes another sees the entities of both', inc.updated.includes.includes(reading.id) && both.results.length === 3 && bothView.nodes === 3, `${both.results.length} found, ${bothView.nodes} in view`)
  await call('project_update', { id: thesis.id, includes: [] })

  // A bundle out, and back in: merged by id, nothing duplicated.
  const saved = await call('project_save', { id: thesis.id, format: 'json', route: '/unigraph/2d' })
  check('the thesis saves as a bundle', saved.count >= 3 && /\.ae\.json$|\.aegraph\.json$/.test(saved.filename), JSON.stringify(saved).slice(0, 140))
  let file
  for (let i = 0; i < 60 && !file; i++) {
    file = readdirSync(process.env.DOWNLOADS).find((f) => f === saved.filename)
    if (!file) await sleep(500)
  }
  check('the bundle file landed in the downloads folder', !!file, readdirSync(process.env.DOWNLOADS).join(', '))
  const text = readFileSync(join(process.env.DOWNLOADS, file), 'utf8')
  const bundle = JSON.parse(text)
  check('the bundle carries the project, its entities and the screen state', bundle.project && Array.isArray(bundle.entities) && bundle.entities.some((e) => e.id === t1.id) && bundle.state?.route === '/unigraph/2d', `${bundle.entities?.length} entities, route ${bundle.state?.route}`)
  const before = (await call('project_list')).projects.find((p) => p.id === thesis.id)
  const opened = await call('project_open_bundle', { text })
  await sleep(1500)
  const after = (await call('project_list')).projects.find((p) => p.id === thesis.id)
  const t1After = await call('get_entity', { id: t1.id })
  check('opening the bundle merges by id: same project, same entities, nothing duplicated', opened.opened.id === thesis.id && opened.created === 0 && after.entities === before.entities && t1After.label === 'Thesis chapter one' && (await call('search_entities', { query: 'chapter one', library: true })).results.length === 1, JSON.stringify({ created: opened.created, updated: opened.updated, upToDate: opened.upToDate, entities: after.entities }))

  // Tidy: both projects and what they hold.
  await call('project_delete', { id: thesis.id, exclusive_entities: true })
  await call('project_delete', { id: reading.id, exclusive_entities: true })
  await tidied(evaluate, [thesis.id, reading.id, t1.id], wasHolding)
}
