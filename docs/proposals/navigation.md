# Two doors, one model — navigation for aegraph-ui

*A proposal. Status: draft for discussion · September 2026.*

## TL;DR

- **Annotations are not double-counted in the data; they are double-shown in the UI.** Every annotation is one `annotation` entity (a resource — it carries the comment, type, tags) plus one `annotates` relationship (it carries the anchor: the selector). That is the right model — it is what lets a highlight be an object, be annotated in turn, and be an edge in the graph. What is wrong is that the Entities page headlines both facets side by side ("All entities 566 = 250 + 316", Resources 31, Relationships 31 `annotates`) as if they were peers. Fix the presentation, not the model: relationships stop counting as "entities" in the browser, and *structural* links (`annotates`, `contains`, `derived-from`) fold into a collapsed group in the Relationships table, so the list defaults to the links people authored.
- **Navigate by activity, not by taxonomy.** The data model has one primitive; the UI needs two doors, because people arrive with two intentions: *"open the thing I'm reading / watching / annotating"* and *"curate what the graph knows"*. The single Entities page merged those doors and hid the first one behind a rail row and a type facet. Go back to two top-level browsers — **Resources** (the Library, with resource types as first-class tabs, and the media apps underneath) and **Knowledge** (Entities · Relationships · Types · Tags) — built on the same table component, the same URL scheme and the same type registry, so "resources are entities" stays true in the code and in every cross-link.
- **Views are not data you browse; they are things you open.** Scenes, layouts, renderings, workstations and analyses (`graph` category) leave the browsers and stay where they are used: Graph → Layouts & views.

Everything below is layout on top of code that already exists (`EntityBrowser` takes a `category`; `TypesView`, `TagsView`, `CategoryRail`, the New menu and quick actions all survive). Estimated effort: two to three days, mostly re-routing and CSS.

---

## 1. What this product is trying to do

From the two design notes (*A General-Purpose Information Model* and *An Information Exchange Protocol*) and the code:

1. **One primitive.** The entity: id, type, tags, data, meta. A relationship is an entity that points at two `EntityRef`s (id + optional selector). Nodes and edges, documents and highlights, saved views and type definitions are all entities, so they export, import, tag and link the same way.
2. **Data is not the view.** Filters, layouts, renderings, scenes and workstations are entities too, but they are *presentation* — they describe how to look at data, they are not what the data is about.
3. **Bring the applications to the information.** Documents, diagrams, images, videos and audio each get a real app (reader, editor, player, annotator). The workstation lets you arrange those apps beside the graph, the table and the assistant over the same store.
4. **Annotation is a primitive, not an editor feature.** A highlight, a comment, a box on an image, a moment in a video is an object with a stable address (`annotates` + selector), so it can be browsed, tagged, linked and annotated in turn.
5. **Interspection.** Inspect, navigate, manipulate, analyse — the graph explorer, analyses, filters and layouts.

Points 1 and 3 pull in opposite directions in the UI. Point 1 says "everything is an entity, show one table". Point 3 says "a document is something you *read*, show me the reader". Both are right, and the current Entities page tried to satisfy point 1 at the expense of point 3. The user-facing consequence is exactly the complaint: resource tabs are hidden.

## 2. Annotations: when the relationship is created, and whether it's a double count

`createAnnotation(store, targetId, selector, init)` in `src/core/resources/annotations.ts` is the only writer, and everyone goes through it:

| Caller | Selector |
| --- | --- |
| Annotate dialog (Resources / Entities → New → Annotation) | text quote, region, time — by target type |
| Document editor (select text → annotate), `src/features/documents/documents.ts` | text (exact + prefix/suffix) |
| Image annotator | region (px) |
| Video / audio pickers | time (start, end, optional region) |
| Assistant tools `annotate_passage`, `annotate_image`, `annotate_video`, `annotate_audio` | as above |
| Demo data (`knowledgeInfra.ts`), synthetic generator (`exchange/generate.ts`), seed | as above |

Each call upserts **two** records in one batch: the `annotation` entity (type `annotation`, category resource; `data.comment`, `data.annotationType`, tags, label) and the `annotates` relationship (source = annotation, target = `{id, selector}`). Reading goes the other way: `annotationsOf(store, targetId)` walks incoming `annotates` edges. The Inspector's Annotations tab, the reader's highlights, the image boxes and the timeline markers are all views over that edge.

**Is that a double count?** No — the two records hold different information and neither can be dropped:

- Put the selector on the annotation entity instead (`data.target = {id, selector}`) and you lose: annotations as first-class graph edges (the explorer would have to synthesise them), annotations of annotations, and the "relationships are explicit, not hidden in application code" principle from the design note.
- Drop the annotation entity and keep only an edge with a comment on it, and you lose: tags, types, an id to link to, a card in the Library.

**But it is a double *show*.** Three places make the same object appear twice as if it were two things:

1. **"All entities" counts relationships.** 250 entities + 316 relationships = 566 is a number nobody has a use for; it exists because the rail treats relationships as a subset of one table. The count should be entities; relationships get their own count.
2. **The Relationships table lists `annotates` at the top of the type facet** next to `references`, `related`, `works-at`. The first group are *structural* — they follow mechanically from a resource operation (you annotated; you embedded; you derived). The second are *authored* — someone asserted them. Mixing them makes 31 `annotates` rows look like 31 facts about the domain.
3. **Resources → Annotations tab and Relationships → annotates** show the same 31 objects from two ends, with no hint that they are the same.

Proposed rule: a relationship type carries a flag `structural: true` (`annotates`, `contains`, `derived-from`; extensible via `schema:type`). The Relationships table hides structural types by default behind one collapsed group at the bottom of its type facet — *"Structural links · 47"* — with a toggle; the graph explorer is unchanged (it already filters by type, and annotation edges are exactly what you want to see there). The Annotations tab in the Inspector stays the primary way to see them, because that is where they mean something.

This reverses one earlier decision (relationships were added to "All" because you asked why they weren't). The reason to reverse it is that the question was a symptom of the page, not a real need: nobody wants a list where a person and a `works-at` edge are rows in the same table.

## 3. The navigation

### Sidebar

```
Dashboard
Workstation
──────────────
Resources                   → /resources        the Library: every resource, by type
    Documents               → /documents        the apps (unchanged)
    Diagrams                → /diagrams
    Images                  → /images
    Videos                  → /videos
    Audio                   → /audio
Knowledge                   → /knowledge        Entities · Relationships · Types · Tags
Graph
    2D view · 3D view · Projector · Layouts & views   (unchanged; saved views live here)
Build
    Playground · Datasets
Data model                  → /model            (+ "Browse everything" → /entities, the power-user table)
```

Two browsers, both one click from the sidebar, both with their kinds one click from the page. Nothing in the sidebar needs expanding to reach a resource type. `Entities` as a top-level item goes away; the unified table stays reachable at `/entities` for MCP, "Open in…" and the curious, linked from Data model, but it is no longer what the product leads with.

### Resources — the Library

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Resources                                                   [Export] [+ New ▾]│
│ What people read, watch, annotate and edit.                                  │
│                                                                              │
│ [All 120] [Documents 18] [Diagrams 6] [Images 22] [Videos 9] [Audio 7]       │
│ [Webpages 14] [Notes 13] [Annotations 31]                                    │
│ ┌──────────┬─────────────────────────────────────────────────────────────┐   │
│ │ Tags     │ ⌕ Filter…                        [Table ▾]  [+ Note] [+ Web] │   │
│ │  infra 9 │ ☐  Label                 Type      Tags        Updated      │   │
│ │  ...     │ ☐  Provenance primer     Document  infra       2 h ago      │   │
│ │ Sources  │ ☐  ...                                                      │   │
│ └──────────┴─────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Type is a row of tabs across the top**, not a rail entry. Eight resource types fit one row at desktop width; they wrap at narrow widths. Counts on the tabs. `?type=` in the URL, as today.
- **The rail is for filters** (tags, source, date), not for choosing which table you are looking at. That is the confusion the current rail creates: it mixes "subset of this table" (Resources, Knowledge) with "a different table" (Types, Tags).
- Card / list / table view switch, the quick actions per type (`+ Note`, `+ Webpage`, *From clipboard* for diagrams…), drag-multiselect, right-click *Open in Documents* / *Open in Knowledge* — all unchanged.
- A tab for a media type is the *table* of that type; the app is one click further (row → open, or sidebar child). *Documents* under Resources in the sidebar and the *Documents* tab in the Library are the same set of entities; the sidebar child opens the app, the tab opens the table. That duplication is deliberate and should be labelled: the app's Library tab links to *"All documents in Resources →"* and the Resources tab has *"Open the Documents app →"*.
- **Annotations are a resource type here.** Their table has Target and Selector columns (quote / box / 0:42–1:10), and the row opens the target at the anchor. This is the one place to list annotations as objects; the Knowledge → Relationships table hides their edges by default (§2).

### Knowledge

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Knowledge                                                   [Export] [+ New ▾]│
│ What the resources are about, and the vocabulary that describes it.          │
│                                                                              │
│ [Entities 98] [Relationships 240] [Types 34] [Tags 21]                       │
│ ┌──────────┬─────────────────────────────────────────────────────────────┐   │
│ │ Types    │ ⌕ Filter…                       [+ Person] [+ Org] [+ Entity]│   │
│ │  Person  │ ☐  Label            Type     Tags     Links   Updated       │   │
│ │  Org     │ ☐  Ada Lovelace     Person   pioneer  12      3 d ago       │   │
│ │  Concept │ ☐  ...                                                      │   │
│ │ Tags     │                                                             │   │
│ └──────────┴─────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Same frame as Resources: title, one-line subtitle, a row of segmented tabs, table with a filter rail. Someone who has used one page knows the other.
- **Entities** = knowledge category (people, orgs, concepts, claims; unregistered types land here). Rail = type tree (coloured), tags.
- **Relationships** = the authored links, Source / Type / Target columns, coloured relationship types in the rail, *Structural links* collapsed at the bottom (§2).
- **Types** = today's `TypesView` (entity types and relationship types, with category, parent, colour). **Tags** = today's `TagsView`. Both are "different tables", and being tabs rather than rail rows makes that honest.
- New menu: Entity, Relationship, Type, Tag — and nothing about webpages or PDFs; those belong to Resources' New menu. The current section-first ordering logic stays.
- A resource opened here (via *Open in Knowledge* on a document, say) shows as a node: its row plus its links. So "resources ⊂ entities" is still visible when you go looking for it.

### Naming: Knowledge vs Ontology

You suggested *Resources and Ontology*. I recommend **Knowledge** for the second door and here is the distinction: *ontology* is the vocabulary — types, relationship types, their hierarchy — and it is exactly the Types tab. People, organisations and claims are not ontology; they are the knowledge the ontology describes. Calling the whole page Ontology would make the Entities tab feel misplaced inside it (the same overload we are trying to escape, from the other side). If the name Knowledge has worn thin from the earlier round-trips, the alternatives that keep the meaning are *Graph data* (but "Graph" is taken by the explorer) or *Model* (which you set aside). It is a one-word change either way; the structure is the same.

### Where the third category goes

`graph` category entities (scene, layout, rendering, filter, analysis, workstation, projection) are removed from both browsers. They are reachable from Graph → *Layouts & views* (`GraphCollectionsView`, which already exists) and from the explorer's own pickers. They are still entities and still in `/entities` for anyone who wants the raw table.

### Cross-links (what keeps "one model" true)

| From | Action | Goes to |
| --- | --- | --- |
| Any resource row/card | *Open in Knowledge* | `/knowledge?sel=<id>` — the node and its links |
| Any knowledge entity that is a resource | *Open in Resources* / *Open in Documents* | the Library row / the app |
| Type in Knowledge → Types | *Show entities* | `/knowledge?type=…` or `/resources?type=…` by category |
| Tag anywhere | click | the browser that holds most of its entities, filtered (`bestCategory`, exists) |
| Annotation in Resources → Annotations | row open | the target at the anchor (reader/annotator/player) |
| Inspector → Annotations tab | unchanged | |
| Dashboard | resource counts by type → Resources tabs; entity/relationship counts → Knowledge tabs | |

`openInItems` becomes category-aware: one item, labelled by where the entity lives, instead of "Open in Entities".

## 4. What changes in code

Small, because the pieces exist:

1. **Routes** — `/resources[?type=&tag=&q=&sel=]` → `EntityBrowser category="resource"` with a `tabs` prop (type row) instead of `categorySwitch`; `/knowledge?tab=entities|relationships|types|tags` → a `KnowledgeView` that hosts `EntityBrowser category="knowledge"`, the relationships table (`view="relationships"` already exists), `TypesView`, `TagsView` under one frame. `/entities?category=…` keeps working (redirects for resource/knowledge/relationships/types/tags; the unified table for `all`).
2. **`CategoryRail`** retires; its counts move to the tab rows. `sectionFromParam` and `Section` shrink to the Knowledge tabs.
3. **Sidebar** — Entities item removed; Resources group `to: '/resources'`; Knowledge leaf added (`Network` or `Shapes` icon; the `Boxes` icon can move to Data model).
4. **Relationship registry** — `structural?: boolean` on type definitions; default true for `annotates`, `contains`, `derived-from`; the relationships table groups by it; `relationshipCount()` gains an `{ authored }` option for the tab count.
5. **New menus / quick actions** — split by browser (already data-driven via `newActionsByCategory`).
6. **`routes.ts` / `openIn.ts`** — `browserHref` picks `/resources` or `/knowledge` by category; `entityHref` for relationships → `/knowledge?tab=relationships&sel=`; schema → `/knowledge?tab=types&type=`.
7. **Tests** — the URL assertions in `routes`, `openIn`, assistant `navigate` tool, `EntitiesView` redirects.
8. **README** Browsing section, demo presets that link to `/entities?category=…`.

Nothing in the store, the exchange format, the explorer or the media apps changes.

## 5. Decisions I need from you

1. **Name of the second door**: Knowledge (recommended) · Ontology · Model.
2. **Structural links hidden by default** in Knowledge → Relationships, with a toggle: yes (recommended) / no.
3. **"All entities" table**: keep at `/entities`, out of the sidebar, linked from Data model (recommended) · remove entirely.
4. **Tabs across the top** for both browsers (recommended) · keep a left rail for the kind switch.

Say yes to the recommendations and I will implement it as one branch, in the order above, keeping every existing URL working.
