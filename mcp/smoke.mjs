/**
 * End-to-end smoke over the real MCP bridge and a headless tab:
 *
 *   npm run dev            (in another terminal, on :5199)
 *   npm run smoke          (= node mcp/drive.mjs mcp/smoke.mjs)
 *
 * A fresh profile every run. It creates a project, loads a demo into it,
 * relaunches the tab (the persistence-load path), sets a typed property,
 * saves and reopens a bundle, and asserts what the audit's L6/L7 class of
 * bug broke: nothing outside the project gets marked on reload, the scope
 * survives startup, deep links land where they point.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = new URL('.', import.meta.url).pathname
const profile = mkdtempSync(join(tmpdir(), 'aegraph-smoke-'))
const downloads = mkdtempSync(join(tmpdir(), 'aegraph-smoke-dl-'))
const failures = []

function run(steps, url) {
  const r = spawnSync(process.execPath, [join(here, 'drive.mjs'), steps, ...(url ? [url] : [])], { env: { ...process.env, PROFILE: profile, DOWNLOADS: downloads, GL: process.env.GL ?? '' }, encoding: 'utf8' })
  process.stdout.write(r.stdout)
  if (r.status !== 0) {
    process.stderr.write(r.stderr)
    failures.push(`${steps} exited ${r.status}`)
  }
  for (const line of r.stdout.split('\n')) if (line.startsWith('FAIL ')) failures.push(line.slice(5))
}

try {
  run(join(here, 'smoke/1-project.mjs'))
  run(join(here, 'smoke/2-relaunch.mjs'), 'http://localhost:5199/entities?category=knowledge&type=person')
  run(join(here, 'smoke/3-bundle.mjs'))
  const bundle = readdirSync(downloads).find((f) => f.endsWith('.ae.json') || f.endsWith('.aegraph.json'))
  if (!bundle) failures.push('no bundle was downloaded')
  else {
    process.env.SMOKE_BUNDLE = join(downloads, bundle)
    rmSync(profile, { recursive: true, force: true })
    run(join(here, 'smoke/4-open.mjs'))
  }
} finally {
  rmSync(profile, { recursive: true, force: true })
  rmSync(downloads, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`\nsmoke: ${failures.length} failure(s)\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nsmoke: ok')
