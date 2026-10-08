import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

const helper = new URL('./smoke/lib.mjs', import.meta.url).href
it('a failed smoke exits nonzero while still allowing cleanup', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { check } from ${JSON.stringify(helper)}; check('broken', false); console.log('cleanup ran'); check('later passed', true)`], { encoding: 'utf8' })
  expect(child.status).toBe(1)
  expect(child.stdout).toContain('FAIL broken')
  expect(child.stdout).toContain('cleanup ran')
})
it('a successful smoke exits zero', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { check } from ${JSON.stringify(helper)}; check('works', true)`], { encoding: 'utf8' })
  expect(child.status).toBe(0)
})
