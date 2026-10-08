# Performance analysis and plan — 2026-09-17

## Outcome (2026-09-18)

Every step below was done, as the `[perf]` commits (`git log --grep='^\[perf\]'`): 11718b7 hover picking · 0265bce lazy chunks · d7fab6c switcher counts / scopeOf cache · cadbad4 seed positions · 7a6a2df dormant renderers · 66c8789 visible-rows / render-loop guard. Step 4 (vendor dedupe) was dropped after inspection — see P3. Measured after, same harness:

| | Before | After |
| --- | --- | --- |
| Hover sweep, 40 moves, 6k-node slice | 51 long tasks, 125 s | 0 long tasks, 15 s (the sleeps) |
| Landing on the 6k-node slice | long tasks 2.6 s + 7.5 s | none |
| Entities page mount | 1,003 ms of long tasks (max 568) | 55–107 ms |
| Entry chunk | 1,283 KB | 544 KB |
| Graph Explorer chunk | 1,647 KB (three.js inside) | Graph3D its own 1,360 KB chunk, loaded on first 3D |
| Kept graph pages | canvases held for ever | 0 canvases after 60 s away; selection and camera identical on return |
| "Maximum update depth" on the relationships view | intermittent | not reproduced in three runs; the error log now names the owner if it recurs |

Harness caveat found on the way: under headless software WebGL a bare 1×1 `getContext('webgl2')` took **9.9 s** (measured), so any walk that unmounts a graph page (KeptPages evicting a section, or the dormant release) shows an 8–10 s "long task" attributed to `loseContext`. On hardware the same calls are 5–8 ms. Read the graph-page numbers in the page-walk table below with that in mind; the hover, landing, Entities and bundle numbers are unaffected.

Measured on the Aurora reliability review project (5,960 nodes / 14,094 edges in scope; the Library holds 43,685 entities) through the headless driver (`GL=1 node mcp/drive.mjs`, software WebGL, machine load average 6–8 from other sessions). Wall-clock numbers are therefore upper bounds; the *shape* of each cost — what runs, how often, on which thread — is what the plan rests on. Scripts: `perf.mjs`, `perf2.mjs`, `perf3.mjs`, `perf6.mjs`, `perf7.mjs` in the session scratchpad.

## What was measured

| Area | Result |
| --- | --- |
| Cold boot (dev server, persisted Library) | 1.0 s to a populated store; 223 modules, 12.7 MB of unminified JS; no long tasks. Fine in dev, but see bundle. |
| Production bundle | 49 MB of assets across 388 chunks. Entry chunk 1.28 MB (Anthropic SDK 644 KB + all assistant tools 320 KB + demo datasets 103 KB). GraphExplorer chunk 1.65 MB, of which **`three` is 4.4 MB of source — loaded for 2D too**. Plotly 4.5 MB, Excalidraw bundled **twice** (1.78 MB + 0.94 MB in two chunks), ELK three times (worker + two bundles), transformers 852 KB. |
| Store hot paths (43k entities) | `all()` 0 ms (cached); `query({text})` 11.7 ms cold / 2.8 ms warm; `relationships()` 0.8 ms; `countByType` 1.6 ms. Good. |
| Page mounts (long tasks) | Entities 1,003 ms in 3 tasks (max 568); Graph Explorer 913 ms (max 848); Analytics charts 357 ms; Insights 186 ms; Ontology 50 ms. |
| Heap across 7 kept pages | 179 → 308 MB, monotonic. Kept pages (last 3 sections + warm workstation tabs) hold their explorers, sigma contexts and tables. |
| Graph Explorer, 39-node scene | Everything sub-frame: filter 6 ms, style 1 ms, build 1 ms, no long tasks on hover/select/filter. |
| Graph Explorer, full 5,960-node slice | Load (worker layout + build) one 7.5 s long task on landing. **Every mouse move over the canvas: one 1.8–4.1 s long task**; 40 moves = 125 s wall; idle rAF 1/s while hovering. Select 200: 110 ms. Text filter: 69 ms. Metrics (degree, PageRank, betweenness, Louvain): 135 ms. |
| Intermittent | "Maximum update depth exceeded" ×3 once, on `/entities?category=relationships` after Graph and Analytics pages were kept behind it; not reproducible in isolation. |

## Findings, ranked by user impact

### P1 — Hover on a large graph: sigma reads GPU pixels up to three times per mouse move
CPU profile of six mouse moves on the big slice: **32.5 s of 53 s in `readPixels`** under `Sigma.handleMove → getNodeAtPosition`. Sigma picks the node under the cursor by rendering ids into a framebuffer and reading one pixel back — a synchronous GPU pipeline flush — and does it once for the hover candidate, again to check the current hover, and a third time for edges because we pass `enableEdgeEvents: true`. On real hardware each flush is a few ms at 60 Hz mouse rate, i.e. the whole frame budget; under software GL it is seconds. This is the single biggest cost in the app and it is per-event.

Fix (Graph2D.tsx, no change to what the user sees):
1. **Throttle hover picking to one pick per animation frame** — wrap the container's `mousemove` in a rAF coalescer before sigma sees it (sigma's `captor` listens on the container; intercept at capture phase, store the last position, dispatch one synthetic move per frame). Most of the win; ~10 lines.
2. **Drop `enableEdgeEvents` on large slices** (> ~2,000 edges): edge hover/click are then resolved from our own edge geometry on click only (we already have positions and the halo reducer), keeping edge selection while removing the third `readPixels` per move.
3. Optional: skip picking entirely while the camera is animating or a drag is in flight (sigma exposes `isMoving`).

Expected: hover cost goes from *n·3 flushes/second* to ≤ 60/s with 1–2 each; on a real GPU the big slice becomes hoverable at full frame rate. Verify with `perf6.mjs` (long-task count on a 40-move sweep should drop from 40+ to a handful) and the `gx:refresh` mark.

### P2 — `three` (4.4 MB) ships in the GraphExplorer chunk for the 2D view
`GraphExplorer.tsx` imports `Graph3D` statically (`import { Graph3D } from './Graph3D'`), so react-force-graph-3d and all of three.js are parsed on the first visit to `/graph/2d`. Same pattern: `AppLayout.tsx` imports `AssistantPanel` statically, dragging the Anthropic SDK (644 KB) and every tool module into the entry chunk; `projectTools.ts` and `DatasetsView.tsx` import the demo dataset builders (103 KB) statically.

Fix: `lazy(() => import('./Graph3D'))` with a `Suspense` fallback at the one `dims === 3` render site; `lazy` for `AssistantPanel` (it mounts only when opened); `import()` the demo builders inside the two functions that run them. Zero behaviour change; ~1.6 MB off the explorer chunk, ~0.8 MB off the entry. Also fix the build warning: `WorkstationView.tsx` is dynamically imported by routes but statically by three workspaces, so its lazy import is ineffective — import it statically in `AppRoutes` (it is needed by Entities anyway).

### P3 — Duplicate vendor code in the bundle — *withdrawn after inspection*
The apparent duplicates are not: `chunk-EIO257PC` is Excalidraw's own pre-split chunk and `scene-*.js` is its `index.js` (different code); `elk-worker.min.js` is a `?url` worker asset and `elk.bundled.js` the Node-only fallback browsers never fetch; the two identical-size `chunk-FOHPRMQF` files are two *versions* of `@mermaid-js/parser` — one from `mermaid`, one bundled inside `@excalidraw/mermaid-to-excalidraw`'s own `node_modules` — and only the second loads when a Mermaid diagram is converted to Excalidraw. Plotly, three, viz and mermaid each already sit in one chunk. A `manualChunks` map would change every chunk boundary for no byte saved; not done.

### P4 — The project switcher recounts every project's scope on every render
Profile of the Entities page mount: `walk store.ts:177` 272 ms + `scopeCounts` 142 ms + `scopedCounts` 90 ms + `addVocabulary` 77 ms. Source: `ProjectSwitcher.tsx` builds its `items` array in the component body — `projectCounts(store, p.id)` for each of the 5 projects — on **every render of the sidebar**, i.e. every store tick and every route change, though the menu is closed. Each count walks the project's scope (thousands of ids) and every included project.

Fix: compute the counts only when the menu opens (inside the `onClick` that sets `menu`, or a `useMemo` keyed on `[menu, dataVersion]`), and give `store.scopeOf` a per-version cache (it is also called by `scopeEntities`, the publish and bundle paths). ~500 ms off the Entities mount and off every store change while the sidebar is visible.

### P5 — Kept pages never release memory
Heap climbs 179 → 308 MB over seven navigations and does not come back. `KeptPages` keeps the last three sections mounted and `WARM_TABS` keeps workstation tabs alive, which is what makes tab switching instant, but a kept Graph Explorer keeps its sigma instance (two WebGL contexts, the picking framebuffers), its ForceAtlas2 worker and its slice; a kept Analytics page keeps Plotly figures.

Fix: an "idle" contract for kept views — when `useViewActive()` turns false, Graph2D calls `sigma.kill()` after a grace period (say 60 s) and recreates on return (positions and camera are already persisted, so this is invisible); PlotlyChart purges its figure the same way; the FA2 worker is terminated whenever the view is inactive. Cap kept sections at 2 on machines reporting `navigator.deviceMemory ≤ 4`.

### P6 — Big-slice landing is one 7.5 s long task
Landing on the full slice through the gate is a single long task: build the sigma graph (5,960 `addNode` + 14,094 `addEdge`), resolve 20k styles, first render. The worker layout itself is off-thread; the *build* is not.

Fix: chunk `graph.addNode/addEdge` over `requestIdleCallback`/`scheduler.yield` in slices of ~2,000 with the veil already shown (it is — "seed cloud" veil); resolve styles in the same chunks. The user sees the same veil for the same time but the tab stays responsive (the sidebar, ⌘K and the assistant keep working during the load).

### P7 — Entities page mount: 568 ms long task beyond P4
After the switcher, the rest is `jsxDEV`/`createElement` (React dev overhead, ~320 ms — disappears in production) and the `EntityTable` first render of a 50-row page with 12 columns plus the category rail counts. `registry.countInCategory` and `scope` recompute per keystroke through `dataVersion`. Low priority; re-measure in a production build before touching.

### P8 — Intermittent render loop on the relationships view
"Maximum update depth exceeded" fired three times once, only after Graph and Analytics were kept behind the Entities page, and did not reproduce in isolation. React bounds it (no hang) but it is a sign of a `setState`-in-effect cycle sensitive to timing. Candidates are the lint hits `WorkstationView.tsx:486` and `KeptPages.tsx:29` (`set-state-in-effect`) plus `EntityTable.tsx:214` (`onVisibleRowsChange` fires on every `rows` identity change; `EntityBrowser` stores those rows in state, which re-renders the table, which recomputes `rows` if any dependency is unstable). Fix the last one regardless: pass `onVisibleRowsChange` through a ref and compare row ids before setting state. Then add a dev-only guard that logs the owner stack (`React.captureOwnerStack`) when the warning fires, so the next occurrence names the component.

## Plan

Order is by impact ÷ risk; each step is independently shippable and verified with the same scripts.

| # | Step | Files | Risk | Verify |
| --- | --- | --- | --- | --- |
| 1 | rAF-coalesce mouse moves before sigma; disable edge events above 2k edges (click resolves edges from geometry) | `Graph2D.tsx` | low — interaction-only, no state change | `perf6.mjs` long-task count; hover/click/edge-click by hand on Aurora and the 39-node scene |
| 2 | Lazy `Graph3D`, `AssistantPanel`, demo builders; static `WorkstationView` in routes | `GraphExplorer.tsx`, `AppLayout.tsx`, `projectTools.ts`, `DatasetsView.tsx`, `AppRoutes.tsx` | low — Suspense fallbacks at three sites | build sizes; open 2D, switch to 3D, open assistant, load a demo |
| 3 | Project switcher counts on open only; cache `scopeOf` per store version | `ProjectSwitcher.tsx`, `store.ts` | low | `perf2.mjs` Entities profile: `walk`/`scopeCounts` gone from the mount |
| 4 | `manualChunks` for the big vendors; single ELK import path | `vite.config.ts`, ELK worker | medium — chunk boundaries change; must re-test every lazy route | `mapsize.mjs`: each vendor once; every page opens in a production `vite preview` |
| 5 | Chunked sigma graph build behind the veil | `Graph2D.tsx` | medium — touches the sync effect; must keep the "no positions flicker" behaviour | `perf3.mjs`: landing long task split into < 100 ms tasks; screenshots of the veil |
| 6 | Kept-view idle release (sigma, Plotly, FA2 worker) | `Graph2D.tsx`, `PlotlyChart.tsx`, `KeptPages.tsx` | medium — a returning tab must look identical | heap after the 7-page walk plateaus; return to a kept graph restores camera and selection |
| 7 | `onVisibleRowsChange` through a ref + owner-stack guard | `EntityTable.tsx`, `EntityBrowser.tsx` | low | the relationships view after the page walk; no warning |
| 8 | Production re-measure of Entities mount; virtualise the table only if still > 200 ms | `EntityTable.tsx` | — | `perf2.mjs` against `vite preview` |

Steps 1–3 are a day's work and remove the two costs a user feels most (hover stalls on big graphs, the Entities page stutter) and 2.4 MB of first-visit JavaScript. Steps 4–6 are the bundle and memory hygiene that make the app feel the same after an hour as after a minute. I would do them in that order and re-run the whole measurement set after each, on a production build as well as dev, before starting the next.

## Not a problem (measured and fine)

Store queries and indexes; metrics over 6k nodes (135 ms in the worker); filter changes on the big slice (69 ms); selection of 200 nodes (110 ms); Ontology and Insights mounts; cold boot; the 39-node scene end to end. The worker layout and view-budget gate from earlier work hold up.
