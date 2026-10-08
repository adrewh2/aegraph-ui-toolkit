import { readdirSync } from 'node:fs'
import { check } from './lib.mjs'
// Save the project as a bundle (a browser download).
export default async ({ call, sleep }) => {
  const saved = await call('project_save', { route: '/entities?category=knowledge&type=person' })
  check('bundle saved', saved.count > 500 && /\.(ae|aegraph)\.json$/.test(saved.filename), JSON.stringify(saved))
  for (let i = 0; i < 60; i++) {
    if (readdirSync(process.env.DOWNLOADS).some((f) => f === saved.filename)) break
    await sleep(500)
  }
  check('bundle file landed', readdirSync(process.env.DOWNLOADS).includes(saved.filename), readdirSync(process.env.DOWNLOADS).join(', '))
}
