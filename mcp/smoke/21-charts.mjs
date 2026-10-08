/**
 * Charts, driven with a mouse: the builder draws a figure without a line
 * of code, the addresses that open it create nothing behind your back,
 * changing a field redraws, saving it makes exactly one chart entity,
 * and reopening that chart from the saved list brings the same picture
 * back. Needs GL=1 for the pages it passes through.
 * Starts from the Library (b35) for meaning rather than for passing.
 * Run under a profile dirtied on purpose — a project left open and a
 * filter matching nothing — with no declared state it is still 15 of
 * 15, because nothing it checks would notice: "the figure holds real
 * data" asks only for more than zero points, and "saving makes exactly
 * one chart" counts charts before and after, both inside whatever scope
 * is open. The declaration is what makes the figure the demo's and the
 * count the Library's.
 *   GL=1 node mcp/drive.mjs mcp/smoke/21-charts.mjs
 * or `npm run smoke:charts-page`.
 */
import { check, selectOptions, selectPick, startFrom } from './lib.mjs'

const PLOTS = `window.__aegraph.store.library.all().filter((e) => e.type === 'plot').length`
const PAGE = `(() => ({
  route: location.pathname,
  figures: document.querySelectorAll('.js-plotly-plot').length,
  picker: document.querySelector('.gx-picker')?.textContent.trim() ?? null,
  errors: (window.__aegraphErrors ?? []).length,
}))()`
/** What the figure is actually drawing, as Plotly holds it: the trace type and how many points. */
const FIGURE = `(() => {
  const p = document.querySelector('.js-plotly-plot')
  if (!p || !p.data) return null
  return { traces: p.data.length, type: p.data[0]?.type ?? null, points: (p.data[0]?.x ?? p.data[0]?.labels ?? []).length }
})()`

export default async ({ evaluate, sleep, logs, call }) => {
  await startFrom({ call, evaluate, sleep }, 'library')
  await evaluate(`location.assign('/analytics/charts'); 1`)
  await sleep(10000)
  const landing = await evaluate(PAGE)
  check('the charts page opens', landing.route.startsWith('/analytics/charts'), landing.route)
  const before = await evaluate(PLOTS)

  // The addresses that open the builder must not leave a chart behind, the way /documents/new once left documents.
  await evaluate(`location.assign('/charts/new'); 1`)
  await sleep(6000)
  check('the old address redirects to the builder', (await evaluate(PAGE)).route === '/analytics/charts/new', (await evaluate(PAGE)).route)
  await evaluate(`location.assign('/analytics/charts/new'); 1`)
  await sleep(7000)
  const opened = await evaluate(PAGE)
  check('and opening the builder saves nothing by itself', (await evaluate(PLOTS)) === before, `${before} charts before, ${await evaluate(PLOTS)} after two visits`)
  check('the builder draws a figure straight away', opened.figures === 1, `${opened.figures} figures`)
  const first = await evaluate(FIGURE)
  check('and the figure holds real data', !!first && first.traces > 0 && first.points > 0, JSON.stringify(first))

  // Change what the chart counts and watch it redraw.
  const changed = await selectPick({ evaluate, sleep }, `document.querySelectorAll('.select-trigger')[0]`, null, { other: true })
  check('the field it reads can be changed', typeof changed === 'string', String(changed))
  await sleep(3000)
  const redrawn = await evaluate(FIGURE)
  check('and the picture follows the field', !!redrawn && redrawn.traces > 0, JSON.stringify(redrawn))

  // Save it: one chart, named, and offered in the list afterwards.
  const picker = await evaluate(`(() => {
    const b = document.querySelector('.gx-picker')
    if (!b) return null
    b.click()
    return b.textContent.trim()
  })()`)
  check('the chart picker is offered, saved or not', typeof picker === 'string', String(picker))
  await sleep(1000)
  check('the picker offers to save a new chart', await evaluate(`(() => { const b = [...document.querySelectorAll('.menu button, .menu__item')].find((m) => /^Save as new chart/.test(m.textContent.trim())); if (!b) return false; b.click(); return true })()`))
  await sleep(1200)
  const name = `Smoke chart ${Date.now().toString(36)}`
  const named = await evaluate(`(() => {
    const d = document.querySelector('.dialog')
    if (!d || !d.querySelector('input')) return false
    const box = d.querySelector('input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, ${JSON.stringify('%N%')})
    box.dispatchEvent(new Event('input', { bubbles: true }))
    const save = [...d.querySelectorAll('.btn')].find((b) => b.textContent.trim() === 'Save')
    if (!save) return false
    save.click()
    return true
  })()`.replace('%N%', name))
  check('it asks what to call the chart', named === true)
  await sleep(2500)
  check('saving makes exactly one chart', (await evaluate(PLOTS)) === before + 1, `${before} → ${await evaluate(PLOTS)}`)
  check('and the page says which chart it is now on', (await evaluate(PAGE)).picker?.includes('Smoke chart') === true, String((await evaluate(PAGE)).picker))

  // Reopen it from the list, on a page that has forgotten it.
  await evaluate(`location.assign('/analytics/charts'); 1`)
  await sleep(8000)
  const reopened = await evaluate(`(() => {
    const card = [...document.querySelectorAll('button, a, .si-card')].find((b) => b.textContent.includes(${JSON.stringify('%N%')}))
    if (!card) return false
    card.click()
    return true
  })()`.replace('%N%', name))
  check('the saved chart is listed where charts are kept', reopened === true, name)
  await sleep(7000)
  const back = await evaluate(FIGURE)
  check('and opening it draws the same picture again', !!back && back.traces === redrawn.traces && back.type === redrawn.type, `${JSON.stringify(redrawn)} → ${JSON.stringify(back)}`)
  check('nothing threw along the way', (await evaluate(`(window.__aegraphErrors ?? []).length`)) === 0 && logs.length === 0, `${logs.length} console lines`)
}
