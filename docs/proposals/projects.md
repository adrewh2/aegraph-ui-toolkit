# Projects in aegraph-ui

*A proposal. Status: draft for discussion · September 2026.*

## TL;DR

Three nouns, each doing one job:

| Noun | What it is | Where it lives |
| --- | --- | --- |
| **Library** | Everything this browser knows: every entity, relationship, tag, type definition. One store, as today. | IndexedDB (`aegraph`) |
| **Project** | A *named scope over the Library*: a set of entities you are working with, plus the presentation state built on them (scenes, layouts, workstations, projections). An entity can be in any number of projects. Loading a project scopes the UI to it. | An entity of type `project` + a membership mark on each member (`meta.projects`) |
| **Bundle** | A *file* that carries a project (or the whole Library) out of one browser and into another: the members, their relationships, their presentation entities, tag metadata, type definitions, and the UI state needed to reopen it on the same screen. | `.aegraph.json` (the existing `aegraph/v1` document, extended additively) |

Resources are **not** duplicated: they live once in the Library and are *referenced* by projects. Projects can reference other projects two ways — **derived from** (the pipeline's sub-project chain, which already exists) and **includes** (composition). "Save the full state and load it back" is a **Bundle** whose scope is the whole Library.

The graph explorer already has the seed of this: its Dataset stage is either the workspace or a loaded `project`. This proposal makes that idea the organising principle of the whole app instead of a feature of one page.

---

## 1. The problem

What exists today:

- One `EntityStore`, persisted in one IndexedDB database. Resources (documents, images, videos, diagrams, conversations…), knowledge (people, concepts, claims…), presentation state (filters, layouts, renderings, analyses, scenes, workstations, projections) and the ontology (`schema:type`) all live in it, side by side.
- The Datasets page loads a demo, a generated graph, or a file — with **Replace workspace** (wipe everything first) or **Merge**. Export writes the whole store as an `aegraph/v1` document.
- Some state lives outside the store, in `localStorage`: the explorer's filter/layout/style/selection, held positions, the workstation arrangement, the assistant session, AI settings, camera memory.
- The pipeline's `project` entity (`members`, materialised metric `values`, `parentProjectId`, filter/layout/style/analysis ids) is a subset of the workspace that the explorer can load as its Dataset stage.

What is confusing, concretely:

1. **"Load a dataset" is destructive or muddling.** Loading the Knowledge Infrastructure demo after a ChatGPT export means either wiping the export or mixing 100 conversations into a literature graph with no way to tell them apart later. There is no notion of "the ChatGPT stuff" as a thing.
2. **There is no unit of work to save.** A scene saves a graph arrangement; a workstation saves panes; but "the state I was in" — this dataset, that workstation, those scenes, this document open — has no name and no file.
3. **Export is all-or-nothing.** You cannot hand someone "the claims and their evidence, with the two scenes that show them" without giving them everything.
4. **Two meanings of "project" are about to collide**: the pipeline's exported view, and the thing the user means by "my project".

The question underneath all four: *when I have several bodies of work, are the resources shared or copied, and what is the thing I open, save and send?*

## 2. Principles this proposal is derived from

These are aegraph's own design commitments, applied to the question. Each decision below cites the principle it follows.

- **P1 · Addressability.** Every entity has one id and is referenced, never copied. A highlight points at a document; a scene points at a layout. Projects should point at entities the same way.
- **P2 · Model / display separation.** Presentation state is stored as entities (`layout`, `rendering`, `scene`, `workstation`) so it is addressable, taggable and exportable. A project is presentation-level too — *which things I am looking at* — so it should be an entity, not a hidden container.
- **P3 · Local-first, one store.** The persistence layer (paged bulk writes, overlay, tombstones) was built and measured for one large store. Scoping should be a cheap index over that store, not a second store.
- **P4 · Types, tags and categories are properties of things, not places.** Category decides where a type is *browsed*; tags are flat many-to-many. Project membership is the same kind of fact: many-to-many, carried by the entity.
- **P5 · Deterministic ids make imports idempotent.** The demo (`ki-…`), ChatGPT (`chatgpt-<id>`), diagram exports (`dg-<hash>-n-…`) and graph imports already mint stable ids, so re-importing updates instead of duplicating. Bundles should lean on this rather than invent a second identity scheme.
- **P6 · Performance is a stated priority.** Nothing here may add per-frame or per-render work; membership checks must be set lookups.

## 3. The model

### 3.1 Library — one global store

The Library is the store as it exists today, renamed in the UI so the concept has a name. All entities live here exactly once. The Library is not a project: it is the space projects are cut from. A user who never creates a project sees no difference from today; the implicit project is "the Library".

*Why one Library rather than one store per project:* P3 (the persistence work is per-store and already tuned), P1 (cross-project references only work if ids are global), and the practical fact that resources are big — a video's annotations, a 40-page document's body, an image's data URL — and copying them per project multiplies storage and makes "the same document in two projects" two documents that drift.

### 3.2 Project — a named scope

A **project** is an entity (`type: 'project'`, graph category, already registered) that names a set of members and carries the presentation state built on them.

```ts
interface ProjectData extends EntityData {
  // ── Scope ─────────────────────────────────────────────────────────
  /** Projects whose members are also in scope here (composition). Cycles rejected. */
  includes?: EntityId[]
  // ── Provenance (the pipeline's sub-project chain, unchanged) ─────
  parentProjectId?: EntityId
  filterId?: EntityId; layoutId?: EntityId; renderingId?: EntityId; analysisId?: EntityId
  /** Metric columns exported with a sub-project, readable as data.<metric> while it is loaded. */
  values?: Record<EntityId, Record<string, number>>
  // ── What to show when it opens ────────────────────────────────────
  home?: { route?: string; workstationId?: EntityId; sceneId?: EntityId }
  // ── Bookkeeping ───────────────────────────────────────────────────
  summary?: { nodes: number; edges: number; byCategory: Record<string, number>; metrics?: string[] }
  archived?: boolean
}
```

**Membership is a mark on the member, not a list on the project:**

```ts
interface EntityMeta {
  …
  /** Projects this entity belongs to. Absent = Library only. */
  projects?: EntityId[]
}
```

The store keeps a `byProject: Map<EntityId, Set<EntityId>>` index next to `byType` and `byTag`, maintained on upsert/remove like the others; `store.query()` gains `project?: EntityId` and every scoped page passes it.

*Why a mark on the entity rather than a list on the project (P4, P6):* the pipeline's current `members: EntityId[]` works for a few hundred nodes but a 300k-entity project would be a 10 MB array rewritten on every add, and it is one JSON record — exactly the shape the paged persistence was designed to avoid. Marks scale like tags do (an index, O(1) per check), travel with the entity when it is exported, and make "which projects is this in?" a field read instead of a scan. Relationships were also considered for membership and rejected (§5.3).

**What is in a project.** Anything: resources, knowledge, relationships, and presentation entities (scenes, layouts, filters, renderings, analyses, workstations, projections, diagrams). A presentation entity may reference an entity in another project — references are global (P1) — the bundle exporter follows such references (§3.3) so a bundle is self-contained.

**How things get in:**

- *Created while a project is active* → marked with that project. This is the common case and needs no UI: open the ChatGPT project, annotate a conversation, the annotation is in the project.
- *Imported* → the import creates (or updates) a project for the source and marks everything it loaded. "Load the Knowledge Infrastructure demo" becomes "create project *Knowledge Infrastructure* with 229 entities" — and the ChatGPT project stays intact beside it. Re-importing the same source updates the same project (P5).
- *Explicitly* → **Add to project…** on any entity, selection, or search result (multi-membership), and **Remove from project** (which never deletes the entity).
- *By inclusion* → `includes` pulls another project's members into scope without marking them (§3.2.1).
- *By derivation* → the pipeline's **Export as project** marks the exported view's entities with the new sub-project and records `parentProjectId` (this already exists; it just gains marks).

**Scope resolution.** `scopeOf(project) = byProject[project] ∪ ⋃ scopeOf(includes)`, memoised per store version. The explorer's Dataset stage, the Entities table, the resource lists and the assistant's `search_entities` all take this set. Relationships are in scope when both endpoints are (the rule `datasetGraph` already applies).

#### 3.2.1 Projects referencing projects

Two relations, because they answer different questions:

| Relation | Direction | Question it answers | Effect on scope |
| --- | --- | --- | --- |
| `parentProjectId` (derived from) | child → parent | *Where did this come from?* The pipeline's iteration chain: *Workspace ▸ Ranked ▸ Ranked · communities*. | None — the child has its own members (a subset, marked at export). |
| `includes` (composition) | container → part | *What is this made of?* A "Thesis" project that includes "Literature", "Interviews" and "Figures". | Union — the part's members are in the container's scope, without being copied or re-marked. |

Both are optional; most projects use neither. Cycles in `includes` are rejected at write time. A project that includes another is not affected when the included project archives; it is affected when it is deleted (the members drop out of scope unless they were also marked directly).

*Why not a single "parent" tree:* folders force one hierarchy; the same literature belongs to the thesis and to the reading group. Composition (P4: many-to-many) fits; derivation is a different fact and should not be conflated with it.

### 3.3 Bundle — the file

A bundle is the existing `aegraph/v1` document with two additive, optional sections:

```jsonc
{
  "format": "aegraph/v1",
  "entities": [ /* members, their relationships, presentation entities, the project entity itself, referenced schema:type entities */ ],
  "tags": [ /* tag metadata for tags used inside */ ],
  "project": "ki-project",              // which entity in `entities` is the project this file *is* (absent for a Library snapshot)
  "state": {                            // optional: how to reopen it on the same screen
    "route": "/graph/2d?scene=ki-scene-overview",
    "workstationId": "ki-ws-research",
    "explorer": { /* the explorer's persisted state: filter, layout, style, positions, selection, camera */ },
    "panes":    { /* per-page state the workstation keeps: open document, playhead, zoom */ }
  }
}
```

Old files remain valid (no `project`, no `state` → import as a new project named after the file). Old readers ignore the new keys.

**Export closure.** A project bundle contains, computed once at export:

1. the members of the project (direct + included, flattened — the receiver may not have the included projects);
2. relationships among them;
3. presentation entities marked with the project, **plus** any entity a presentation entity references by id (a scene's layout, a projection's diagram, a workstation tab's document) — followed transitively so a scene never opens onto missing parts;
4. `schema:type` entities for every type used (vocabulary travels with the data, as the demo already does);
5. tag metadata for every tag used;
6. the project entity, with `summary` refreshed;
7. optionally `state`.

A **Library snapshot** is the same file with everything, no `project`, and `state` describing the whole app (active project, workstation, explorer). This is "save the full state of aegraph-ui".

**Import semantics.** *Merge by id, then activate.* Every entity in the file is upserted; an entity that already exists in the Library is updated only if the file's `meta.updatedAt` is newer (otherwise kept, and counted as "already up to date"). The project entity is upserted and becomes the active project; its members get the mark. Nothing is ever wiped by an import. *Replace workspace* moves from the import dialog to the Library page as **Clear library…**, the destructive action it always was.

*Why merge-by-id is safe (P5):* ids in aegraph are either random UUIDs (never collide) or deterministic per source (collide only with themselves — the same paper, the same conversation, the same diagram node). The only real conflict is the same deterministic entity edited on two machines; "newer wins, older reported" is the right default for a local-first tool, and the report lets the user see it. A full three-way merge is a later problem and belongs with sync, not bundles.

*Why one JSON file, still:* it is what every importer and exporter, the MCP `import_graph` tool and the demo build script already speak. A zip container with an `assets/` folder (images and audio as files rather than data URLs, gzip per part) is the obvious next step once bundles regularly exceed tens of MB, and the `format` field is where that is announced.

### 3.4 App state that is not an entity

Today this lives in `localStorage` under fixed keys, so it cannot follow a project or be saved. The rule becomes: **UI state is keyed by project, and bundles may carry it.**

| State | Today | Proposed |
| --- | --- | --- |
| Explorer (filter, layout, style, selection, held positions, rule, camera) | `aegraph:explorer:v1` | `aegraph:explorer:<projectId>`; included in a bundle's `state.explorer`; a scene remains the *saved* form |
| Workstation arrangement | `aegraph:workstation:v1` + `workstation` entities | the current arrangement is a `workstation` entity marked with the project (auto-saved, unnamed until named); `project.home.workstationId` |
| Open document / media position / zoom | per-page keys | `state.panes` in bundles, keyed by pane |
| Assistant session, AI settings, bridge settings | global keys | stay global — they are about the user, not the work |

Switching projects swaps the explorer and workstation state with it, so two projects feel like two windows.

## 4. The questions, answered

**Do resources live in a global space and projects are a different thing?** Yes. The Library is global; a project is a scope over it. A resource is in the Library once and in zero or more projects.

**Does all the data get duplicated?** No. Projects are marks and references. The only copying is at the file boundary — a bundle *contains* its closure — and importing a bundle merges by id, so importing the same bundle twice, or two bundles that share a paper, yields one paper.

**Should projects reference other projects?** Yes, in two distinct ways: **derived from** (provenance — the pipeline's sub-project chain) and **includes** (composition — a project made of projects). Neither copies anything.

**How should the UI look?** A project switcher where the workspace name goes; every list scoped to the active project with a one-click **Library** toggle; a project page for what is inside, where it came from, and export; the Library page for projects, sources and storage. Mock-ups in §6.

**How do we save the full state and load it back, or load other ones?** *Save project…* writes a bundle with the closure and the screen state; *Save library snapshot…* writes everything. *Open bundle…* merges it in and activates it; nothing is lost. "Load in other ones" is the same action: the file becomes another project beside the ones you have.

## 5. Alternatives considered

### 5.1 One store per project (vaults)

Each project is its own IndexedDB database; switching swaps the store. This is Obsidian's and Logseq's model.

*Rejected because:* cross-project references are impossible (ids are per store) — a claim in one project cannot cite a paper in another without copying it; resources are duplicated and drift; the persistence layer, the search index and the type registry would need to be multiplied; and "the same document in two projects" — the case that motivates projects — is exactly what it cannot express. It also does not answer "save the full state": you would still need a bundle.

*Kept as a future escape hatch:* naming the IndexedDB database by a library id costs nothing now and allows "work" and "personal" libraries — or a 1M-entity benchmark library — later, without touching the project model.

### 5.2 Copy on add ("a project owns copies")

Adding an entity to a project clones it with a new id.

*Rejected because:* P1. Annotations, scenes and relationships would point at one of the copies; edits diverge; export would carry near-duplicates. It answers "isolation" at the cost of everything the entity model is for.

### 5.3 Membership as relationships (`in-project` edges)

Each membership is a relationship entity from member to project.

*Rejected because:* it doubles the relationship count for large projects, every graph view and degree count must learn to hide a whole relationship type, and the store already has a cheaper mechanism for many-to-many facts that are not domain facts — tags. Membership is tag-shaped (P4), so it gets a tag-shaped index.

### 5.4 Projects as folders (one tree)

A project is a folder that contains sub-folders.

*Rejected because:* one hierarchy cannot express the same material in two projects; composition (`includes`) gives the useful part of nesting without the exclusivity. Derivation (`parentProjectId`) is already a tree and stays one.

## 6. UI

### 6.1 Project switcher (sidebar header)

Where the sidebar today shows the footer avatar, the header gains the active project. It is the one control that answers "what am I looking at?".

```
┌──────────────────────────────┐
│ ▾ Knowledge Infrastructure   │  ← active project (click: menu)
│   229 entities · 7 scenes    │
├──────────────────────────────┤
│  Dashboard                   │
│  Workstation                 │
│  Entities                    │
│  Resources ▸                 │
│  Graph ▸                     │
│  …                           │
```

Menu (an illustrative mock-up: the names and counts are made up):

```
┌───────────────────────────────────────┐
│ ● Knowledge Infrastructure   229 · 7  │
│   Chat export (example)      100 · 1  │
│   Thesis (includes 2)        412 · 3  │
│   ─────────────────────────────────── │
│   Library (everything)       988      │
│   ─────────────────────────────────── │
│   New project…                        │
│   Open bundle…                        │
│   Save project…            ⌘S         │
│   Manage projects →                   │
└───────────────────────────────────────┘
```

Switching a project swaps scope everywhere, restores the project's `home` (its workstation or scene) and its explorer state.

### 6.2 Scoped pages with a Library toggle

Every list — Entities, Documents, Images, Videos, Audio, Diagrams, the graph's Dataset — shows the active project's scope by default. Each page's bar gets the same small control:

```
Entities   [ In project ▾ | Library ]     Search…     + New
```

Choosing **Library** shows everything with a faint *in project* chip on rows that are members, so "find it in the Library, add it to the project" is a two-click flow. Creating something on a page creates it in the active project.

### 6.3 Project page (`/project/:id`)

The project as a thing: what is in it, where it came from, and the actions.

```
Knowledge Infrastructure                         [Save project…] [Duplicate] [Archive]
A research group's working notes on connected knowledge.       tags: demo, literature

 ┌ Contents ───────────────────────────┐  ┌ Structure ─────────────────────────────┐
 │ Resources    16 documents · 21 web  │  │ Includes      —                        │
 │              6 images · 5 videos    │  │ Derived from  —                        │
 │ Knowledge    27 people · 31 concepts│  │ Sub-projects  Ranked (pagerank) →      │
 │              9 standards · 6 claims │  │ Home          Scene · Overview         │
 │ Graph        7 scenes · 7 layouts   │  │ Source        demo · seeded 2026-08-25 │
 │              6 filters · 2 styles   │  └────────────────────────────────────────┘
 │              4 workstations         │
 └─────────────────────────────────────┘
 Members ─────────────────────────────────────────── [In project | Library]  Search…
 (the Entities table, scoped)
```

### 6.4 Library page (replaces Datasets)

An illustrative mock-up; the names and counts are made up.

```
Library                                              988 entities · 1,204 relationships · 41 MB

Projects
  Knowledge Infrastructure   229   7 scenes   opened today        [Open] [Save…] [⋯]
  Chat export (example)      100   1 scene    opened yesterday     [Open] [Save…] [⋯]
  Thesis                     412   includes Knowledge…, Chat ex…   [Open] [Save…] [⋯]
  + New project      Open bundle…      Save library snapshot…

Sources                                 (each creates or updates a project)
  Demo workspaces: Knowledge Infrastructure · AcademicsKG
  Generate: [10k ▾]  Import file: drop .aegraph.json / .jsonl / .csv / .gexf / .graphml / .cyjs / .excalidraw / conversations.json

Storage
  IndexedDB 41 MB · 3 pages · overlay 212 · [Compact]      Clear library…  (danger)
```

### 6.5 Graph explorer

No new UI: the Dataset chip in the pipeline bar *is* the project switcher's twin. It shows the active project and its breadcrumb (`Thesis ▸ Ranked`) and offers the Library. Export as project keeps working and now marks members.

### 6.6 Everywhere else

- Row menus and the selection bar gain **Add to project…** (a picker with the projects, multi-select) and **Remove from project**.
- The inspector shows *In projects: Knowledge Infrastructure, Thesis* as chips.
- Deleting an entity that is in other projects warns: *Also in Thesis. Remove from this project instead?* — remove is the default action; delete stays one step further.
- Deleting a project offers two options, plainly worded: **Delete project only** (entities stay in the Library) and **Delete project and its exclusive entities** (those in no other project), with counts.

## 7. Changes by layer

| Layer | Change |
| --- | --- |
| `core/entity/types.ts` | `EntityMeta.projects?: EntityId[]` |
| `core/entity/store.ts` | `byProject` index; `query({ project })`; `projectsOf(id)`; `mark(ids, project)` / `unmark`; `scopeOf(project)` with `includes` resolution, memoised per version |
| `core/graph/types.tsx` | `ProjectData` gains `includes`, `home`, `archived`, `summary.byCategory`; `members` becomes derived (kept readable for old data, migrated to marks on load) |
| `core/exchange/formats.ts` | `AegraphDocument.project?`, `state?`; `closureOf(store, project)` for export; import returns `{ project, created, updated, upToDate, conflicts }` |
| `core/entity/persistence.ts` | unchanged on disk; DB name takes a library id (default `aegraph`) for the future |
| `app/providers.tsx` | `ActiveProjectContext` (id in `localStorage`, `aegraph:project`); state keys become `<key>:<projectId>` |
| `features/projects/` | switcher, page, picker, delete dialog |
| `features/datasets/` | becomes the Library page; every source creates/updates a project |
| Explorer | Dataset stage = active project by default; scenes keep `projectId` |
| Assistant / MCP | `project_list`, `project_open`, `project_create`, `project_add` / `project_remove`, `project_save` (bundle → download or inline), `project_import` (inline text), `get_app_context.project` |
| Docs | a *Projects* page in `/docs` |

Migration on first load: the existing Library becomes project-less (everything visible as "Library"); the pipeline's existing `project` entities get their `members` converted to marks. No data moves.

## 8. Worked behaviours

- **Two datasets side by side.** Load the demo → project *Knowledge Infrastructure*. Drop `conversations.json` → project *ChatGPT export*. Switch between them; each restores its own workstation and explorer. Neither is wiped.
- **A thesis out of both.** New project *Thesis*, includes both. Scope is the union; scenes made here are marked *Thesis*. Add three specific papers directly (marks) so they survive if an include is removed later.
- **Filter by PageRank** (unchanged): in *Thesis*, run PageRank, Export as project → *Thesis · ranked* (derived from Thesis, members marked, `values` carried). Filter on `data.pagerank`.
- **Send it to a colleague.** *Save project…* on *Thesis* → `thesis.aegraph.json`: union of the two included projects, the scenes, layouts, workstations, the type definitions, tag colours, and `state` pointing at the Overview scene. They *Open bundle…*; it merges (their Library may already have the demo — same ids, so nothing doubles) and opens on the same screen.
- **Save everything.** *Save library snapshot…* → one file with every entity and the app state. Open it on a new machine: identical Library, same active project, same panes.

## 9. Performance

- Membership check: one `Set.has` (P6). Scope sets are memoised per store version and per project; a 1M-entity Library with a 300k-member project costs one `Set` of 300k ids (~10 MB), built once per version change, not per render.
- Marks are stored on the entity, so persistence traffic on "add to project" is one overlay write per entity, batched for bulk adds (≥ 500 → page write, as today).
- Export closure is a single pass over the scope plus a reference walk over presentation entities (hundreds, not thousands).
- No per-frame work anywhere: the explorer already filters by a member set.

## 10. Rollout

**Phase 1 — Scopes (the model).** `meta.projects`, `byProject`, `scopeOf`, active project context, switcher, scoped pages with the Library toggle, imports create projects, Datasets → Library page. Existing behaviour is the "Library" case, so nothing breaks.

**Phase 2 — Bundles (the file).** Export closure with `project` and `state`; import merge-by-id with activation and a report; Library snapshot; `Open bundle…` everywhere a file can be dropped; MCP tools.

**Phase 3 — Structure (the relations).** `includes` with cycle checks and union scope; project page with Contents/Structure; delete dialogs with counts; per-project UI state; docs page.

**Later.** Zip bundles with an assets folder; multiple libraries; sync (where real conflict resolution belongs).

## 11. Open questions

1. Should an entity created in the **Library** view (no project active) be prompted for a project, or silently stay Library-only? *Proposed: stay Library-only; the empty-project state is legitimate.*
2. Should `includes` be transitive? *Proposed: yes, with cycle rejection — a thesis that includes a chapter that includes its figures should see the figures.*
3. Bundle `state` carries positions and camera; should it also carry unsaved (dirty) filter/style? *Proposed: yes — that is the point of "the state I was in"; the receiver sees them as dirty and may save them.*
