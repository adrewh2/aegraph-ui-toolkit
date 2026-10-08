# A behaviour pass over `core/graph` — what it found, and the shape of what it found

*A note. Status: report · 17 September 2026, extended the same evening. Seven wake-ups of the autonomous session on the first day, nineteen more on the second, one module each.*

## The method

Every module in `src/core/graph` that a user's question passes through already had a test file. The pass did not read those tests for what they covered; it read the module for what a caller could ask, listed the questions the tests never asked, and wrote them down as a new file beside the old one (`<module>-edges.test.ts`) before touching any code. Then:

1. Run the new tests. Some fail.
2. For each failure, decide who is wrong. When the code is — the docs, the type's comment or the module's own contract say one thing and the answer says another — fix the code minimally, with the failing test as the evidence. When the expectation is — the fixture was misread, the behaviour is a documented choice — correct the test and say so in the commit.
3. Typecheck, run the whole suite, commit the module's tests and fixes together.

Seven modules, seven commits, about thirty minutes each. The discipline that mattered: the test came first, and a wrong answer was only ever changed under a test that showed it wrong. Fourteen of my own expectations were wrong across the seven passes; each was corrected in the test, never in the code.

## The eight defects

| Module | Commit | What a user saw | Cause |
| --- | --- | --- | --- |
| `values.ts` | `8274156` | `data.address.city` in a style, a placement axis or a chart drew nothing, though [Values](/docs/values) promises dotted paths reach nested keys | `valueOf` read `node.data[key]` with the whole dotted key |
| `values.ts` | `8274156` | A date field used as a number (a placement axis, a sort) came out as *missing*, though `numericOf`'s own comment says ISO dates coerce | `coerce` needs two dates to compare; with one and a zero it fell through to strings |
| `values.ts` | `8274156` | A node whose label is an empty string showed as blank where every table shows its id | `label ?? id` treats `''` as present; `displayLabel` does not |
| `selector.ts` | `cbfa3ad` | *Top 5 by PageRank* (in `graph_query`, a placement's order, any tool that sorts) could begin with nodes that had no PageRank | a descending sort reversed the whole list, blanks included |
| `selector.ts` | `cbfa3ad` | A tool asking for notes with a project of three members loaded and three other nodes in view was told nothing was hidden | `outsideView` was skipped whenever the dataset and the view had the same *count* of nodes |
| `placement.ts` | `967df1f` | A grid or circle ordered descending by a value put the nodes with no value first | the same reversal as the selector's |
| `rendering.ts` | `8ce92ad` | *Colour by field* with a dotted key coloured everything as missing | `getPath` was handed the key without its `data.` prefix |
| `plot.ts` | `c810cac` | A bar chart with numeric bins over a field where one row holds a word turned the whole axis categorical (Plotly's rule for a mixed axis) | the word made a bucket of its own on the numeric axis instead of counting as missing |

Three modules answered every question right: the filter (`82e1acd`, eight tests over roots and checklists, direction, degree bands, k-core, components, the cap, includes and excludes, members, skipped predicates), and shortest paths with the selection (`fc457ae`, seven tests over weights, direction, reachability, every selection operation).

## The shape

Five of the eight are two ideas repeated:

- **Blanks on a descending sort** — the selector and the placement each sorted ascending with blanks last and then reversed the lot. The same line, written twice. The fix was the same in both places (reverse the valued part, keep the blanks last); the third place that sorts, the plot builder's buckets, does not carry blanks, and the fourth, the Nodes table in the explorer, sorts in React and was not in this pass.
- **A dotted key into `data`** — `values.ts` (`data.a.b`), `rendering.ts` (`field` attr `a.b`) and `fields.ts` (`getPath`) each had their own way to read a data field, and none walked into an object. One helper, `dataAt`, now serves all three; the test that proved it wrong in one place proved it wrong in the next.

The lesson is not that the code was careless — the modules with the most callers (filter) were clean — but that *a rule stated once in the docs is implemented in several places*, and a test written against the rule finds every place at once. Two things would make the next such rule cheaper to keep:

1. **One `sortWithBlanksLast(keyed, desc)`** in `core/graph/fields.ts`, used by the selector, the placement and anything that later sorts by a value. The explorer's Nodes table is the obvious next caller.
2. **A cross-module test** of the three rules the docs state about values — dotted keys reach nested data, ISO dates read as numbers where a number is wanted, a blank label reads as the id — run through every entry point that reads a value: `valueOf`, `getPath`/`matchPredicate`, `nodeAttrValue`, the plot builder's `axisValue`. Today three of those four have the test; the fourth is covered only by the plot's own fixture.

## What was not passed

`core/graph` modules with tests but no edge pass, in rough order of how much a user leans on them:

- `metrics/csr.ts` and `compute.ts` — the metric kernels (degree, components, clustering, PageRank, betweenness, closeness, eigenvector, HITS) and sampling. `metrics.test.ts` checks values on a small fixture; the edges are disconnected graphs, self-loops, multi-edges, weights, and the sampled paths.
- `budget.ts` — the view budget and its trim suggestions; `budget.test.ts` exists.
- `pipeline.ts` — `describePipeline`: staleness, metric refs in layout and style, the notes.
- `project.ts` / `dataset.ts` — `buildProject`, `projectOverlay`, `datasetKeyOf` order-independence, members.
- `scales.ts` — `domainOf` with a single value, log with zeros, `categories` overflow and ordering.
- `algorithms.ts` — `kCore`, `connectedComponents`, `hopsFrom`, `degreesOf` directly (the filter pass reached them through `applyFilter`).
- `layouts.ts` — the built-in layouts' parameters at the edges (a single node, `spacing` 0, `centerId` absent).

Outside `core/graph`, the same pass would suit `core/entity/store.ts` (marks, scopes, includes, `query`), `core/exchange/formats.ts` (every accepted shape of an entity) and `core/resources/annotations.ts` (selectors of every kind).

## What it cost

Seven wake-ups; 51 new tests in seven files (the suite went from 429 to 480 with them); eight code changes, none larger than a dozen lines; no change to any public shape. Every fix has a user-facing sentence in its commit message, and every commit was made with the full suite green.


---

## The second day

The pass left `core/graph` the same evening and went through the rest of the core: the store, annotations, every import and export format, the diagram pipeline end to end, the layouts, scenes, the style channels again, and one place that is not a module at all — the runner every assistant tool goes through. Same method, same rule: the test first, a wrong answer changed only under a test that showed it wrong.

### Nineteen passes

| Module | Commit | Tests | Defects | In a sentence |
| --- | --- | --- | --- | --- |
| `metrics/csr.ts`, `compute.ts` | `f00daa3` | 11 | 1 | The CSR built an edge whose end was not a node; the kernels on loops, multi-edges, weights and sampling |
| `scales.ts`, `budget.ts`, `algorithms.ts` | `b4a8de6` | 9 | 0 | Domains from one value and log over zeros, the tenth of slack over an accepted load, k-core cascades |
| `pipeline.ts`, `project.ts`, `dataset.ts` | `edf120b` | 7 | 0 | Staleness, metric refs in style and layout, the dataset key's order independence |
| `entity/store.ts` | `ddd29a5` | 7 | 0 | Cascades, scopes through a cycle, marks bringing the joining relationships, the two version counters |
| `resources/annotations.ts` | `68b6485` | 9 | 1 | `data.comment` overrode the trimmed named comment; every selector kind, deletion from either end |
| `exchange/formats.ts` | `2b3fe9f` | 15 | 2 | A declared `kind: 'entity'` lost to inferred `source`/`target`; `directed: "false"` read as directed |
| `exchange/graph/*` (cyjs, CSV, GraphML, GEXF, mapping) | `e995ae8` | 14 | 4 | cyjs dropped `name` beside a label, leaked `directed` into every relationship's data, let inferred ends override a declared group; CSV wrote `NaN` |
| `exchange/graph/rdf.ts` | `13d6dca` | 11 | 4 | A triple stated twice made two edges; the stub count lied; `%` in a name threw `URIError`; a stub kept its mark after being described |
| `diagrams/mapping.ts` | `976fcbb` | 8 | 3 | A node named like a project was merged *into* the project; an unmapped edge label vanished; skipped edges were silent |
| `diagrams/sync.ts`, `dotPatch.ts` | `3a2c070` | 14 | 2 | A removed node stayed in a chained `a -> b -> c`; a one-line graph got statements above `digraph {` |
| `diagrams/dot.ts`, `mermaid.ts` | `9b0fe67` | 17 | 8 | `{ a b } -> c` made no edges; trapezoids never parsed; a quoted label with `]` was cut; `-->` at line start made a node `--`; four smaller reads |
| `diagrams/excalidraw.ts` | `1c56cd9` | 9 | 0 | Deleted elements, half-bound arrows, frames by id or containment, previous-drawing reuse |
| `diagrams/layout.ts`, `geometry.ts`, `extract.ts` | `4506db0` | 10 | 1 | A path coordinate in scientific notation was read as a command |
| `graph/layouts.ts` | `2d7f319` | 11 | 3 | `concentric-by-degree` looped forever at spacing 0; `force` threw below zero; pins kept for ids outside the slice |
| `graph/projection.ts` | `5ad91d2` | 7 | 2 | A collapsed entity was twice a group member; nested groups lost their parent on the way out |
| `graph/parallel.ts`, `style.ts` | `1a318f6` | 5 | 1 | `a→b` and `b→a` drew as one curve in every renderer |
| `features/assistant` tool runner | `97d5b6c` | 4 | 1 gap | No runner validated tool arguments against the schema |
| `graph/rendering.ts` (channels, legends) | `c791e0c` | 9 | 1 | The legend stripped a tag namespace only when spelled without its colon |
| `graph/filter.ts` (structure) | `decc706` | 5 | 0 | Pruning order, off-values, a cap of zero, walks through cycles by direction |

182 tests, 34 defects and one gap. With the first day: 233 new tests in twenty-six files, the suite from 429 to 666, 42 things fixed, none larger than a screen.

### The ten that mattered most

1. **Opposite arrows drawn as one** (`parallel.ts`). `a cites b` and `b cites a` — the commonest bundle in any citation or dependency graph — drew as a single curve in the 2D explorer, the 3D view and the SVG export. The bundle got mirrored indices, but every renderer applies curvature relative to the edge's own direction, so the mirrored sign cancelled the flipped perpendicular and both control points landed on the same side. Confirmed on the live canvas the next wake-up, screenshot on record.
2. **An infinite loop one call away** (`layouts.ts`). At `spacing: 0`, `concentric-by-degree` never placed a node: the ring radius never grew and its capacity was 0/0. The tool schema says `minimum: 0.1`, but — see 3 — nothing enforced it, so the assistant could hang the tab.
3. **Tool arguments were never checked** (the runner). The SDK's `betaTool.parse` is the identity, its docstring notwithstanding; the bridge and the MCP server forward what they get. Every `minimum`, `maximum` and `enum` in sixty tool schemas was documentation for the model and nothing more. `createAppTools`, the one place every runner passes through, now checks the top-level arguments against the schema and refuses with a sentence the model can act on.
4. **A `%` in a name failed the whole RDF import** (`rdf.ts`). `decodeURIComponent` on a local name with a stray percent threw `URIError`, and the importer rethrew it as "not valid RDF". One bad label, no import.
5. **A diagram node merged into a project** (`diagrams/mapping.ts`). The import's merge-by-label and reuse-by-id checks excluded layouts, views and diagrams but not projects, workstations or, by id, type definitions. A DOT node labelled "Project" would have tagged the project entity and written data onto it.
6. **`{ a b } -> c` made no edges** (`dot.ts`). A subgraph or block at the start of a statement was read as a block on its own and the arrow after it skipped as junk. The right-hand form worked, so the sample-based tests never saw it.
7. **A stub that never grew up** (`exchange/graph/mapping.ts`). A thing first imported as a reference (`stub: true`) kept that mark forever once a later file described it in full, because the update merged the old data under the new attributes.
8. **`directed` in every imported relationship's data** (`cyjs.ts`). The parser read `directed` from an edge's data and left it there too, so a cyjs round trip stamped `data.directed` on every relationship — and, by the same slip, a flat element declaring `group: 'nodes'` was filed as an edge if it carried `source` and `target`.
9. **A node removed but not gone** (`dotPatch.ts`). The patcher took a deleted node off its own line and left the chained edge that named it, so Graphviz recreated the node on the next render. The first test written for it passed for the wrong reason — the graph was on one line, which turned out to be a second defect: statements inserted above `digraph {`.
10. **Trapezoids** (`mermaid.ts`). `[/x\]` and `[\x/]` never parsed: the first bracket pair whose opener matched gave up when its closer was missing instead of trying the next. Small, but every shape the docs list should parse.

### What the method taught

- **Wrong expectations ran about one to one with defects.** Across the nineteen passes I tallied twenty-seven of my own expectations wrong against thirty-four real defects. Every one was corrected in the test with a sentence saying why, never in the code. The ratio is the point: a test that fails is a question, not a verdict, and the module's own comments and docs decide it. The passes with the most wrong expectations (layout geometry, seven) were the ones where I guessed arithmetic; the passes with none (the store, Excalidraw, the filter's structure) were the ones where I read the code first.
- **Live verification found what paper could not.** The parallel-edge fix was proved on paper by the SVG writer, then driven headlessly the next wake-up — and the live run is what showed that `graph_layout` accepted `spacing: 0` against its schema, which led to the runner fix. A page is involved; drive it.
- **A hang looks like nothing.** The layout loop showed as a vitest run that never printed its summary. The discipline that came out of it: run vitest into a log file with a bounded wait, read the `Tests` line, treat a `Failed Tests` header *or a missing summary* as stop, and kill stray workers by PID. One commit went in with a failing test because a grep pipeline masked the exit status; it was amended within the minute, and the rule was written down.
- **The richest seams were the parsers.** Hand-written parsers of formats with a grammar (DOT, Mermaid, RDF, cyjs) gave eight, four and four defects; modules with one caller and a typed contract (the store, the filter) gave none. If there is a third day, it starts with whatever else parses text.

### What remains

- `core/graph/metrics/cache.ts` and `src/analysis/run.ts` — the result cache's invalidation, partial compute over a changed option set, the `runInsights` hooks.
- The layout worker path — `runLayoutInWorker`, `layoutEngines.ts`, what happens when an engine refuses or the worker dies mid-job.
- `core/exchange/pack` (the binary format's edges), `atlas.ts`, `chatgpt.ts` (the classifier around the export).
- `features/graph/explorerState` reducers — a features-level pass, the first outside `core`.
- The explorer's Nodes table sort, still the one sort not using `sortWithBlanksLast`.
- `mcp/server.mjs` — routing between tabs, the timed-out call, the manifest.
- Persistence (`persistence.ts`) — needs `fake-indexeddb`; the owner's call.

## The third day

The pass moved out of `core`: the bridge server, the explorer's provider and its verbs, the tables, the workstation, the sandbox, the docs, the Markdown parser, the formatting helpers — and, where a page was involved, one owner request landed between wake-ups (Table and Graph buttons per type on the Ontology page, `3ffafff`). Same method. The one new thing was a harness: React providers mounted for real with no DOM at all.

### Fifteen passes

| Module | Commit | Tests | Defects | In a sentence |
| --- | --- | --- | --- | --- |
| `core/graph/metrics/cache.ts`, `compute.ts` | `f21f0d0` | 5 | 1 | The paths walk ran with nothing asked and reported a diameter of 0 |
| `core/graph/runLayoutInWorker.ts`, `layoutEngines.ts` | `56ad7a4` | 6 | 2 | An already-aborted signal still spawned a worker; the job type dropped `params` |
| `features/graph/explorerState` (reducer) | `0937bd8` | 8 | 2 | A landed picture kept the last layout error; a repeated selection was a change |
| `core/exchange/pack` | `2121c09` | 6 | 3 | A truncated pack looped forever; a year below 100 became 19xx; the version message pointed the wrong way |
| `mcp/server.mjs` | `a90f282` | 10 | 1 | With the whole port span taken, the status tool named a port another session owns |
| `features/graph/explorerState` (provider) | `08ef161` | 6 | 0 | `positionsFor`, both `runLayout` paths, cancel, the unmount, `selectOp` — mounted for real |
| `features/resources/EntityTable` (sort) | `eda220c` | 7 | 1 | One unparsable date keyed `NaN` and left the whole column unsorted |
| `core/exchange/atlas.ts`, `chatgpt.ts` | `afce59b` | 10 | 1 | A `current_node` the mapping lacked emptied the conversation |
| `features/graph/useSelectionActions` | `cfdc604` | 9 | 0 | Hide/unhide, pins, focus, remove, tag, the path, export, open-in-graph, linked entities |
| `core/graph/budget.ts` (leftovers), `fields.ts` | `5acafa0` | 7 | 0 | Zero budgets, duplicate edges, tied trims; every predicate operator on every value shape |
| `features/graph/focus.ts`, `cameraMemory.ts` | `5719351` | 6 | 0 | Every colour form, fades and deepenings at 0/1, the camera keyed per picture, the debounced saver |
| `features/workstation/model.ts` | `79129f2` | 7 | 4 | A tab moved to a pane that did not exist was swallowed; three smaller |
| `features/workstation/FixedPanes`, `hosts.ts` | `3571992` | 5 | 3 | Maximizing an id the page lacked collapsed every pane; two smaller |
| `scripting/sandbox.ts`, `outputs.ts`, preludes, `detect.ts` | `58e652b`, `8e1aa46` | 13 | 3 | A returned promise read as `{}`; a thrown object as `[object Object]`; an empty png as an image |
| `src/docs` (integrity), `lib/markdown.ts`, `lib/format.ts`, `lib/*`, `exportView`, `snapshot` | `8bc655b`, `6093697`, `4c15d88`, `01952be` | 26 | 8 | Parentheses in a link URL; six formatting slips; a NaN snapshot size |

131 tests, 29 defects. With the two days before: 364 new tests in forty-four files, the suite from 429 to 837, 71 things fixed by this table's count (the journal's running tally, which bundles a couple, says 69).

### The ones that mattered most

1. **A truncated pack hung the tab** (`pack/bytes.ts`). The byte reader read past the end as `undefined`, and the varint loop never ended — a synchronous hang on a corrupt or cut-off `.aeb`, not an error. Every read checks its bounds now.
2. **One bad date unsorted the whole column** (`EntityTable`). `new Date('garbage').getTime()` is `NaN`, `NaN` compares equal to everything, and V8's sort returned the rows untouched. Unparsable values sink with the missing ones.
3. **A tab moved to nowhere vanished** (`workstation/model.ts`). `moveTab` closed the tab at its source before checking the destination existed; with a stale pane id the tab was gone and the focus pointed at nobody.
4. **Maximize collapsed everything** (`FixedPanes`). An id the page did not have matched no pane, so every pane collapsed — the one state the module promises never to reach.
5. **A stale leaf pointer emptied a conversation** (`chatgpt.ts`). The fallback walk from the root ran only when `current_node` was absent, not when it named a node the mapping lacked.
6. **Scripts returning promises got `{}`** (`sandbox.ts`). No event loop in the sandbox, so nothing ever settles; the script now gets an error saying scripts are synchronous.
7. **`InfinityM`, `-0`, `1000K`, numeric dates as digits, negative durations, emoji cut in half** (`lib/format.ts`). Six slips in the helpers every view calls, none of which had a test.
8. **The status tool named another session's port** (`mcp/server.mjs`). With the span exhausted, a bridge that was not listening at all reported the base port.

### What the harness made possible

- **Providers mounted without jsdom.** `react-dom/client` needs surprisingly little when the tree renders nothing: a container with a node type, tag name and namespace, an owner document with `addEventListener`, a `window`, an `activeElement`, an `HTMLIFrameElement` to test against. With those, `ExplorerProvider` mounts for real — effects, callbacks, dispatch under `act` — and `useSelectionActions` on top of it with a `MemoryRouter`, the toast provider (its text read from the fake element's `textContent`) and a pane host. Two passes, fifteen tests, no new dependency. The pattern is in `explorerProvider-edges.test.tsx` and `selectionActions-edges.test.tsx`.
- **Fake tabs and fake workers.** The bridge is tested by a real MCP client over stdio and tabs over `ws`; the layout worker by a `Worker` class the test drives by hand. Both let the test say what the other side does — a tab that never answers, a worker that answers twice, a server whose port is taken.
- **Named waits solved a flake.** The bridge's token test stalled in about one full run in three and passed alone every time. Each wait got a name (`stuck: close with wrong token`), the next stall said which, and it was the test's own race: the second close listener was attached only after awaiting the first. Rule kept: a wait that can hang says what it is waiting for.

### Open owner decisions

- **b10, b20, b22** — from the first two days, still open in the console's backlog.
- **b24** — the `.ae.csv` export has no `meta.projects` column, so project membership does not round-trip through CSV.
- **b26** — the script wrapper is sloppy-mode JavaScript: `entity.data.n = 5` into the frozen dataset is silently ignored (a sort or push still throws with the read-only hint). `'use strict'` would report it but break scripts that assign undeclared names.
- Persistence (`persistence.ts`, 435 lines) still has no edge pass — it needs `fake-indexeddb` or an owner's blessing to stub IndexedDB.

### What remains

Modules of eighty lines or more that no `-edges` test imports, by size, leaving out demo data and the assistant's tool files (owned by another session this week):

- `features/maps/maps.ts` (728) — places, KML/GeoJSON, the time filter.
- `core/exchange/generate.ts` (364) — the synthetic dataset generator (its 200k timing test is load-sensitive).
- `features/documents/documents.ts` (302), `features/projects/publish.ts` (426), `folder.ts` (243) — the document model, publishing a page, the project folder.
- `features/ontology/profile.ts` (263), `reference.ts` (194) — type profiles and the schema reference behind the Ontology page.
- `core/constraints/engine.ts` (230), `rules.ts` (157) — the new rules every write must satisfy.
- `core/exchange/import.ts` (222), `ae/validate.ts` (179), `core/projects/bundle.ts` (164) — the import front door, the validator, bundles.
- `analysis/analyses/anomalies.ts` (230), `temporal.ts` (208) — Insights' analyses.
- `scripting/view/engine.ts` (209), `python/engine.ts` (195) — the iframe and Pyodide engines' pure parts.
- `core/search/vocabulary.ts` (194), `core/graph/engines/spectral.ts` (171), `elk.ts` (163).
- `core/exchange/graph/svg.ts` — the SVG writer has an interop test but no edge pass: labels, curves, markers, escaping, an empty view, huge coordinates.
