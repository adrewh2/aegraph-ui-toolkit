# Follow-ups

Things agreed but not yet built, with the context needed to pick them up.

## Local demos: drop the `.env.local` path hack

*Recorded 2026-09-12.* The Datasets page's **On this machine** card is fed by the dev server from absolute paths in `.env.local` (`AEGRAPH_LOCAL_DEMOS`, see `vite.config.ts` → `localDemos`). It exists so the conversation atlas can be loaded with one click without committing personal data. It should go away once the pipeline below produces its output in a place the app can discover on its own (a folder the app watches, or the pipeline writing into the app's own data dir), or once projects/bundles (`docs/proposals/projects.md`) make "open this bundle" the normal path. Until then: never commit `.env.local`; `.env.example` documents the variable.

## A first-class ChatGPT pipeline, in the app

*Recorded 2026-09-12.* Today the app has two half-paths for ChatGPT data:

- `core/exchange/chatgpt.ts` reads a raw `conversations.json` (or the old "prepared" file) into `conversation` resources with messages — no semantics.
- `core/exchange/atlas.ts` reads the *output* of the ChatGPT pipeline, a separate, private tool (`parse → segment → label → consolidate → cluster → export`, Python, LLM-labelled against a 10-facet ontology; output `data/out/conversation-atlas*.json`) into segments, topics, domains, themes, personas, named entities, clusters and regions with namespaced `facet:value` tags.

Wanted: one first-class pipeline that runs the export through those stages from inside aegraph-ui (or drives the pipeline repo and imports its result), so that:

1. **Parse** is shared: one recovery of the linear thread per conversation (the two existing parsers disagree slightly on how many conversations an export holds — resolve to one).
2. **Tagging** is a stage the user can run and re-run in the app against the ontology (`config/ontology.yaml` in the pipeline repo): closed facets validated, open facets consolidated; results land as tags + `data.facets` on entities, and as `topic`/`domain`/… entities with relationships, exactly as the atlas import lays them out today — so the atlas importer becomes the pipeline's last stage rather than a separate path.
3. **Segments link back to conversations** (`next-in-conversation`, `data.conversation_id`) and the conversation resources keep their messages, so a segment opens as a readable chat at the right place.
4. Facets become **value refs** (`tags` namespace-aware: `tag:domain`, `data.facets.domain`) so the explorer can partition, place and filter by them without extra wiring — the same idea the old app called Dimensions.
5. The pipeline's clustering/regions are optional analyses the app could also compute itself (Louvain over `similar-to` is close) — decide which side owns them.

Pieces already in place: `chatgpt.ts` (parse), `atlas.ts` (import of labelled output), the `conversation` resource and viewer, tags with colours, the value/selector engine, projects as the natural container for one export.

## Finish the DBpedia sample dataset

*Recorded 2026-09-13; moved 2026-10-08.* The sample is now the `dbpedia-programming-languages` demo in the aegraph-ui-demos repository (`generators/dbpedia-programming-languages`, which keeps the N-Triples and the SPARQL script). What was left — rebuilding the N-Triples once DBpedia's endpoint is healthy, checking the predicates, and a scene and a plot that make it a one-click story — is that generator's work now, recorded in its README.

## Timeline view with a brushable range

*Recorded 2026-09-15.* The data is temporal (a conversation export spanning years, Aurora's eighteen months) but the only time axis is inside plots. Wanted: a **Timeline** view — activity of the current project over time, from `meta.createdAt` / `meta.updatedAt` and any temporal property the rows carry (`data.created`, `created_ts`, `startedAt`… — `isTemporalRef` in `features/plots/PlotPanel.tsx` and `axisValue` in `core/graph/plot.ts` already decide what reads as a date), as a bar-per-period histogram with a brushable range. The brushed range is a **first-class filter predicate** applied to the open Graph Explorer and Entities tabs (a `time?: { ref: ValueRef; from: number; to: number }` on `FilterSpec` in `core/graph/filter.ts`, evaluated by `applyFilter` alongside `fields`; the Entities browser gets the same through its URL, like `?tag=`). Pieces to reuse: `buildPlot` with `bin: 'month'` for the histogram; `plotContextFor` for row resolution; the cross-page hand-over pattern (`graphSetupHref` / `readGraphSetup` in `app/openIn.ts`) for pushing a range to other tabs; the MCP surface should expose it (`graph_filter { time }`). Scope it as one view under Analytics and a *Time* fold in the explorer's Filter tab.

## Performance at 50k nodes / 200k edges, end to end

*Recorded 2026-09-15.* Worker force layouts landed (`08b7b56`), the 3D level of detail exists, edges draw through compound programs (`features/graph/edgeHalo.ts`), the view budget gates big draws. Not yet measured as one path: import → tables → graph → metrics at 50k nodes / 200k edges. The task: build a synthetic dataset of that size (`scripts/` — a generator like the Aurora demo's in aegraph-ui-demos), drive it with `mcp/drive.mjs` (`GL=1`, the `gx:*` performance marks), record import time, first paint, filter latency, a force layout, PageRank + Louvain, and the Nodes/Edges tables; then fix the top three hotspots with numbers before and after. Suspects, in order: `EntityTable` sorting/filtering on every keystroke over 200k relationship rows (paginate the *work*, not only the rows); `applyFilter` rebuilding `collectEdges` from scratch on each patch; the halo compound program doubling edge draw calls for every edge type (draw halos only for the focus set by giving them their own tiny program input); `listValueRefs` sampling on every render of the plot panel; `styleContext` recomputing every scale on selection changes.

## Project version control: resource changes, history in bundles, big projects

*Recorded 2026-09-18.* Projects now have Git-style history: `project:commit` entities plus content blobs in the `aegraph-history` IndexedDB database (`src/core/projects/{versioning,history,historyBlobs,autosave}.ts`), the Changes / History / Settings tabs under a project (`src/features/projects/history/`), autosave or commit-by-hand per project, and the `project_changes` / `project_commit` / `project_history` / `project_restore` tools. What is captured is the *content* of every entity in the project's scope, property by property. Left for later:

1. **Resource changes, further.** Done since: a document's `data.content` diffs as lines; an image's `data.src` (or any `src`/`poster`/`thumbnail` field) shows both pictures side by side; a list of records — a conversation's messages, annotations, an Excalidraw scene's elements (parsed from `data.source`) — shows items added / removed / changed by `id` (moves and resizes summarised as "moved/resized"); DOT and Mermaid sources diff as lines; the `project_changes` / `project_history` tools return the same as `list` / `image` entries. Still wanted: a *resource* view in the Changes list that groups a resource with the annotations and highlights that point at it (`data.target.id`), video/audio annotations rendered against the time axis, a PDF body (stored as a data URL) compared page by page, and a rendered side-by-side of an Excalidraw scene rather than the element list. `ChangeList.tsx` → `PropertyRow` is the one place renderers plug in; `diffProperties` / `diffList` in `versioning.ts` decide the rows.
2. ~~Add the project's page links.~~ Done: `ProjectsView.tsx` renders `<ProjectNav>` on the Overview.
3. **History in bundles.** A bundle carries the project, not its commits (`projectClosure` never reaches `project:commit` entities and the blobs live outside the store). Decide whether *Save project…* should offer "with history" (commits as entities + blobs inline, gzip) so a project moves between devices with its past, and whether `importBundle` should accept them (then blobs need a stable id → dedupe by commit id).
4. **Big projects.** A first commit of a 100k-entity project writes one blob holding every entity (a single IndexedDB record; measured fine to a few hundred MB but never on a slow disk), and every autosave rehashes only new entity objects (WeakMap-cached) but still walks the scope. Options when it hurts: chunk blobs by 4,000 entities like `persistence.ts` pages, pack them with `packDocument`, hash in a worker, and store per-entity blobs by content hash so an entity edited fifty times keeps one copy per distinct version rather than per commit.
5. **Tag metadata and UI state** (tag colours, the explorer's saved positions in localStorage) are not part of a commit; only entities are. Positions saved as `layout` entities are.
6. **Cross-tab.** Commit entities sync between tabs through the persistence layer's BroadcastChannel; blobs are read from the shared database on demand, so a commit made in one tab is visible in another. Autosave runs in every tab that has the project open — two tabs editing the same project can each autosave; the trees are rebuilt from the chain when HEAD moves, so this is safe but produces interleaved Autosave commits. A leader election (or committing only from the visible tab) would tidy it.
