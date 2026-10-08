/**
 * Point this clone's git at `.githooks`, so the pre-commit guard that keeps
 * your data out of the repo is there before the first commit.
 *
 * `npm install` runs it (package.json › prepare); `npm run hooks` re-runs it.
 * It is deliberately quiet and never fails a install: no git, a tarball with
 * no `.git`, a worktree — it simply says what it did and exits 0.
 *
 * It never switches off a hook that was already there. Pointing
 * core.hooksPath at `.githooks` would silently bypass an organisation's
 * global hooks directory (a secret scanner, say) or the clone's own
 * `.git/hooks`; so where one was, it is recorded in the clone's config as
 * `aegraph.previousHooksPath`, and `.githooks/pre-commit` and `pre-push`
 * run it after their own check (`data_guard_chain` in data-guard.sh).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quiet = process.argv.includes('--quiet')
const say = (m) => !quiet && console.log(`[hooks] ${m}`)

try {
  if (!existsSync(resolve(root, '.git'))) {
    say('no .git here — nothing to point at .githooks (a fresh clone will run this again).')
    process.exit(0)
  }
  const current = (() => {
    try {
      return execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  })()
  if (current === '.githooks') {
    say('already installed.')
    process.exit(0)
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  // What ran before: a hooksPath from any config level, or else the clone's own hooks directory if it holds a hook.
  const ownHooks = resolve(root, git('rev-parse', '--git-path', 'hooks'))
  const hasHook = (dir) => ['pre-commit', 'pre-push'].some((h) => existsSync(resolve(dir, h)))
  const previous = current ? (current.startsWith('~') || isAbsolute(current) ? current : resolve(root, current)) : hasHook(ownHooks) ? ownHooks : ''
  if (previous && resolve(previous) !== resolve(root, '.githooks')) {
    git('config', 'aegraph.previousHooksPath', previous)
    say(`chained: the hooks in ${previous} still run, after this repo's own check (aegraph.previousHooksPath).`)
  }
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root })
  say('installed: .githooks/pre-commit refuses to commit project bundles, exports, ChatGPT data, .env files and anything over 5 MB.')
} catch (err) {
  say(`could not install the hooks: ${err instanceof Error ? err.message : err}`)
  say('run `npm run hooks` once git is available — until then, nothing guards your commits.')
}
