/**
 * Insights, driven with a mouse: the five analyses are offered before
 * anything runs, running them fills the page with ranked findings, every
 * section either lists findings or says why it has none, each finding
 * offers what to do with it, and "Show graph" lands in the explorer with
 * exactly the entities the finding named selected. Needs GL=1 for the
 * graph it ends on. Starts from the Library with a fresh view: the
 * analyses run over what is in view, so a project another step left open
 * and a filter it left in the explorer both decide what they can find
 * (b35).
 *   GL=1 node mcp/drive.mjs mcp/smoke/18-insights.mjs
 * or `npm run smoke:insights`.
 */
import { check, startFrom } from './lib.mjs'

const PAGE = `(() => {
  const p = document.querySelector('.ins')
  if (!p) return { there: false }
  const sections = [...p.querySelectorAll('.ins__section')].map((s) => ({
    title: s.querySelector('h2')?.textContent.trim() ?? '',
    findings: s.querySelectorAll('.ins__list > *').length,
    note: s.querySelector('p.muted')?.textContent.trim() ?? null,
  }))
  return {
    there: true,
    picks: [...p.querySelectorAll('.ins__pick')].map((x) => x.textContent.trim()),
    cards: [...p.querySelectorAll('.ins__card h3')].map((x) => x.textContent.trim()),
    sections,
    findings: p.querySelectorAll('.ins__list > *').length,
    meta: p.querySelector('.ins__meta')?.textContent.trim() ?? null,
    error: p.querySelector('.ins__error')?.textContent.trim() ?? null,
    errors: (window.__aegraphErrors ?? []).length,
  }
})()`
const FIRST = `(() => {
  const f = document.querySelector('.ins__list > *')
  if (!f) return null
  return { title: f.innerText.split(String.fromCharCode(10)).find((l) => l.trim().length > 3) ?? '', actions: [...f.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean) }
})()`
const EXPLORER = `(() => {
  const h = (window.__aegraphExplorers?.handles ?? []).at(-1)
  if (!h) return null
  const s = h.getState()
  return { route: location.pathname, nodes: h.getSlice().nodes.length, selected: s.selectedIds.length }
})()`

export default async ({ call, evaluate, sleep, logs }) => {
  await startFrom({ call, evaluate, sleep }, 'fresh')
  await evaluate(`location.assign('/insights'); 1`)
  await sleep(9000)
  const idle = await evaluate(PAGE)
  check('the page offers its analyses before anything is run', idle.picks.length === 5 && idle.cards.length === 5 && idle.findings === 0, `${idle.picks.length} picks, ${idle.cards.length} cards`)
  check('each one is described, not just named', idle.picks.every((p) => idle.cards.includes(p)), idle.picks.join(', '))

  await evaluate(`(() => { const b = [...document.querySelectorAll('.ins button')].find((x) => /Run analyses/.test(x.textContent)); b.click(); return 1 })()`)
  let report = null
  for (let i = 0; i < 12; i++) {
    await sleep(3000)
    report = await evaluate(PAGE)
    if (report.sections.length) break
  }
  check('running fills the page with what it found', report.sections.length >= 2 && report.findings > 0, `${report.sections.length} sections, ${report.findings} findings`)
  check('the most interesting come first, then each analysis in turn', report.sections[0]?.title.includes('Most interesting') && report.sections.length === 6, report.sections.map((s) => s.title).join(' · '))
  check('every section either lists findings or says why it has none', report.sections.every((s) => s.findings > 0 || !!s.note), report.sections.map((s) => `${s.title}:${s.findings}${s.note ? '(note)' : ''}`).join(' '))
  check('it says what it ran over', /entities/.test(report.meta ?? '') && /relationships/.test(report.meta ?? ''), String(report.meta))
  check('and reports no error of its own', report.error === null, String(report.error))

  const first = await evaluate(FIRST)
  check('a finding says something and offers what to do with it', (first?.title.length ?? 0) > 10 && ['Save as claim', 'Ask', 'Show graph'].every((a) => first.actions.includes(a)), `${first?.title} — ${first?.actions.join(', ')}`)

  await evaluate(`(() => { const f = document.querySelector('.ins__list > *'); const b = [...f.querySelectorAll('button')].find((x) => /Show graph/.test(x.textContent)); b.click(); return 1 })()`)
  await sleep(6000)
  const graph = await evaluate(EXPLORER)
  check('showing a finding lands in the explorer with what it named selected', graph?.route.startsWith('/graph') && graph.selected > 0 && graph.selected <= graph.nodes, JSON.stringify(graph))
  check('nothing threw along the way', (await evaluate(`(window.__aegraphErrors ?? []).length`)) === 0 && logs.length === 0, `${logs.length} console lines`)
}
