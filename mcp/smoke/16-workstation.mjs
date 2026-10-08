/**
 * The Workstation, driven with a mouse: it opens with its panes and
 * their tabs, a pane splits into two, a view added to the focused pane
 * arrives as a tab beside the others, a tab keeps a history of its own
 * (follow a link inside it, then step back with the pane's own arrow),
 * and the whole arrangement is still there after a reload — which is the
 * part a person notices, since the browser's own history knows nothing
 * about panes.
 *   GL=1 node mcp/drive.mjs mcp/smoke/16-workstation.mjs
 * or `npm run smoke:workstation`.
 *
 * IT ARRANGES ITS OWN. The front door (`defaultWorkstation()` in
 * `workstation/model.ts`) is one pane of Chats and the graph in 3D, which
 * gives this step neither a second pane nor a page with links to follow;
 * so before it opens the Workstation it writes the arrangement it
 * measures into `aegraph:workstation:v1` — About aegraph beside the
 * graph in 2D — from another page, so the Workstation is not on screen to
 * save over it. What a first run lands on is step 14's to check.
 */
import { check } from './lib.mjs'

const LAYOUT = `(() => {
  const panes = [...document.querySelectorAll('.ws-pane')]
  return {
    route: location.pathname,
    panes: panes.length,
    tabs: panes.map((p) => [...p.querySelectorAll('.ws-tab__label')].map((t) => t.textContent.trim())),
    focused: panes.findIndex((p) => p.classList.contains('is-focused')),
    errors: (window.__aegraphErrors ?? []).length,
  }
})()`
/**
 * Where each pane's active tab is, as the workstation saved it. The saved form is a preset: it keeps the paths
 * and drops the trail, so a tab's history is read from the pane's own Back arrow rather than from here.
 */
const PATHS = `(() => {
  const raw = localStorage.getItem('aegraph:workstation:v1')
  if (!raw) return null
  const ws = JSON.parse(raw).ws
  const panes = []
  const walk = (n) => (n.kind === 'pane' ? panes.push(n) : n.children.forEach(walk))
  walk(ws.root)
  return panes.map((p) => p.tabs[p.active]?.path ?? null)
})()`
const backArrow = (pane) => `(() => {
  const p = document.querySelectorAll('.ws-pane')[${pane}]
  const b = [...p.querySelectorAll('.ws-tabs__btn')].find((x) => x.title === 'Back')
  return b ? { there: true, enabled: !b.disabled } : { there: false }
})()`
const click = (sel, text) => `(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)} || x.title === ${JSON.stringify(text)})
  if (!b) return false
  b.click()
  return true
})()`

/** Two panes: a documentation page (links to follow) beside the graph in 2D. The saved form is a preset. */
const ARRANGEMENT = {
  ws: {
    root: {
      kind: 'split', id: 's1', dir: 'row', ratio: 0.4,
      children: [
        { kind: 'pane', id: 'p1', tabs: [{ id: 't1', path: '/docs/about', title: 'About aegraph' }], active: 0 },
        { kind: 'pane', id: 'p2', tabs: [{ id: 't2', path: '/unigraph/2d' }], active: 0 },
      ],
    },
    focused: 'p1',
  },
  dirty: false,
}

export default async ({ evaluate, sleep, logs }) => {
  await evaluate(`location.assign('/docs'); 1`)
  await sleep(4000)
  await evaluate(`localStorage.setItem('aegraph:workstation:v1', ${JSON.stringify(JSON.stringify(ARRANGEMENT))}); 1`)
  await evaluate(`location.assign('/workstation'); 1`)
  await sleep(11000)
  const opened = await evaluate(LAYOUT)
  check('the Workstation opens with its panes and their tabs', opened.panes >= 2 && opened.tabs.every((t) => t.length > 0), JSON.stringify(opened.tabs))

  check('the focused pane splits in two', await evaluate(click('.ws-top .btn', 'Split right')))
  await sleep(1200)
  const split = await evaluate(LAYOUT)
  check('and the new pane is there beside it', split.panes === opened.panes + 1, `${opened.panes} → ${split.panes}`)

  // Add a view to the focused pane: the menu is a portal, so it needs a moment before its items exist.
  check('the add-view menu opens', await evaluate(click('.ws-top .btn', 'Add view')))
  await sleep(800)
  const items = await evaluate(`[...document.querySelectorAll('.menu button')].map((m) => m.textContent.trim()).slice(0, 20)`)
  check('it offers the pages a pane can host', items.length > 3 && items.some((i) => /Entities/.test(i)), items.slice(0, 6).join(', '))
  await evaluate(`(() => { const b = [...document.querySelectorAll('.menu button')].find((m) => /Entities/.test(m.textContent)); b.click(); return true })()`)
  await sleep(1500)
  const added = await evaluate(LAYOUT)
  check('the view arrives as a tab in the focused pane', added.tabs.flat().filter((t) => /Entities/.test(t)).length >= 1, JSON.stringify(added.tabs))

  // A tab's own history, in the pane that hosts the documentation: follow one of its links, then step back with
  // the pane's own arrow — the browser's back button would leave the Workstation altogether.
  const start = (await evaluate(PATHS))[0]
  check('the first pane starts on a page of its own', typeof start === 'string' && start.startsWith('/docs/'), String(start))
  check('the back arrow has nowhere to go yet', (await evaluate(backArrow(0))).enabled === false)
  const followed = await evaluate(`(() => {
    const p = document.querySelectorAll('.ws-pane')[0]
    const a = [...p.querySelectorAll('a[href^="/docs/"]')].find((x) => x.getAttribute('href') !== ${JSON.stringify('%START%')})
    if (!a) return null
    a.click()
    return a.getAttribute('href')
  })()`.replace('%START%', start))
  await sleep(2500)
  const moved = (await evaluate(PATHS))[0]
  check('following a link inside a tab moves that tab', !!followed && moved === followed, `${start} → ${moved}`)
  check('and its back arrow lights up', (await evaluate(backArrow(0))).enabled === true)
  await evaluate(`(() => { const b = [...document.querySelectorAll('.ws-pane')[0].querySelectorAll('.ws-tabs__btn')].find((x) => x.title === 'Back'); b.click(); return 1 })()`)
  await sleep(2000)
  check('and takes it back where it was', (await evaluate(PATHS))[0] === start, `${moved} → ${(await evaluate(PATHS))[0]}`)

  // The arrangement is the workstation's own, not the browser's: it must come back after a reload.
  const saved = await evaluate(LAYOUT)
  await evaluate(`location.reload(); 1`)
  await sleep(10000)
  const back = await evaluate(LAYOUT)
  check('the arrangement survives a reload', back.panes === saved.panes && JSON.stringify(back.tabs) === JSON.stringify(saved.tabs), `${saved.panes} panes ${JSON.stringify(saved.tabs)} → ${back.panes} panes ${JSON.stringify(back.tabs)}`)
  check('nothing threw along the way', back.errors === 0 && logs.length === 0, `${back.errors} page errors, ${logs.length} console`)
}
