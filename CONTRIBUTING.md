# Contributing

Thank you for looking. This is a working repository rather than a finished
product, and the rules below are the ones that keep it coherent — they are also
what a review will ask about, so reading them first saves a round trip.

## Getting it running

```sh
npm install        # also installs the pre-commit guard (see Your data, below)
npm run dev        # http://localhost:5173
```

`npm install` fetches nothing from the network beyond the registry. The first
`npm run dev` or `npm run build` does (`predev` / `prebuild`): it downloads the
Pyodide runtime and its packages (from jsDelivr; plotly's wheel from PyPI) and the demo projects
(the copies aegraph.dev publishes; a checkout of the private aegraph-ui-demos
repository, or a token for it, takes precedence), and copies the script sandbox's libraries and the ONNX runtime out of
`node_modules`.
None of them is in the repository and all are ignored.

Node 22 or later (`.nvmrc` says 22; `engines` in `package.json` warns on an
older one). Chrome or Edge for everything — the projects folder and WebGPU need
them; Firefox and Safari run the app with those two features off. The README's
*Getting started* has what each prerequisite is for, and
[`docs/configuration.md`](docs/configuration.md) every environment variable the
app, the dev server, the bridge and the scripts read.

## The checks

```sh
npx tsc --noEmit -p tsconfig.app.json   # types, the app (what you run while working)
npx tsc -b --noEmit                     # types, every project: the app, the Vite configs, dev/ (what CI runs)
npm run lint                            # oxlint
npm test                                # the whole suite
npm run test:ci                         # what CI runs: the unit suite, then the bridge tests serially
```

`npm test` runs everything at once, which is what you want while working. CI
uses `test:ci` because the bridge tests spawn real processes and bind real
ports: run alongside two hundred other files on a loaded runner they fail on
timing rather than on anything true.

A pull request is expected to be green. What CI checks, and why each one is
there:

| Job | What it would catch |
| --- | --- |
| **Types, lint and tests** | the ordinary things, plus that `npm install` installs the commit guard |
| **The app builds, with the sandboxes in it** | a bundler losing a file — `?url` on a `.js` under `src/` once dropped both script sandboxes' bootstraps, and only a look at the output showed it |
| **No known advisory** | `npm audit --omit=dev` at `low` is a gate: nothing with an advisory ships to a browser. The build tools are gated too |
| **No secret in the history** | a credential in any commit, ever — not just the tip |
| **Nobody's data is in the repo** | a tracked project bundle, export or `.env`, and anything over 5 MB |
| **The lockfile works everywhere** | a lockfile rebuilt on one machine holding only that machine's native binaries, which is how `oxlint` became uninstallable on Linux while every check passed on a Mac |
| **CodeQL** | injection and taint-flow classes, weekly as well as per pull request. It reports under Security → Code scanning, which — like dependency review — starts working when the repository is public |
| **Dependency review** | a new dependency with an advisory or a licence this project cannot carry, said on the pull request. It reads GitHub's dependency graph, so it runs once the repository is public and skips itself until then |

Dependabot opens a grouped pull request weekly for dependencies and for the
actions in `.github/workflows` — which are pinned to commits, since a tag can be
moved to point at different code.

Two things the tests deliberately assert about configuration, because both ways
of getting them wrong are silent: `src/__tests__/headers.test.ts` checks the
deployed Content-Security-Policy still forbids inline script *and* still allows
what the script sandboxes are built on, and the lockfile job checks the native
binaries. Read `SECURITY.md` before changing either.

There is also a slow suite a person runs by hand — `npm run smoke` and the
`smoke:*` scripts — which drives a real headless browser over the bridge. It is
not part of CI. `/docs/smoke` explains what each step proves.

## Your data never goes in the repository

`npm install` points git at `.githooks`, whose `pre-commit` refuses to commit a
project bundle, an export, a ChatGPT file, a `.env` or anything over 5 MB, and
`.gitignore` refuses the same by shape. If you are working from a clone, keep
your projects folder somewhere else entirely. `SECURITY.md` has the detail.

Adding a dataset the project genuinely ships means an edit to `DATA_ALLOW` in
`.githooks/data-guard.sh` (which both hooks and CI read), the allow-list in
`.gitignore` and `.github/workflows/ci.yml`, in the same commit, saying why it
holds nobody's data; `scripts/__tests__/data-guard.test.ts` fails when they
drift apart.

## What "done" means here

A change is not done when the code works; it is done when what surrounds the
code says so, **in the same commit**:

1. **Documentation.** A change a user can see updates the page that describes
   it — the in-app docs page under `src/docs`, the README section, the file
   format spec and its JSON schema when a file can carry something new. Present
   tense, written for the reader of the product, not as a changelog.
2. **Tools.** A feature reachable from the UI is reachable through a tool
   (`src/features/assistant/*Tools.ts`), and a change to a feature's behaviour
   or data shape changes its tool, the tool's test, and the tool's description —
   which is its documentation.
3. **The area's guide.** Every area has an `AGENTS.md`: what it is, its layout,
   its rules. Read the one for the area before changing it; when you add an
   area, a page, a tool or a convention, add it there.
4. **Tests.** New behaviour comes with a test that would fail without it. The
   suite is fast and the bar is a test that describes the behaviour, not one
   that repeats the implementation.

`AGENTS.md` at the root is the map of the whole thing and is the best place to
start.

## Security

Please do not open a public issue for a vulnerability. `SECURITY.md` says how to
report one privately, and documents the parts of the system where data becomes
something the browser draws or runs — read that section before changing a
renderer, a sandbox, an importer or anything that fetches.

## Commits

One change per commit, with a message that says what is different and why
anyone should care — the subject as a sentence, the body in prose. Look at
`git log` for the tone. Contributions are under Apache-2.0, like the rest of the
repository.
