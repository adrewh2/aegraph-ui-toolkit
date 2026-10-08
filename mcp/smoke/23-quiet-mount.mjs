/**
 * Every page mounts quietly. A render loop — React's "Maximum update depth
 * exceeded" — is the failure this catches: it costs a page its frame rate
 * and says nothing to the person using it, which is how one sat on the
 * Scripts page for a fortnight (backlog b27) before a headless run noticed.
 * Each page is opened twice, because the second mount is where a loop
 * caused by remembered state shows, and a fresh profile goes first so the
 * first-run path is included.
 * Starts from the Library: it visits every page and asks each to put
 * something on screen, and a project another step left open gives most
 * of them nothing to show (b35).
 *   GL=1 node mcp/drive.mjs mcp/smoke/23-quiet-mount.mjs
 * or `npm run smoke:quiet`.
 */
import { check, startFrom } from './lib.mjs'

// `/` loaded fresh is the front door, the Workstation (Chats in front); the Dashboard it redirects from is reached in-app.
const PAGES = ['/', '/entities', '/ontology', '/graph', '/insights', '/analytics/scripts', '/analytics/charts', '/scenes', '/display', '/documents', '/diagrams', '/maps', '/workstation', '/docs', '/projects']
/**
 * Pages known to be noisy, with the reason. A page here that has gone quiet fails the run too: the entry is
 * then stale and should go, which is how a fix announces itself.
 */
const KNOWN = {
  // b27 (/display's redirect written back until React gave up) was a kept page behind the front one navigating the
  // browser — fixed in KeptPages, where a hidden page's move now stays on its own frozen address.
}
const STATE = `JSON.stringify({ route: location.pathname, errors: (window.__aegraphErrors ?? []).length, body: document.body.innerText.trim().length })`

export default async ({ call, evaluate, sleep, logs }) => {
  await startFrom({ call, evaluate, sleep }, 'library')
  const noisy = []
  const empty = []
  for (const page of PAGES) {
    for (const visit of [1, 2]) {
      const before = logs.length
      await evaluate(`location.assign(${JSON.stringify(page)}); 1`)
      // Wait for the page to have something on it rather than for a guessed number of seconds: a heavy view on a
      // busy machine is slow, and a sweep that samples the blank moment between the old page and the new one
      // reports an empty page that is merely late.
      let s = { route: page, errors: 0, body: 0 }
      for (let i = 0; i < 12; i++) {
        await sleep(1500)
        s = JSON.parse(await evaluate(STATE))
        if (s.body > 200) break
      }
      await sleep(2500) // and a moment more, since a loop needs renders to run before it complains
      s = JSON.parse(await evaluate(STATE))
      const said = logs.slice(before).map((l) => String(l))
      if (said.length || s.errors) noisy.push(`${page} (visit ${visit}): ${s.errors} page errors, ${said.length} console — ${said[0]?.slice(0, 80) ?? ''}`)
      if (s.body < 200) empty.push(`${page} (visit ${visit}): ${s.body} characters on the page`)
    }
  }
  const known = Object.keys(KNOWN)
  const unexpected = noisy.filter((n) => !known.some((k) => n.startsWith(`${k} `)))
  const quietNow = known.filter((k) => !noisy.some((n) => n.startsWith(`${k} `)))
  check('every page mounts without a word on the console or in the error log, bar the known ones', unexpected.length === 0, unexpected.join(' | '))
  check('and every page puts something on screen', empty.length === 0, empty.join(' | '))
  check('the known noisy pages are still the only noisy ones', quietNow.length === 0, quietNow.length ? `${quietNow.join(', ')} is quiet now — take it out of KNOWN` : '')
  for (const k of known) if (noisy.some((n) => n.startsWith(`${k} `))) console.log(`     ${k}: ${KNOWN[k]}`)
}
