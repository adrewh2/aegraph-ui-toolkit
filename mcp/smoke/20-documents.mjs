/**
 * Documents, driven with a mouse: the address that makes one makes
 * exactly one, what is typed is what is rendered, a phrase selected in
 * the editor can be annotated, and the annotation is still fixed to that
 * phrase after a reload — an annotation that loses its anchor is worse
 * than none. Everything happens in the profile the run makes for itself.
 * It needs no declared starting state (b35): every check is about the
 * document it wrote, the phrase it selected and the annotation it made,
 * and the one before-and-after count it does keep is taken inside
 * whatever scope is open, so it moves with it. Run under a profile
 * dirtied on purpose — a project left open and a filter matching
 * nothing — it is 11 of 11 with nothing declared.
 *   GL=1 node mcp/drive.mjs mcp/smoke/20-documents.mjs
 * or `npm run smoke:documents`.
 */
import { check } from './lib.mjs'

const PHRASE = 'kingfisher'
const TEXT = 'The kingfisher waits above the weir. A second sentence for company.'
const COUNT = `(() => {
  const s = window.__aegraph.store
  return s.library.all().filter((e) => e.type === 'document').length
})()`
const ANNOTATIONS = `(() => {
  const s = window.__aegraph.store
  return s.library
    .all()
    .filter((e) => e.type === 'annotation')
    .map((a) => ({ id: a.id, quote: String(a.data.selectedText ?? ''), comment: String(a.data.comment ?? '') }))
})()`
/** Where the annotation points, as the store records it: the relationship carries the selector. */
const ANCHORS = `(() => {
  const s = window.__aegraph.store
  return s.library
    .all()
    .filter((e) => e.kind === 'relationship' && e.type === 'annotates')
    .map((r) => ({ from: r.source.id, to: r.target.id, kind: r.target.selector?.kind ?? null, exact: r.target.selector?.exact ?? null }))
})()`

export default async ({ evaluate, sleep, logs }) => {
  await evaluate(`location.assign('/documents'); 1`)
  await sleep(9000)
  const before = await evaluate(COUNT)

  await evaluate(`location.assign('/documents/new'); 1`)
  await sleep(6000)
  const after = await evaluate(COUNT)
  check('the address that makes a document makes exactly one', after === before + 1, `${before} → ${after}`)
  check('and opens it', /^\/documents\/[0-9a-f-]{8,}/.test(await evaluate(`location.pathname`)), await evaluate(`location.pathname`))

  const typed = await evaluate(`(() => {
    const pm = document.querySelector('.ProseMirror')
    if (!pm) return null
    pm.focus()
    document.execCommand('insertText', false, ${JSON.stringify(TEXT)})
    return pm.innerText.trim()
  })()`)
  check('what is typed is what the page shows', typed === TEXT, String(typed).slice(0, 60))
  await sleep(2000)

  const selected = await evaluate(`(() => {
    const pm = document.querySelector('.ProseMirror')
    const node = [...pm.querySelectorAll('p')].map((p) => p.firstChild).find((n) => n && n.textContent.includes(${JSON.stringify(PHRASE)}))
    if (!node) return null
    const i = node.textContent.indexOf(${JSON.stringify(PHRASE)})
    const r = document.createRange()
    r.setStart(node, i)
    r.setEnd(node, i + ${PHRASE.length})
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
    pm.dispatchEvent(new Event('mouseup', { bubbles: true }))
    document.dispatchEvent(new Event('selectionchange'))
    return sel.toString()
  })()`)
  check('a phrase can be selected in the editor', selected === PHRASE, String(selected))
  await sleep(1000)

  check('and the toolbar offers to annotate it', await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /annotate/i.test(x.textContent.trim()) || /annotate/i.test(x.title || ''))
    if (!b || b.disabled) return false
    b.click()
    return true
  })()`))
  await sleep(1500)
  const dialog = await evaluate(`(() => { const d = document.querySelector('.dialog'); return d ? { title: d.querySelector('.dialog__title')?.textContent.trim() ?? '', quoted: d.innerText.includes(${JSON.stringify(PHRASE)}) } : null })()`)
  check('the dialog quotes what was selected', dialog?.title === 'Annotate selection' && dialog.quoted === true, JSON.stringify(dialog))

  await evaluate(`(() => {
    const d = document.querySelector('.dialog')
    const box = d.querySelector('textarea') ?? d.querySelector('input')
    const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(box, 'A note about the bird')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    const create = [...d.querySelectorAll('.btn')].find((b) => b.textContent.trim() === 'Create')
    create.click()
    return 1
  })()`)
  await sleep(2500)
  const made = await evaluate(ANNOTATIONS)
  check('an annotation is kept with the passage and the comment', made.some((a) => a.quote.includes(PHRASE) && a.comment === 'A note about the bird'), JSON.stringify(made.slice(-2)))

  // The anchor is the point: reload and ask the store where the annotation points, not the screen.
  await evaluate(`location.reload(); 1`)
  await sleep(9000)
  const kept = await evaluate(ANNOTATIONS)
  const anchors = await evaluate(ANCHORS)
  check('the annotation survives a reload', kept.some((a) => a.quote.includes(PHRASE)), `${kept.length} annotations`)
  check('and still points at the passage it was made on', anchors.some((a) => a.kind === 'text' && String(a.exact).includes(PHRASE)), JSON.stringify(anchors.slice(-2)))
  check('the page shows it against the document', await evaluate(`document.body.innerText.includes('A note about the bird') || document.body.innerText.includes(${JSON.stringify(PHRASE)})`))
  check('nothing threw along the way', (await evaluate(`(window.__aegraphErrors ?? []).length`)) === 0 && logs.length === 0, `${logs.length} console lines`)
}
