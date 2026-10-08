# Use cases

What aegraph is *for*, as ten concrete jobs. Each one names the goal, the path through the app, the tools that do the same over MCP, and the utilities underneath that make it work — so you can tell which job a feature serves, and which jobs a change would touch. [A working session](/docs/workflow) walks one session end to end; this page is the map.

The jobs group into three kinds: **collecting evidence** (1–4), **understanding a corpus** (5–8), and **keeping and sharing what you learned** (9–10).

## 1. Read a literature set and keep the claims

*Goal:* turn a folder of papers and pages into statements you can defend.

1. Add sources: drop PDFs and `.md` files on **Documents**, save URLs as webpages, paste YouTube talks into **Videos**.
2. Read in the viewer and **annotate**: select a passage → a `annotation` entity anchored by an `annotates` relationship with a text-quote selector, so the highlight survives edits and travels with the export.
3. State what you concluded as `claim` entities (New → Entity, type *claim*), then link evidence with `supports` / `challenges` — from the inspector's *Link to…*, or by right-clicking an annotation.
4. Open the **Graph Explorer** filtered to `claim`, `annotation`, `document` and their links to see which claims rest on one source.

*Over MCP:* `create_document` / `annotate_document` / `create_relationship`; `graph_filter {types:['claim','annotation','document']}`. `npm run smoke:claims` drives this job over the bridge: the annotation is anchored by its words (a text-quote selector with context), so an edit elsewhere in the document leaves it in place and the reader still highlights it; the claim's evidence shows in the graph as `degree.in:supports`.
*Utilities:* selectors (`core/entity/ids.ts`), `createAnnotation` (the one writer for annotation + edge), the reader's highlight rendering, structural vs authored relationship types.

## 2. Review media and pin moments

*Goal:* watch a talk or listen to an episode and come away with timestamped notes and stills.

1. Add the video (any YouTube link) or Spotify item.
2. While it plays: **Note at m:ss**, **Draw box** over a frame, `I`/`O` to mark a range on audio. Each is an annotation with a `time` selector (`{start, end?, region?}`), shown on the timeline and, for video, saved with a JPEG still.
3. Later, the Annotations tab of the inspector, the Library's Annotations rows, and `annotate_video` / `capture_video_frame` over MCP all read the same objects.

*Over MCP:* `create_video` / `annotate_video`, `create_audio` / `annotate_audio`, `create_image` / `annotate_image`, `capture_video_frame`, `control_playback`. `npm run smoke:media` drives the half that needs no player.
*Utilities:* the YouTube IFrame API and Spotify embed wrappers, tab capture for stills, `RangeTimeline`, the `time` selector.

## 3. Map what happened where

*Goal:* places, routes and areas with dated notes, on a map you own.

1. **Maps** → New map; add `location`s (search, paste a Google Maps link, click), draw a `path` (click by click) or an `area` (lasso), or import KML/GeoJSON.
2. Pin notes to a point and a time (`geo` selector with `at`/`until`); the timeline filters by date.
3. Locations are knowledge entities: link them to people and events, filter the graph to `in-region` links, style by tag.

*Over MCP:* `create_map`, `add_location`, `add_path`, `add_area`, `annotate_map`, `enrich_location`, `map_import`, `map_state`. `npm run smoke:maps` drives the job over the bridge without the network (coordinates and Google Maps links only): places with times, a measured path and area, a pinned note, `map_state`, a location's neighbourhood in the graph, and the map page with its pins — which fold into one cluster pin when they sit within a few hundred metres at the map's zoom.
*Utilities:* Leaflet with three tile providers, Nominatim, the `geo` selector, Douglas–Peucker thinning, KML/GeoJSON import/export.

## 4. Draw a system and make it data

*Goal:* a diagram someone drew becomes entities you can query, and stays a diagram.

1. **Diagrams** → paste DOT, Mermaid or an `.excalidraw` file; preview; convert between them.
2. **Export to dataset** — the mapping wizard chooses entity types from group/class/shape and relationship types from labels/arrows, previews new/updated/merged entities, and keeps the geometry as a Scenes `projection`.
3. Explore the result in the Graph Explorer; edit nodes; **Save the view as a diagram** to round-trip back to DOT/Mermaid with the same ids.

*Over MCP:* `create_diagram`, `view_diagram`, `write_diagram`, `diagram_to_dataset`, `display`; the way back is `graph_export {format:'dot'|'mermaid', save_as}`, the same picture the explorer's *Save the view as a diagram* makes. `npm run smoke:diagram` drives the round trip: DOT → entities with `dg-` ids and a scene → an edit → DOT again with the same ids, so a second export to the dataset updates in place. Node types come from cluster labels put back into the singular (a cluster labelled *Services* gives the type `service`, which is what the way back labels its cluster again).
*Utilities:* the DOT/Mermaid parsers, `diagramFromEntities`, Graphviz and Mermaid renderers (lazy), `core/diagrams/geometry.ts`, deterministic ids (`dg-<hash>-…`) so re-export updates in place.

## 5. Explore a big corpus without losing the thread

*Goal:* thousands of nodes (a ChatGPT export, a crawl, a citation graph) and a picture you can read.

1. Load the source through **Open project…** in the sidebar's project menu (a ChatGPT `conversations.json`; a graph file in GEXF/GraphML/cyjs/RDF; a demo) — or open the atlas pipeline's bundle, which arrives as a project with its analytics in place.
2. Open the Graph Explorer. The **view budget** gate shows the load by type and unticks the densest relationship kinds; accept a trim or draw everything.
3. Narrow: types and tags (namespaces fold), `roots_match` + depth for "these things and everything one hop out", the neighbourhood tools, k-core and components.
4. Choose a layout — force (worker, with live physics), an on-demand engine (ELK, WebCola, ngraph, spectral), or a placement by values — and a style: colour by type or a tag namespace, size by degree or a metric.
5. Pick rows in the pane's **Nodes** table to jump the camera; open a node's record; switch 2D ↔ 3D without losing the view.

*Over MCP:* `graph_filter {roots_match, depth}` → `graph_layout` → `graph_style` → `graph_save {kind:'scene'}` (see the recipe in [Assistant & MCP](/docs/assistant)).
*Utilities:* `applyFilter`, the layout worker and `layoutEngines`, `styleContext`, the view budget, camera memory and the 2D/3D hand-off, the engine's semantic zoom (level of detail by how densely nodes sit on screen).

## 6. Find out what stands out

*Goal:* "show me what is interesting" before you know what to ask.

1. **Insights** runs five analyses (key players, community map, ontology in use, activity over time, outliers and gaps) over the open project or Library, ranked by how far each finding sits from the unremarkable.
2. Each finding opens as a **graph** (filtered and styled), a **plot**, or a **table**; *Ask* hands it to the assistant; *Save as claim* keeps it; community chips name a group as an entity.
3. For a specific view, the explorer's **Stats** tab computes metrics (PageRank, betweenness, Louvain…) that styles and placements can use.

*Over MCP:* `analyze {action:'run'|'show'|'get'}`, `graph_metrics`.
*Utilities:* the `src/analysis` package (pure, columnar, worker-run), the CSR metrics worker, `runInsights`, findings → plot/filter specs.

## 7. Iterate an analysis into a subset

*Goal:* "the top of the graph by PageRank, and only that".

1. Run metrics on the view (Stats tab or `graph_metrics`).
2. **Export view as a project** — the members plus the metric columns become a `project` entity with provenance.
3. **Use the project as the dataset**; now `data.pagerank` is an ordinary field: filter `fields:[{path:'data.pagerank', op:'gte', value:0.01}]`, place, style, repeat. The pipeline bar draws the chain.

*Over MCP:* `graph_metrics` → `graph_project {action:'export'}` → `graph_project {action:'load'}` → `graph_filter {fields}`. `npm run smoke:iterate` drives exactly this chain over the bridge and checks each step (a filter on `metric.*` is refused with the recipe; the export carries the columns; the loaded project scopes the view and shows in `graph_state`'s breadcrumb; the field filter narrows; unloading returns to the workspace).
*Utilities:* the fixed pipeline order (`core/graph/pipeline.ts`), `buildProject`, value overlays (`projectOverlay`), the filter context.

## 8. Chart it, or script it

*Goal:* a figure from the data, or a computation the built-ins do not offer.

1. **Analytics → Charts**: rows from a selector, x/y/group/colour as value refs, bins and aggregates, eight chart kinds; saved as `plot` entities and shown on the Scenes page.
2. **Analytics → Scripts**: JavaScript in a sandbox (`aegraph.query`, `aegraph.plot`, `aegraph.remember/recall`), Python via Pyodide with networkx, or a visual script rendering into a fixed layer over the page. Scripts persist, keep their camera, and the ones you have run in this browser re-run on load — a script that came in a bundle waits for **Run**.

*Over MCP:* `plot`, `script {action:'run'|'save'|'show'}`. `npm run smoke:charts` drives the charts half (a binned bar, an aggregate, a scatter; shown, saved, reopened, updated; metric columns lent from a Stats run over the whole dataset and from Insights) and `npm run smoke:scripts` the scripts half.
*Utilities:* `core/graph/plot.ts` → Plotly (lazy), the QuickJS sandbox, the Pyodide worker, `FrameLayer`.

## 9. Keep several bodies of work apart, and together

*Goal:* the thesis, the reading group and the ChatGPT archive in one Library without mixing them.

1. Create a **project**; everything created or loaded while it is open is marked with it. Add or remove entities from any table's *Projects* menu; a project can `include` others.
2. Switching projects swaps the pages' remembered state (explorer, workstation, positions, camera).
3. **Save project…** writes a bundle (`<name>.ae.json` with `project` and `state`); **Open project…** merges it back by id. **Save as new project** forks with a review dialog.

*Over MCP:* `project_create`, `project_open`, `project_add`, `project_save`, `project_open_bundle`, `load_dataset`. `npm run smoke:projects` drives the job over the bridge: two projects, search and the explorer scoped to the open one, the explorer's filter remembered per project across a switch, an include seeing both, and a bundle saved and opened again merging by id without a duplicate.
*Utilities:* marks in `meta.projects` and the `byProject` index, `scopeOf` with includes, bundle closure (`core/projects`), per-project UI keys.

## 10. Let an agent do the legwork

*Goal:* say what you want and watch the app do it.

1. In-app: **⌘J** opens the assistant; every message carries what is on screen. Right-click anything → *Ask about this*.
2. From Claude Code: enable the **bridge** in the sidebar; the same 76 tools run in the tab. Recipes that work as one or two calls: a described neighbourhood as a scene (`graph_filter {roots_match}` → `graph_save`), a filtered table by meaning (`open_entities {query}`), findings on demand (`analyze`), a project published as a page (`project_publish`).
3. Headless: `mcp/drive.mjs` runs a steps file against a fresh profile — the smoke suites and every verification in the changelog use it.

*Utilities:* the tool manifest (one file per domain under `features/assistant`), `explorerHandle`, semantic ranking (`core/search/vocabulary.ts` + the local embedder), the bridge server (`mcp/server.mjs`).

## What the jobs have in common

Every job above passes through the same few utilities, which is what keeps the app one thing rather than ten:

| Utility | Jobs that use it |
| --- | --- |
| Selectors on `annotates` (text, region, time, geo) | 1, 2, 3 |
| `applyFilter` and the `Selector` grammar | 5, 6, 7, 8, 10 |
| Value refs (`data.*`, `degree…`, `metric.*`) | 5, 7, 8 |
| Layouts in the worker (built-in and engines) | 4, 5, 6 |
| Scenes (filter + layout + style) | 4, 5, 6, 9, 10 |
| Projects as marks; bundles | 5, 7, 9, 10 |
| The tool manifest and app context | all |

If a proposed change does not serve one of these ten jobs, or breaks one of these seven utilities, that is worth noticing before building it.
