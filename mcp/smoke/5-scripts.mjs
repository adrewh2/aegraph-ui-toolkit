/**
 * The Scripts tool over the bridge: every engine, every action. Needs GL=1
 * for the visual engine (WebGL in headless Chrome) and public/pyodide +
 * public/vendor in place (npm run pyodide / vendor). Run alone with
 * Starts from the Library (b35). It reads the demo's incidents and
 * services through ds.byType, so what it can see is whatever scope is
 * open; and it used to assert only that "a project is open", which is a
 * fact about the profile rather than about this step — true on a fresh
 * profile because the system map opens there, true or false on a shared
 * one by whatever the last step left, and in neither case the thing the
 * scripts depend on. It now asks for the rows themselves.
 * One check still fails, and not from the profile: "a visual frame
 * survives leaving the page" reports the frame marked and positioned
 * over its host but not shown. The wait before it was a guessed 900ms
 * and is now a poll, which is better but did not fix it — a probe doing
 * the same three tool calls in isolation, save_as and all, finds the
 * frame at display block and visibility visible both before and after.
 * So something earlier in this step leaves it otherwise. See b39.
 *   GL=1 node mcp/drive.mjs mcp/smoke/5-scripts.mjs
 * or as part of `npm run smoke:scripts`.
 */
import { readFileSync } from 'node:fs'
import { startFrom } from './lib.mjs'

const results = []
const check = (name, ok, detail = '') => results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${String(detail).slice(0, 140)}` : ''}`)

export default async ({ call, evaluate, sleep, logs }) => {
  await startFrom({ call, evaluate, sleep }, 'library')
  const run = async (args) => {
    try {
      return await call('script', args)
    } catch (e) {
      return { toolError: String(e.message) }
    }
  }
  const ctx = await call('get_app_context')
  // What the scripts below actually need is the demo's incidents and services in view. This asked instead
  // whether *a* project was open, which is a fact about the profile and not about this step: on a fresh profile
  // the system map opens and it passed, on the shared one it passed or failed by whatever the last step left,
  // and either way the scripts read the same rows. Ask for the rows (b35).
  check('the demo the scripts read is in view', (ctx.counts?.incident ?? 0) > 0 && (ctx.counts?.service ?? 0) > 0, `${ctx.counts?.incident ?? 0} incidents, ${ctx.counts?.service ?? 0} services, in ${ctx.project?.label ?? 'the Library'}`)
  const api = await run({ action: 'api', language: 'python' })
  check('api text', typeof api === 'string' && api.includes('by_type'))

  // JavaScript (QuickJS)
  let r = await run({ action: 'run', language: 'js', code: "const inc = ds.byType('incident'); const m = rollup(inc, (e) => bin(e.data.startedAt, 'month'), (e) => e.data.duration_min, 'median'); return figure([line(m.map((x) => x.key), m.map((x) => x.value), { name: 'mttr' })], { title: 'MTTR' })" })
  check('js figure', /figure/.test(r.summary ?? '') && r.outputs?.[0]?.traces?.length === 1, r.summary ?? r.error)
  r = await run({ action: 'run', code: "return table(ds.byType('service').map((e) => ({ id: e.id, deg: ds.degree(e.id) })))" })
  check('js table', /table/.test(r.summary ?? ''), r.summary ?? r.error)
  r = await run({ action: 'run', code: "const p = {}; ds.byType('service').forEach((e, i) => { p[e.id] = { x: i * 50, y: (i % 3) * 40 } }); return scene(p, { label: 'grid' })" })
  check('js scene', /scene/.test(r.summary ?? ''), r.summary ?? r.error)
  r = await run({ action: 'run', code: 'while (true) {}', timeout_ms: 500 })
  check('js interrupt', /interrupt/i.test(r.error ?? ''), r.error)
  r = await run({ action: 'run', code: "return fetch('https://example.com')" })
  check('js no fetch', /fetch.*not defined/i.test(r.error ?? ''), r.error)

  // Python (Pyodide). 60s is the most the tool's schema allows; these asked for 90s and were refused outright
  // once the tools began checking their inputs, which is what the three Python failures in the table were.
  // Python (Pyodide)
  const t0 = Date.now()
  r = await run({ action: 'run', language: 'python', timeout_ms: 60000, code: "import plotly.express as px\ninc = by_type('incident')\ninc['month'] = inc['startedAt'].dt.to_period('M').dt.to_timestamp()\nm = inc.groupby('month')['duration_min'].median().reset_index()\npx.line(m, x='month', y='duration_min')" })
  check('py boot + plotly express', /figure/.test(r.summary ?? ''), `${Date.now() - t0}ms · ${r.summary ?? r.error ?? r.toolError}`)
  r = await run({ action: 'run', language: 'python', code: "entities.groupby('type').size()" })
  check('py DataFrame → table', /table/.test(r.summary ?? ''), r.summary ?? r.error)
  r = await run({ action: 'run', language: 'python', timeout_ms: 60000, code: "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.bar(['a', 'b'], [1, 2])\nfig" })
  check('py matplotlib → image', /image/.test(r.summary ?? ''), r.summary ?? r.error)
  r = await run({ action: 'run', language: 'python', timeout_ms: 60000, code: "g = graph()\nf'{len(g.nodes)} nodes'" })
  check('py graph() loads networkx', /nodes/.test(r.outputs?.[0]?.text ?? ''), r.outputs?.[0]?.text ?? r.error)
  r = await run({ action: 'run', language: 'python', code: "import asyncio\nawait asyncio.sleep(0)\nprint('slept')\n'awaited'" })
  check('py top-level await', r.outputs?.[0]?.text === 'awaited' && r.logs?.includes('slept'), r.error ?? r.outputs?.[0]?.text)
  r = await run({ action: 'run', language: 'python', code: "from js import fetch\nr = await fetch('https://example.com')\nr.status" })
  check('py fetch blocked by CSP', /Failed to fetch|NetworkError/.test(r.error ?? ''), r.error ?? JSON.stringify(r.outputs))
  r = await run({ action: 'run', language: 'python', code: "print('hi')\n1/0" })
  check('py error keeps logs, drops harness frames', /ZeroDivision/.test(r.error ?? '') && r.logs?.includes('hi') && !/<exec>|prelude/.test(r.stack ?? ''), r.error)

  // Visual (sandboxed iframe)
  r = await run({ action: 'run', language: 'view', timeout_ms: 20000, code: "import * as THREE from 'three'\nconst gl = new THREE.WebGLRenderer().getContext(); console.log('gl', typeof gl.drawArrays === 'function')\nlet f = 'no'; try { await fetch('https://example.com') } catch { f = 'blocked' }\nlet ls = 'no'; try { localStorage.getItem('x') } catch { ls = 'throws' }\naegraph.result({ text: `fetch ${f} · localStorage ${ls}` })" })
  check('view three.js + WebGL + isolation', r.outputs?.[0]?.text === 'fetch blocked · localStorage throws' && (r.logs ?? []).includes('gl true'), r.outputs?.[0]?.text ?? r.error)

  // Save / list / get / show / delete
  r = await run({ action: 'save', code: "return { text: 'saved' }", name: 'Smoke script' })
  check('save', !!r.id)
  const id = r.id
  const g = await run({ action: 'get', id })
  check('get', g.code?.includes('saved') && g.language === 'js')
  const l = await run({ action: 'list' })
  check('list', !!l.scripts?.some((s) => s.id === id))
  const s = await run({ action: 'show', id })
  check('show a saved script on the page', s.shown === true && /text/.test(s.summary ?? ''), s.summary ?? s.error)
  const tpl = readFileSync(new URL('../../src/features/scripts/examples/constellations.js', import.meta.url), 'utf8')
  const t1 = Date.now()
  r = await run({ action: 'show', language: 'view', timeout_ms: 30000, code: tpl })
  await sleep(1500)
  const frames = await evaluate(`[...document.querySelectorAll('iframe')].filter((f) => (f.getAttribute('sandbox') ?? '').includes('allow-scripts')).length`)
  check('Constellations template renders', r.shown === true && /table/.test(r.summary ?? '') && frames > 0, `${Date.now() - t1}ms · ${r.summary ?? r.error}`)
  // A show with save_as while another script is open writes its run to the new script, not the one the page was on.
  const b = await run({ action: 'show', code: "return { text: 'B' }", save_as: 'Smoke script B' })
  const ga = await run({ action: 'get', id }), gb = await run({ action: 'get', id: b.id })
  check('runs are attributed to their own script', gb.lastRun?.summary === 'text · 1 chars' && ga.lastRun?.summary === 'text · 5 chars', `${ga.lastRun?.summary} / ${gb.lastRun?.summary}`)
  await call('open', { page: '/entities' }); await sleep(500)
  await call('open', { page: '/scripts' }); await sleep(800)
  const back = await evaluate('location.search')
  check('a bare /scripts reopens the last script', back.includes(b.id), back)
  // Leaving the page keeps the last result: a visual frame is hidden, not ended, and shown again on return without a run.
  const v = await run({ action: 'show', language: 'view', timeout_ms: 20000, save_as: 'Smoke visual', code: "document.getElementById('app').textContent = 'alive'; aegraph.result({ text: 'shown' })" })
  await sleep(400)
  await evaluate(`document.querySelector('iframe.sc__view').dataset.mark = 'kept'`)
  await call('open', { page: '/entities' }); await sleep(500)
  await call('open', { page: '/scripts' })
  // Wait for the frame to be put back over its host rather than sampling at a guessed moment: the page remounts
  // and the frame is shown a beat later, so a single reading at 900ms caught it mid-return and called it hidden.
  const FRAME = `(() => { const f = document.querySelector('iframe.sc__view'); const h = document.querySelector('.sc__viewhost'); if (!f || !h) return {}; const a = f.getBoundingClientRect(), b = h.getBoundingClientRect(); return { mark: f.dataset.mark, shown: f.style.display !== 'none' && f.style.visibility === 'visible', over: Math.abs(a.left - b.left) < 2 && Math.abs(a.width - b.width) < 2 } })()`
  let kept = {}
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    kept = await evaluate(FRAME)
    if (kept.mark === 'kept' && kept.shown && kept.over) break
  }
  check('a visual frame survives leaving the page', kept.mark === 'kept' && kept.shown && kept.over, JSON.stringify(kept))
  await call('open', { page: '/scripts?script=' + b.id }); await sleep(700)
  const txt = await evaluate(`document.querySelector('.sc__output--text')?.textContent ?? ''`)
  check('another script shows its own last result', txt.includes('B'), txt)
  // What a visual script remembers comes back on its next run (per script, in this browser).
  const m = await run({ action: 'show', language: 'view', timeout_ms: 20000, save_as: 'Smoke memory', code: "const n = aegraph.recall('runs', 0) + 1; aegraph.remember('runs', n); aegraph.result({ text: 'run ' + n })" })
  await sleep(600)
  const m2 = await run({ action: 'show', id: m.id })
  check('aegraph.remember/recall across runs', m.outputs?.[0]?.text === 'run 1' && m2.outputs?.[0]?.text === 'run 2', `${m.outputs?.[0]?.text} → ${m2.outputs?.[0]?.text}`)
  // edit: one unique find/replace on a saved script, without resending it.
  const ed = await run({ action: 'edit', id, find: "'saved'", replace: "'edited'" })
  const ge = await run({ action: 'get', id })
  const bad = await run({ action: 'edit', id, find: 'nope', replace: 'x' })
  check('edit replaces one unique piece', ed.id === id && ge.code.includes("'edited'") && /not found/.test(bad.toolError ?? ''), `${ge.code.slice(0, 40)} · ${bad.toolError?.slice(0, 40)}`)
  const d = await run({ action: 'delete', id })
  check('delete', d.deleted === true)
  for (const x of [b.id, v.id, m.id]) await run({ action: 'delete', id: x })

  console.log(results.join('\n'))
  const errors = logs.filter((l) => /error/i.test(l) && !/font cache/i.test(l))
  if (errors.length) console.log(`console: ${errors.slice(0, 5).join(' | ')}`)
}
