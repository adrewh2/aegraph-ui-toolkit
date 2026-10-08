# The smoke suite

Twenty-six scripted runs over the real MCP bridge and a headless Chrome tab. Fourteen drive one job the way an agent would — tool call by tool call — and check what landed in the store, on the page and in the file system; the last twelve drive the page itself: opening a project, opening the GPU explorer, arranging panes, being told there is nothing to answer with, reading what an analysis found, working the entity table, annotating a passage, building a chart and drawing a diagram are things a person does with a mouse. Three of them are about what a page does when it is left alone or left behind: one opens every page twice and listens, one leaves Unigraph and comes back to it, and one makes a map from the page's own buttons and reloads it. The last is a tool run rather than a page one, and exists because an audit found four tools that nothing else executed. They are the verification behind the [use cases](/docs/use-cases): nine of the ten jobs have a run here.

## The driver

`mcp/drive.mjs` starts the bridge server (`mcp/server.mjs`) over stdio, launches Chrome on the dev server (`http://localhost:5199/` unless a URL is given) with its own profile, enables the bridge in the tab, waits for the tool manifest, and hands a steps file `{ call, evaluate, shot, sleep, send, logs }`: `call(name, args)` is an MCP tool call (a tool error throws), `evaluate(js)` runs in the page, `shot()` takes a screenshot. Delete confirmations the bridge raises are accepted by the driver.

What it needs:

- **`npm run dev` on port 5199** in another terminal (or pass a URL as the second argument).
- **`GL=1`** for anything that draws the graph: the engine needs WebGL2 (or WebGPU), and headless Chrome only provides it with software GL turned on. Every script below sets it.
- **`PROFILE=<dir>`** (default `./mcp-profile`): Chrome's user data directory, where the Library lives between runs. A fresh directory means a first run: the seed sample and the welcome document, and — when the build has demos — the aegraph-ui system map demo open as a project, on one pane with one tab: its whole graph in Unigraph · 3D with the simulation running live. Steps that need the Aurora demo open it from the demos catalog (`load_dataset {sources:['aurora']}`, or its `bundleUrl` from `/demos/catalog.json`); its whole graph sits above the explorer's view budget, so they trim it (`graph_filter {max_nodes}`) or root it at what they made.
- **`DOWNLOADS=<dir>`** (default `./downloads`): where the browser's downloads land (`project_save`, `graph_export {download:true}`).
- **One driver at a time.** Each run is a Chrome; several at once starve the machine (an earlier session lost a background run to the OS). Wrap a run in a bounded wait and, if it must be stopped, kill the driver by PID and its Chrome by the PID `pgrep -f user-data-dir=<profile>` gives — never by pattern, which can take other bridges with it.

`npm run smoke` runs steps 1–4 as one story on a temporary profile; every other step is its own script on whatever profile is set:

| Script | Step | Proves |
| --- | --- | --- |
| `npm run smoke` | 1–4 | a project, a relaunch, a bundle out, a bundle in |
| `npm run smoke:scripts` | 5 | scripts: every engine, every action |
| `npm run smoke:scenes` | 6 | scenes and physics round-trip |
| `npm run smoke:iterate` | 7 | use case 7 — metrics → project → filter on `data.pagerank` |
| `npm run smoke:claims` | 8 | use case 1 — a document, an anchored annotation, a claim, the evidence graph |
| `npm run smoke:diagram` | 9 | use case 4 — DOT → dataset → DOT with the same ids |
| `npm run smoke:projects` | 10 | use case 9 — projects apart and together, a bundle out and back |
| `npm run smoke:charts` | 11 | use case 8 — charts from a selector, shown, saved, metrics lent |
| `npm run smoke:maps` | 12 | use case 3 — a map, places, a path, an area, a note, the map page |
| `npm run smoke:media` | 13 | use case 2 — video, audio and image annotations with time and region selectors |
| `npm run smoke:way-in` | 14 | the way in: `/new`, every tab, one dialog size, a demo opened beside an untouched Library |
| `npm run smoke:unigraph` | 15 | the GPU explorer on software WebGL: both handles, frames actually drawn, 2D and 3D one session |
| `npm run smoke:workstation` | 16 | panes and tabs: a split, a view added, a tab's own back arrow, the arrangement after a reload |
| `npm run smoke:assistant` | 17 | the assistant with no key and the bridge off: what it says instead of answering |
| `npm run smoke:insights` | 18 | the five analyses, their ranked findings, and a finding shown in the graph |
| `npm run smoke:entities` | 19 | the table: sections, search, the inspector, and an edit that survives a reload |
| `npm run smoke:documents` | 20 | a document made, written, annotated, and the annotation still anchored after a reload |
| `npm run smoke:charts-page` | 21 | the chart builder: a figure drawn, a field changed, saved once, reopened the same |
| `npm run smoke:diagrams-page` | 22 | a diagram from a template, its source edited, drawn, and the same after a reload |
| `npm run smoke:quiet` | 23 | every page mounted twice: nothing on the console, nothing in the error log, something on screen |
| `npm run smoke:scene-kept` | 24 | Unigraph left by the sidebar and come back to: the same tab, the same engine, the picture never thrown away |
| `npm run smoke:maps-page` | 25 | the Maps page by hand: New map, two places pasted as links, the list and the map agreeing, a reload, and `/maps/new` |
| `npm run smoke:unrun-tools` | 26 | the four tools nothing else ran: `app_diagnostics`, `view_diagram`, `globe_load`, `globe` |
| `npm run smoke:aurora` | 27 | what the headless engine authored (the Aurora demo's generator, in the demos repo), opened in the app: Aurora's five scenes drawn from their own filter, layout and style and framed on them, its ten scripts run, its charts computed |
| `npm run smoke:scene-first-slice` | 28 | a Unigraph tab opened on a scene (`/unigraph/2d?scene=…`, a cold load, the explorer remembering the whole graph) filters to the scene from its first render — every filter pass the scene's size, none of the whole graph first |
| `npm run smoke:headless` | — | the engine with no browser at all (no driver, no tab): a project created over MCP, the graph analysed and laid out, the workspace saved and reopened in a second process |

## The steps

**1 — Project** (`1-project.mjs`). A new project opens and takes the scope from the seeded one; the Knowledge Infrastructure demo opens beside it as a project of its own, its entities join the smoke project, which takes the scope back; a typed property (`born` as a date, `score` as a number) is set on three people and defined on the type; the demo's seed entities stay out of the project.

**2 — Relaunch** (`2-relaunch.mjs`). The tab is started again on a deep link (`/entities?category=knowledge&type=person`): the project is still open, the link lands, the rail shows the type, the defined properties are columns. This is the persistence-load path — the one part of the Library store (`entity/persistence.ts`) no unit test reaches.

**3 — Bundle** (`3-bundle.mjs`). `project_save` writes the project as a bundle; the file lands in the downloads folder.

**4 — Open** (`4-open.mjs`). On a fresh profile, `project_open_bundle` from that file's text opens the same project on the saved route with the type definitions travelled.

**5 — Scripts** (`5-scripts.mjs`). The Scripts tool end to end: JavaScript in the QuickJS sandbox (a figure, a table, a scene, an interrupted infinite loop, `fetch` absent), Python in Pyodide (plotly express, a DataFrame as a table, matplotlib as an image, `graph()` as networkx, top-level await, `fetch` blocked by CSP, an error keeping its logs), the visual engine (three.js with WebGL, isolated from `fetch` and `localStorage`), and save / list / get / show / edit / delete. Needs `public/pyodide` and `public/vendor` in place.

**6 — Scenes** (`6-scenes.mjs`). On 400 best-connected nodes: a force layout, physics on, a scene saved mid-physics holds the running picture; a store write mid-physics does not snap it back; loading the scene restores the saved positions exactly with physics off; physics resumes from there.

**7 — Iterate** (`7-iterate.mjs`, use case 7). A filter on `metric.*` is refused with the export recipe; `graph_metrics` over the view; `graph_project export` carries the metric columns as values; `load` makes the project the Dataset stage, offered as `data.*` fields and shown in `graph_state`'s breadcrumb; a field filter on `data.pagerank` narrows the view and `graph_query` reads the values back; `unload` returns to the workspace.

**8 — Claims** (`8-claims.mjs`, use case 1). A document; a passage annotated by quote (a quote not in the document refused); the `annotates` relationship carrying a text selector with prefix and suffix; a claim; `supports` from the annotation; an edit elsewhere in the document leaving the annotation in place; the reader highlighting the passage; the three-node evidence graph; `degree.in:supports` on the claim; `inspect` opening it.

**9 — Diagram** (`9-diagram.mjs`, use case 4). DOT with two clusters and three labelled edges → a diagram → the dataset, dry run and real (deterministic `dg-` ids, singular types from the clusters, relationship types from the labels, a `derived-from` link per entity, a scene with a position for every node) → a second export would update in place → an entity edited → the view back as DOT through `graph_export` with the same ids and the edit, kept as a diagram → exporting that diagram reuses every entity.

**10 — Projects** (`10-projects.mjs`, use case 9). Two projects with entities of their own; search and the explorer scoped to the open one (`library: true` sees all); a scene saved in one absent from the other; a filter set in one remembered across a switch, the other's own state restored; an include making one see both; a bundle saved with the project, its entities and the screen state, and opened again from its text merging by id with nothing duplicated.

**11 — Charts** (`11-charts.mjs`, use case 8). Over the seeded demo's incidents: a bar binned by month whose counts add up to the rows, a median per severity, a scatter coloured by severity; a chart shown on the Scenes page, saved with its row count, listed, opened, read back and updated in place; metric columns lent to a chart from a Stats run over the whole dataset (not from one over a filtered view) and from an Insights run.

**12 — Maps** (`12-maps.mjs`, use case 3). Without the network: a map by coordinates; a location with a stay and one from a Google Maps link; a measured path and area; a note pinned with a radius and a time; `map_state`; a location linked to a person and that neighbourhood alone in the graph; the map page with its pins (folded into one cluster at this zoom — paths and areas carry a pin too), the note, the path and the area drawn. Geocoding and Wikipedia are exercised in `mapTools.test.ts` with the network stubbed.

**13 — Media** (`13-media.mjs`, use case 2). The half that needs no player: a video from a YouTube link, annotated at a moment and over a range with a region of the frame (a region outside the frame refused); a Spotify track annotated over a range, an artist refused for having no timeline; an image from a same-origin URL with its size read and a box clamped to it; every annotation with its selector on the entity (`get_entity` from either end), in the Library's annotation rows, and on the inspector's Annotations tab. Playback control and frame capture need a real player and stay out.

## A run on record

20 September 2026, M-series Mac, dev server, software GL, one driver at a time, the shared `mcp-profile`, with the Library open and the profile swept before each step. 272 checks of 282 pass; the whole suite is about 13 minutes of wall clock, plus the reset between steps.

| Step | Checks | Time |
| --- | --- | --- |
| 1–4 (`npm run smoke`) | 16 of 16 | 47 s |
| 5 scripts | 26 of 27 | 52 s |
| 6 scenes | 8 of 8 | 24 s |
| 7 iterate | 12 of 12 | 14 s |
| 8 claims | 14 of 14 | 16 s |
| 9 diagram | 13 of 13 | 14 s |
| 10 projects | 8 of 10 | 22 s |
| 11 charts | 13 of 13 | 18 s |
| 12 maps | 8 of 9 | 18 s |
| 13 media | 14 of 14 | 14 s |
| 14 way-in | 6 of 7 | 32 s |
| 15 unigraph | 9 of 9 | 34 s |
| 16 workstation | 10 of 13 | 40 s |
| 17 assistant | 10 of 11 | 32 s |
| 18 insights | 9 of 10 | 30 s |
| 19 entities | 18 of 18 | 46 s |
| 20 documents | 11 of 11 | 42 s |
| 21 charts-page | 15 of 15 | 59 s |
| 22 diagrams-page | 13 of 13 | 54 s |
| 23 quiet | 3 of 3 | 135 s |
| 24 scene-kept | 11 of 11 | 26 s |
| 25 maps-page | 15 of 15 | 22 s |
| 26 unrun-tools | 10 of 10 | 16 s |

**The steps share a profile, so a step that does not say where it starts inherits whatever the last one left.** They share the store, the open project and the remembered view, and several change all three. Measured before any of them said so, step 11 reported 4 of 9 and step 15 3 of 9, both reading a few dozen entities because an earlier step had left someone else's project open; step 15's three remaining failures were then a filter another step had left in the explorer. Steps 11, 15, 18, 19, 21, 22, 23, 24 and 26 now call `startFrom` (see *Where a step starts*) and all nine hold up under a profile dirtied on purpose — a project left open and a filter matching nothing. Steps 13, 20 and 25 were put to the same test and need nothing: they count only what they make. Step 12 failed the test and then failed identically on a clean profile, which is a fourth answer worth knowing — a control run can fail for a reason that has nothing to do with the dirt, so check the clean run before concluding anything (b38). Four of the nine — 21, 22, 23 and 26 — passed the dirt with nothing declared and were declared anyway, because what they were passing was not the question: a threshold of more than zero points, a count of charts before and against after, a diagram tally read from the store rather than the page. They are green in any scope, which is exactly why the scope has to be said. Choosing between `'library'` and `'fresh'` is worth doing against that dirt rather than by eye: step 24 was given `'library'`, and the dirt showed it drawing an empty picture, because a leftover filter is exactly what empties the canvas it watches. Step 19 is the measure of what that is worth: under the same dirt, before it declared anything, it dropped to 16 of 18 and its table read one row. The rest still inherit; b35 tracks them. Step 16 is the one to read before copying the pattern: it wants the two-pane arrangement a first run leaves, which no reset restores, and its header says what arranging its own would take.

The failures above, then, are of three kinds: defects (b33, b34), checks that describe something the app no longer does, and checks that depend on a starting state nobody has written down.

Step 5's three Python failures are gone: they were the step asking for a 90-second budget where the tool's schema caps at 60, and Pyodide fits inside the cap with room to spare — the same shape as the two fixed at wake-up 137. Its *a project is open* check went too; it asserted a fact about the profile rather than anything the step needs, and now asks for the demo rows the scripts actually read. What remains is *a visual frame survives leaving the page*, which reports the frame marked and over its host but not shown, identically on a clean profile and a dirtied one, and which a probe making the same calls in isolation cannot reproduce. Filed as b39.

*The map page opens on the map with its pins, note, path and area* (step 12) fails because the note's pin now folds into the cluster with the places and the shapes, so the check's `notes === 1` cannot hold — identical numbers on a clean profile and on a dirtied one. Filed as b38.

*Entities made while a project is open belong to it* (step 10) fails on the count, not the marking: `meta.projects` names the open project correctly, but `project_list` reports four entities for a project holding one note while that project is the active one. Filed as b33.

*Coming back restores the reading group's own explorer state* fails on a gap between two mechanisms that both work. Switching projects does swap the pages' remembered state: `switchProject` stashes the outgoing project's values for the keys in `PROJECT_UI_KEYS` and writes the incoming project's. But on Unigraph every tab is its own explorer session, so the explorer writes `aegraph:explorer:v1:<session>` and `aegraph:explorer:positions:v1:<session>`, and the stash names only the unscoped keys — so the filter, the layout and the held positions are neither saved nor restored, while the camera (unscoped) is. Two projects, a text filter set in each, switched back and forth: the filter that comes back is the one the other project was using. Filed as b34.

## Writing a step

A steps file exports one async function taking the driver's handles and uses `check(name, ok, detail)` from `mcp/smoke/lib.mjs`, which prints `ok` or `FAIL` lines the runner counts. Make what the step creates its own (a label with *Smoke* in it), delete it at the end, and never assume the profile is empty: the seed is there, and its `service`, `store` and `incident` types are easy to collide with. When a page is involved, prefer a class the app owns (`.md-hl`, `.geo-pin--note`) over structure, and give React a beat (`sleep`) after `open`.

**Where a step starts.** The steps share one profile, so the state a step begins in is whatever the last one left: the open project scopes every page and every tool, and the remembered view — filter, layout, held positions, the workstation arrangement — is read back on mount. Say which state the step wants, at the top, with `startFrom({ call, evaluate, sleep }, state)` from `lib.mjs`: `'library'` puts the Library back and sweeps what the suite leaves, `'fresh'` also clears the remembered view and reloads so the pages read it again. Decide which by running the step against a profile dirtied on purpose — a project left open and a filter matching nothing — rather than by reading it: step 24 was given `'library'` on good reasoning and the dirt showed it drawing an empty picture in one run. There are three outcomes and all three are worth writing down. The step breaks: declare the state it needs. The step passes but both sides of its comparison moved together, so it was measuring a scope nobody meant: declare it anyway, for meaning (step 26). The step counts only what it made itself and the dirt changes nothing: say so in the header and add no reset — that is the shape to copy (step 25). Put the same sentence in the step's header comment, because the reader of a failure needs to know what the step assumed. A step that relies on a page being already arranged should say so and, better, arrange it itself. See b35 for what this cost before it was written down.

**Tidying up.** A step runs on a profile other steps share, and what it leaves behind changes what they see: a project left open scopes the next step to nothing, and a step whose ids collide with its own last run reports counts that make no sense. So end with `tidied(evaluate, ids, wasHolding)` from `lib.mjs` — `const wasHolding = await counted(evaluate)` at the top — which checks two things: that the ids the step named are gone, and that the library is the size it was. The second matters more than it looks: naming ids is not enough when a step makes three entities and six relationships and deletes three, and 237 entities from one step were sitting in `mcp-profile` before anyone checked. Delete only what the run actually made — a scene's layout or filter may be older than the run, and taking it away is as bad as leaving something behind; snapshot the ids first if the step loads saved parts. A delete raises a confirmation in the tab, so tidy from a page that can answer: not from a dead address (`/maps/new`), and not before the tab has announced its tools again after a reload. Never write the tidy as a swallowed `catch`. And when a step throws, its tidy never runs at all: clean the profile before reading anything into the next run's failure, because deterministic ids make the second failure look nothing like the first.

The shared smoke assertions leave a failed command with a nonzero exit status, after the step finishes its cleanup. For isolated release checks, use a fresh browser profile and download directory: a previous download with the same filename can otherwise be mistaken for the current exported bundle.
