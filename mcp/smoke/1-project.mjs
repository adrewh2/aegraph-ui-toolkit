import { LABEL, check } from './lib.mjs'
// A project, a demo opened beside it, a typed property on its people.
export default async ({ call, evaluate }) => {
  // Whatever project a profile has open, the smoke project takes over from it.
  const before = await call('project_list')
  const { created } = await call('project_create', { label: LABEL, route: '/' })
  const after = await call('project_list')
  check('a new project opens and takes the scope', after.active === created.id && after.projects.length === before.projects.length + 1, `${before.projects.length} project(s) before, active ${after.active === created.id ? 'the new one' : after.active}`)
  const loaded = await call('load_dataset', { sources: ['knowledge-infrastructure'] })
  // A demo is a bundle from the demos repo: it opens as a project of its own, beside the one just made.
  check('the demo opens as a project of its own', !!loaded.into?.id && loaded.into.id !== created.id && loaded.loaded > 500, JSON.stringify(loaded).slice(0, 120))
  // The steps after this one want the smoke project open with a dataset in it: its members are the demo's entities
  // (marked, never copied — relationships between them come along), and it takes the scope back.
  const added = await call('project_add', { project: created.id, query: { tag: 'demo:knowledge-infra' } })
  await call('project_open', { id: created.id })
  const back = await call('project_list')
  check('the demo’s entities join the smoke project, which is open again', back.active === created.id && added.added > 200, JSON.stringify(added).slice(0, 120))
  const people = await call('search_entities', { type: 'person', limit: 3 })
  const set = await call('set_properties', { ids: people.results.map((p) => p.id), properties: { born: '1815-12-10', score: '8.5' }, kinds: { born: 'date', score: 'number' } })
  check('typed properties set and defined', set.updated === 3 && set.definedOn.includes('person'), JSON.stringify(set))
  const seedsMarked = await evaluate(`window.__aegraph.store.library.all().filter((e) => e.id.startsWith('seed-') && e.meta.projects?.length).length`)
  check('seed entities stay out of the project', seedsMarked === 0, `${seedsMarked} marked`)
}
