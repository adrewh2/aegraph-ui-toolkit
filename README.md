# aegraph-ui-toolkit

A workspace for graphs, ontologies and the data around them — aegraph's public edition, with no accounts and no server. React 19 + TypeScript + Vite.

## This edition

**aegraph-ui-toolkit is a modified public version of `aegraph-ui`, a private repository** — the app behind [aegraph.dev](https://aegraph.dev). It is the same app with no accounts and no server: the Supabase sign-in (GitHub and Google), the assistant's allow list and its Admin page, free chat, and the site's server functions are taken out; everything else — the pages, the tool set and the MCP connection to Claude Code — is the same code. There is nothing to sign in to and no function behind the site: your data stays in your browser (IndexedDB, and the bundles you save), and the assistant is Claude Code over MCP (the bridge, below) or an Anthropic API key of your own, which the browser sends straight to the Claude API. Deployed, it is a static site.

A first visit opens the **aegraph-ui system map** — the app's own architecture as an ontology and its graph — in **Unigraph · 3D**, on a workstation of one pane. That and the other demo projects come from the demos aegraph.dev publishes, fetched at build time (*Demo projects* below); a build that cannot reach them runs with none.

Copyright 2026 Andrew Han. Licensed under the Apache License, Version 2.0 ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)).

This file is the architecture map: where each part lives and the ideas behind it. The in-app documentation (`src/docs/*.md`, served at `/docs`) is the product manual and stays in step with the code; `AGENTS.md` (and the `AGENTS.md` in each area) is the working guide for people and agents changing the code.

## Getting started

What you need, and what each thing is for:

| | For | Without it |
| --- | --- | --- |
| **Node 22 or later** (`.nvmrc`) | the dev server, the build, the tests, the bridge | nothing runs |
| **Chrome or Edge** | everything: the projects folder (saving bundles into a folder of your choosing) and WebGPU for Unigraph | see *Browser support* below |
| **Claude Code**, installed and logged in (`claude`) | the assistant, locally: the chat panel's turns run as `claude -p` on your subscription, over the bridge | the app works; the assistant panel says to connect the bridge |
| **The bridge** registered with Claude Code | Claude Code driving the app's tools, and the in-app chat | Claude Code has no `aegraph` tools and the panel cannot chat |
| `OPENAI_API_KEY` in `.env.local` (optional) | voice through OpenAI's models on the dev server | voice uses the browser's own recogniser and voice |

```sh
npm install        # the registry only; also installs the commit guard
npm run dev        # http://localhost:5173 — the first run downloads Pyodide and the demos, copies the vendored libraries
npm test           # vitest
npm run build      # tsc -b, then vite build into dist/
```

The bridge: running `claude` in this repository registers it through `.mcp.json` (the `aegraph` server, `node mcp/server.mjs`) — the first time, Claude Code asks once to approve the project's `aegraph` MCP server, and `/mcp` in Claude Code then shows it connected; from anywhere else, `claude mcp add aegraph -- node /path/to/aegraph-ui-toolkit/mcp/server.mjs`. Then in the app, sidebar → **Claude Code** → **Enable bridge**. *Claude Code bridge* below and `/docs/assistant` have the rest. Every environment variable — the dev server's, the bridge's, the headless engine's, the scripts' — is in [`docs/configuration.md`](docs/configuration.md), with what breaks without it; `.env.example` is the template for `.env.local`.

### Browser support

| Browser | Works | Differences |
| --- | --- | --- |
| **Chrome, Edge** (desktop) | fully | — |
| **Firefox** | yes | no projects folder (the File System Access API): **Save project…** downloads the bundle and **Open project…** reads it back; Unigraph draws with WebGL2 where WebGPU is off |
| **Safari** | yes | the same as Firefox; and Safari may clear a site's storage after seven days of browsing without a visit to it |

The workspace lives in the browser's own storage (IndexedDB) and nowhere else, so whichever browser you use, keep what matters as bundles (`/docs/projects` › *Where projects live*).

## Entity system (`src/core/entity`)

The information model from the Aegraph design docs, kept deliberately small:

| Primitive | Where | Notes |
| --- | --- | --- |
| `Entity` | `types.ts` | `id`, `type`, `label`, `tags[]`, `data{}`, `meta`. Plain, serializable data — no classes, no display state. |
| `Relationship` | `types.ts` | An entity (`kind: 'relationship'`) with `source`/`target` refs. Typed, taggable, annotatable like anything else. |
| `EntityRef` + `Selector` | `types.ts`, `ids.ts` | Address a whole entity or a region inside it (text quote, range, image region, time). `aegraph:<id>#<selector>` URI form. |
| Tags | `store.ts` | Flat strings on entities; optional per-tag metadata (color, description) lives beside the graph. |
| Type registry | `schema.ts` | Opt-in `defineEntityType()` adds fields, validation, icons, and actions. Unregistered types still work everywhere. |
| `EntityStore` | `store.ts` | In-memory graph with indexes by type/tag/endpoint, cascade delete, traversal, subscriptions (`useSyncExternalStore`). |
| `AegraphDocument` | `types.ts` | The exchange format (`aegraph/v1`, the `.ae.json` file): `{ $schema, entities[], tags?[], project?, state? }`. Specified by `core/exchange/ae/aegraph-v1.schema.json`. Export any view; import into any store. |

### Categories

A **category** is a property of a *type* (never of an entity), describing how its data is used. It decides where things are browsed:

| Category | What | Where | Types come from |
| --- | --- | --- | --- |
| `resource` | Artifacts people read/watch/edit — webpage, annotation, document, video, note | `/entities?category=resource` | registered in `src/core/resources/types.tsx` |
| `knowledge` | Domain instances — architect, philosopher, field, concept, major work… | `/entities?category=knowledge` (type rail, grouped by parent) | emergent from data; **unregistered types default here** |
| `graph` | Presentation collections — `layout` (positions), `rendering` (legend), `view` (saved arrangement) | `/graph/layouts` | `src/core/graph/types.tsx` |
| `schema` | Type definitions — `schema:type` entities giving a type its label, category, parent, color | `/entities?category=types` | the data |

The effective ontology (`TypeRegistry`, `src/core/entity/typeRegistry.ts`) merges code definitions with `schema:type` entities from the store, so an imported dataset carries its own vocabulary and the Types page can recategorise, re-parent, or recolor any type — including ones nobody registered. Type names used only by relationships are treated as relationship vocabulary and kept out of entity facets.

Persistence is IndexedDB (`persistence.ts`), written incrementally from store events: bulk upserts land as ~2k-entity pages, small edits in an overlay, deletes as tombstones; compacted on load when the overlay grows. An opened `.aeb` whose every entity is new to the Library is kept as the file itself — one page, gzipped as it arrived — rather than its entities packed again (a million-entity bundle: 16 ms against 4.5 s, 93 MB on disk against 180 MB). The store keeps its entities in a table that gives each a **handle**, a small integer (`entity/table.ts`), so bulk bookkeeping is a bitset (`entity/handleSet.ts`): a project's working diff is sets of handles with their sizes kept. Swap in a server adapter by replacing `Persistence` in `src/app/providers.tsx`.

Booting is one screen: `index.html` paints the boot screen before any script runs, `AppProviders` renders the same markup while the workspace is read, and the page's code-split chunks (`src/app/preload.ts` — the route's page and, for the explorer, its renderer) are fetched in the same wait, so the boot screen is followed by the page itself, never by a `Loading…` for the route and another for the renderer. Pages reached by navigation afterwards still load on demand behind their Suspense fallbacks. Each stage of the boot is a `performance.measure` (`boot:idb` the IndexedDB read, `boot:preload` the page's chunks, `boot:seed`, `boot:restore`, `boot:ready` from navigation to the screen going), so the Performance panel — or `performance.getEntriesByType('measure')` — says where a slow start went. On an Apple laptop the read is about 100 ms for a thousand entities and 450 ms for 145,000; what remains of a slow start on the dev server is Vite transforming the modules (a cold load after an edit is seconds; a `vite preview` of `dist/` is the honest number).

## Exchange (`src/core/exchange`)

| | |
| --- | --- |
| `formats.ts` | Three formats carrying the same aegraph/v1 information: the **`.ae.json`** document, **JSONL** (one entity per line, streams), **CSV** (one flat sheet, `data` as a JSON column, streams). `normalizeEntity()` accepts foreign records with just an `id`. Incremental `CsvParser`. |
| `ae/` | **The `.ae.json` file format** — the specification other systems build to. `aegraph-v1.schema.json` is a JSON Schema (draft 2020-12) for the whole document, served at `/spec/aegraph-v1.schema.json` (with `example.ae.json` beside it; a test keeps the `public/spec` copies identical to the source). `validate.ts` is the same rules in code — `validateAe(doc)` reports each problem with a JSON pointer, plus unresolved and duplicate ids — behind the `validate_ae` assistant/MCP tool. The loader stays lenient; validation is for producers. Documented at `/docs/spec`. Exports are named `<name>.ae.json` / `.ae.jsonl` / `.ae.csv` (`.gz` optional); a bare `.ae` and the older `.aegraph.json` still load. |
| `export.ts` | `serialize()` yields string chunks; `exportToBlob()` builds the file, optionally gzipped via `CompressionStream`. |
| `import.ts` | `parseFile()` streams a `File` (gzip via `DecompressionStream`) with progress + abort; `loadParsed()` commits in one store transaction. |
| `generate.ts` | Seeded, deterministic synthetic academic graph (people → works → fields, concepts, influence, annotations with text selectors). ~250k entities in ~300 ms. `generate.worker.ts` runs it off the main thread. |

The app ships no projects of its own. The demo projects — Aurora, China tour, Knowledge Infrastructure, AcademicsKG, Programming languages (DBpedia) and the rest — reach a build from the copies aegraph.dev publishes; each is built by a generator in the private `aegraph-ui-demos` repository, whose checkout, when there is one, takes precedence (see *Demo projects* below).

The **Projects dialog** drives all of this — *Open project…* in the sidebar's project menu, or the `/new` address (the older `/datasets` page is still there and still works): open a demo, generate 10k–1M, drag-and-drop import, export in any format, clear.

## Audio (`src/features/audio`)

`/audio` lists Spotify tracks, albums, playlists and episodes; `/audio/:id` plays one through Spotify's embed (a sandboxed `open.spotify.com/embed` frame driven by messages) and annotates it by **moment** or **time range**. Any open.spotify.com link or `spotify:` URI; title and artwork via oEmbed.

- **Ranges**: press `I` / `O` while listening (or the In/Out buttons) to mark a pending range; drag its handles or body on the timeline; `Enter` to annotate, `Esc` to clear. Preview plays the range and stops at the end; `L` loops it.
- **Timeline** (`RangeTimeline.tsx`): scrub bar, annotation spans packed into lanes so overlaps stack, point markers, hover time, and resize/move handles on the selected annotation (drag, or ←/→ nudge 0.5 s, shift for 5 s). Retiming rewrites the `time` selector on the `annotates` relationship.
- **Range editor** (`RangeEditor.tsx`) in the annotate dialog: dual-thumb slider, typed clocks, "use playhead" buttons.
- Spotify only reports duration once playback starts, so the timeline uses a provisional length (shown as `~4:00`) until then; the real duration is persisted on the entity.

## Workstation (`src/features/workstation`)

The sections — Documents, Diagrams, Images, Videos, Audio, Maps, Scenes, Scripts, Datasets, Charts, Ontology, Projects, one per sidebar entry — are pane hosts too (`SectionHost.tsx`, `hosts.ts`): each opens on its **List**, an inner tab that stays at the front and cannot be closed (`ListDef`), and whatever is opened from it gets a tab of its own beside it (`openInHost` / `navigateInHost` in `model.ts`). The `workstation` tool addresses them by name.

`/entities` is itself a pane host (`EntitiesWorkspace`: `WorkstationView` with `chrome="tabs"`, its own storage key, the address bar following the active tab): a filtered view — *Related entities*, a pick from a plot — opens as a new tab beside the one you came from, named after the filter, and the table says plainly what it is showing. Views inside any pane get `useOpenInTab()` (`paneContext.ts`), which opens a tab in their pane or navigates when there is none.

`/workstation` — iTerm-style split panes. The layout is a binary split tree (`model.ts`): split any pane right or down, drag the gutters, close panes; each pane has tabs, and each tab is any view in the app. Tabs drag between panes.

Every tab runs under its own in-memory router (`PaneRouter.tsx` supplies react-router's location/navigation contexts directly), so views navigate inside their tab — with per-tab back/forward — while the browser URL stays on `/workstation` and every pane shares the one entity store. The routes come from `src/app/AppRoutes.tsx`, shared with the top-level app.

Shortcuts: `⌘D` split right, `⌘⇧D` split down, `⌘⇧W` close pane, `⌘⇧]`/`[` next/previous tab, `⌥⌘←/→` move focus between panes. Arrangements persist locally and can be saved as `workstation` entities (Graph category) via the picker; templates (Research, Curate, Media review, Single) seed common layouts. Other parts of the app can open a view here with `window.dispatchEvent(new CustomEvent('aegraph:workstation:open', { detail: { path, split? } }))`.

## Diagrams (`src/core/diagrams`, `src/features/diagrams`)

Graphviz (DOT) and Mermaid as first-class resources and as an exchange format.

- **Parsers** (no rendering dependency, fully tested): a tolerant DOT parser (subgraphs/clusters, node/edge/graph defaults, edge chains and fan-out, ports, quoted/HTML labels, all comment styles); Mermaid flowchart/graph (all node shapes, `:::class`, `classDef`/`class`, subgraphs, every arrow form incl. inline labels and `&` fan-in), classDiagram (members, all relationship arrows with cardinalities), erDiagram, stateDiagram(-v2) (composite states), mindmap, sequence (participants + messages). Both produce one `ParsedDiagram` model.
- **Writers**: DOT and Mermaid flowchart from a `ParsedDiagram`; `diagramFromEntities()` turns entities + relationships into one (types → clusters, type colors → fills). Convert either direction in the editor.
- **Rendering**: `@viz-js/viz` (Graphviz wasm, all engines) and `mermaid`, lazy-loaded. Live preview with zoom, SVG/PNG/source download.
- **Export to dataset** — the mapping wizard: (1) what was found, (2) entity type from group / class / shape / fixed and relationship type from label / arrow style / fixed, with an editable per-key table, tags, merge-by-label, link-to-diagram, keep-attributes, (3) preview of new / updated / merged entities and relationships. Imported ids derive from diagram + node id, so re-exporting updates in place; diagrams exported *from* the dataset keep entity ids and round-trip exactly. The mapping is saved on the diagram.
- **Entry points**: Resources → Diagrams (new from template / paste / import `.dot` `.gv` `.mmd`), Datasets → import a diagram file (opens the wizard) or export a category as a diagram, Graph view → save the current view as a diagram.

## Unigraph — the graph explorer (`src/features/graph`, `src/features/gpugraph`)

The **Unigraph** page: a pane host (`UnigraphWorkspace.tsx`, host `unigraph`, like Entities) whose tabs are explorer sessions, each with its own persisted filter / layout / selection (`?session=` scopes the keys; a new tab seeds from the last-used state). `GraphExplorer.tsx` is the shell — the panels, the toolbar, scenes, the inspector, the explorer handle the tools drive — and `/unigraph/2d` and `/unigraph/3d` are its two cameras over one picture drawn by the engine below, so switching tabs keeps filter, layout, selection and held positions. The Graph Explorer that preceded it (sigma.js in 2D, three.js in 3D, the engine as a third tab) is gone; its addresses (`/graph/*`) redirect here with their query (`app/routes.ts` › `modernGraphPath`), and its scenes load.

- **The engine** (`core/packed/`, `features/gpugraph/`) — built for a million nodes. `core/packed` is the pure data layer: `BitSet`, `IdRegistry` (string ids ↔ dense indices; a *virtual* mode gives a generated graph ids without strings), `TypeTable`, `PackedGraph` (SoA nodes and edges, CSR adjacency plus a per-node delta list for edges added since the last build, tombstone removals, `compact()` as one counting sort), `SpatialGrid` (a uniform grid by counting sort: picking and marquees visit a few cells), the deterministic community-structured `generateGraph`, and the O(V+E) layouts (`layoutCoarse`: label propagation → discs or balls on a sunflower / Fibonacci spiral, hubs in the middle — the benchmark's; `layoutMultilevel` (`multilevel.ts` over `louvain.ts`): a Louvain hierarchy drawn top-down as balls within balls, collisions per community on small grids, springs, a wall at each parent's edge; `localForce`: grid-accelerated Fruchterman–Reingold over a subset, 2D or 3D). `features/gpugraph/engine/` is the runtime: `GraphEngine` owns positions (`x, y, z, r` per node), colours, flags and the bitsets (selected, filtered, around, path, pinned), tracks dirty index ranges and uploads only those, renders on demand, and emits events (select, hover, dragEnd, contextmenu…) that never touch React per frame; `webgpu.ts` (WGSL, storage buffers read by `instance_index`, per-mode render passes, an id pass into a 16×16 texture for picking) and `webgl2.ts` (node data as textures indexed by `gl_InstanceID`, one instanced edge buffer, the same id pass) implement one `Renderer` contract; both project every vertex through one view-projection matrix (`camera.ts` orthographic, `camera3.ts` an orbit camera), so 2D and 3D are one engine. `lod.ts` is the semantic zoom (four regimes by the mean spacing of nodes on screen), `labels.ts` a 2D canvas over the GL canvas with a screen occupancy grid, `interaction.ts` the pointer handling (hover picked once per frame, drags, marquee, orbit/pan/dolly), `packed.worker.ts` the worker (generate, layouts, communities). `GpuGraph.tsx` is the explorer's view (`features/graph/view.ts` is the contract it implements): `compile.ts` turns the slice + styles + positions into the engine incrementally (node shapes, curved parallel edges and edge labels included) (stable indices; edges rebuilt as a set), selection and positions flow back through the explorer's reducer, and `GpuHud.tsx` adds the backend/frame readout and the **benchmark** (with the engine's own layouts for a benchmark graph; the explorer's picture uses the Layout tab, where **Multilevel (communities)** — `layouts.ts` › `multilevel`, the packed `layoutMultilevel` over the slice, straight from the worker's columns (`multilevelWire`) — is the algorithm this renderer switches a big unplaced view to) (`bench.ts`: presets 10k–1m, a scripted suite that reports the performance budgets in ms). `assistant/gpuGraphTools.ts` → `gpu_graph`. The headless driver's `GL=hw` runs Chrome on the machine's GPU (Metal, WebGPU) so the numbers are real. Docs page *The explorer › The engine*.

- **Filters** (`core/graph/filter.ts`) — types, relationship types, tags (any/all), text, neighbourhood (roots + depth), min degree, hide isolated, node cap (keeps best-connected). Saved as `filter` entities.
- **Layouts** (`core/graph/layouts.ts`) — Force (Unigraph) (the engine's own model, live on the GPU), force (ForceAtlas2 in 2D, d3-force-3d in 3D, stepped in the worker; seeded from previous positions), multilevel (communities), radial by type, clusters by type, concentric by degree, layered (dagre), circular, grid, sphere, random. Pure functions → position maps, saved as `layout` entities.
- **Appearance** (`core/graph/rendering.ts`, `features/graph/StylePanel.tsx`) — after Gephi. Every visual channel (node colour, size, opacity, shape; edge colour, width, opacity) is driven by a **constant**, a **ranking** (a numeric attribute — degree/in/out, any `data` field, a computed metric — mapped onto a size/width/alpha range or a sequential/diverging palette, linear or log, auto or manual domain) or a **partition** (a categorical attribute — type, tag, community, a field — mapped onto a categorical palette or the four shapes, with per-category overrides). Channels are set for all nodes/edges and overridden per type or per tag; a ranking at type scope is normalised over that type's members only. Per-type/tag rows also carry a size multiplier, visibility, labels and arrows; a precedence switch decides whether type or tag rules win (hidden always wins). Saved as `rendering` entities; older `colorBy`/`sizing`/plain-value specs are migrated on load. The legend follows the global colour channel.
- **Orthogonal** — filters, layouts and styles each have their own picker and load independently; loading one never touches the others.
- **Diagram geometry and the Scenes page** (`core/diagrams/geometry.ts`, `extract.ts`, `excalidraw.ts`; `core/graph/projection.ts`; `features/scenes/`) — diagrams import with their 2D geometry: Excalidraw files (`.excalidraw`) carry it natively (shapes with bound text → nodes, bound arrows → edges, frames → groups); Graphviz geometry comes from the layout engine's JSON output (positions, sizes, shapes, colours, spline routes, cluster boxes); Mermaid's from its rendered SVG. Exporting a diagram to the dataset captures that geometry as a **scene** entity (type key `projection`, kept for saved data) keyed by the entity and relationship ids it created. The **Scenes** tab (`/scenes`, `features/scenes/`) shows one scene — drawn with its own SVG renderer, independent of the graph engines; labels and edges from the entity store, geometry from the scene — or one plot. It is a view, not a panel system (Workstation does panels and hosts it like any other view): `?id=<scene>` / `?plot=<plot>`, and `&over=<scene>` draws another scene underneath, faded, to compare two arrangements. A *Source render* toggle places the diagram's own render underneath to check the import one-to-one; nodes can be dragged (routed edges then straighten) and the result saved. New scenes can also start from a saved layout or a grid of entities. The assistant's `display` tool drives the same view: state, show, compare, select, fit, save, list. Diagrams convert DOT ↔ Mermaid ↔ Excalidraw. Vocabulary: a **project** is the container (what data), a **scene** is one saved view of it (the Scenes page's scene, or the Display Graph's *graph scene* — filter + layout + style), a **workstation** is an arrangement of panes.
- **Local demos** (`vite.config.ts` → `localDemos`, `features/datasets/LocalDemosCard.tsx`) — dev only: `.env.local` names datasets on this machine (`AEGRAPH_LOCAL_DEMOS="Label=/abs/path.json;Label=/abs/export-dir;…"`, see `.env.example`); the dev server lists and streams them (a directory serves its `conversations*.json` chunks one by one), and the Datasets page loads them with one click under **On this machine** — the atlas, the conversations, or **both, linked**. Nothing is bundled or committed. `core/exchange/atlas.ts` → `linkAtlasConversations` joins the two halves whichever arrives first (`features/conversations/linkAtlas.ts`): every segment gets a `segment-of` link to its conversation, the conversation inherits the segments' facet tags and one weighted link per region / cluster / topic / domain / theme / persona / named entity, and an `atlas` block the conversation viewer uses to mark where each segment starts in the thread and to jump to its region, cluster and topics. `core/exchange/atlas.ts` reads the old aegraph scene-graph format — what the atlas pipeline, a separate, private tool, emits — into segments, topics, domains, themes, personas, named entities, clusters and regions, with facet tags and their colours and type definitions; dropping such a file on the Datasets page does the same. Follow-ups in `docs/followups.md`.
- **Maps** (`features/maps/`) — a `map` resource (centre, zoom, base layer) and three knowledge types on it: `location` (a point, address), `path` (a LineString; length computed) and `area` (a Polygon; area computed), each with a representative `lat`/`lng`, optional `at`/`until`, and a `mapId` naming the map it belongs to (or none — the Maps home shows all of them at once). Leaflet with OpenStreetMap, Esri satellite and OpenTopoMap tiles — no keys. Locations come from Nominatim search, Google Maps links (long-form URLs, `geo:`, `lat, lng`), or a click; paths are drawn click by click (double-click ends), areas with a lasso (thinned by Douglas–Peucker); KML (Google Earth) and GeoJSON import all three and export back with notes and times. Notes pin to the map through the `geo` selector — point, optional radius, optional `at` / `until` — and a timeline filters everything dated. Actions sit top right like every page (Add location · Add path · Add area · New map). Old `place` entities and the map → place `shows` relationship migrate once, at the first start after the upgrade — only those the old app wrote (`core/resources/migrate.ts`). Tools `create_map`, `add_location`, `add_path`, `add_area`, `annotate_map`, `map_import` (KML/GeoJSON), `map_state` (listing, or the map as GeoJSON/KML).
- **ChatGPT exports** (`core/exchange/chatgpt.ts`, `features/conversations/`) — the Datasets page loads `conversations.json` from a ChatGPT data export, or the prepared (summarised) file the old aegraph produced, **from a file on your machine**: it is parsed in the browser, stored only in the local workspace, and never bundled or committed (`.gitignore` blocks the usual filenames). Each conversation is a `conversation` resource carrying its messages; the detail view shows it as a chat with search and copy-as-Markdown. Prepared files add topics (as entities), keywords (as tags), summary and sentiment; merging can link conversations to existing entities by title.
- **Library parity** (`features/resources/capabilities.tsx`) — every action a dedicated page offers (Documents, Diagrams, Images, Videos, Audio) is declared once as a `TypeCapabilities` entry and mirrored in the Entities browser when that type is selected: toolbar buttons and a grouped **New** menu, page-specific row menu items (Open page, Rename, Duplicate, Move to…, Download, Convert, Export to dataset…, Open original/Watch on YouTube/Open in Spotify), file drop onto the table routed to the right importer, and type-aware deletion (folders cascade). The feature's own dialogs are reused, not copied.
- **Scenes** (`core/graph/scene.ts`) — a `scene` entity is the composition: filter + layout + style + 2D/3D, referencing the three parts by id. The top bar draws it as `Scene = Filter + Layout + Style`. Saving a scene saves any part that isn't saved yet (named `Scene · filter` etc.) and updates dirty ones; editing any part marks the scene dirty; loading a scene loads all three and switches to its view. Positions are *held*: nodes a saved layout doesn't know are placed by the current algorithm beside the known ones (`resolvePositions`). Drags and live physics (FA2 worker / d3) write back into the held positions; save writes them to the layout entity.
- Hover/selection highlighting with neighbour dimming, labels auto/all/none, edge toggle, fit/zoom, Focus (restrict to a node's neighbourhood), inspector on the right.
- **Pipeline** (`core/graph/pipeline.ts`, `features/graph/PipelineBar.tsx`) — every view runs **Dataset → Filter → Layout → Style → Analysis → Export**, in that order, always. Filters never read this iteration's metrics; to filter by PageRank you run the analysis, **export** the view as a `project` entity (members + materialised metric columns + provenance) and **load** it as the Dataset of the next iteration, where the metrics read as `data.<metric>`. Subprojects on the same data are the export chain (the dataset chip in the toolbar).
- **Values & selectors** (`core/graph/values.ts`, `selector.ts`) — one grammar names a value on a node everywhere (`data.<key>`, `meta.updatedAt`, `degree.in:cites`, `metric.pagerank`, `selected`, …) and one selector JSON names a set of nodes for every tool; degree indexes per relationship type are built lazily.
- **Position layouts** (`core/graph/placement.ts`, `features/graph/PlacementOverlay.tsx`) — place a selection from its values in a region of the viewport (grid, scatter, heatmap grid, circle, line, stack), transform groups, and keep the rule on the layout so it can be re-derived; the same positions show in 2D and 3D.
- **Plots** (`core/graph/plot.ts`, `features/plots/`) — shown on the Scenes page tab: a spec over the same values and selectors (rows from a selector; traces with x/y/group/colour/size as value refs; `bin` by time unit or width; `agg` count/sum/mean/…; scatter, line, area, bar, histogram, box, heatmap, pie) built into Plotly traces by a pure function and drawn by a lazily loaded Plotly. Saved as `plot` entities; the `plot` tool previews, shows, saves, opens and lists them. Docs page *Plots*.
- **Documentation** (`/docs`, `src/docs/*.md`, `features/docs`) — the in-app manual: the model, the explorer, the pipeline and its ordering, values and selectors, position layouts, analysis, exchange, and a tool reference generated from the live manifest.

## Performance

Measured on the production build with 622k entities (39k people, 98k works, 59k concepts, 410k relationships), M-series Mac, headless Chrome:

| Operation | Time |
| --- | --- |
| Generate in worker | ~1.0 s |
| Index into store | ~0.8 s |
| Persist to IndexedDB (background) | ~1.4 s |
| Cold load from IndexedDB | ~1.6 s |
| Text search over all entities | ~200 ms cold, ~90 ms warm |
| Resources tab switch (client nav) | ~45 ms |
| Sort 212k rows by label | ~160 ms |
| Heap | ~320 MB |

How: plain immutable entity objects; per-version cached reads; a lazily built lowercase search string per entity (WeakMap); `transaction()` collapses bulk loads into one notification; sort keys extracted once per row (collator under 50k rows, code-unit order above); paged IndexedDB writes instead of one record per entity (that alone was 32 s → 1.4 s).

## Browsing (`src/features/resources/EntityBrowser.tsx`)

One `EntityBrowser` component backs the **Entities** shell (`src/features/entities/EntitiesView.tsx`): `/entities` (every entity, with a rail of sections — All / Resources / Knowledge / Graph, then Relationships / Types / Tags — and the types of the chosen category grouped by parent; `?category=`, `?type=`, `?tag=`, `?q=`, `?sel=`), `?category=relationships` (with relationship types in the rail), `?category=types` and `?category=tags` are sections of the same page, and `/graph/layouts` reuses the browser. Resources are a category here, not a separate table; the pages under the Resources nav (Documents, Diagrams, Images, Videos, Audio) are the apps. Old `/resources[/<type>]`, `/knowledge[/…]` and `/tags` links redirect.

- Sort, per-column filters, global search, column show/hide + resize (remembered per tab), pagination
- Click / ⌘-click / shift-click / checkbox multi-select; `⌫` delete, `⌘A`, `Esc`, `↵` open
- Double-click to edit any editable cell (text, number, url, tags, color, boolean)
- Right-click context menu: open, copy id/JSON, open link, annotate, link to, filter by tag, delete
- Inspector panel: fields (editable), relationships (add/remove, follow), JSON, validation issues
- Create: note, webpage, annotation (+ `annotates` relationship), document, PDF from URL, video from URL (oEmbed), relationship
- Export visible/selected rows as aegraph JSON or CSV; import aegraph JSON
- Tags tab: rename, color, description, usage count, delete; click a tag to filter

## Documents (`src/features/documents`)

`/documents[/:id]` — a viewer/editor for `document` entities. Folders are documents with `extension: 'folder'`; hierarchy is `data.parentId`.

- Tree sidebar: folders (expand/collapse, remembered), search by title/tag/content, drag-and-drop or "Move to…" between folders, context menu (rename, duplicate, move, download, open in Resources, delete — folders cascade)
- Markdown / plain text: edit, split, and preview modes; formatting toolbar and shortcuts (`⌘B` `⌘I` `⌘K` `⌘E`, Tab indent, list continuation); autosave with `⌘S` to flush; word/char counts
- Select text (in the editor or the preview) → **Annotate**: creates an `annotation` entity plus an `annotates` relationship carrying a text-quote selector (`exact` + `prefix`/`suffix`). Annotations render as highlights in the preview (tinted by their tag color) and list in the Annotations panel
- PDFs: attach by URL or upload (≤ 15 MB, stored inline as a data URL so it travels with exports); rendered by the browser's viewer
- Import `.md` / `.txt` / `.pdf` files; download any document
- Info panel reuses the Resources `Inspector` (fields, relationships, JSON, validation)

Markdown rendering is dependency-free: `src/lib/markdown.ts` parses to an AST and `src/components/Markdown.tsx` renders React elements directly — no HTML strings, so untrusted content can't inject markup, and `javascript:`-style URLs are dropped.

## Licence and contributing

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)


Copyright 2026 Andrew Han, under Apache-2.0 ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)) — permissive, with an
express patent grant, which is what a company embedding this in a product needs
from its legal review. [`CONTRIBUTING.md`](CONTRIBUTING.md) has how to run it,
the checks CI enforces, and what "done" means here (documentation, tools, the
area's guide and a test, in the same commit). [`docs/configuration.md`](docs/configuration.md)
is the operator's reference: every environment variable, and what a fork for an
organisation changes. A deployment can also leave whole features out at build time —
`AEGRAPH_FEATURES_OFF=maps,globe,videos,audio` — and its sidebar rows, routes, tools and
docs page go with them while their entities stay in the Library (`src/app/features.ts`).

`npm install` needs nothing but the registry and installs the pre-commit guard.
`.npmrc` sets `legacy-peer-deps` because a transitive Excalidraw dependency
declares React 18 while this app is on 19; the file says so and when to remove
it.

## Security and privacy

The workspace is the browser's own database; nothing is uploaded, and there is
no telemetry. A project leaves only as a bundle, a published page or an export,
to a place you name. Two independent guards keep that data out of a clone of
this repository: `.gitignore` refuses every shape the app writes (bundles,
packs, published pages, exports, `public/datasets/`, every `.env` but the
example) wherever it sits, allowing back only the datasets the project ships;
and `.githooks/pre-commit` refuses the same at commit time, plus anything over
5 MB, so a file forced past `.gitignore` with `git add -f` is still stopped.
`npm install` installs the hook (`prepare` → `scripts/hooks.mjs`, which points
`core.hooksPath` at `.githooks`); `npm run hooks` re-runs it and
`git config --get core.hooksPath` should print `.githooks`.

The Claude Code bridge is the most powerful surface here — every tool, and a
chat turn that spawns `claude -p` — so it checks the WebSocket handshake's
`Origin` and refuses any page but this machine's dev server or preview and,
a single hosted origin (`AEGRAPH_HOSTED_ORIGIN`: by default **aegraph.sh**, this
edition's own site — set it to your own deployment instead, or empty for none), before the
socket opens (`AEGRAPH_BRIDGE_ORIGINS` replaces the list,
`AEGRAPH_BRIDGE_TOKEN` adds a token; `mcp/origin.test.mjs`). A connected
server can point the tab at a chat turn's own bridge (`probe`), and the tab
follows only a `ws://` URL on this machine's loopback (`bridge.ts ›
loopbackBridgeUrl`). A chat turn's
`claude -p` has the app's tools and no built-in tool at all — no shell, no
file access — and runs outside the repository, and every tool result reaches
Claude Code wrapped as untrusted data (`mcp/chat.mjs`, `mcp/frame.mjs`,
`mcp/security.test.mjs`).

**Third-party services** in the settings menu (the foot of the sidebar) is the one switch over everything
that leaves the machine — map tiles, place search, Wikipedia, the embedding
model, the media and web-page embeds, linked-data import. It is on; off is
offline mode, and each feature says so rather than failing quietly
(`src/features/account/settings.ts`, `__tests__/offline.test.ts`).

[`SECURITY.md`](SECURITY.md) is the whole picture: what reaches the network and
when, where keys live, and the checklist for deploying to an organisation. The
in-app page is `/docs/privacy`.

## Assistant (`src/features/assistant`, `src/core/ai`)

A chat panel on the right (`⌘J`, or the floating button) that acts inside the app through tools rather than describing what to do:

- **Documents** — `list_documents`, `read_document`, `create_document`, `write_document`, `edit_document` (exact-match replace, must be unique, or `append`), `move_document`, `annotate_document`
- **Entities** — `search_entities`, `get_entity`, `create_entity`, `update_entity`, `create_relationship`, `delete_entity` (asks in-chat before deleting), `list_tags`, `list_entity_types`
- **App** — `get_app_context` (current route, open document, selected text), `open` (navigate to an entity or page)

The **Chats page** (`/chats`, `src/features/chats/`) shows a chat full size — the same `ChatThread` the panel renders — between the list of chats (open, recorded, imported) and its **artifacts**: what the chat made or changed (`artifacts.ts` derives them from the writing tools' calls; the record keeps them in `ConversationData.artifacts`), each open as a tab in a pane host (documents, diagrams, maps and entities in the artifact view `/artifact/:id`, scenes in Unigraph). Each turn sends an `<app_context>` block so "this document" / "the selection" resolve without asking. Tool calls show as expandable cards in the transcript; edits land live in the open editor (the editor adopts external changes when there's no unsaved typing). The chat history persists in `localStorage` and survives reloads.

Built on `@anthropic-ai/sdk`'s beta tool runner with streaming; defaults to `claude-opus-5` with adaptive thinking and a configurable effort level. The system prompt is cached (`cache_control`). Two ways to reach Claude, chosen in the assistant settings:

- **Claude Code over the bridge** — with the bridge connected (*Claude Code bridge* below), each message is a `claude -p` turn on your own subscription, with the app's tools. On this machine (`localhost`, `127.0.0.1`, `[::1]`) it is the only way: no key reaches the Claude API from there (`isLocalHost` in `src/core/ai/settings.ts`; `createClient` throws `LocalOnlyError`). On a deployed copy it works when the bridge accepts that page's origin — which it does not by default: set `AEGRAPH_HOSTED_ORIGIN` (or `AEGRAPH_BRIDGE_ORIGINS`) to it.
- **Your own API key** — on a deployed copy: an Anthropic API key pasted into the assistant settings, stored in this browser only, and sent straight from the browser to the Claude API (`dangerouslyAllowBrowser`, `src/core/ai/client.ts`). Nothing sits in between, and nothing is spent on anyone's account but yours. With a key and the bridge both there, *Answer through Claude Code even when a key is set* picks the bridge.

With neither, the panel and the Chats page open on the settings and say which to set up.

## Demo projects (`scripts/demos/fetch.mjs`, `src/features/projects/DemosPanel.tsx`)

Every project the app offers to open is built in the private [`aegraph-ui-demos`](https://github.com/adrewh2/aegraph-ui-demos) repo — this repository carries none — and reaches a build as static files: `prebuild` (`scripts/demos/fetch.mjs`) copies each demo's bundle (gzipped, a sixth of the size), preview and README into `public/demos/` (gitignored), and the Projects dialog's Demos tab shows them as cards, each opened with a click; `load_dataset` lists and opens them by id. A link opens one too — `?demo=<id>&scene=<scene>` on any page (`src/app/demoLink.ts`, read by the boot in `app/providers.tsx`; the scene menu's *Copy link to this scene* makes one). **With no checkout and no token — a clone of this repository, a fork — the build takes the copies aegraph.dev publishes:** `AEGRAPH_DEMOS_SITE`, by default `https://aegraph.dev`, read from its `/demos/catalog.json` and held to the same names (`catalog.mjs › fromPublished`). `AEGRAPH_DEMOS_SITE=off` and no other source: no demos, no error. A checkout of `aegraph-ui-demos` (`../aegraph-ui-demos`, `~/workspace/aegraph-ui-demos` or `AEGRAPH_DEMOS_DIR`) or a token takes precedence: with `AEGRAPH_DEMOS_TOKEN`, a fine-grained token with *Contents: read* on that one repository, the script reads it through the GitHub API (the token never reaches the browser). That token, and the Vercel deploy hook through which a push to the demos repo redeploys the site, are aegraph.dev's own setup; a build of this repository needs neither. A demo whose `exportedAt` and size are unchanged is not fetched again.

The dev server does not use those copies when a checkout is there: `vite.config.ts › liveDemos` serves `/demos/catalog.json` and each demo's bundle, preview and README straight from the checkout on every request, and the app reads the catalog afresh each time the tab opens. Rebuild a demo with its generator and open it again from the Demos tab: the project updates in place, with no fetch and no restart. `AEGRAPH_DEMOS_LIVE=0` serves the copies instead, as a build would.

## Claude Code bridge (`mcp/`, `src/features/bridge`)

Lets Claude Code drive the running app through the same tool set as the in-app assistant (about a hundred tools, listed live at `/docs/assistant`) — on your Claude subscription, no API key. `mcp/server.mjs` is an MCP server (stdio) that hosts a local WebSocket; the app tab connects to it, sends its tool manifest, and executes every call in the browser. The server holds no state, so the tools are always exactly what the app exposes. The sidebar's Claude Code dialog gives the setup as one command to copy — on the deployed site, clone this edition's repository, install, `npm run dev`; on that local app, `claude` in the checkout (`src/app/edition.ts` names the repository; the toolkit edition overrides that file, and shows a link to its public repository at the foot of the sidebar).

```sh
npm run dev                      # the app
# in the app: sidebar → "Claude Code" → Enable bridge
claude                           # run in this repo; .mcp.json registers the "aegraph" server
> summarize the open document and tag it
```

`claude -p "…"` works the same way for one-shot tasks. And the other direction: with the bridge connected and no API key, the in-app assistant sends its messages *to* Claude Code — each one a `claude -p` turn (resumed across messages) with its own copy of the bridge for the app's tools and **no built-in tool** (`--tools ""` plus a deny list: no shell, no file reads or edits, no web fetch), run in an empty folder of its own with only the environment Claude Code needs; `AEGRAPH_CLAUDE_ARGS` cannot widen that (`mcp/chat.mjs`). `aegraph_bridge_status` reports whether a tab is connected. Deletes pause on a confirmation dialog in the app. Every tool result is handed to Claude Code inside `<untrusted_data>`, and the server's MCP instructions say nothing inside it is an instruction (`mcp/frame.mjs`; `drive.mjs` and `attach.mjs` unwrap it). A remote image in a result is fetched only over https from a public address, capped and timed (`mcp/publicUrl.mjs`). Env: `AEGRAPH_BRIDGE_PORT` (default 8787, bound to 127.0.0.1), `AEGRAPH_BRIDGE_ORIGINS` (replaces the pages allowed to connect), `AEGRAPH_HOSTED_ORIGIN` (the one hosted site allowed besides this machine's pages — none by default; set it to your own deployment), `AEGRAPH_BRIDGE_TOKEN` (optional shared secret, appended as `?token=` to the URL in the app's bridge settings; compared in constant time), `AEGRAPH_BRIDGE_TIMEOUT_MS`. With several tabs open, calls go to the tab you last brought to the front.

## Headless engine (`src/headless`, `mcp/smoke-headless.mjs`)

The same tools, no browser. `src/headless/engine.ts` hosts the logical engine in Node — one workspace file (`.ae.json`, gzip optional) read at boot, written back a quarter-second after every data change through a temp file and a rename, the open project remembered in it — and `server.ts` exposes the app's tool groups over stdio MCP. The tool set is the browser's minus what a browser owns (the explorer canvas and camera, the globe, media players, the workstation, voice): entities, documents, projects and history, the ontology, constraints, `analyze`, scripts, datasets, charts, maps, diagrams, memory, `validate_ae` — plus `workspace_status` / `workspace_save` / `workspace_reload` / `open_project` / `import_file` / `export_file`, the graph computed rather than drawn (`graph_slice`, `graph_metrics`, `graph_layout`, which reports a tree's roots, depth and undrawn cross-links), and `graph_scene`, which composes a Unigraph scene — data + filter + layout + style, with the camera and panels it opens on — into the same part entities `graph_save` writes in a tab. 68 tools. JavaScript scripts run here as well: the QuickJS sandbox is WebAssembly, so `ScriptRunner` evaluates in-process where there are no workers (`src/scripting/runner.ts`).

```sh
npm run headless -- ~/work.ae.json     # build (Vite SSR → dist-headless) + run
npm run smoke:headless                 # end-to-end over MCP with no browser
claude mcp add aegraph-headless -- node "$PWD/dist-headless/aegraph-headless.mjs" ~/work.ae.json
```

Its tool results, errors included, reach the client inside the same `<untrusted_data>` envelope the bridge uses, under the same instructions (`src/headless/results.ts`, `mcp/frame.mjs`): the workspace's text is data, never an instruction — a client that reads results as JSON calls `unframe`. Several clients can drive one running instance over MCP's streamable HTTP transport (`--port <n>`, loopback only); otherwise it is stdio, one client per process. A lock beside the workspace keeps it to one writer (autosave would otherwise have two processes overwriting each other; a stale lock is taken over, `--force` ignores a live one). Commit content, IndexedDB in the browser, is `<workspace>.history/<commit>.json.gz` here, so `project_commit` and a later `project_restore` work across processes.

Built with `vite.headless.config.ts` (one SSR pass, deps external) because app modules reach for bundler-resolved imports — `?raw`, a `.py` prelude, a stylesheet beside a component. On 6,037 entities / 14,094 relationships: boot 300 ms, `graph_slice` 18 ms, degree + PageRank + Louvain 80 ms, tree layout 45 ms, `analyze` 140 ms, force (200 iterations) 2.5 s. Documented at `/docs/assistant#headless-the-engine-with-no-browser`.

## Projects and versions (`src/core/projects`, `src/features/projects`)

A **project** is a named scope over the one Library: membership is `meta.projects` on the members, `store.scope` is the open project and `store.library.*` reads past it; switching projects stashes and restores the per-project UI state, including every section’s tab arrangement (`active.ts`) and lands on the project's `data.home.route`. A project travels as a **bundle** — `.ae.json`, or `.aeb`, the byte pack — with its `state` (route, workstation), opened from a file, a URL (`/open?url=`), the Datasets page or `project_open_bundle`; a chosen **projects folder** (File System Access API) makes Save write there. **Templates** (`template.ts`) give an imported project the charts, scripts and scenes it names. **Publishing** (`features/projects/publish.ts`) writes the project as a self-contained read-only page. **Versions** (`versioning.ts`, `history/`): commits with a message or by autosave, a content hash per entity, unsaved changes as a property-by-property diff (long texts as line diffs, pictures side by side, record lists item by item), a history to walk and restore; commit content lives in a second IndexedDB database so a long history costs the Library nothing. Tools: `project_*` — list, open, create, update (autosave), add/remove, save, open_bundle, template, publish, changes, commit, history, restore. Docs page *Projects*.

## Ontology, constraints and claims (`src/features/ontology`, `src/core/constraints`, `src/features/knowledge`)

The **Ontology** page: *Schema* (every type and relationship type with properties, parents, the type pairs it joins and their cardinality; downloadable), *Network* (types as nodes), *Tags* (the matrix), *Claims* (findings kept with `supports`/`challenges` evidence, communities named as entities) and *Constraints*. A **constraint** (`core/constraints`: `constraint.ts`, `rules.ts`, `engine.ts`, `templates.ts`) is an entity in the ontology: conditions in the filter language over an entity, a JavaScript rule over the entity or the whole graph (judged with the write laid on top), or a saved script judged by the audit; required, unique, what a relationship may join; scoped to a project; from templates. The store's write guard refuses a failing write with the constraint and condition named, so an agent can correct and retry; the audit lists every violation in the data as it stands. Tool `constraint {action}`. Docs pages *Constraints*, *Insights*.

## Insights, charts, scripts and datasets (`src/analysis`, `src/features/analysis`, `src/features/plots`, `src/features/scripts`, `src/scripting`, `src/core/datasets`)

**Insights** runs five analyses over the current view and returns ranked findings, each with a visual; a finding becomes a claim, a community a named entity (`analyze` tool). **Charts** are a spec over the values grammar built into Plotly by a pure function (`core/graph/plot.ts`), saved as `plot` entities, built without code in the Analytics page (`plot` tool). **Scripts** run in a sandboxed iframe: JavaScript with a typed `ds` API, Python in Pyodide (numpy, pandas, plotly; matplotlib, scipy, scikit-learn, networkx, statsmodels on demand), and Visual scripts drawing with three.js, d3 or a canvas; the editor completes from the data as it stands (`scripts/completion.ts`, `vocabulary.ts`), scaffolds from a description, and keeps a snapshot of the dataset per run (`snapshot.ts`); saved as `script` entities (`script` tool; `script {action:"schema"}` for an agent about to write one; `data.locked` scripts — every demo's — refuse to be overwritten or deleted until unlocked in the page's Details dialog or with `save {locked:false}`); a script put to use is one of the subtypes `script:filter` (applied in the explorer, `scripts/filters.ts`, `graph_filter {script}`), `script:constraint` (judged by the audit, `scripts/constraints.ts`) or `script:scene` (shown on the Scenes page) — `parent: script`, retyped by `markScriptUse` when a script is saved with a kind or first connected; `script {action:"apply"}` does the connecting). **Datasets** (`core/datasets/dataset.ts`, `features/analytics/DatasetView.tsx`) are the hand-off of the analytics flow *scene → script → dataset → chart*: a table a script returns kept as a `dataset` entity (`columns`, `rows`, `source`) — a saved script's rerun refreshes the same dataset — edited in place in a virtualised grid on the Datasets tab of Analytics (cells read by column kind, rows and columns inserted, moved, sorted; CSV in and out; a pasted block of cells; spreadsheet keys, the arrows leaving the cell editor at the edge of its text — `analytics/grid/keys.ts`), every edit a write to the entity (`dataset` tool). A dataset is also read from a file (`core/datasets/files.ts`, bounded): delimited text with any separator, Excel workbooks by the app's own zip-and-XML reader over the bounded inflater (`xlsx.ts`), Parquet through hyparquet and its codecs, loaded on demand (`parquet.ts`) — what a chat attachment and `dataset {action:"create", file}` go through. Docs pages *Insights*, *Charts*, *Scripts*, *Datasets*.

## Maps and the globe (`src/features/maps`, `src/features/globe`)

See the Maps entry under Unigraph for the model (map, location, path, area, and their subtypes through `parent`). `MapWorkbench.tsx` is the page's state — places, notes, the time window and playhead, selection — shared by the flat Leaflet stage (`MapCanvas.tsx`), the **globe** (`globe/GlobeStage.tsx`: react-globe.gl; below 400 features globe.gl's own arcs and points, above it one merged three.js layer with its own picking, `trackLayer.ts`; the hidden stage freezes its inputs and pauses its render loop) and the table beside them (`MapBody.tsx`, the standard entity table with tabs by kind, a **Types** multiselect, and the layout the map or the types carry). `wikipedia.ts` enriches a place with a photo and a paragraph, stored on the entity. Tools `create_map`, `add_location`/`add_path`/`add_area`, `annotate_map`, `map_import`, `map_state`, `enrich_location`, `globe`, `globe_load`, `table_layout`. Docs page *Maps*.

## Search, voice and the docs (`src/features/search`, `src/features/voice`, `src/features/docs`)

`⌘K` (`search/CommandPalette.tsx`) lists recent things, actions, entities, views, tags, types, projects and findings from one box. **Voice** (`voice/`) drives the assistant without its panel: continuous listening, dictation joined into one command, answers read aloud, questions answered by speech; a listener and a speaker through OpenAI are an option — with a key of your own, or on the dev server with `OPENAI_API_KEY` from `.env.local` (`dev/openai.ts`, served at `/api/openai` by the dev server only). The assistant **reads the web** with `web_fetch` (`assistant/webTools.ts`): directly when a host allows the browser to read it, else — when the app runs on the dev server — through `dev/fetch.ts`, the dev server's public-addresses-only reader at `/api/fetch`. A deployed copy has no server, so a page that does not let the browser read it cannot be read there, and the tool says so. **Documentation** (`docs/pages.ts`, `src/docs/*.md`) is grouped and in reading order; `toolReference.ts` generates the tool reference from the live manifest; `lookup.ts` lets the assistant read a page or search the docs (`docs` tool), and the assistant knows which docs page is on screen.

## Images (`src/features/images`)

`/images` is a gallery of `image` entities (upload, paste a URL, or drop files on the page; inline uploads are capped at 10 MB). `/images/:id` is the annotator: **Draw box** drags a rectangle over the picture, which becomes an `annotation` entity linked by an `annotates` relationship whose selector is `{ kind: 'region', x, y, width, height }` in original-pixel coordinates; **Select** moves and corner-resizes boxes (the selector updates), `Delete` removes the selected one. Whole-image notes attach without a selector. Zoom fits by default (upscaling small images to 4×). Images also appear as a tab in the Library.

The assistant sees images: `view_image` returns the pixels as an image block (base64 for uploads, URL for remote) plus existing boxes, and `annotate_image` draws boxes in pixel coordinates — so "find the logo and box it" works end to end.

## Videos (`src/features/videos`)

`/videos` lists YouTube videos (add any watch/share/shorts/embed link; title and channel come from oEmbed; `?t=` start times are honoured). `/videos/:id` embeds the video as a sandboxed `youtube-nocookie.com/embed` frame, driven by the embed's own messages (`listening`, `command`, `infoDelivery`), so the page can read and control playback — no provider script runs in the app's origin: **Note at m:ss** annotates the current moment (optionally a span with an end time); **Draw box** pauses and lets you drag a rectangle over the frame, storing a region in fractions of the frame so it survives resizing. Both are `annotation` entities linked by `annotates` with a `time` selector (`{ kind: 'time', start, end?, region? }`). The timeline shows markers and spans (click to seek); boxes appear over the video while playback is inside their window; the panel lists everything by time. Videos also appear as a Library tab.

**Stills.** A YouTube iframe is cross-origin, so its pixels can't be read from a canvas; instead the page uses tab capture (`getDisplayMedia` with `preferCurrentTab`). The first capture asks you to share the tab, then the stream stays open for the page session so later captures are instant. With **stills** ticked (default), every note or box saves a JPEG of the frame on the annotation itself (`data.imageUrl` + `imageWidth/Height`) — shown as a thumbnail (cropped to the region when there is one) in the panel, previewable full size, and visible wherever the annotation appears (Library, Inspector). **Capture frame** saves a still without a comment. YouTube's own controls are off so stills come out clean; use the toolbar, the timeline, or `Space`.

The assistant gets the playhead in its app context (`open_video … playhead=95s`), can `annotate_video` moments/spans/regions, `create_video` by URL, and `capture_video_frame` (optionally seeking first) — which returns the still as an image block so it can see what's on screen.

## Internal deployment readiness

[The company readiness audit](docs/proposals/company-readiness-2026-09-30.md) describes aegraph-ui's hosted edition; for this edition see [`SECURITY.md`](SECURITY.md). Headless autosave failures retain unsaved data and expose `saveError` through `workspace_status`; repair the filesystem and retry `workspace_save` before stopping the process. Older IndexedDB formats without a verified migration are preserved and refused, never erased during an upgrade.
