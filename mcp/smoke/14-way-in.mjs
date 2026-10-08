/**
 * The way in for a project — the dialog a first visit lands on, driven
 * as a person drives it rather than as an agent: `/new` opens it, every
 * tab shows its panel, the dialog keeps one size from tab to tab (it
 * used to grow and shrink under the pointer), it opens on Your projects,
 * a shipped demo opens from the Demos tab as a project that knows it is
 * a demo, and the Library it was opened beside is still whole. Nothing
 * here is a tool call: this is the page answering a mouse. Needs GL=1
 * only for the graph the dashboard draws behind the dialog.
 *   GL=1 node mcp/drive.mjs mcp/smoke/14-way-in.mjs
 * or `npm run smoke:way-in`.
 */
import { check } from './lib.mjs'

/** The dialog as the page has it: its box, its tabs, and what the open panel says. */
const DIALOG = `(() => {
  const d = document.querySelector('.projdlg')
  if (!d) return null
  const r = d.getBoundingClientRect()
  const panel = d.querySelector('.projdlg__panel')
  return {
    w: Math.round(r.width),
    h: Math.round(r.height),
    tabs: [...d.querySelectorAll('.projdlg__tab')].map((b) => b.textContent.trim()),
    on: [...d.querySelectorAll('.projdlg__tab')].filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.textContent.trim()),
    says: panel ? panel.textContent.trim().length : 0,
  }
})()`
const STORE = `(() => {
  const s = window.__aegraph?.store
  return { scope: s?.scope ?? null, demo: s?.scope ? s.get(s.scope)?.data?.demo ?? null : null, scoped: s?.size?.() ?? 0, library: s?.library?.all?.().length ?? 0, route: location.pathname, dialog: !!document.querySelector('.projdlg') }
})()`
const ERRORS = `(window.__aegraphErrors ?? []).length`

export default async ({ evaluate, sleep }) => {
  await evaluate(`location.assign('/new'); 1`)
  await sleep(9000)
  const opened = await evaluate(DIALOG)
  check('/new lands with the Projects dialog open', !!opened && opened.tabs.length >= 6 && opened.on[0] === 'Your projects', JSON.stringify(opened))
  if (!opened) return

  const before = await evaluate(STORE)
  const sizes = []
  for (const label of opened.tabs) {
    await evaluate(`(() => { const b = [...document.querySelectorAll('.projdlg__tab')].find((x) => x.textContent.trim() === ${JSON.stringify('%TAB%')}); b.click(); return 1 })()`.replace('%TAB%', label))
    await sleep(900)
    sizes.push(await evaluate(DIALOG))
  }
  check(
    'every tab opens its own panel',
    sizes.every((s, i) => s.on[0] === opened.tabs[i] && s.says > 40),
    sizes.map((s) => `${s.on[0]}:${s.says}`).join(' '),
  )
  const boxes = [...new Set(sizes.map((s) => `${s.w}x${s.h}`))]
  check('the dialog is the same size on every tab', boxes.length === 1, boxes.join(' '))

  // A demo from the demos repo, never one of the datasets this machine happens to serve: those are the owner's own.
  await evaluate(`(() => { const b = [...document.querySelectorAll('.projdlg__tab')].find((x) => x.textContent.trim() === 'Demos'); b.click(); return 1 })()`)
  await sleep(1200)
  const picked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.projdlg__panel .democard')].find((x) => /^China tour/.test(x.querySelector('.democard__title')?.textContent.trim() ?? ''))
    if (!b) return null
    b.click()
    return true
  })()`)
  check('the shipped demos are offered to open', picked === true)
  await sleep(7000)
  const after = await evaluate(STORE)
  check('the demo opens as the project in scope, and the dialog closes behind it', after.scope === 'china-tour' && after.scoped > 10 && !after.dialog, JSON.stringify(after))
  check('the project knows it is a demo, so Your projects leaves it to the Demos tab', /^\/demos\/china-tour\//.test(after.demo ?? ''), JSON.stringify(after.demo))
  check('the Library it was opened beside is still whole', after.library >= before.library + after.scoped, `${before.library} → ${after.library} with ${after.scoped} of its own`)
  check('nothing threw along the way', (await evaluate(ERRORS)) === 0)
}
