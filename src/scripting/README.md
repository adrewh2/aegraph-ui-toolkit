# scripting

Code over a read-only dataset snapshot, in two sandboxed engines, returning
figures, tables, images and scenes. Nothing leaves the machine.

**JavaScript** — `sandbox.ts`, `prelude.js`, `worker.ts`, `runner.ts`: a
QuickJS interpreter compiled to WebAssembly inside a worker. No I/O by
construction (no fetch, DOM, storage or timers); interrupt handler and memory
limit; the snapshot is parsed into the VM once per key and the context is
shared by the runs over it — so once the prelude is in, it is **locked down**:
every built-in and hidden intrinsic, the prelude's bindings and every global
are frozen, the host reads results through functions taken before any script
ran, a run's new globals are swept, and anything that cannot be swept costs the
context. An `untrusted` run (code its owner has not run here) discards it.

**Python** — `python/engine.ts`, `python/worker.js`, `python/prelude.py`:
Pyodide (CPython 3.12) with numpy, pandas and plotly loaded, more packages
on import, inside a worker inside a *sandboxed iframe* (opaque origin,
CSP `connect-src` limited to where the runtime and wheels are served —
`public/pyodide`, fetched by `scripts/pyodide/fetch.mjs`, else the CDN).
Jupyter-style execution: the trailing expression is displayed; every run has
a namespace of its own, copied from the prelude as loaded. A timeout
terminates the worker and boots a fresh one, and so do a run over another
project and an `untrusted` run (Python cannot be fenced from itself in one
interpreter). The worker answers only on a MessagePort the bootstrap hands it,
kept in a closure a script cannot reach. The runtime comes from this origin
only: with no `public/pyodide`, Python says to run `npm run pyodide`.

**Visual** — `view/engine.ts`: an ES module with a DOM, canvas and WebGL
in a sandboxed iframe (opaque origin, CSP to this origin only); three.js,
d3 and Plotly served from `public/vendor` (`scripts/vendor.mjs`); the frame
is the output. `ds` and the JavaScript prelude are in scope.

**No inline script in either frame, and that is load-bearing.** A frame —
`srcdoc` or loaded from a URL, it makes no difference — inherits the app's
Content-Security-Policy, and the `<meta>` policy a frame sets for itself can
only narrow what it inherited, never widen it. So an inline bootstrap stops
running the moment the app enforces a `script-src`, silently. Both engines
therefore load their bootstrap by URL from `public/sandbox/` — `view-boot.js`
and `python-boot.js`, served verbatim — and everything after it arrives as a
`blob:` script: the prelude and the user's module in the Visual frame, the
worker's source in the Python one. `sandboxBoot.ts` builds the URL and carries
`SANDBOX_PROTOCOL`, the version in its query string: **bump it in the same
commit as any change to the messages an engine and its bootstrap exchange**, or
a cached bootstrap will talk to a newer engine and fail unreadably.

`import * as THREE from 'three'` used to work through an inline
`<script type="importmap">`, which has no external form and so cannot survive
that. `view/specifiers.ts` rewrites those specifiers to their URLs before the
module is made; the documented API is unchanged.

Shared: `types.ts` (Snapshot, RunResult, Output, Language), `outputs.ts`
(`outputsOf`: the returned value as validated outputs), `figure.ts`
(`sanitizeFigure`: a figure Plotly may draw in the app's page — no URL it would
fetch, no markup that loads anything; `PlotlyChart` applies it too),
`limits.ts` (what a run may send back: log lines, result size, remembered
state), `detect.ts` (language from code). What runs without being asked is
decided in `src/features/scripts/consent.ts`. `src/features/scripts/api.ts` mirrors both preludes
in prose for the tool description and the docs page — change them together.
