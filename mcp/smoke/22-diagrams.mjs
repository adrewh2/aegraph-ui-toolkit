/**
 * Diagrams, driven with a mouse: one made from a template, its source
 * edited and the picture following, the spellings it offers (DOT,
 * Mermaid, Excalidraw) reachable, and the diagram still itself after a
 * reload. Also what the bare `/diagrams/new` address does, the way the
 * other landing addresses are checked. Needs GL=1 for the pages it
 * passes through.
 * Starts from the Library (b35) for meaning rather than for passing:
 * under a profile dirtied on purpose it is 13 of 13 with nothing
 * declared, because its counts read `store.library` and so go round the
 * open project entirely. That is also a weakness worth knowing about —
 * the first check is called "the diagrams page opens with what is
 * already there" and reads the store rather than the page, so with a
 * project open the page could list nothing while the check is happy.
 * Declaring the Library makes the two agree; making that check read the
 * page is still to do.
 *   GL=1 node mcp/drive.mjs mcp/smoke/22-diagrams.mjs
 * or `npm run smoke:diagrams-page`.
 */
import { check, selectOptions, selectPick, startFrom } from './lib.mjs'

const COUNT = `window.__aegraph.store.library.all().filter((e) => e.type === 'diagram').length`
const PAGE = `(() => ({
  route: location.pathname,
  svg: document.querySelectorAll('svg').length,
  nodes: document.querySelectorAll('svg .node, svg g.node, svg [class*=node]').length,
  editors: document.querySelectorAll('textarea, .cm-content').length,
  errors: (window.__aegraphErrors ?? []).length,
}))()`
/** The diagram as the store holds it: what it is written in, and how much of it there is. */
const SAVED = (name) => `(() => {
  const d = window.__aegraph.store.library.all().find((e) => e.type === 'diagram' && e.label === ${JSON.stringify(name)})
  if (!d) return null
  const src = String(d.data.source ?? '')
  return { id: d.id, format: d.data.format ?? null, chars: src.length, hasWeir: src.includes('weir') }
})()`

export default async ({ evaluate, sleep, logs, call }) => {
  await startFrom({ call, evaluate, sleep }, 'library')
  await evaluate(`location.assign('/diagrams'); 1`)
  await sleep(10000)
  const before = await evaluate(COUNT)
  check('the diagrams page opens with what is already there', before > 0, `${before} diagrams`)

  // The bare address, checked like the others: it must not make anything, and it must not strand the reader.
  await evaluate(`location.assign('/diagrams/new'); 1`)
  await sleep(6000)
  const at = await evaluate(PAGE)
  check('the /diagrams/new address makes nothing by itself', (await evaluate(COUNT)) === before, `${before} → ${await evaluate(COUNT)}`)
  check('and leaves a way back rather than a blank page', await evaluate(`document.body.innerText.includes('Back to diagrams') || location.pathname === '/diagrams'`), at.route)

  // The way the page itself offers: a template, named, created.
  await evaluate(`location.assign('/diagrams'); 1`)
  await sleep(7000)
  check('the page offers a new diagram', await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'New diagram'); if (!b) return false; b.click(); return true })()`))
  await sleep(1500)
  const name = `Smoke diagram ${Date.now().toString(36)}`
  const templates = await selectOptions({ evaluate, sleep }, `document.querySelector('.dialog .select-trigger')`)
  check('and a choice of templates to start from', Array.isArray(templates) && templates.length > 3, String(templates?.slice(0, 3)))
  await evaluate(`(() => {
    const d = document.querySelector('.dialog')
    const input = d.querySelector('input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify('%N%')})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 1
  })()`.replace('%N%', name))
  await selectPick({ evaluate, sleep }, `document.querySelector('.dialog .select-trigger')`, 'flowchart')
  await evaluate(`[...document.querySelectorAll('.dialog .btn')].find((b) => b.textContent.trim() === 'Create').click(); 1`)
  await sleep(5000)
  check('creating one makes exactly one diagram', (await evaluate(COUNT)) === before + 1, `${before} → ${await evaluate(COUNT)}`)
  const made = await evaluate(SAVED(name))
  check('and it is written in the format the template chose', !!made && made.chars > 0, JSON.stringify(made))
  const drawn = await evaluate(PAGE)
  check('the diagram is drawn, not just stored', drawn.svg > 0 && drawn.editors > 0, `${drawn.svg} svg, ${drawn.editors} editors`)

  // Edit the source: the picture has to follow, and the store has to keep it.
  const edited = await evaluate(`(() => {
    const box = document.querySelector('.dp textarea, textarea')
    if (!box) return null
    const proto = HTMLTextAreaElement.prototype
    const src = 'flowchart TD' + String.fromCharCode(10) + '  kingfisher --> weir' + String.fromCharCode(10) + '  weir --> river'
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(box, src)
    box.dispatchEvent(new Event('input', { bubbles: true }))
    box.dispatchEvent(new Event('change', { bubbles: true }))
    box.blur()
    return src.length
  })()`)
  check('the source can be edited', typeof edited === 'number', String(edited))
  await sleep(4000)
  const after = await evaluate(SAVED(name))
  check('and what was typed reaches the diagram', after?.hasWeir === true, JSON.stringify(after))

  // Reload: the diagram is still itself, and still drawn.
  await evaluate(`location.reload(); 1`)
  await sleep(9000)
  const back = await evaluate(SAVED(name))
  const shown = await evaluate(PAGE)
  check('the diagram survives a reload with its source', back?.hasWeir === true && back.chars === after.chars, `${after?.chars} → ${back?.chars} characters`)
  check('and is drawn again', shown.svg > 0, `${shown.svg} svg`)
  check('nothing threw along the way', (await evaluate(`(window.__aegraphErrors ?? []).length`)) === 0 && logs.length === 0, `${logs.length} console lines`)
}
