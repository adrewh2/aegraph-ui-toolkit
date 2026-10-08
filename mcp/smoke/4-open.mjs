import { readFileSync } from 'node:fs'
import { LABEL, check } from './lib.mjs'
// A fresh profile opens the bundle: same project, same route, same columns.
export default async ({ call, evaluate, sleep }) => {
  const text = readFileSync(process.env.SMOKE_BUNDLE, 'utf8')
  const r = await call('project_open_bundle', { text })
  check('bundle opens as the project', r.opened?.label === LABEL && r.created > 500, JSON.stringify(r).slice(0, 140))
  await sleep(1200)
  const url = await evaluate(`location.pathname + location.search`)
  check('reopens on the saved route', url === '/entities?category=knowledge&type=person', url)
  const cols = await evaluate(`[...document.querySelectorAll('th')].map((t) => t.textContent.trim())`)
  check('type definitions travelled', cols.includes('Born') && cols.includes('Score'), cols.join(' | '))
  const ctx = await call('get_app_context')
  check('project is open after import', ctx.project?.label === LABEL, JSON.stringify(ctx.project))
}
