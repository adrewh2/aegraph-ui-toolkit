import { LABEL, check } from './lib.mjs'
// The tab relaunched on a deep link: the project is still open, the link landed, nothing new got marked.
export default async ({ call, evaluate, sleep }) => {
  await sleep(500)
  const ctx = await call('get_app_context')
  check('project survives a relaunch', ctx.project?.label === LABEL, JSON.stringify(ctx.project))
  const url = await evaluate(`location.pathname + location.search`)
  check('deep link lands on the person table', url === '/entities?category=knowledge&type=person', url)
  const active = await evaluate(`document.querySelector('.res__facet.is-active')?.textContent ?? ''`)
  check('rail shows the deep-linked type', /^People/.test(active), active)
  const cols = await evaluate(`[...document.querySelectorAll('th')].map((t) => t.textContent.trim())`)
  check('defined properties are columns', cols.includes('Born') && cols.includes('Score'), cols.join(' | '))
  const seedsMarked = await evaluate(`window.__aegraph.store.library.all().filter((e) => e.id.startsWith('seed-') && e.meta.projects?.length).length`)
  check('reload marks nothing (the load race)', seedsMarked === 0, `${seedsMarked} marked`)
  const libraryCount = await evaluate(`window.__aegraph.store.library.entityCount()`)
  const scoped = await evaluate(`window.__aegraph.store.entityCount()`)
  check('scope is narrower than the Library', scoped < libraryCount, `${scoped} of ${libraryCount}`)
}
