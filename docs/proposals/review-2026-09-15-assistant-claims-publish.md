# Review: ⌘K palette, acting assistant, claims, publish — and neighbours

Date: 2026-09-15. Scope: the features added in commits 1039df6 (⌘K), 17544d6 (assistant context + "Ask about this"), f64b15f / d3ce8b6 (claims, communities), 847896a (publish), 9446fcd (docs), plus the code they touch (explorer handle, EntityBrowser, Insights, projects, store scoping) and a general pass over lint, tests and type-check.

State at review: `npx tsc --noEmit -p tsconfig.app.json` clean; `vitest` 64 files / 391 tests green; `oxlint` 104 warnings, none new except two `no-unused-expressions` in CommandPalette (comma-expression style, same as elsewhere).

Severity: **H** — wrong results or a visible malfunction for a normal action; **M** — a wrong edge case, a jank, or a UX misstep; **L** — polish, hygiene.

Nothing below has been changed yet. Each item says what to change and which files it touches so the fix can be judged for regression risk before it is made.

---

## A. Publish

### A1 (H) Publishing a project that is not the open one produces an empty or wrong page
`publishProject` reads the scope with `scopeEntities(store, id)` (unscoped — correct), but everything after that goes through the store's *scoped* readers: `applyFilter` → `store.query`, `plotContextFor` → `datasetGraph` → `store.all()`, and `store.relationshipsOf` / `store.ofType` for claims and communities. Those see the **open** project. The Projects page shows a Publish button on every project's page, so publishing project B while A is open yields scenes with no nodes, charts over A's data, and no evidence links.
- **Fix:** offer Publish only for the open project — `disabled={activeId !== id}` with a title "Open the project first" (`ProjectsView.tsx`); in `project_publish`, throw when `p.id !== store.scope` with the same message (`projectTools.ts`). Add a guard at the top of `publishProject` too (`publish.ts`), so no caller can hit it.
- Risk: none to existing UI; the button already sits next to "Open".

### A2 (M) Duplicate DOM ids in the published page
Documents render as `<details id="e-<docId>">` and the same document is also a row `<tr id="e-<docId>">` in the entity table. Two elements share an id; `#e-…` links to a document land on whichever comes first, and the table's `reveal()` finds the `<details>` instead of the row.
- **Fix:** prefix document sections `d-` and link `Documents` chips to `#d-…`; keep `e-…` for rows only (`publish.ts`, both the HTML and `PAGE_SCRIPT`).

### A3 (M) Link handler swallows clicks on chips whose entity is not in the table
In `PAGE_SCRIPT` the delegated click handler calls `preventDefault()` then `reveal(id)`; when the entity was cut by `maxEntities` there is nothing to reveal, so the chip is dead with no feedback.
- **Fix:** only `preventDefault()` when `byId[id]` exists; otherwise let the anchor be a no-op link with a `title="Not in the table (first N entities listed)"` set at render time.

### A4 (M) 3D scenes are drawn flattened without saying so
A scene with `renderer: '3d'` uses its layout's `x,y` (z dropped) through `svgFromView`. The picture is a projection, but the caption says nothing.
- **Fix:** append " · 3D scene, drawn flat" to the caption (`sceneSvg`), or skip 3D scenes when the layout has z and say "not drawn (3D)".

### A5 (L) Long synchronous work on the main thread
Scenes that colour by metrics call `computeMetrics` synchronously; force layouts under 800 nodes run synchronously. On a project with several big scenes the tab freezes for a few seconds with only "Publishing…" on the button.
- **Fix (optional):** yield between scenes (`await new Promise(r => setTimeout(r))`) and report progress in the toast/button ("Drawing scene 2 of 5"). No behaviour change.

### A6 (L) Sticky table header assumes a one-line nav
`.et th { top: 42px }` — on narrow screens the nav wraps and the header slides under it. Cosmetic. Fix: `position: sticky` only above 700px, or measure nothing and drop stickiness on the header.

---

## B. Claims and communities

### B1 (H) `claimFor` matches by finding id only — collides across projects when the Library is open
Finding ids are per analysis, not per dataset (`centrality:hubs` exists in every run). `claimFor` looks up `store.ofType('claim')` by `data.findingId`. With a project open, `ofType` is scoped, so it is fine. With **no project open** (the Library), it sees every project's claims, and *Save as claim* on the Library's own findings would silently **relabel and re-link another project's claim** instead of creating one.
- **Fix:** record `data.scope` (project id or `null`) on the claim and match on `findingId` **and** `scope` (`claims.ts`); same guard in `communityEntityFor` (already keyed by content hash, but add scope for symmetry). Update `claims.test.ts` with a cross-scope case.

### B2 (M) Naming a community from the graph navigates away from the graph
`NameCommunityDialog.submit` ends with `navigate(browserHref(entity))`. From the Graph Explorer (a workstation tab) that yanks the user to the Entities page mid-exploration.
- **Fix:** don't navigate; the toast says where it is ("Named X · N members linked · see Ontology › Claims"). From Insights the Claims tab and the Entities table both list it. (`NameCommunityDialog.tsx`)

### B3 (M) `ensureType` does not see a Library-level definition from inside a project
`ensureType` checks `store.get(schemaTypeId(name))` (unscoped). If the Library already defines `claim` (the demo does) but the open project has not marked that definition, nothing is created **and** the project's registry still infers the type without colour or label.
- **Fix:** when a definition exists and a scope is open, `store.mark([schemaTypeId(name)], scope)` so the project carries it (`claims.ts`). Test: define in Library, open an empty project, save a claim, expect the registry to resolve `Claim` with its colour.

### B4 (M) Naming a very large community creates one relationship per member with no warning
A community in a large imported project can have tens of thousands of members → as many `member-of` relationships in one `upsertMany`. It works, but it is a big change to the dataset made from a small dialog.
- **Fix:** in the dialog, above ~2,000 members show the count in red with "This creates N relationships" and require a second click (or a checkbox). (`NameCommunityDialog.tsx`)

### B5 (L) `useStoreVersion` in every `FindingRow`
Each finding row subscribes to the store to recompute `claimFor`. Fine at 30 rows; move the version read to `ReportView` and pass `claimFor` results down if the list ever grows. No change proposed now.

### B6 (L) Community chips show the analysis's quoted label
Chips read `“Orders” · deploy · 1,413`; I strip the leading quotes in the chip, but the analysis still names communities with quotes plus a distinctive tag. Cosmetic; leave.

---

## C. Assistant context and "Ask about this"

### C1 (M) Table registry key collides when two Entities tabs are on screen
`useReportTable(\`browser:${basePath}\`, …)` — two Entities panes in the Workstation (both active) share the key, so one overwrites the other and the first to unmount deletes the survivor's entry.
- **Fix:** key by `useId()` (`EntityBrowser.tsx`), keep `view` for the label.

### C2 (M) "Ask about this" with no API key sends a prompt that fails behind the settings pane
The assistant opens on its settings (no key), while the queued prompt is sent, fails with "API key rejected / missing", and the error sits behind the settings form.
- **Fix:** in `session.sendWhenIdle`, if `getAiSettings().apiKey` is empty, hold the prompt and subscribe to settings; send when a key is saved. Show a toast "Add an API key to ask the assistant" (`session.ts`, using the existing settings listener set — expose a `subscribeAiSettings`).

### C3 (M) A queued prompt survives "New chat"
If the user presses *New chat* while a queued ask is waiting for the current turn to finish, the ask fires into the fresh chat.
- **Fix:** `reset()` clears any pending `sendWhenIdle` subscription (`session.ts`).

### C4 (M) Tabs of hidden pane hosts are reported as on screen
`getContext().tabs` lists every mounted host (`mountedHost`), and kept pages keep hosts mounted behind the front page. The assistant may read "tabs[entities]: …" while the Entities page is hidden.
- **Fix:** add `active: () => boolean` to `HostHandle` (from the host's `useViewActive`) and skip inactive hosts (`hosts.ts`, `WorkstationView.tsx`, `useAppHost.ts`). Low risk: additive.

### C5 (L) `useReportTable` stringifies the selection every render
`JSON.stringify(info)` with a 20k-id selection on each EntityBrowser render (every keystroke in its search). Cheap but avoidable.
- **Fix:** dependency key `${view}|${showing}|${rows}|${selected.length}|${selected.at(-1)}`.

### C6 (L) Sidebar still advertises ⌘K for its search box
The palette pre-empts ⌘K at capture phase; the sidebar search still shows a `⌘ K` badge and focuses on ⌘K in its own handler (never reached). Owner is another session (`Sidebar.tsx` is dirty there). Proposal for them: clicking the search box opens the palette; drop the handler; keep the badge.

---

## D. ⌘K palette

### D1 (M) Search runs synchronously on every keystroke over the whole store
`store.query({ text })` plus `store.tags()`, `listProjects`, `registry.all()` run inside `useMemo` per keystroke. On a large imported project that is tens of milliseconds per key — noticeable stutter while typing. The Entities page debounces for exactly this reason.
- **Fix:** `const deferred = useDeferredValue(q)` and compute items from `deferred`; keep the input responsive. Optionally cap `store.query` with a `limit` if the store supports it. (`CommandPalette.tsx`)

### D2 (L) Recent-item keys can collide with schema entity ids
Recents store `type:<name>` for types; `schemaTypeId` is also `type:<name>`, so a recent "type" is resolved by `store.get` as the schema entity and opens through `entityHref` rather than the types list. Same outcome most of the time; fix by prefixing palette keys (`k:type:`, `k:tag:`) so they never resolve as entity ids.

### D3 (L) ⌘K over a modal dialog
The palette opens over an open `Dialog` and Esc closes the palette only (capture-phase stop). Acceptable; note only.

---

## E. General codebase pass (not from the new features)

### E1 (M) Sigma "Cannot set properties of undefined (setting 'x')" race
Reproduced once: a fresh explorer, `acceptLoad(getLoad())` immediately followed by `runMetrics(...)` — the metrics result lands while sigma is still building its node cache for the new slice, and `Sigma.process` writes into a missing entry. Not reproducible with a pause between the two. Likely the same window a user can hit by clicking "Show everything" and then immediately starting an analysis.
- **Proposal:** in `Graph2D`, guard the style/metrics refresh so it is skipped (and re-run on the next frame) when the sigma graph is mid-rebuild — e.g. hold a `rebuilding` ref set around the graph sync effect and check it before `sigma.refresh()`. Needs a targeted repro first; I would write one before touching Graph2D (shared with another session).

### E2 (L) Lint: 12 `react-hooks/exhaustive-deps` warnings, 7 `set-state-in-effect`, 8 `react(refs)` during render
All pre-existing (`WorkstationView.tsx`, `PlotlyChart.tsx`, `paneContext.ts`, `KeptPages.tsx`, `MapWorkbench.tsx`, `PipelineBar.tsx`, `StorageCard.tsx`, `EntityTable.tsx:176`). The `refs`-during-render ones in `WorkstationView.tsx:496/517/627` and `paneContext.ts:44` (`useViewActiveRef`) are deliberate patterns (a ref mirrored each render). `EntityTable.tsx:176` mutates a `cache` object inside `useMemo` — fine as a memo-local cache. No fix proposed; listed for the record.

### E3 (L) `docs/proposals/*.md` and `public/datasets/dbpedia-programming-languages.nt` are untracked from other sessions
Not mine; noting so nobody sweeps them in.

---

## F. Open item — the Claims tab wiring is uncommitted
`src/features/ontology/OntologyView.tsx` carries my four small edits (Claims tab) on top of another session's uncommitted Tags-tab work. The Tags-tab owner commits through a temporary index with only their hunks, so my hunks may stay uncommitted indefinitely.
- **Proposal:** commit my hunks the same way (temporary index, `git apply --cached` of just those hunks), after confirming the file still type-checks with both sets present — it does now.

---

## Suggested order

1. A1, B1 (correctness; small, isolated)
2. B2, B3, C1, C2, C3, A2, A3 (edge cases users will hit)
3. D1, C4, C5, A4, B4 (jank and clarity)
4. F, then the L items as time allows; E1 only after a repro.

Verification plan for each batch: `tsc`, `vitest`, then the headless scripts already in the scratchpad (`ask.mjs`, `claims.mjs`, `pubapp.mjs` + `pubcheck.mjs`, `palette.mjs`) re-run against the dev server, plus one manual pass on the Aurora project: ⌘K, Ask about this from a table row and a graph node, Save as claim, Name a community from the graph, Publish.
