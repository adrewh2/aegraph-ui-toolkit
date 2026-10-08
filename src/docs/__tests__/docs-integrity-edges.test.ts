import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../core/entity/store'
import '../../core/resources/types'
import '../../core/graph/types'
import { parseValueRef } from '../../core/graph/values'
import { createAppTools } from '../../features/assistant/tools'
import { HeadlessEngine } from '../../headless/engine'
import { createHeadlessTools } from '../../headless/tools'
import { DOC_PAGES } from '../../features/docs/pages'
import { parseMarkdown } from '../../lib/markdown'

/**
 * The documentation as a whole: every Markdown file in src/docs is a page
 * and every page's file exists; anchors point at headings the target page
 * has (the Markdown renderer's own ids); every tool name the docs write
 * in backticks is a tool the assistant has; every value reference quoted
 * in the values page parses; code fences close; one title per page and
 * no empty headings; no heading id repeats within a page. And every
 * address a page sends the reader to is one the app answers — the page
 * ids, the routes in AppRoutes, and the files served under /spec.
 */
const pages = DOC_PAGES.filter((p) => !p.component)
/** A path in the repository, from this test file's place in it. */
const repo = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url))
const headingsOf = (source: string) => parseMarkdown(source).filter((b): b is Extract<ReturnType<typeof parseMarkdown>[number], { t: 'heading' }> => b.t === 'heading')

describe('docs integrity', () => {
  it('every Markdown file under src/docs is a registered page, and the ids are the file names', () => {
    const files = readdirSync(fileURLToPath(new URL('..', import.meta.url))).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort()
    const ids = pages.map((p) => p.id).sort()
    expect(ids).toEqual(files)
  })

  it('every anchor a page links to is a heading the target page renders', () => {
    const byId = new Map(pages.map((p) => [p.id, p]))
    const problems: string[] = []
    for (const p of pages) {
      for (const m of p.source.matchAll(/\]\((?:\/docs\/([a-z-]+))?#([^)\s]+)\)/g)) {
        const target = m[1] ? byId.get(m[1]) : p
        if (!target) {
          problems.push(`${p.id}: /docs/${m[1]} is not a page`)
          continue
        }
        const ids = new Set(headingsOf(target.source).map((h) => h.id))
        if (!ids.has(m[2])) problems.push(`${p.id} → /docs/${target.id}#${m[2]} (headings: ${[...ids].slice(0, 8).join(', ')}…)`)
      }
    }
    expect(problems).toEqual([])
  })

  it('every tool name the docs write in backticks is a tool the assistant has (or a documented alias of one)', () => {
    // The docs cover both hosts: the tools in a tab, and the ones the headless engine adds in their place.
    const headless = createHeadlessTools(new HeadlessEngine({ file: join(tmpdir(), 'aegraph-docs-test.ae.json'), autosave: false }))
    const tools = new Set([...createAppTools({ store: new EntityStore(), navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => false }), ...headless].map((t) => t.name))
    const prefixes = new Set([...tools].map((t) => t.split('_')[0]))
    // Names that are parameters or concepts, not tools, though they share a prefix (`web_search` is Anthropic's
    // server-side search on the site, beside the app's own `web_fetch`).
    const notTools = new Set(['graph_objects', 'define_on_type', 'view_budget', 'tag_mode', 'roots_match', 'save_as', 'dry_run', 'write_to_entities', 'accept_large', 'define_template', 'delete_template', 'export_data', 'web_search'])
    const mentioned = new Set<string>()
    for (const p of pages) for (const m of p.source.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)) if (prefixes.has(m[1].split('_')[0]) && !notTools.has(m[1])) mentioned.add(m[1])
    expect(mentioned.size).toBeGreaterThan(30)
    expect([...mentioned].filter((n) => !tools.has(n)).sort()).toEqual([])
    // The bridge's own status tool is the one name the docs use that is not an app tool.
    expect([...mentioned].includes('aegraph_bridge_status')).toBe(false)
  })

  it('every value reference the values page quotes parses, and the ones it calls out as invalid do not', () => {
    const values = pages.find((p) => p.id === 'values')!
    // Backticked references only: a bare `data` in prose is the field, not a ref.
    const refs = [...values.source.matchAll(/`((?:data|meta|metric)\.[A-Za-z_][\w.]*|degree(?:\.(?:in|out))?(?::[\w-]+)?|selected|pinned|label|type|id|tags)`/g)].map((m) => m[1])
    expect(refs.length).toBeGreaterThan(8)
    const bad = refs.filter((r) => !parseValueRef(r))
    expect(bad).toEqual([])
    for (const r of ['data.', 'metric.', 'degree.sideways', 'nonsense', '']) expect(parseValueRef(r), r).toBeUndefined()
  })

  it('code fences close, each page has one title and it comes first, headings are not empty, and no heading id repeats within a page', () => {
    for (const p of pages) {
      const fences = p.source.split('\n').filter((l) => /^\s*```/.test(l)).length
      expect(fences % 2, `${p.id}: fences`).toBe(0)
      const hs = headingsOf(p.source)
      expect(hs.filter((h) => h.level === 1).length, `${p.id}: titles`).toBe(1)
      expect(hs[0].level, `${p.id}: first heading`).toBe(1)
      for (const h of hs) expect(h.id, `${p.id}: empty heading`).not.toBe('')
      const ids = hs.map((h) => h.id)
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
      expect(dup, `${p.id}: repeated heading ids`).toEqual([])
    }
  })

  it('every address a page links to is one the app answers: a page id, a route, or a file it serves', () => {
    const routes = readFileSync(fileURLToPath(new URL('../../app/AppRoutes.tsx', import.meta.url)), 'utf8')
    // `path="/graph/:mode"` matches /graph/2d; `path="*"` is the catch-all and matches nothing on purpose — a link
    // that only the catch-all answers is a link to the dashboard by accident.
    const patterns = [...routes.matchAll(/path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*')
    const matchers = patterns.map((p) => new RegExp(`^${p.replace(/:[^/]+/g, '[^/]+').replace(/\*/g, '.*')}$`))
    const ids = new Set(DOC_PAGES.map((p) => p.id))
    const spec = new Set(readdirSync(fileURLToPath(new URL('../../../public/spec', import.meta.url))))
    const problems: string[] = []
    for (const p of pages) {
      for (const m of p.source.matchAll(/\]\((\/[^)\s]*)\)/g)) {
        const path = m[1].split('#')[0].split('?')[0]
        if (!path) continue
        if (path.startsWith('/docs/')) {
          if (!ids.has(path.slice('/docs/'.length))) problems.push(`${p.id} → ${m[1]} is not a documentation page`)
        } else if (path.startsWith('/spec/')) {
          if (!spec.has(path.slice('/spec/'.length))) problems.push(`${p.id} → ${m[1]} is not served from public/spec`)
        } else if (!matchers.some((re) => re.test(path))) {
          problems.push(`${p.id} → ${m[1]} is not a route the app has`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  /**
   * The three things the docs say about the repo that can go quietly false while the prose still reads well: a
   * command to run, a file to open, and the smoke table's account of the suite. Each was checked by hand at
   * wake-up 139 and each was true; they are here so the next rename is caught by a test rather than by a reader
   * typing a command that does not exist.
   */
  it('every command the docs tell the reader to run is a script the repo has', () => {
    const scripts = new Set(Object.keys(JSON.parse(readFileSync(repo('package.json'), 'utf8')).scripts))
    const wrong: string[] = []
    for (const p of pages) for (const m of p.source.matchAll(/`npm run ([a-z0-9:_-]+)`/g)) if (!scripts.has(m[1])) wrong.push(`${p.id}: npm run ${m[1]}`)
    expect(wrong).toEqual([])
  })

  it('every file in the repo the docs point at is a file the repo has, or one a script fetches', () => {
    const wrong: string[] = []
    // Some paths the docs name are not in the repo by design: `npm run pyodide`, `vendor` and
    // `demos` fetch them into ignored directories. A fresh clone has the docs before it has those,
    // so a path that .gitignore covers is not a broken reference — a mistyped source path still is.
    // A rule like `public/pyodide/` only matches a directory, and in a fresh clone the path is
    // not there to tell — so ask about both spellings.
    const generated = (rel: string) =>
      [rel, `${rel}/`].some((p) => {
        try {
          execFileSync('git', ['check-ignore', '-q', '--', p], { cwd: repo('.') })
          return true
        } catch {
          return false
        }
      })
    for (const p of pages) {
      for (const m of p.source.matchAll(/`((?:src|mcp|scripts|public|api)\/[A-Za-z0-9_./-]+)`/g)) {
        if (!existsSync(repo(m[1])) && !generated(m[1])) wrong.push(`${p.id}: ${m[1]}`)
      }
      // The smoke page names its steps by file name alone (`6-scenes.mjs`), which is where a renamed step hides.
      for (const m of p.source.matchAll(/`(\d+-[a-z0-9-]+\.mjs)`/g)) {
        if (!existsSync(repo(`mcp/smoke/${m[1]}`))) wrong.push(`${p.id}: mcp/smoke/${m[1]}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('the smoke page has a row for every step, and each row runs that step', () => {
    const steps = readdirSync(repo('mcp/smoke')).filter((f) => /^\d+-.*\.mjs$/.test(f)).map((f) => Number(f.split('-')[0]))
    const scripts = JSON.parse(readFileSync(repo('package.json'), 'utf8')).scripts
    const smoke = pages.find((p) => p.id === 'smoke')!
    const rows = [...smoke.source.matchAll(/^\| `npm run ([a-z0-9:_-]+)` \| (\d+) \|/gm)].map((m) => ({ script: m[1], step: Number(m[2]) }))
    // Steps 1-4 are one story under `npm run smoke` and share a row; every other step has one of its own.
    const listed = new Set(rows.map((r) => r.step))
    expect(steps.filter((n) => n > 4 && !listed.has(n)), 'a step with no row on the smoke page').toEqual([])
    expect(rows.filter((r) => !scripts[r.script]).map((r) => r.script), 'a row naming a script the repo has not').toEqual([])
    expect(rows.filter((r) => !new RegExp(`/${r.step}-`).test(scripts[r.script] ?? '')).map((r) => `${r.script} runs ${scripts[r.script]}`), 'a row whose script runs a different step').toEqual([])
  })

  it('names the pages the sidebar can reach, so a page that stops existing is caught here first', () => {
    const routes = readFileSync(fileURLToPath(new URL('../../app/AppRoutes.tsx', import.meta.url)), 'utf8')
    for (const path of ['/docs', '/docs/:page', '/entities', '/graph', '/insights', '/new', '/projects']) {
      expect(routes.includes(`path="${path}"`), `${path} is no longer a route`).toBe(true)
    }
  })
})
