import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * The repository must never carry someone's project data. Five things say so
 * — `.gitignore`, the pre-commit hook, the pre-push hook, the CI job, and
 * `.vercelignore` for what a CLI deploy uploads — and four of them keep their
 * own copy of which files this repo really ships.
 * A list that drifts is how a guard quietly stops guarding, so this reads all
 * of them and runs the hooks' own logic against real paths.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

/** The hook's own answer for a path: the reason it refuses, or '' when it allows. */
const guard = (path: string, size = 100) =>
  execFileSync('sh', ['-c', `. ./.githooks/data-guard.sh; data_guard_reason "$1" || data_guard_oversized "$1" "$2" || true`, 'sh', path, String(size)], { cwd: root, encoding: 'utf8' }).trim()

/** The paths named in a shell/ERE allow-list, unescaped: `public/spec/example\.ae\.json` → `public/spec/example.ae.json`. */
function allowedPaths(ere: string): string[] {
  return ere
    .replace(/^\^\(|\)\$$/g, '')
    .split('|')
    .map((p) => p.replace(/\\/g, ''))
    // Only the plain paths: an alternation like `src/.*(ae|aegraph).json` is a pattern, not a file.
    .filter((p) => !/[*()]/.test(p))
}

const guardSh = read('.githooks/data-guard.sh')
const DATA_ALLOW = /DATA_ALLOW='([^']+)'/.exec(guardSh)![1]

describe('the data guard', () => {
  it('refuses every shape the app writes, whatever it is called', () => {
    for (const p of [
      'my-project.ae.json',
      'notes.aeb',
      'archive.ae.json.gz',
      'public/datasets/whatever.aegraph.json',
      'deep/inside/a/folder/project.aeb.gz',
      'conversations.json',
      'my-chatgpt-export.json',
      '.env',
      '.env.local',
      'shot-1.png',
      'run.screenshot.png',
    ]) {
      expect(guard(p), p).not.toBe('')
    }
  })

  it('allows the project’s own source and the documents it ships', () => {
    for (const p of [
      'src/features/projects/folder.ts',
      'README.md',
      '.env.example',
      'public/spec/example.ae.json',
      'public/templates/conversation-atlas.template.ae.json',
      'src/core/exchange/__tests__/fixtures/small.ae.json',
      'src/core/exchange/chatgpt.ts',
    ]) {
      expect(guard(p), p).toBe('')
    }
  })

  it('refuses anything too big to be source, bar the one tracked file that is legitimately big', () => {
    expect(guard('public/datasets/notes.nt', 6_000_000)).toContain('over the 5 MB limit')
    expect(guard('src/lib/huge.ts', 6_000_000)).toContain('over the 5 MB limit')
    expect(guard('package-lock.json', 6_000_000)).toBe('')
    // The demos left for their own repository: a dataset here again is refused, however it is named.
    expect(guard('scripts/aurora/base.aegraph.json', 40_000_000)).not.toBe('')
    expect(guard('public/datasets/china-tour.ae.json')).not.toBe('')
  })

  it('is the one description: both hooks source it, and neither keeps rules of its own', () => {
    for (const hook of ['.githooks/pre-commit', '.githooks/pre-push']) {
      const src = read(hook)
      expect(src, hook).toContain('data-guard.sh')
      expect(src, hook).toMatch(/data_guard_reason/)
      // No second copy of the shapes to drift from the first.
      expect(src, hook).not.toMatch(/\\\.\(ae\|aegraph\)/)
    }
  })

  it('.gitignore allows back exactly the files the hooks do', () => {
    const ignore = read('.gitignore')
    const unignored = new Set(
      ignore
        .split('\n')
        .filter((l) => l.startsWith('!'))
        .map((l) => l.slice(1).trim()),
    )
    for (const p of allowedPaths(DATA_ALLOW)) {
      if (p === '.env.example') {
        expect(unignored.has('.env.example')).toBe(true)
        continue
      }
      // Either the exact path is allowed back, or a pattern that covers it (src/**).
      const covered = unignored.has(p) || [...unignored].some((u) => u.includes('**') && p.startsWith(u.split('**')[0]))
      expect(covered, `${p} is allowed by the hooks but not by .gitignore`).toBe(true)
    }
  })

  it('CI checks what the hooks check — by reading the same file, not a copy of the list', () => {
    const ci = read('.github/workflows/ci.yml')
    // Both CI data checks: what is tracked now, and what the branch's commits add.
    expect(ci).toContain('No project bundle, export or env file is tracked')
    expect(ci).toContain('No commit in this branch adds data')
    expect(ci).toContain('Nothing tracked is over 5 MB')
    const steps = ci.split('- name:').filter((s) => /^ (No project bundle|No commit in this branch|Nothing tracked)/.test(s))
    expect(steps).toHaveLength(3)
    for (const step of steps) {
      const name = step.split('\n')[0].trim()
      expect(step, name).toContain('data-guard.sh')
      expect(step, name).toMatch(/data_guard_(reason|oversized)/)
      // A copy of a list here is the drift this test exists to prevent.
      expect(step, name).not.toContain('china-tour')
      expect(step, name).not.toContain('package-lock')
    }
    // Walking the branch's commits needs the history, not a shallow clone.
    expect(ci).toContain('fetch-depth: 0')
  })

  it('an install points git at the hooks, so a fresh clone is guarded before its first commit', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.prepare).toContain('hooks.mjs')
    expect(read('scripts/hooks.mjs')).toContain('core.hooksPath')
  })

  it('never switches off a hook that was there before: both hooks hand over to it once their own check passes', () => {
    // An organisation's global hooksPath (a secret scanner) or the clone's own .git/hooks is recorded by the
    // install as aegraph.previousHooksPath; pointing core.hooksPath here must not silently bypass it.
    expect(read('scripts/hooks.mjs')).toContain('aegraph.previousHooksPath')
    expect(guardSh).toMatch(/data_guard_chain\(\)/)
    expect(read('.githooks/pre-commit')).toMatch(/data_guard_chain pre-commit "\$@"\n$/)
    expect(read('.githooks/pre-push')).toMatch(/data_guard_chain pre-push "\$@"\n$/)
    // pre-push reads its refs from stdin once, and hands the same lines on.
    expect(read('.githooks/pre-push')).toContain('input=$(cat)')
  })
})

/**
 * The rules are only as good as the names they are handed. By default git quotes a name with a non-ASCII character
 * (`"caf\303\251.ae.json"`, quotes included), which no shape matches and no size can be read for, and a list split on
 * spaces hands `my project.ae.json` over as two harmless words. So the hooks and the CI steps themselves are run here,
 * in a scratch repository, on such names — not just the rules on a string.
 */
describe('the data guard, run for real on awkward names', () => {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
  const BIG = 6_000_000
  let dir = ''
  let hooks = ''
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  /** Runs a command, returning its status and what it said (stdout and stderr together). */
  const run = (cmd: string, args: string[], input = '', extra: Record<string, string> = {}) => {
    const r = spawnSync(cmd, args, { cwd: dir, env: { ...env, ...extra }, input, encoding: 'utf8' })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const put = (name: string, bytes: number | string = 'x') => {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), typeof bytes === 'number' ? Buffer.alloc(bytes, 'a') : bytes)
  }
  const commitAll = (msg: string, ...flags: string[]) => {
    git('add', '-A')
    return run('git', ['commit', '-q', '-m', msg, ...flags])
  }

  /** A CI step's `run:` script, read out of ci.yml as it is. */
  const ciStep = (name: string) => {
    const lines = read('.github/workflows/ci.yml').split('\n')
    const at = lines.findIndex((l) => l.trim() === `- name: ${name}`)
    const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l))
    const indent = lines[runAt + 1].match(/^\s*/)![0].length
    const body: string[] = []
    for (const l of lines.slice(runAt + 1)) {
      if (l.trim() && l.match(/^\s*/)![0].length < indent) break
      body.push(l.slice(indent))
    }
    return body.join('\n')
  }
  // Actions runs a step with `bash -e`.
  const runCi = (name: string, extra: Record<string, string> = {}) => run('bash', ['-e', '-c', ciStep(name)], '', extra)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegraph-guard-'))
    // The CI steps source ./.githooks from the checkout; git runs the hooks from outside the tree, so a branch
    // without them (an orphan) is still read by them.
    hooks = mkdtempSync(join(tmpdir(), 'aegraph-guard-hooks-'))
    cpSync(resolve(root, '.githooks'), join(dir, '.githooks'), { recursive: true })
    cpSync(resolve(root, '.githooks'), hooks, { recursive: true })
    git('init', '-q', '-b', 'main')
    git('config', 'core.hooksPath', hooks)
    put('README.md', 'hello')
    expect(commitAll('start').status).toBe(0)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(hooks, { recursive: true, force: true })
  })

  const awkward = ['café.ae.json', 'my project.ae.json', 'données/projet été.aeb', 'nested/.env', 'keys/server.pem']

  it('the commit hook refuses a bundle whose name has a non-ASCII character or a space, and a nested .env or key', () => {
    for (const name of awkward) {
      put(name)
      const r = commitAll(name)
      expect(r.status, name).not.toBe(0)
      expect(r.out, name).toContain(name)
      git('reset', '-q', '--hard')
      rmSync(join(dir, name), { force: true })
      git('clean', '-qfdx')
    }
  })

  it('the commit hook reads the size of such a file, rather than taking it for 0', () => {
    for (const name of ['données très grosses.bin', 'big file.bin', 'naïve.bin']) {
      put(name, BIG)
      const r = commitAll(name)
      expect(r.status, name).not.toBe(0)
      expect(r.out, name).toContain('over the 5 MB limit')
      git('reset', '-q', '--hard')
      git('clean', '-qfdx')
    }
    // Source with the same kind of name goes through.
    put('docs/notes été.md', 'fine')
    expect(commitAll('fine').status).toBe(0)
  })

  it('the push hook refuses those names in commits made with --no-verify, merges and first commits included', () => {
    const remote = mkdtempSync(join(tmpdir(), 'aegraph-guard-remote-'))
    try {
      execFileSync('git', ['init', '-q', '--bare', remote], { env })
      git('remote', 'add', 'origin', remote)
      expect(run('git', ['push', '-q', 'origin', 'main']).status).toBe(0)

      // A plain commit, skipped past the commit hook.
      put('café.ae.json')
      put('big file.bin', BIG)
      expect(commitAll('data', '--no-verify').status).toBe(0)
      let r = run('git', ['push', 'origin', 'main'])
      expect(r.status).not.toBe(0)
      expect(r.out).toContain('café.ae.json')
      expect(r.out).toContain('big file.bin')
      git('reset', '-q', '--hard', 'HEAD~1')

      // A merge that brings a file of its own (an "evil merge"): the merge commit is read too.
      git('switch', '-q', '-c', 'side')
      put('side.md', 'side')
      expect(commitAll('side').status).toBe(0)
      git('switch', '-q', 'main')
      put('main.md', 'main')
      expect(commitAll('main').status).toBe(0)
      run('git', ['merge', '-q', '--no-ff', '--no-commit', 'side'])
      put('my project.ae.json')
      git('add', '-A')
      expect(run('git', ['commit', '-q', '--no-verify', '-m', 'merge']).status).toBe(0)
      r = run('git', ['push', 'origin', 'main'])
      expect(r.status).not.toBe(0)
      expect(r.out).toContain('my project.ae.json')
      git('reset', '-q', '--hard', 'origin/main')

      // A first commit on a branch of its own (no parent): read whole.
      git('switch', '-q', '--orphan', 'fresh')
      put('naïve.aeb')
      git('add', 'naïve.aeb')
      expect(run('git', ['commit', '-q', '--no-verify', '-m', 'root']).status).toBe(0)
      r = run('git', ['push', 'origin', 'fresh'])
      expect(r.status).not.toBe(0)
      expect(r.out).toContain('naïve.aeb')
    } finally {
      rmSync(remote, { recursive: true, force: true })
    }
  })

  it('the push hook reads the new commits when the remote’s tip is one it has never fetched, rather than none', () => {
    put('café.ae.json')
    expect(commitAll('data', '--no-verify').status).toBe(0)
    const sha = git('rev-parse', 'HEAD')
    // Someone else pushed to the branch: git hands over a remote sha this clone does not have.
    const r = run('bash', [join(hooks, 'pre-push'), 'origin', 'nowhere'], `refs/heads/main ${sha} refs/heads/main ${'1234567'.repeat(5)}9\n`)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('café.ae.json')
    // It keeps nothing behind in a predictable place.
    expect(read('.githooks/pre-push')).toContain('mktemp')
    expect(read('.githooks/pre-push')).not.toMatch(/\/tmp\/aegraph-pre-push\.\$\$/)
  })

  it('the CI checks refuse the same names, as the hooks do', () => {
    put('café.ae.json')
    put('my project.ae.json')
    put('big file.bin', BIG)
    put('données/très gros.bin', BIG)
    expect(commitAll('data', '--no-verify').status).toBe(0)
    const tracked = runCi('No project bundle, export or env file is tracked')
    expect(tracked.status).not.toBe(0)
    expect(tracked.out).toContain('café.ae.json')
    expect(tracked.out).toContain('my project.ae.json')
    const big = runCi('Nothing tracked is over 5 MB')
    expect(big.status).not.toBe(0)
    expect(big.out).toContain('big file.bin')
    expect(big.out).toContain('données/très gros.bin')
    // A push event: the commits since `before`. The first commit is the base; the data commit is new.
    const commits = runCi('No commit in this branch adds data', { BASE: git('rev-parse', 'HEAD~1') })
    expect(commits.status).not.toBe(0)
    expect(commits.out).toContain('café.ae.json')
    // A new branch (`before` is zeros): the last commits, not none.
    expect(runCi('No commit in this branch adds data', { BASE: '0'.repeat(40) }).status).not.toBe(0)
  })

  it('the CI checks pass a clean tree', () => {
    put('docs/notes été.md', 'fine')
    put('.env.example', 'KEY=')
    put('api/.env.example', 'KEY=')
    expect(commitAll('fine').status).toBe(0)
    for (const step of ['No project bundle, export or env file is tracked', 'Nothing tracked is over 5 MB']) {
      expect(runCi(step).status, step).toBe(0)
    }
    expect(runCi('No commit in this branch adds data', { BASE: git('rev-parse', 'HEAD~1') }).status).toBe(0)
  })
})

describe('environment files and keys', () => {
  const refused = ['.env', 'api/.env', 'deep/inside/.env.local', 'certs/server.pem', 'tls.key', 'signing/store.p12', 'win/cert.pfx', 'id_rsa', 'home/.ssh/id_ed25519', 'keys/id_ecdsa.pub', 'gcp-service-account.json', 'config/my-service-account-prod.json']

  it('are data wherever they sit; an environment file’s example is not', () => {
    for (const p of refused) expect(guard(p), p).not.toBe('')
    for (const p of ['.env.example', 'api/.env.example', 'src/core/keys.ts', 'docs/service-accounts.md']) expect(guard(p), p).toBe('')
  })

  it('.gitignore ignores the same shapes', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'aegraph-ignore-'))
    try {
      const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: scratch }
      execFileSync('git', ['init', '-q', scratch], { env })
      cpSync(resolve(root, '.gitignore'), join(scratch, '.gitignore'))
      const ignored = (p: string) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: scratch, env }).status === 0
      for (const p of refused) expect(ignored(p), `${p} is refused by the hooks but not ignored by .gitignore`).toBe(true)
      expect(ignored('api/.env.example')).toBe(false)
      expect(ignored('.env.example')).toBe(false)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('.vercelignore — what `vercel deploy` from a checkout uploads', () => {
  /** Git's own reading of an ignore file, in a scratch repository where it is the only rule there is. */
  const withIgnore = (file: string, check: (ignored: (p: string) => boolean) => void) => {
    const scratch = mkdtempSync(join(tmpdir(), 'aegraph-vercelignore-'))
    try {
      const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: scratch }
      execFileSync('git', ['init', '-q', scratch], { env })
      cpSync(resolve(root, file), join(scratch, '.gitignore'))
      check((p) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: scratch, env }).status === 0)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  const unignored = (file: string) =>
    read(file)
      .split('\n')
      .filter((l) => l.startsWith('!'))
      .map((l) => l.slice(1).trim())

  it('leaves out every shape the hooks refuse: bundles, exports, ChatGPT files, screenshots, environment files, keys', () => {
    const data = [
      'my-project.ae.json',
      'notes.aeb',
      'archive.ae.json.gz',
      'public/datasets/whatever.aegraph.json',
      'deep/inside/a/folder/project.aeb.gz',
      'conversations.json',
      'my-chatgpt-export.json',
      'exports/rows.csv',
      'shot-1.png',
      'mcp/run.screenshot.png',
      'mcp-profile/Default/Cookies',
      '.env',
      'api/.env.local',
      'certs/server.pem',
      'home/.ssh/id_ed25519',
      'config/my-service-account-prod.json',
    ]
    for (const p of data) expect(guard(p) !== '' || /profile|exports/.test(p), `${p} is not data to the hooks`).toBe(true)
    withIgnore('.vercelignore', (ignored) => {
      for (const p of data) expect(ignored(p), `${p} would be uploaded by a CLI deploy`).toBe(true)
    })
  })

  it('keeps the source a build needs, the documents the repo ships and the example env file', () => {
    withIgnore('.vercelignore', (ignored) => {
      for (const p of [
        'index.html',
        'package-lock.json',
        '.env.example',
        'public/spec/example.ae.json',
        'public/templates/conversation-atlas.template.ae.json',
        'src/core/exchange/chatgpt.ts',
        'src/features/conversations/ChatGptImportCard.tsx',
        'src/core/exchange/__tests__/fixtures/small.ae.json',
      ])
        expect(ignored(p), `${p} would be left out of a CLI deploy`).toBe(false)
    })
  })

  it('allows back exactly the files the hooks do — no more, so a dataset that left the repo cannot ride along', () => {
    const allowed = new Set(allowedPaths(DATA_ALLOW))
    const back = unignored('.vercelignore')
    for (const p of allowed) expect(back.includes(p), `${p} is allowed by the hooks but not by .vercelignore`).toBe(true)
    // A plain path allowed back here must be one the hooks allow; patterns over src/ and the env example are the hooks' too.
    const plain = back.filter((p) => !p.includes('*') && p !== '.env.example' && p !== '/index.html')
    for (const p of plain) expect(allowed.has(p), `${p} is allowed back by .vercelignore but not by DATA_ALLOW`).toBe(true)
    // And the same for .gitignore's data allow-backs (it also allows back files that are not data, such as editor
    // settings), which named the demos' datasets until they moved to aegraph-ui-demos.
    const looksLikeData = (p: string) => /\.(ae|aegraph)\.json|\.aeb|^public\/datasets\/|^scripts\/aurora\//.test(p)
    const gitPlain = unignored('.gitignore').filter((p) => !p.includes('*') && looksLikeData(p))
    for (const p of gitPlain) expect(allowed.has(p), `${p} is allowed back by .gitignore but not by DATA_ALLOW`).toBe(true)
  })
})
