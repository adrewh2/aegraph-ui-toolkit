import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import { createAppTools } from '../tools'

/**
 * Every tool the assistant advertises is run by a unit test — this file
 * fails when one arrives without a test. A tool may instead be listed
 * below as covered only by the smoke suite (mcp/smoke, the slow harness
 * a person runs by hand); the list is checked both ways, so it shrinks
 * on its own: a tool on it that gains a unit test fails until it is
 * taken off, and one on it that no smoke step calls fails too.
 *
 * "Run" means a test executes the tool, not merely names it: the
 * `tool(tools, 'x')`, `run('x')` and `run(tools, 'x')` idioms of the
 * tests here, a `name === 'x'` lookup, and `call('x'` in a smoke step.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..', '..')
const read = (dir: string, ext: string) => readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }))

/** Tools run only by the smoke suite. Write a unit test for one and take it off; add to it only with a smoke step that calls the tool. */
const SMOKE_ONLY = ['delete_entities', 'get_app_context', 'load_dataset', 'project_save', 'set_properties']

const namesIn = (text: string, patterns: RegExp[]) => {
  const names = new Set<string>()
  for (const p of patterns) for (const m of text.matchAll(p)) names.add(m[1])
  return names
}
// tool(tools, 'x') · run('x') / run('x', {…}) · run(tools, 'x') / run(createXTools(), 'x') · a `name === 'x'` lookup · tool('x')
const UNIT_IDIOMS = [/tool\(tools, '([a-z_]+)'\)/g, /\brun\('([a-z_]+)'[,)]/g, /\brun\([^'\n]*, '([a-z_]+)'\)/g, /name === '([a-z_]+)'/g, /\btool\('([a-z_]+)'\)/g]
const SMOKE_IDIOMS = [/call\('([a-z_]+)'/g]

describe('tool coverage', () => {
  const manifest = createAppTools({ store: new EntityStore(), navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => false }).map((t) => t.name)
  const unit = new Set<string>()
  for (const { file, text } of read(here, '.test.ts')) if (file !== 'toolCoverage.test.ts') for (const n of namesIn(text, UNIT_IDIOMS)) unit.add(n)
  const smoke = new Set<string>()
  for (const { text } of read(join(root, 'mcp', 'smoke'), '.mjs')) for (const n of namesIn(text, SMOKE_IDIOMS)) smoke.add(n)

  it('advertises a good many tools, each with a unique name', () => {
    expect(manifest.length).toBeGreaterThan(80)
    expect(new Set(manifest).size).toBe(manifest.length)
  })

  it('every tool is run by a unit test, or is on the smoke-only list', () => {
    const untested = manifest.filter((n) => !unit.has(n) && !SMOKE_ONLY.includes(n)).sort()
    expect(untested, 'tools with no unit test (write one in __tests__, or list it as smoke-only with a smoke step that calls it)').toEqual([])
  })

  it('the smoke-only list names real tools that a smoke step calls and no unit test runs', () => {
    expect(SMOKE_ONLY.filter((n) => !manifest.includes(n)), 'not a tool').toEqual([])
    expect(SMOKE_ONLY.filter((n) => !smoke.has(n)), 'no smoke step calls it').toEqual([])
    expect(SMOKE_ONLY.filter((n) => unit.has(n)), 'has a unit test now: take it off the list').toEqual([])
  })
})
