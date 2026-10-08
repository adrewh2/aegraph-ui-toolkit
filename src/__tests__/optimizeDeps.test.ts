import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A package the app imports that the dev server did not pre-bundle is discovered the first time a page needs it:
 * the server rebuilds every dependency and reloads the page — tens of seconds with a large Library, and a pane
 * mid-load can end up with two copies of React. So every package the browser code imports is in
 * vite.config.ts › optimizeDeps.include. (The headless engine runs in Node and is not the dev server's.)
 */
const ROOT = join(__dirname, '..', '..')
const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
const block = config.slice(config.indexOf('optimizeDeps: {'), config.indexOf('\n  },', config.indexOf('optimizeDeps: {')))
const included = new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]))
const dependencies = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies ?? {}))
const packageOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' || path.endsWith(join('src', 'headless')) ? [] : sources(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('optimizeDeps.include', () => {
  it('lists every package the browser code imports, so no page load re-bundles the dev server', () => {
    const imported = new Set<string>()
    for (const file of sources(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/(?:^|\n)\s*import\s+(type\s+)?[^'\n;]*?from\s+'([^']+)'|import\('([^']+)'\)|(?:^|\n)\s*import\s+'([^']+)'/g)) {
        if (m[1]) continue // a type import has no runtime
        const spec = m[2] ?? m[3] ?? m[4]
        if (!spec || spec.startsWith('.') || spec.startsWith('node:') || spec.includes('?') || /\.css$/.test(spec)) continue
        if (dependencies.has(packageOf(spec))) imported.add(spec)
      }
    }
    expect([...imported].filter((s) => !included.has(s)).sort()).toEqual([])
  })
})
