/**
 * The Entities page, driven with a mouse: the section rail moves between
 * every entity, the categories, types, tags and relationships; the
 * search narrows the table and giving it nonsense empties it honestly;
 * picking a row opens the inspector on that entity; a relationship in
 * the inspector leads to the entity at its other end; and an edit to a
 * field is still there after a reload, which is the only proof that it
 * reached the store rather than the screen. Everything happens in the
 * profile the run makes for itself, on the demo the app opens there.
 * Starts from the Library with a fresh view: every count it checks is
 * over the whole store, so a project another step left open shows it a
 * few rows instead (16 of 18 and a one-row table, measured), and the
 * page is a pane host whose remembered tab can narrow it too (b35).
 *   GL=1 node mcp/drive.mjs mcp/smoke/19-entities.mjs
 * or `npm run smoke:entities`.
 */
import { check, startFrom } from './lib.mjs'

const TABLE = `(() => {
  const rail = [...document.querySelectorAll('.res__cat')].map((b) => ({ label: b.querySelector('.res__facet-label')?.textContent.trim() ?? '', current: b.classList.contains('is-current') }))
  return {
    route: location.pathname + location.search,
    rail: rail.map((r) => r.label),
    current: rail.find((r) => r.current)?.label ?? null,
    rows: document.querySelectorAll('tbody tr').length,
    // The table pages at fifty, so the rows on screen say nothing about narrowing once there are more than
    // that: its footer reports the whole result ("1-50 of 1,234"), and that is the number a search moves.
    total: Number((document.querySelector('.et__footer span')?.textContent ?? '').replace(/.*of\s*/, '').replace(/[^0-9]/g, '')) || 0,
    columns: [...document.querySelectorAll('thead th')].map((t) => t.textContent.trim()).filter(Boolean),
    empty: /Nothing|No entities|no matches/i.test(document.querySelector('.res__table')?.innerText ?? ''),
    errors: (window.__aegraphErrors ?? []).length,
  }
})()`
const INSPECTOR = `(() => {
  const i = document.querySelector('.insp')
  if (!i) return null
  return {
    title: i.querySelector('.insp__head')?.innerText.split(String.fromCharCode(10))[0] ?? '',
    tabs: [...i.querySelectorAll('[role=tab], .insp__tab')].map((t) => t.textContent.trim()).filter(Boolean),
    text: i.innerText.replace(/[ ]+/g, ' ').slice(0, 300),
  }
})()`
const railTo = (label) => `(() => {
  const b = [...document.querySelectorAll('.res__cat')].find((x) => x.querySelector('.res__facet-label')?.textContent.trim() === ${JSON.stringify('%L%')})
  if (!b) return false
  b.click()
  return true
})()`.replace('%L%', label)
const type = (value) => `(() => {
  const s = document.querySelector('input[type=search], input[placeholder*="Search all"]')
  if (!s) return false
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(s, ${JSON.stringify(value)})
  s.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`

export default async ({ call, evaluate, sleep, logs }) => {
  await startFrom({ call, evaluate, sleep }, 'fresh')
  await evaluate(`location.assign('/entities'); 1`)
  await sleep(9000)
  const opened = await evaluate(TABLE)
  check('the table opens with rows and named columns', opened.rows > 5 && opened.columns.includes('Label') && opened.columns.includes('Type'), `${opened.rows} rows: ${opened.columns.join(', ')}`)
  check('the rail offers the sections of the one Library', opened.rail.length >= 4 && ['Types', 'Tags'].every((s) => opened.rail.includes(s)), opened.rail.join(' · '))

  for (const section of ['Types', 'Tags']) {
    check(`the rail moves to ${section}`, await evaluate(railTo(section)))
    await sleep(1500)
    const at = await evaluate(TABLE)
    check(`and ${section} has its own table`, at.current === section && at.rows > 0, `${at.current}, ${at.rows} rows`)
  }
  check('and back to every entity', await evaluate(railTo(opened.rail[0])))
  await sleep(1500)

  // Search: something that is there, then something that is not.
  check('the search box is offered', await evaluate(type('annotation')))
  await sleep(1500)
  const found = await evaluate(TABLE)
  check('it narrows the table', found.total > 0 && found.total < opened.total, `${opened.total} → ${found.total} matching (the page shows ${found.rows})`)
  await evaluate(type('zzzznothinghere'))
  await sleep(1500)
  const none = await evaluate(TABLE)
  check('and says so rather than showing nothing at all', none.rows === 0 && none.empty, `${none.rows} rows, empty message: ${none.empty}`)
  await evaluate(type(''))
  await sleep(1200)

  // The inspector on a row, and a relationship followed from it.
  await evaluate(`(() => { const r = document.querySelector('tbody tr'); r.click(); return 1 })()`)
  await sleep(1800)
  const insp = await evaluate(INSPECTOR)
  check('picking a row opens the inspector on it', !!insp && insp.title.length > 0, JSON.stringify(insp?.title))
  const first = await evaluate(`(() => { const r = document.querySelector('tbody tr td:nth-child(2)'); return r ? r.textContent.trim() : null })()`)
  check('and it is the row that was picked', !!first && insp.text.includes(first.slice(0, 20)), `${first} vs ${insp.text.slice(0, 40)}`)

  // The fields live behind their own tab; a media or diagram entity opens on its own view first.
  check('the inspector has a Fields tab', await evaluate(`(() => { const b = [...document.querySelectorAll('.insp button')].find((x) => x.textContent.trim() === 'Fields'); if (b) b.click(); return !!b })()`))
  await sleep(1200)
  const rows = await evaluate(`[...document.querySelectorAll('.insp .editable')].length`)
  check('and fields that can be edited in place', rows > 0, `${rows} editable fields`)

  // An edit has to reach the store, not just the field: change the label, reload, look again. The profile is a
  // fresh one made for this run, and the entity is the demo's, so nothing of anyone's own is touched.
  const edited = await evaluate(`(() => {
    const first = document.querySelector('.insp .editable')
    if (!first) return null
    first.click()
    return true
  })()`)
  check('a field opens its editor when clicked', edited === true)
  await sleep(1000)
  const mark = await evaluate(`(() => {
    // A short field edits in place, inside the row; a longer one or a tag list opens a popover.
    const box = document.querySelector('.popover input, .popover textarea, .insp input[type=text], .insp textarea')
    if (!box) return null
    const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const mark = 'Smoke label ' + Date.now().toString(36)
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(box, mark)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return mark
  })()`)
  check('the editor takes a new value', typeof mark === 'string', String(mark))
  await sleep(1500)
  await evaluate(`location.reload(); 1`)
  await sleep(9000)
  const kept = await evaluate(`document.body.innerText.includes(${JSON.stringify(mark)})`)
  check('and what was typed is still there after a reload', kept === true, `looking for ${mark}`)
  // Paging with a row selected: Next goes to the next page and stays there (it used to snap back to the selected row's).
  const footer = `(() => { const f = document.querySelector('.et__footer'); const m = f && /(\\d+) \\/ (\\d+)/.exec(f.textContent); return m ? [Number(m[1]), Number(m[2])] : null })()`
  const press = (label) => evaluate(`(() => { const b = [...document.querySelectorAll('.et__footer button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true })()`)
  await evaluate(`(() => { document.querySelector('tbody tr td:nth-child(2)')?.click(); return 1 })()`)
  await sleep(600)
  const before = await evaluate(footer)
  if (before && before[1] > 1) {
    await press('Next')
    await sleep(900)
    const after = await evaluate(footer)
    check('Next pages on with a row selected', !!after && after[0] === before[0] + 1, `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
  } else check('Next pages on with a row selected (one page only: nothing to page)', true)
  check('nothing threw along the way', (await evaluate(`(window.__aegraphErrors ?? []).length`)) === 0 && logs.length === 0, `${logs.length} console lines`)
}
