# About aegraph

aegraph is a workbench for building and managing knowledge as a graph: the things you care about, what kind of thing each one is, how they relate, where the evidence lives, and what the graph looks like when you draw it. It is four things at once, over one store of data:

1. **An entity management system** — every document, web page, image, video, person, concept, claim, chart and saved view is an entity you can browse in a table, open, tag, annotate and link.
2. **An ontology builder** — the types, their properties, their parents and the relationship vocabulary are themselves entities, defined in the data, so a dataset carries its own vocabulary and you shape it while you work rather than before.
3. **A graph and analysis workbench** — the same entities drawn in 2D and 3D through a fixed pipeline (dataset → filter → layout → style → analysis → export), charted, analysed for what stands out, and kept as claims.
4. **A tool surface for people and agents** — everything above is reachable through the UI, through an in-app assistant, and through MCP from Claude Code, using one tool set.

It runs in the browser, stores everything locally (IndexedDB), and exchanges data as one open file format, `.ae.json`.

**This edition, aegraph-ui-toolkit, is a modified public version of the private repository aegraph-ui** (the app behind aegraph.dev): the same app with no accounts and no server — no sign-in, no allow list, no server functions — and the assistant as Claude Code over MCP or your own API key. Copyright 2026 Andrew Han, under the Apache License 2.0.

## The idea in one paragraph

Most knowledge tools make you choose: a database with a fixed schema, a wiki with no structure, or an ontology editor that wants the universe defined before the first fact goes in. aegraph starts from a *deliberately small model* — an entity with a type, a label, tags, free-form data and provenance; a relationship that is an entity with a source and a target — and lets structure emerge: anything can be added untyped, then tagged, then typed, then given declared properties, then constrained. The ontology sits *above* the store as a semantic contract, not inside it as a table layout, so the application never has to know your domain in advance: it knows how to read a definition of Person, not what a Person is.

## The model

Five primitives cover everything (see the live [Data model](/docs/model) page for what this workspace actually holds):

| Primitive | What it is |
| --- | --- |
| **Entity** | `id`, `type`, `label`, `tags[]`, `data{}`, `meta` — plain data, no classes. |
| **Relationship** | An entity with a `source` and a `target`. Typed, tagged, described, annotated like anything else; it has identity, so facts can be talked about. |
| **Ref + Selector** | Address a whole entity or a region inside one — a text quote, a character range, a box on an image, a time span — so annotations point at exactly the passage without minting a new entity for it. |
| **Tag** | A loose classification: a flat string, many per entity, with optional colour and description kept beside the graph. |
| **Type** | Structural identity: one string per entity. A definition (a `schema:type` entity) adds a label, colour, parent, category, declared properties and their kinds. Undefined types still work everywhere. |

The three are kept distinct on purpose — *type* says what a thing is, *tag* says how you are filing it, *property* is data on it — and a thing can move along the spectrum from unstructured to formally described without migration.

`meta` carries `createdAt`, `updatedAt`, `accessedAt` and `source` (`user`, `assistant`, `import:…`, an extractor's name) — the beginning of provenance on every entity and every relationship.

### Types are entities

`Person` is not just a string on entities; it is an addressable thing: `type:person`, of type `schema:type`, with a label, description, colour, a `parent` (multiple inheritance is not yet supported), a category, and `properties` that become typed columns and inspector rows for every entity of that type and its subtypes. Relationship vocabulary (`worksAt`, `supports`, `member-of`) is resolved the same way. Because definitions are entities they export with the data, are edited with the same tools, and are visible to the assistant.

### Categories

A **category** is a property of a type, never of an entity, and says how the type's data is used: `resource` (things with content of their own — documents, pages, media), `knowledge` (things you assert about the world — people, organisations, concepts, claims), `project` (presentation state stored as entities — filters, layouts, styles, scenes, charts, scripts, workstations), and `schema` (the type definitions). Presentation state being entities is what lets a saved view travel with the data and be addressed by an agent.

### Media applets: every kind of material, one system

Knowledge does not arrive as a graph. It arrives as a document someone wrote, a page they found, a diagram on a whiteboard, a photograph, a recorded talk, a podcast, a place on a map, a chat transcript. Most tools handle one of these well and treat the rest as attachments. aegraph treats each as a **first-class applet**: a viewer and editor purpose-built for that medium, in which the medium stays whole and readable, and from which meaning flows into the entity system.

| Applet | The medium | What it does |
| --- | --- | --- |
| **Documents** | Markdown and plain text, folders | A rich editor with annotation of exact passages; folders are documents too |
| **Web pages** | Any URL | Framed, annotated, and captured — the page becomes a resource with its passages addressable |
| **Diagrams** | Graphviz, Mermaid, Excalidraw | Parsed, rendered, and converted in both directions: a diagram becomes entities and relationships, and a set of entities becomes a diagram, with the geometry kept as a scene |
| **Images** | Uploads and URLs | Regions drawn on the picture become annotations in original-pixel coordinates |
| **Videos** | YouTube | Moments, spans and frame regions, with stills captured from the player |
| **Audio** | Spotify tracks, albums, episodes | Moments and time ranges on a timeline |
| **Maps** | Places, paths, areas; Google Maps links; KML and GeoJSON | Locations and notes at a point and a time |
| **Conversations** | ChatGPT exports | Transcripts as resources, segmented and linked to what they discuss |

Two directions run through every applet.

**Outward — from the ontology into media.** Entities and relationships can be drawn as a diagram, arranged in a graph scene, charted, laid out on a map, or published as a page. The medium is generated from the model, so it is always current and always traceable back to the entities it shows.

**Inward — from media into the ontology.** External material is brought in and kept intact — the article, the talk, the whiteboard photo — while annotations attach structured meaning to precise regions of it: this phrase names a person, this box is the logo, this minute is where the claim is made. Those annotations link to entities and relationships, so the raw material, the evidence and the assertions built on it live in one graph and are navigable from any direction.

The chain is *raw material → annotations → entities → relationships → ontology*, and every step is inspectable. This is why aegraph can serve as the one place where a body of work is consolidated: the sources are here, whole; the knowledge extracted from them is here, typed and linked; the analyses and the pictures made from that knowledge are here, as entities; and the assistant sees all of it at once. Nothing has to be flattened into triples to participate, and nothing has to be left outside the system because it is the wrong shape.

## What is built

- **Entities** — the table of everything by category, type, tag and text; the inspector with fields, annotations, relationships, JSON and validation issues; bulk property edits; context menus that lead to related entities, graphs, charts, projects and the assistant.
- **Ontology** — the **Schema** reference (every type the app knows, with entities or without, its properties declared, inherited or only observed; every relationship type with the pairs of types it connects and the cardinality each pair shows; downloadable as JSON), the schema **Network** (types as nodes, relationship patterns as weighted links, every type→relationship→type triple), a per-type page with its properties, relationships, tags and instances, the tag matrix (`list_tags {matrix: true}` over MCP), and the **Claims** tab. The **Types** table recategorises, re-parents, recolours and adds properties to any type.
- **Unigraph** — the graph explorer, drawn by one engine in 2D and 3D (WebGPU with a WebGL2 fallback, a flat or an orbit camera over the same picture, built for a million nodes: packed arrays, bitset selection, semantic zoom, a benchmark suite); filters, ten layouts, Gephi-style style channels, metrics (degree variants, PageRank, betweenness, closeness, HITS, clustering, components, Louvain), all saved as entities and composed into scenes; several sessions as tabs; large-graph budgets and a worker for heavy layouts. **Slides** over it: decks of slides made from the data hang at fixed places above the 3D picture, each beaming down to what it shows — the readable projections of a web too dense to read whole, stepped through like a presentation, a scene per deck over the same web. Slides can be **composed** of reusable blocks — flows, stats, lists, timelines, in rows and columns — whose boxes are bound to entities, and in 3D the blocks hang as plates between the web and the slides, a block shared by two slides one plate with two lines up to it. And a deck can be told from a **story** — the directed outline of a document, chapters and points each citing what they draw on — so the 3D view stacks the concerns apart: the web, the story's directed path, each slide's blueprint of outer and inner rectangles, the finished decks.
- **Insights on selected text** — right-click words anywhere you read for the entities they name, the tags they match and the entities that mention them (`text_insights` over MCP).
- **Insights** — five analyses that return ranked findings with a visual each; findings become **claims** with evidence, and communities become named entities.
- **Charts, Scripts and Datasets** — charts over entity fields and lent metrics without code; sandboxed JavaScript or Python over the dataset for everything else, with a typed API, completion and snapshots; a saved script put to use is a subtype of `script` — a filter script Unigraph applies, a constraint script the audit judges, a scene script the Scenes page shows; the tables scripts return kept as **dataset** entities, edited in a grid on the Datasets page that moves like a spreadsheet's (the arrows leave a cell at the edge of its text), refreshed by the script's next run, in and out as CSV, read from CSV, TSV, delimited text, Excel and Parquet files attached to a chat — the analytics flow is scene → script → dataset → chart; a dataset counts entities by type, tag or field, and its columns are value references (`dataset:<id>.<column>`) a chart, a filter or a Unigraph colour reads. Saved scenes and charts are listed as galleries of pictures, drawn from the entity itself so those made over MCP or headlessly have one too.
- **Projects** — named scopes over one Library, bundled as `.ae.json` / `.aeb`, templated, **published** as a self-contained read-only web page, and **versioned**: commits with a message (or autosave), unsaved changes as a property-by-property diff, a history to walk and restore, over MCP as well.
- **Constraints** — rules every write must satisfy, kept as entities in the ontology: required and unique properties, what a relationship may join and how many, JavaScript checks; an audit over what is already there; violations shown where they happen.
- **Chats** — every conversation with the assistant is an entity in the project, and a page of its own: the chat beside its artifacts — the documents, diagrams, maps, scenes and entities it made — each open as a tab (Unigraph included), listed in the chat's record so they outlast it. Images, documents and data files — CSV, TSV, Excel, Parquet — dropped, pasted or picked into a chat are added to the project as they are sent, a table as a dataset.
- **Resources** — documents (a rich editor, PDFs, folders), web pages, images, YouTube videos, Spotify audio (and a whole Spotify library as a graph), ChatGPT conversations, diagrams (Graphviz, Mermaid, Excalidraw, round-tripped to and from the graph) — each with annotation of exact places in it.
- **Maps and the globe** — locations, paths and areas (and their subtypes) on a map with a timeline; the same on a 3D globe with thousands of tracks played through time; Wikipedia photos and summaries on places; KML and GeoJSON in and out; table layouts a project brings with it.
- **Exchange** — `.ae.json` (specified by a JSON Schema and a validator), JSONL, CSV, graph formats, RDF/N-Triples, Apache Parquet (points and links tables — Cosmograph's large maps), ChatGPT exports, diagram files.
- **Workstation** — split panes hosting any view as tabs, per-tab routers, saved arrangements.
- **Assistant and MCP** — one tool set (about a hundred tools) used by the in-app assistant and by Claude Code through a local bridge; every message carries what is on screen, and every context menu has *Ask about this*. It reads the web with `web_fetch` — a page, its scripts, an API, a data file's type and size — asking before each new host, so a link pasted into a chat can be followed to the data behind it. It answers through your own Claude Code over the bridge, or, on a deployed copy, with an Anthropic API key of your own — there are no accounts.
- **⌘K** — one box for entities by name or by the text inside them (with the line that matched), views, projects, findings, tags, types, the docs and actions; the full result set one row away in the Entities table.
- **Voice** — talk to the assistant: dictation of any length, transcribed with the app's own vocabulary, and a voice that answers.
- **Settings and this browser** — from the foot of the sidebar: **Third-party services**, one switch that turns off everything leaving your machine (offline mode), and **Developer tools**, which shows the tools for working on aegraph itself, such as the GPU view's benchmark; and **This browser**, which stashes, restores and clears everything aegraph keeps in the browser.
- **Documentation** — these pages, searchable in the app and readable by the assistant, with a tool reference generated from the live manifest.

## Where it is going

The direction is to make the ontology a first-class, managed artefact rather than a description that happens to be true of the data: relationship schemas (domain, range, cardinality, inverse), multiple inheritance, constraints with severity levels, an ontology linter, inference with explanations, assertions with provenance and confidence so several sources can disagree without corrupting the graph, entity resolution (aliases, external ids), versioned ontologies with previewable migrations, schema-change proposals from agents that a person accepts or rejects, and ontology-aware queries. Each of these builds on primitives that already exist — types as entities, relationships with identity, `meta.source`, the validator, the registry — which is the point of having kept the model small. The [Ontology roadmap](/docs/roadmap) lays the gaps out in order.

Read on: [A working session](/docs/workflow) for the day-to-day, [Data model](/docs/model) for what this workspace holds, [Unigraph](/docs/explorer) and [The pipeline](/docs/pipeline) for the graph, [Projects](/docs/projects) for scopes and bundles, [Assistant & MCP](/docs/assistant) for the tools, [Privacy & security](/docs/privacy) for where your work lives and what reaches the network.
