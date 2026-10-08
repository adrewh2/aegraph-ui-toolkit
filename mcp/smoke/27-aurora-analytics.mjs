/**
 * The analytics the headless engine authored, opened in the app.
 *
 * The Aurora demo's generator (aegraph-ui-demos, generators/aurora) writes
 * its scripts, charts and Unigraph scenes with no browser at all — it drives
 * src/headless over MCP — and the bundle carries them. That only counts if the
 * app makes the same picture of them, so this run loads Aurora, opens each
 * scene in Unigraph and checks the canvas has the nodes the scene claims
 * and the style it was given, runs each script in the page's own sandbox,
 * and computes every chart. Anything composed headlessly that the renderer
 * cannot read shows up here as a scene with an empty canvas.
 *   GL=1 node mcp/drive.mjs mcp/smoke/27-aurora-analytics.mjs
 * or `npm run smoke:aurora`. Needs the demos in public/demos/ (the dev
 * server's predev step fetches them from the aegraph-ui-demos checkout).
 */
import { writeFileSync } from 'node:fs'
import { check, startFrom } from './lib.mjs'

/**
 * Whether the picture is on the canvas: frames drawn, and nothing thrown. Node counts come from `graph_state`, the
 * view's own account of its slice — the engine's `nodeCount` is its buffer's capacity, which keeps the high-water
 * mark of every scene opened before this one and reads as hundreds of nodes in a scene of forty.
 */
const SHOT = `(() => {
  const gpu = (window.__aegraphGpuGraphs?.handles ?? []).at(-1)
  const e = gpu?.engine
  const ex = e?.extent?.()
  const cam = e?.camera
  // Is the picture actually in front of the camera? The visible world rectangle (the camera's viewport in CSS
  // pixels over its scale, as camera.worldX does) against the graph's own extent.
  let framed = null
  if (ex && cam && cam.width > 1) {
    const w = cam.width / cam.scale
    const h = cam.height / cam.scale
    const vis = { minX: cam.x - w / 2, maxX: cam.x + w / 2, minY: cam.y - h / 2, maxY: cam.y + h / 2 }
    const overlap = Math.max(0, Math.min(ex.maxX, vis.maxX) - Math.max(ex.minX, vis.minX)) * Math.max(0, Math.min(ex.maxY, vis.maxY) - Math.max(ex.minY, vis.minY))
    const area = Math.max(1, (ex.maxX - ex.minX) * (ex.maxY - ex.minY))
    framed = Math.round((overlap / area) * 100) / 100
  }
  return { route: location.pathname + location.search, capacity: e?.graph?.nodeCount ?? -1, frames: e?.stats?.frames ?? -1, framed, errors: (window.__aegraphErrors ?? []).length }
})()`

export default async ({ call, evaluate, sleep, client }) => {
  await startFrom({ call, evaluate, sleep }, 'fresh')

  // ── Aurora, as the Demos tab opens it: the demo's bundle by URL, from the catalog ──
  // Everything here is asked of the tools rather than of `window.__aegraph.store`: opening a project remounts the
  // app, and the store the page had put on `window` before the remount is not the one the app is using after it —
  // a check that reads it sees an empty Library and calls a loaded dataset missing.
  await sleep(2500)
  const bundleUrl = await evaluate(`fetch('/demos/catalog.json').then((r) => (r.ok ? r.json() : null)).then((c) => c?.demos?.find((d) => d.id === 'aurora')?.bundleUrl ?? null)`)
  check('the demos catalog has Aurora', !!bundleUrl, String(bundleUrl))
  if (!bundleUrl) return
  const opened = await call('project_open_bundle', { url: bundleUrl })
  const project = opened.opened?.id
  const analyticsOf = async () => (await call('search_entities', { tag: 'analytics', limit: 100 })).results ?? []
  let found = []
  for (let i = 0; i < 30 && found.length < 38; i++) {
    await sleep(500)
    found = await analyticsOf()
  }
  if (project) await call('project_open', { id: project })
  check('Aurora opens as a project', !!project && found.length >= 38, JSON.stringify({ created: opened.created, updated: opened.updated, entities: opened.opened?.entities, analytics: found.length }))

  const authored = {
    scripts: found.filter((e) => e.type === 'script' || e.type.startsWith('script:')),
    plots: found.filter((e) => e.type === 'plot'),
    scenes: found.filter((e) => e.type.startsWith('scene')),
    parts: found.filter((e) => ['filter', 'layout', 'rendering', 'analysis'].includes(e.type)).length,
  }
  check('the dataset carries what was authored headlessly', authored.scenes.length >= 5 && authored.scripts.length >= 8 && authored.plots.length >= 5 && authored.parts >= 15, JSON.stringify({ scenes: authored.scenes.length, scripts: authored.scripts.length, charts: authored.plots.length, parts: authored.parts }))

  // ── Every scene: opened in Unigraph, drawn, with its own filter/layout/style ──
  // Opening the project lands on its home route — the Workstation, with a scene of its own in a pane. The scenes
  // below want the explorer *page*: go there first, and let the project's own landing finish before asking.
  await sleep(2000)
  await call('open', { page: '/unigraph/2d' })
  await sleep(2500)
  /**
   * What the explorer holds: which scene it loaded and which parts came with it — read through `graph_state`, which
   * finds the explorer the app is actually showing. Reading the last registered handle instead sees whichever
   * explorer was made last, which on a page with panes is not the one in front, and the run then checks a picture
   * nobody is looking at.
   */
  const loadedFrom = (state) => ({ filterId: state.filterId, layoutId: state.layoutId, renderingId: state.renderingId, sceneId: state.sceneId, algorithm: state.algorithm })

  for (const s of authored.scenes) {
    const d = (await call('get_entity', { id: s.id })).data ?? {}
    const want = { nodes: d.stats?.nodes ?? -1, edges: d.stats?.edges ?? -1, renderer: d.renderer, algorithm: d.algorithm, filterId: d.filterId, layoutId: d.layoutId, renderingId: d.renderingId }
    let shot = {}
    let state = {}
    let loaded = {}
    // The scene loads its parts, the engine rebuilds and the saved positions land; a 3D scene also flies its camera.
    for (let attempt = 0; attempt < 3; attempt++) {
      await call('open', { page: `/unigraph/${want.renderer === '3d' ? '3d' : '2d'}?scene=${s.id}` })
      let ok = false
      for (let i = 0; i < 20 && !ok; i++) {
        await sleep(400)
        state = await call('graph_state', { brief: true })
        loaded = loadedFrom(state)
        shot = await evaluate(SHOT)
        ok = loaded.sceneId === s.id && state.nodes === want.nodes && shot.frames > 0
      }
      if (ok) break
    }
    check(`scene “${s.label}” shows what it saved`, state.nodes === want.nodes && state.edges === want.edges && shot.frames > 0, JSON.stringify({ wanted: want, shown: { nodes: state.nodes, edges: state.edges, frames: shot.frames }, errors: shot.errors }))
    // A scene composed with no camera of its own used to open on the last one's, with the picture off the corner of
    // the canvas; the app frames it on its own positions instead. Sampled until it settles: the framing flies into
    // place, and a reading taken mid-flight is of a camera still moving. 2D only — the 3D camera is an orbit.
    if (want.renderer !== '3d') {
      let framed = shot.framed ?? 0
      for (let i = 0; i < 12 && framed < 0.9; i++) {
        await sleep(400)
        framed = Math.max(framed, (await evaluate(SHOT)).framed ?? 0)
      }
      check(`  and opens framed on it`, framed >= 0.9, `${Math.round(framed * 100)}% of the picture is in view`)
    }
    // SHOTS=<dir> also writes a picture of each scene as the app draws it — for looking at the result, not testing it.
    if (process.env.SHOTS) {
      const r = await client.callTool({ name: 'gpu_graph', arguments: { action: 'snapshot', max_width: 1400 } })
      const img = r.content.find((c) => c.type === 'image')
      if (img) writeFileSync(`${process.env.SHOTS}/${s.id}.jpg`, Buffer.from(img.data ?? img.source?.data ?? '', 'base64'))
    }
    // The parts are entities, and loading the scene loads all three: the filter it was composed with, the positions
    // computed headlessly (so nothing is laid out again), and the style, which the state describes in words.
    check(`  and loads the filter, layout and style it was composed with`, loaded.sceneId === s.id && loaded.filterId === want.filterId && loaded.layoutId === want.layoutId && loaded.renderingId === want.renderingId, JSON.stringify({ loaded, want, style: state.style, layout: state.layout }).slice(0, 300))
  }

  // ── Every script: run in the page's sandbox, as the Scripts page runs it ──
  for (const s of authored.scripts) {
    const r = await call('script', { action: 'run', id: s.id })
    const outputs = r.outputs ?? []
    const kinds = outputs.map((o) => o.kind ?? o.type).join(',')
    const ok = !r.error && outputs.length > 0
    check(`script “${s.label}” runs (${kinds || 'no output'})`, ok, r.error ?? JSON.stringify({ summary: r.summary, ms: r.ms, logs: (r.logs ?? []).slice(0, 1) }).slice(0, 220))
  }

  // ── Every chart: computed from the spec over the real dataset ──
  for (const p of authored.plots) {
    const r = await call('plot', { action: 'get', id: p.id })
    const points = (r.traces ?? []).reduce((n, t) => n + (t.points ?? 0), 0)
    check(`chart “${p.label}” computes points`, points > 0, JSON.stringify({ traces: (r.traces ?? []).length, points, rows: r.stats?.rows }))
  }

  // ── The sidebar: Analytics carries its numbers, as Resources does ──
  const rows = await evaluate(`Object.fromEntries([...document.querySelectorAll('.sb-item, .sb-child')].map((el) => [(el.querySelector('.sb-item__label, .sb-child__label')?.textContent ?? el.textContent ?? '').trim(), Number((el.querySelector('.sb-item__count')?.textContent ?? '').replace(/[^0-9]/g, '')) || 0]))`)
  const wanted = { Scenes: authored.scenes.length, Scripts: authored.scripts.length, Charts: authored.plots.length }
  check('the sidebar counts what Analytics keeps', Object.entries(wanted).every(([row, least]) => (rows[row] ?? 0) >= least) && (rows.Analytics ?? 0) >= Object.values(wanted).reduce((a, b) => a + b, 0), JSON.stringify({ Analytics: rows.Analytics, Scenes: rows.Scenes, Scripts: rows.Scripts, Charts: rows.Charts, Datasets: rows.Datasets, atLeast: wanted }))

  // ── The lists: every saved thing says how much it holds ──
  // A chart of five hundred rows and one of five read the same without it, and a scene says nothing about the size
  // of its picture. The counts come off what was recorded when the thing was saved (`summary`, `stats`), and for
  // Aurora's older charts and scenes that is what the demo's generator computed headlessly and merged.
  for (const [page, noun] of [['/analytics/charts', 'chart'], ['/scenes', 'scene'], ['/analytics/scripts', 'script']]) {
    await call('open', { page })
    let cards = []
    for (let i = 0; i < 20; i++) {
      await sleep(400)
      // One entry per card: its name and the line under it, which is where the count is written.
      cards = await evaluate(`[...document.querySelectorAll('.si__card')].map((el) => ({ title: el.querySelector('.si__title')?.textContent ?? '', meta: el.querySelector('.si__meta')?.textContent ?? '' })).filter((c) => c.title.startsWith('Aurora'))`)
      if (cards.length) break
    }
    // "516 rows", "2K rows", "132 nodes · 141 edges", "42 lines" — the number is formatted, so K and M count.
    const has = (c) => /\d[\d.,]*[KM]?\s(rows?|nodes|placed|lines?|traces?)/.test(c.meta)
    const missing = cards.filter((c) => !has(c))
    check(`the ${noun} list shows how much each one holds`, cards.length > 0 && missing.length === 0, `${cards.length - missing.length} of ${cards.length} say so${missing.length ? ` — e.g. “${missing[0].title}”: ${JSON.stringify(missing[0].meta)}` : ''}`)
  }

  // Aurora is the dataset, not this run's litter: it stays, as the Datasets page would leave it.
  await call('project_open', {})
}
