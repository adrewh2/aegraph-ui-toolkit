# Audit — the model, the nouns, and one search over everything

*A proposal. Status: draft for discussion · 14 September 2026. No code changed.*

*Read for this pass: the README and all fifteen in-app docs pages; `core/entity` (types, categories, store, registry), `core/graph` (filter, layouts, engines, rendering, scene, projection, project, plot, pipeline, budget), `core/projects`, `core/exchange` (ae, atlas, chatgpt, rdf, graph formats); the sidebar, Dashboard, Entities/Resources browser, Ontology, Insights, Analytics, Datasets, Projects pages; the 76-tool manifest; the earlier audit (`docs/audit-2026-09-13.md`) and the two standing proposals (`navigation.md`, `projects.md`). Everything here builds on those rather than repeating them; where an item was already raised there, it is cited.*

---

## 0. What this product is

Stated in one sentence, from the design notes and the code as it now stands:

> **aegraph is a local-first information model — one entity primitive that holds sources, what they are about, and how they are viewed — with an analysis engine over it, applications brought to each kind of source, and an agent layer that can do everything a person can.**

Four strata, each depending only on the one below:

| Stratum | What lives there | Where in the code | Maturity |
| --- | --- | --- | --- |
| **Model** | entity / relationship / selector / tag / type / category; the Library; projects as marks; the `.ae.json` exchange format | `core/entity`, `core/projects`, `core/exchange` | Solid. Specified, validated, benchmarked to 600k entities. |
| **Engine** | filter → layout → style → analysis pipeline; values & selectors; metrics; the five Insights analyses; placement; plots; layout engines; the script sandboxes | `core/graph`, `src/analysis`, `src/scripting` | Strong and still growing fast; the most differentiated part. |
| **Views** | Entities browser, media apps (documents, diagrams, images, video, audio, maps, conversations), Graph Explorer 2D/3D, Display Scene, Insights, Analytics (charts + scripts), Workstation panes, Dashboard | `features/*` | Broad; the seams between them are where the inconsistencies live (§3, §6). |
| **Agents** | in-app assistant (API key) and the Claude Code bridge (MCP) over one tool manifest; semantic ranking; `roots_match`-style intent tools | `features/assistant`, `mcp/` | Unusually complete; parity with the UI is the design rule and mostly holds. |

The goal that binds them — the phrase in the notes is *bring the applications to the information* — is what the resources/knowledge question is really about (§4).

---

## 1. Capability inventory (what exists, in one screen)

- **Sources**: documents (markdown, text, PDF; folders), diagrams (DOT/Mermaid/Excalidraw, both directions), images (regions), videos (moments, spans, boxes, stills), audio (Spotify moments/ranges), maps (locations/paths/areas, KML/GeoJSON), webpages, notes, ChatGPT conversations, atlas segments. Each with an app, an annotator, and a tool family.
- **Knowledge**: any type; emergent vocabulary via `schema:type`; the Ontology page (type × relationship × type network); properties with kinds; tags with namespaces and colours.
- **Graph Explorer**: filters (types, relationship types, tags incl/excl, text, roots+depth or `roots_match`, degree, k-core, components, cap), the view budget gate, ten built-in layouts plus seven on-demand engines, worker layouts, Gephi-style style channels, colour by type or tag namespace, selection tools, paths, physics, placement layouts, position overlays, scenes, a detail pane with a Nodes table, 2D ↔ 3D hand-off.
- **Analysis**: metrics (Stats tab / `graph_metrics`), Insights (five ranked analyses with visuals), Analytics (Plotly charts + JS/Python/visual scripts), the export-as-project iteration loop.
- **Organisation**: Library + projects (marks, includes, bundles, per-project UI state), workstations (split panes, presets), tabbed hosts for Entities / Graph / Analytics.
- **Exchange**: `.ae.json/.jsonl/.csv`, GEXF/GraphML/cyjs/Gephi CSV, DOT/Mermaid/Excalidraw, RDF/N-Triples with a mapping wizard, PNG/SVG, plus a JSON Schema and validator.
- **Agents**: 76 tools; app context per turn; semantic ranking (model / local embeddings / lexical); headless driver and smoke suites over the bridge.

That is a lot of product. The gaps are not missing features; they are the places where two good ideas meet without a rule (§3, §6).

---

## 2. The nouns — a glossary as it should read

Terminology is where the audit found the most friction. Below, the recommended term first, then every name the code or UI currently uses for the same thing, then where the collision shows. Deciding these is the single highest-leverage act available; nearly every other item follows from it.

| Recommended | Also called today | Meaning | Collision |
| --- | --- | --- | --- |
| **Library** | workspace (identifiers only now), "everything", Datasets page's implicit target | The one store: everything this browser knows. | Has no page of its own; "Library" appears as a switcher mode and a sidebar icon label but not as a place. |
| **Project** | *two things*: the named scope (marks, `isProjectEntity`) and the pipeline's exported view (`members[]`, `isProject`) | A named scope over the Library. | Audit L10 is still open: two shapes share one type, one Dashboard tile, one word. The PipelineBar's Dataset menu lists only exported views; the switcher only scopes. |
| **Source** (category `resource`) | resource, artifact, media, "the apps" | An entity with a *body* you open in an app: text, pixels, frames, audio, geometry, messages. | The word "resource" is fine internally; to a user it is a web-dev term. Note §4 argues the category is right and only its *criterion* is unstated. |
| **Knowledge** (category `knowledge`) | entities (sidebar), domain entities, instances, "what the data is about" | An entity with no body — a referent: person, topic, claim, location. | The sidebar item is **Entities**, which is also the name of the primitive that everything is. Navigation proposal §3 settles this; it is undecided. |
| **View** (category `project` in code, `graph` before that) | graph scene, scene, projection, layout, rendering/style, filter, analysis, plot, workstation, script, `view` (a legacy type still registered) | A saved way of looking at data. | The *category* is named `project` and its label is "Project" — so the Entities rail says "Project 4" for four saved views, and the README still says `graph`. A category should not carry the name of one of its members. |
| **Scene** | *two types*: `scene` ("Graph scene": filter + layout + style, opens in Graph Explorer) and `projection` (labelled "Scene": diagram geometry, opens in Display Scene) | One saved picture. | Two entity types both labelled scene, opening in different pages, listed as "Graph scenes 1 · Scenes 0" side by side in the rail. |
| **Analysis** | Stats tab (metrics), `analysis` entity (saved metric columns), **Insights** page (findings), **Analytics** page (charts + scripts), `analyze` tool, `graph_metrics` tool | Computing something about the data. | Three sidebar-level surfaces and an entity type share three near-synonyms. A user cannot predict which door leads to PageRank. |
| **Explorer** | Graph Explorer (was Display Graph), Display Scene (was Projector), "the explorer" in docs and tools | The interactive graph view. | "Display" survives in one name and not the other. Display Scene also shows plots via a Scene \| Plot switch, so its name under-describes it. |
| **Preset** | preset (workstation templates), template (workstation seed layouts), saved (layouts), demo presets (`data/demo/presets.ts` = scenes + workstations) | A named, reusable arrangement. | Audit U10, still open. |
| **Ontology** | Ontology page, Types section (`?category=types`), Data model (`/model` → docs), `schema:type`, `define_entity_type`, Insights → "Ontology in use" | The vocabulary: types, relationship types, their hierarchy and usage. | Four entry points; the new Ontology page and the Insights analysis compute overlapping facts. |
| **Facet** | tag namespace (`domain:philosophy`), property (`data.facets`, `set_properties`), knowledge entity + relationship (`topic` entity, `on-topic` edge) | A dimension along which things are classified. | The atlas import writes the *same fact three ways* (§5). The explorer can partition by tag namespace but not by property; filters take tags but `open_entities` ranks tags and types; `graph_query` reads `data.*`. |
| **Finder** | sidebar search (→ `/entities?q=`), `search_entities`, `open_entities`, `graph_query`, `inspect`, EntityFinder in the detail pane, the table's quick search | Finding a thing by words. | Seven surfaces, no shared definition of "match", no single place a person goes to look for something (§5). |
| **Dataset** | Datasets page (sources & importers), the pipeline's Dataset stage (Library or a project), `load_dataset` tool, "the dataset" in Insights copy | Ambiguous between *a source you can load* and *the data currently in scope*. | The pipeline's stage should say *Library* / *Project*; the page should say *Sources*. |

Three decisions would resolve most rows: (1) name the category of saved things **View** and never "project"; (2) merge the two scene types under one word each — *Scene* for the explorer's composition, *Drawing* (or *Diagram scene*) for imported geometry — or fold `projection` into `scene` with a `kind`; (3) one word for computed things — **Analysis** for what is computed about a view (metrics, findings), **Charts & scripts** for the workbench — and retire "Analytics" as a page name or rename Insights to Analysis.

---

## 3. Organisation — where the seams show

**Three doors to the same table.** The sidebar offers *Entities* (everything, with a category rail), a *Resources* group (the apps, each with its own list), and *Ontology*. The navigation proposal's two-door layout (Resources · Knowledge) was written to fix exactly this and is undecided. The addition of the Ontology page since then makes the third door real: the Types section under Entities and the Ontology page now both answer "what types are there".

**Scope is hard.** Opening a project changes what `store.get`/`query` return for every reader. The last audit fixed six bugs that came from that (L1–L6) and the class remains: any code path that reads the store while a project is open sees a different world, and anything that clears and refills must remember to drop the scope. It also makes the search problem (§5) hard by construction: a scoped store *cannot* find a Library entity to add to the project without `store.library`, which only tools use. Recommendation in §5.3: make scope a facet, not a lens.

**Two hosts with two rules.** Entities, Graph Explorer and Analytics are tabbed pane hosts; Documents, Images, Videos, Audio, Maps, Diagrams are single pages with their own sidebars and Library tabs; Display Scene and Insights are single views. The tab-host pattern is the better one (rename, split, drag, per-tab state) and should become the rule for every list+detail page, with the media apps as views inside it (this is the "media apps become viewers only" option of navigation proposal §3).

**Presentation state in two places.** Explorer state, held positions, camera memory, workstation arrangement, projector's last scene, plot draft: per project in `localStorage`; scenes, layouts, workstations: entities. The projects proposal §3.4 wrote the rule (*arrangement* is per project and may be bundled; *preferences* are global) and audit P7 asked for it to be written into the docs. It still is not, and the media apps' keys are still global.

**Analysis in three places** (see the glossary row). Concretely: PageRank is computed by the Stats tab (view-scoped, cancellable, lent to styles), again by Insights → Key players (dataset-scoped, off-thread, its own worker package), and can be exported to entities by `write_to_entities`. *Corrected 16 Sep (`one-metrics-engine.md`): the kernels are one implementation — `src/analysis` calls `core/graph/metrics`; what is duplicated is the run, since neither side reuses the other's result, and the names.*

**Charts vs plots.** `plot` entities are shown in Display Scene; the Analytics page hosts *Charts* (the same Plotly builder as a pane view) and Scripts. One noun, two pages.

---

## 4. Resources and knowledge — how to think about it

You asked for help thinking, so here is the argument rather than only the answer.

### 4.1 The distinction that holds

Every attempt to split the primitive by *what the data is* (documents vs people) breaks on the first edge case (is a conversation data or a document? a segment? a map?). The split that holds is by *what opening it does*:

- A **source** has a body. Opening it brings an application: a reader, a player, an annotator, a map, a chat. The body is the truth; the fields describe it. Sources are *evidence*.
- A **knowledge entity** has no body. Opening it shows a record: fields and links. It exists because sources are *about* it. Knowledge entities are *referents*.
- A **view** has neither; it describes how to look at other entities. Opening it arranges a screen.
- **Vocabulary** describes types, and belongs to none of the above.

The test for a type, in one line: *when I open one, do I read/watch/edit something (source), look up something (knowledge), or see an arrangement (view)?* Annotations pass the first test (they carry a comment and anchor into a body — they are small sources bound to a place in a bigger one), which is why keeping them in `resource` is right, and why the navigation proposal's rule that the `annotates` edge is *structural* (hidden from the authored-relationships table by default) is the right fix for their double appearance.

Applied to the awkward cases:

| Type | Tier | Why |
| --- | --- | --- |
| conversation | source | Opens as a chat; the messages are the body. |
| segment (atlas) | source | It has an excerpt, a question, a summary — you read it. It is a *derived* source (cut from a conversation), which is worth marking (`derived-from`) but does not change its tier. |
| topic, domain, theme, persona, named entity, cluster, region | knowledge | Referents the segments are about. Clusters and regions are *computed* referents — see 4.3. |
| map | source | Opens in the Maps app; the tiles and layers are its body. |
| location, path, area | knowledge with geometry | They have coordinates but no body; the map is where they are *shown*, as a person is shown in a graph. |
| document folder | source (structural) | A container, not a referent; keep in Sources but out of "Documents" counts if it confuses. |
| claim, evidence | knowledge | Assertions are referents even when they quote a source; the quote is an annotation (source) that `supports` the claim. |
| project | view | It arranges *which data*, the way a scene arranges *how*. Keeping it out of Sources and Knowledge is right; the category should just not be *named* after it. |

### 4.2 Why the UI still feels muddled

Not because the categories are wrong, but because three things are missing:

1. **The criterion is unwritten.** `categories.ts` describes each category by example ("webpages, documents, annotations, videos, notes"). Write the test above into the category descriptions, the Ontology page and the type dialog, and the next imported type gets placed by a rule instead of a guess.
2. **The category is a rail entry, not a place.** In the Entities browser, Resources and Knowledge are two rows in the same rail as Relationships, Types and Tags — five things of three different kinds (a subset, a different table, a vocabulary). The navigation proposal's tab rows fix this and are still the right shape.
3. **Sources have apps but knowledge has none.** Open a document and you get the reader; open a person and you get a fields table. That asymmetry is what makes knowledge feel second-class and what makes people reach for the Entities page as a lowest common denominator. The remedy is not to flatten sources into records but to give knowledge its own app: the **record view** — an entity page that leads with what the sources say about it (the annotations and segments that mention it, grouped by source type), its neighbours as a small graph, and its facets — the "bring the application to the information" idea applied to referents. The detail pane's Nodes/Selected tabs and the new Ontology page are the beginnings of it.

### 4.3 One fact, three representations

The atlas import (and the pipeline it comes from) writes each facet as a tag (`topic:philosophy`), as a knowledge entity (`topic` "philosophy") with an `on-topic` relationship, and the segment's `data.facets`. That is how a filter by tag and the graph's topic nodes can count the same topic differently. It is convenient and it is a modelling inconsistency: three sources of truth that can drift, three ways to query, three answers to "how many things are about philosophy".

A rule, in the spirit of the design notes:

- A **tag** is a label with no identity of its own (`starred`, `year:2024`, `salience:3`). Namespaced tags are *enumerations* — a small closed set of values.
- A **knowledge entity** is anything that can itself have fields, links, description or annotations — anything you would want to open. Topics, domains, personas, named entities are entities; the relationship carries the fact.
- A **property** (`data.*`) is a value on the entity that is not shared identity: a count, a date, a score.

Under that rule the atlas would write open facets (topic, named entity) as entities only, closed facets (mode, register, stakes, salience, year, kind) as tags only, and stop duplicating. The explorer already partitions and filters by both; the missing piece is filtering by *relationship to a knowledge entity* as fluently as by tag (`roots_match` plus depth is the current way; a "linked to any of…" filter clause would make it first-class). Computed referents (cluster, region) are the same as any other entity but should be marked `derived: true` with the run that produced them, so a re-run can replace them.

---

## 5. One search over everything

### 5.1 What exists

Seven ways to look something up, none complete: the sidebar box (a redirect to the Entities table with `?q=`), each table's quick search (all columns, the visible set only), the detail pane's EntityFinder (labels, 12 hits), `search_entities` (substring over id/label/description/tags/data; `library: true` to escape the project), `open_entities` (semantic ranking of types and tags, then union), `graph_query` (selectors over the view or dataset), `inspect`. Text match is the same everywhere — a lowercased concatenation of label, description, type, tags and `JSON.stringify(data)` — which means a document's whole body is matched but never *shown* (no snippet), and a hit inside a 40-page document ranks like a hit in a label.

Semantic search (the local model) is reachable only through tools.

### 5.2 The design

**One Finder, not another table.** ⌘K opens a palette over any page; `/search?q=` is its full-page form. It is not a browser: the tables remain where you *browse*; the Finder is where you *look for*.

- **Query** is words; a mode toggle picks *text* (substring, instant) or *meaning* (local embeddings over labels+descriptions, opt-in download as today). A third mode, *ask*, hands the phrase to the assistant's `open_entities`-style intent ranking and shows what it would pick.
- **Scope is a chip, never a wall.** With a project open the chip reads `in Project X`; one click toggles `in Library`. Hits outside the scope are still listed, greyed, with *Add to project*. The Finder is the one place where the Library is always visible, because finding a thing you know exists is exactly when hiding it hurts most.
- **Results are grouped by tier**: Sources (with a snippet and the app icon), Knowledge (type, top facets, link count), Views (scene/layout/plot/workstation, with *Open in explorer*), Vocabulary (types, tags, properties). Within a group, ranking is label match › description › body; a body hit shows the matching passage, and opening it lands *at the passage* (the reader's find, the video's time) — the selector machinery already knows how.
- **Actions on a hit**: open (in its app / record view), show in table, add to graph (the explorer's `include`), add to project, copy id. Multi-select → *Open as a table* (today's `open_entities` pick) or *Show as a graph* (`roots_match`-style).
- **Facets on the side**: type, tag namespace, project, date — the same `Selector` grammar the tools use, so a Finder query is expressible as one selector and one tool call (`search` = selector + query + mode), and the assistant and the person use the same engine.

### 5.3 What makes it possible: scope as a facet

The Finder cannot be built well on a hard-scoped store: it would have to read `store.library` and re-implement the rules for what is "in" a project. The projects proposal already argued for membership as marks with a `byProject` index; the remaining step is to stop having the *store* switch worlds and instead pass `project` as a query facet from every scoped view. Concretely: `store.query({ project })` and `registry.forProject(id)`; the switcher sets the default facet the views pass; nothing else changes its answer based on global state. The audit's L1–L6 class of bugs disappears, `store.library` becomes unnecessary, and "Library + project" in one list is a query, not an architecture change.

This is the one recommendation in this document that is structural rather than editorial, and it is the one to do first.

### 5.4 Full text

Documents, conversations and segments carry their bodies in `data`; matching them is already O(N) over a cached string. Two additions make it a real full-text search without an index: rank body hits below field hits and return the passage; and for the local semantic mode, embed *passages* (paragraphs / messages) for sources and labels+descriptions for knowledge, cached per entity version as the embedder already does. An inverted index is a later optimisation, not a prerequisite — the measured 200 ms over 600k entities says so.

---

## 6. Critical gaps, ranked

**P0 — the model's promises the product does not yet keep**

1. **Scope as a lens** (§5.3): the source of the last audit's worst bugs and the blocker for a single search.
2. **Two projects** (L10): the pipeline's exported view and the named scope must become one thing (an exported view is a project whose members are marked, with provenance). Until then the word means different things in the Dataset menu and the switcher.
3. **Three answers to "what is this about"** (§4.3): tags, entities and properties for the same facet. Decide the rule; make the importers follow it.
4. **No record view for knowledge** (§4.2): the asymmetry that makes "resources vs knowledge" feel like a taxonomy problem when it is an application gap.

**P1 — coherence**

5. **Navigation decision** (navigation proposal §5, still open): two doors, tabs across the top, structural relationships folded. Plus the Ontology page's place beside the Types section.
6. **One analysis run, one name** (§3, corrected in `one-metrics-engine.md`): a shared result cache so Stats and Insights never recompute the same slice; a name that is not three near-synonyms.
7. **Scene × 2** (§2): one word per thing.
8. **Category `project` renamed View**; the legacy `view` type retired or repurposed.
9. **Per-project vs global UI state**: write the rule (audit P7) and apply it to the media apps.

**P2 — robustness and reach**

10. **Multi-tab** (L14): detect and go read-only or reload.
11. **Relationship-based filter clause** ("linked to any of…"), so knowledge facets are as filterable as tags.
12. **Bundles with assets**: images and audio as files in a container once bundles exceed tens of MB; the `format` field is the hook.
13. **Identity** (audit P5): a local profile or no name.
14. **View tests**: the smoke suites are the net; a CI job that runs them.
15. **The assistant's API key in the browser**: fine for one person; a proxy before anyone else.

---

## 7. Inconsistencies list (small, mechanical)

- README §Categories still documents the `graph` category and `/graph/layouts`; the code says `project` and the rail says "Project".
- `Graph scenes 1 · Scenes 0` in the Entities rail (two scene types).
- Display Scene's page shows scenes *and* plots; Analytics shows charts (the same plots) *and* scripts.
- "Datasets" page vs the pipeline's "Dataset" stage vs `load_dataset`.
- Entities → Types section vs Ontology page vs `/model` (redirects to docs) vs "Data model" in older copy.
- Workstation: templates / presets / saved.
- Tool names: `open_entities` (finds and opens a table), `search_entities` (finds), `graph_query` (finds in the view), `inspect` (finds and opens) — four verbs for looking; the Finder (§5) would let them share one engine and description.
- `graph_state` still returns a very large reply (styles, palettes, algorithms, value refs) on every call; a `fields` parameter or a `brief` flag would help every agent turn.
- The detail pane's "Nodes" tab and the explorer's toolbar "Table" button both mean "this view as a table", one inline and one in a new tab; keep both, but say so in the tooltip.
- `docs/audit-2026-09-13.md` items L10, L11, P4, P6, P7, U4–U8, U10 are still open; this document does not repeat them but they remain the backlog.

---

## 8. Sequence

Nothing here needs to happen at once, and none of it changes the file format.

1. **Decide the nouns** (§2, three decisions) — a morning; then rename in copy, docs, categories and tool descriptions in one pass.
2. **Scope as a facet** (§5.3) — the one structural change; unblocks the Finder and removes a bug class.
3. **Navigation** (navigation proposal, plus the Ontology page's place) — two doors, tabs, structural links folded.
4. **The Finder** (§5) — palette + page + `search` tool over one engine; semantic mode included.
5. **Record view for knowledge** (§4.2) — the app for referents.
6. **One fact once** (§4.3) — importer rule and a relationship filter clause.
7. **One analysis engine** (§3) — metrics computed once, two lenses.

Each step leaves the app working; each is a day or two except the Finder, which is a week done properly.
