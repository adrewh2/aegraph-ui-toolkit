# Handoff: the Scripts tab (testing and extending it)

For a Claude Code session that has the `aegraph` MCP server attached (so
`script`, `analyze`, `plot`, `open`, … reach the user's own browser tab).
Everything below is committed on `master` as of `3754216` (2026-09-13).
Start by reading `src/scripting/README.md` and `src/docs/scripts.md`, then
`src/features/scripts/api.ts` (the reference the assistant reads).

## What exists

Three engines behind one page (`/scripts?script=<id>`, sidebar → Scripts) and
one tool (`script {api|run|show|save|list|get|delete}`, `language` optional —
detected from the code by `src/scripting/detect.ts`):

| language | runs in | sandbox | output |
| --- | --- | --- | --- |
| `js` | QuickJS (WASM) worker — `src/scripting/sandbox.ts`, `prelude.js` | no I/O by construction; interrupt after 5 s; 512 MB | `return figure(...)` / `table(...)` / `scene(...)` / `{ text }` |
| `python` | Pyodide 0.27.7 worker inside a `sandbox="allow-scripts"` iframe — `src/scripting/python/` | opaque origin + CSP `connect-src` = serving origin; timeout 30 s terminates and reboots the worker | Jupyter-style: trailing expression — plotly figure, DataFrame, matplotlib figure (image), str; `print()` → logs |
| `view` | an ES module in a sandboxed iframe with DOM/canvas/WebGL — `src/scripting/view/engine.ts` | opaque origin + CSP to serving origin; Stop removes the frame | the frame itself; `aegraph.result(v)` optional |

Shared contract: `src/scripting/outputs.ts` (`outputsOf`: figure / table / scene
/ text / image / value). Snapshot: `src/features/scripts/snapshot.ts` (dataset
of the open project, long text truncated, latest Insights metrics attached;
cached per store version). Runner singletons: `src/features/scripts/runner.ts`.
Page: `ScriptsView.tsx` (CodeMirror `CodeEditor.tsx`, language select with
Auto, templates in `templates.ts`, handle in `scriptHandle.ts` the tool drives).
Entities: type `script` (`script.ts`), `data.{code, language, lastRun}`.

Generated, gitignored, produced before `npm run dev`/`build`:
`public/pyodide/` (`npm run pyodide`, ~100 MB: runtime + 28 wheels + plotly
from PyPI), `public/vendor/` (`npm run vendor`: three.js build + examples/jsm,
d3, Plotly UMD), `public/demos/` (`npm run demos`: the demo projects, Aurora
among them, from the aegraph-ui-demos repository).
`vite.config.ts` `pyodideCors` sends `Access-Control-Allow-Origin: *` for
`/pyodide/` and `/vendor/` — the iframes have an opaque origin, so without it
`loadPyodide` hangs silently.

Templates worth running first: *Constellations* (`examples/constellations.js`,
three.js + bloom, the graph as columns of time), *Python · pandas + plotly
express*, *Python · 3D scatter*, *Visual · d3 force layout*.

## How to test from your session

The tool loop the assistant is meant to use, and the fastest way to exercise
everything:

```
script {action:"api", language:"python"}            # read the reference once
script {action:"run", language:"python", code:"..."} # summary: traces/first points, table head, logs, errors with stack
script {action:"show", code:"...", save_as:"Name"}   # opens /scripts, runs, draws; saves as a script entity
script {action:"edit", id, find, replace}          # one unique replacement, no resend
script {action:"list"} / get / delete
```

Checks that already pass (re-run them after changes):

- JS: `return figure(line(...))`, `table(...)`, `scene(positions)` → *Open in
  the Display Scene*; `while(true){}` with `timeout_ms: 500` → "interrupted";
  `fetch` → "'fetch' is not defined".
- Python: first run boots in ~4 s (status in the page footer: runtime →
  packages → ready with versions), later runs in ms; `px.line(...)`,
  `entities.groupby('type').size()`, a matplotlib `fig` → image;
  `from js import fetch; fetch('https://example.com')` is a pending future that
  fails (CSP); `await` at top level works (`await asyncio.sleep(0)`, `x = await
  f()`, a trailing `await …` expression is displayed); `g = graph()` loads
  networkx on demand.
- Visual: `import * as THREE from 'three'` works, `renderer.getContext()` is a
  WebGL context, `fetch('https://example.com')` fails, `localStorage` throws
  SecurityError; the Constellations template renders in ~2.5 s.
- Unit tests: `npx vitest run src/scripting` (sandbox, outputs, detection);
  `npx tsc --noEmit -p tsconfig.app.json` (note: `-p .` is a no-op).

The whole checklist above is a smoke step: `npm run smoke:scripts` (=
`GL=1 node mcp/drive.mjs mcp/smoke/5-scripts.mjs`, a fresh headless tab on
the default Aurora project; ~30 s, Pyodide boot included). It prints one
`ok`/`FAIL` line per check — every engine, every tool action, the
Constellations template on screen.

Headless alternative for ad-hoc steps: `PROFILE=aurora-profile GL=1
node mcp/drive.mjs steps.mjs` (steps get `{ call, evaluate, sleep, shot }`).
Gotchas: `window.confirm`/`prompt` on the Scripts page (template replace,
Save as) block CDP — stub them (`window.confirm = () => true`) before
clicking; a full `location.assign` mid-script makes the next bridge call
time out — navigate with `call('open', { page })`.

## Known gaps and good next steps

1. ~~**Async Python cells.**~~ Done (2026-09-13): `_aegraph_run` is async, compiles
   with `PyCF_ALLOW_TOP_LEVEL_AWAIT` and awaits the coroutines `eval` hands
   back; the worker calls it through `runPythonAsync`. Trailing-expression
   display is unchanged. Also fixed: `graph()` failed with "No module named
   networkx" because the import scan only reads the script — the worker now
   loads networkx when the script calls `graph(`.
2. **Micropip from PyPI.** `micropip.install('somepkg')` fails under the
   self-hosted CSP (connect-src is our origin only). Options: add
   `https://pypi.org https://files.pythonhosted.org` to `connect` in
   `python/engine.ts` `locate()` behind a setting, or extend
   `scripts/pyodide/fetch.mjs` `WANT`.
3. **Computed columns.** A script returning `{ columns: { name: { id: value } } }`
   could become `col.<name>` value refs everywhere (plots, styles, filters).
   Needs `src/core/graph/values.ts`.
4. **Scripts in the Display Scene / workstation.** `/scripts?script=<id>`
   already works in panes; a `script` content kind in the Display Scene (show a
   saved script's figure without the editor) would make scripts first-class
   beside plots. Also *Save as plot* when a JS/Python result is a PlotSpec.
5. **Editor niceties.** Autocomplete for `ds.*`/helpers (CodeMirror
   `@codemirror/autocomplete` with a static completion source from `api.ts`),
   error line highlighting from the stack (`script.js:LINE:COL`,
   `script.py line N`), a "Run selection" command.
6. ~~Results across navigation~~ Done (2026-09-13): the last run per script is
   kept in memory (`lastRuns` in `ScriptsView.tsx`) and shown again on return;
   visual frames live in a fixed layer (`FrameLayer` in `view/engine.ts`) that
   tracks the host's rect and clips to scrolling ancestors — leaving the page
   hides the frame, coming back shows the same iframe (no reload, WebGL
   context kept); one live visual at a time.
7. **Visual engine polish.** A dedicated full-screen button for the frame,
   resize the iframe with the pane (it is 62vh fixed), pass `devicePixelRatio`,
   and an optional second output slot for `aegraph.result` figures.
8. **Insights → script.** Findings could carry a "Reproduce as script" action
   that opens the Scripts page with generated code (e.g. the composition
   plot as pandas), turning the harness into a teaching path.
9. **Assistant flow.** The system prompt in `session.ts` routes
   "anything a plot spec can't express" to `script`; try a few natural asks
   ("compare MTTR before and after the alerting overhaul", "3D view of the
   dependency graph") end to end and tighten the reference text in `api.ts`
   where the model stumbles. The tool's `run` summary caps points at 12 per
   trace (`points`).
10. **Security review before any prod deployment.** The Python/Visual iframes
   depend on the CSP meta + `sandbox` attribute; a production host must
   send the CORS header for `/pyodide/` and `/vendor/` and should not add a
   permissive CSP of its own to those paths. The JS engine needs nothing.

## Related

- Analytics harness: `src/analysis/` + `src/features/analysis/`, tool
  `analyze`, page `/insights` (`src/docs/insights.md`). Its metrics are what
  `ds.metric()` / the `metrics` DataFrame expose after a run.
- Aurora demo: built in the aegraph-ui-demos repository (`generators/aurora`)
  and opened from the Demos tab or `load_dataset {sources:['aurora']}`.
- Stage only your own files (never `git add -A`); `vite.config.ts`
  `optimizeDeps.include` must list any new lazily loaded dependency.
