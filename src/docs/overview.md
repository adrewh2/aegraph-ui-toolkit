# Overview

aegraph is a local-first workspace where everything you collect — documents, web pages, images, videos, audio, diagrams, notes, claims, people, concepts — is an **entity** in one graph, and where the graph itself is the way you look at it all.

## Finding anything: ⌘K

**⌘K** (Ctrl+K), or the search box at the top of the sidebar, opens one box that finds and does everything. Type a few words and it searches the open project: entities **by name**, tag or description, and **in text** — a document's body, a transcript, a page's text — each of those shown with the line that matched and the words marked, so you recognise the document by the sentence, not just its title. Every word must occur; put a phrase in "quotes" to match it as written. Beneath the first hits, **All N matches in the Entities table** opens the table with the same words (the same search, so the counts agree) to filter, sort and select; ↵ with nothing listed does the same. Then tags, types, saved views (filters, layouts, styles, scenes, plots, analyses, workstations), projects (opened on the spot), the latest Insights findings, the documentation's sections, and the app's actions — open a page, ask the assistant, and on Unigraph run the layout, fit, clear the filter, toggle the legend, turn the view into a table. An entity opens where it lives — a node selected in Unigraph when it is on screen and draws it, a row in Entities, a document in its viewer; **⌘↵** shows it in the graph instead. ↑↓ move, ↵ opens, Esc closes; with nothing typed it shows what you opened recently.

## The information model

The model is deliberately small. Five primitives cover everything:

| Primitive | What it is |
| --- | --- |
| **Entity** | `id`, `type`, `label`, `tags[]`, `data{}`, `meta`. Plain, serialisable data — no classes, no display state. |
| **Relationship** | An entity with a `source` and `target`. Because it is an entity it can be typed, tagged, annotated and described like anything else. |
| **Ref + Selector** | `{ id, selector? }` — address a whole entity or a region inside one (a text quote, a character range, an image region, a time range). A highlight is addressable without becoming its own entity. |
| **Tags** | Flat strings on any entity, many-to-many. Optional per-tag colour and description live beside the graph, not on it — set the colour in the **Colour** column of Entities › Tags. |
| **Type** | A single string on every entity. Registering a type (`define_entity_type`) adds a label, icon, colour, fields and validation; unregistered types still work everywhere. Click a type's swatch — in Ontology › Schema, or on the type's own page — to set the colour it is drawn in everywhere, or to put it back to the one derived from its name. |

`meta` carries `createdAt`, `updatedAt`, `accessedAt` and `source` (`user`, `assistant`, `import`, …). The whole workspace serialises as one **aegraph document** (`aegraph/v1`: `{ entities[], tags[] }`), which is also the exchange format.

## Properties

A **property** is a field name and a value in an entity's `data`. Any entity can carry any property; nothing has to be declared first.

- **One entity**: the inspector's Fields tab lists every property (declared ones first, with their labels; the rest by key) and ends with **Add property** — a name, an optional kind, a value, Enter. With no kind, typed values are read the obvious way: `true`/`false`, numbers and JSON become those; anything else is text. Pick a kind — text, long text, number, true/false, date, date & time, URL, colour, JSON — and the value gets that kind's widget (a date or date-time picker, a number box, a swatch…) here, in the table and wherever the property is edited; the kind is recorded on the entity's type. The ⋯ on a property row clears or removes it, adds it to the type, or changes its kind (existing values are converted where they can be).
- **Many entities**: select rows and use **Set property** (toolbar or right-click) to put one name/value on all of them.
- **On the type**: a type's properties are defined in its editor — **New type** (on the Ontology page, in the Create menu, or *Define type* over the Types table) for a new one, **Edit type** on a type's page (or *Edit type…* on its row in the Types table) for one that exists. The editor has the type's name, plural and id, its category and the type it specialises, its colour and description, and its properties as rows: a name, a label, a **kind** chosen from a list (text, long text, number, true/false, date, date & time, URL, colour, JSON — or any, read as written), whether it is required, and, opened, a description and a fixed set of allowed values; rows move up and down and come off with the bin. Beneath them is what the type has without defining it — its parent's properties, the app's built-in fields — so the whole shape of one of its entities is on one screen. Every property becomes a labelled, typed column for every entity of the type and its subtypes, and a row with its kind's editor in the inspector.
- **Changing a type that has entities** does what the change means to them: a renamed property moves its value on every entity of the type and its subtypes; a kind given or changed converts the values that can be read as it — `"1815"` becomes the number 1815, `yes` becomes true — and leaves the rest as written; a property taken off the type stays on the entities as an undeclared one. The Edit view says how many values each change touches before you save. A type's id is fixed once it exists: every entity of the type carries it. The inspector's row menu (*add to type*) and the Set property dialog still define one property on the type from where you are.
- **Over MCP**: `set_properties` (ids and/or a query, `properties: { name: value }`, `kinds: { name: kind }` to type them — values are converted or refused —, `remove`, `define_on_type`), `list_properties` (what is in use, per type, with the declared kind), `update_entity` (`data` merged), `tag_entities` (tags on or off many entities at once, by ids or a query) and `define_entity_type` — the editor's own save: `label`, `plural_label`, `category`, `parent`, `color`, `description`, `properties: [{ key, label, kind, description, options, required }]` merged by key, `rename_properties: [{ from, to }]` (the values move), `remove_properties`; it answers with what changed on existing entities.

## Categories

A **category** is a property of a *type*, never of an entity. It says how the type's data is used and therefore where it is browsed. The test for placing a type is what opening one of its entities does: read, watch or edit a body → resource; look up a record of something the sources are about → knowledge; see an arrangement of other entities → project (a view); describe a type itself → schema.

| Category | What lives there | Examples |
| --- | --- | --- |
| `resource` | Things with content of their own — the raw material | document, webpage, image, video, audio, diagram, conversation |
| `knowledge` | Things you assert about the world | person, organization, concept, claim, note, annotation, event |
| `project` | What a project holds beyond its data — presentation state stored as entities | filter, layout, rendering, analysis, scene, plot, script, workstation, project |
| `schema` | The ontology itself | type definitions |

Presentation state being entities is the point: a layout, a filter or an analysis is one addressable, taggable, exportable thing that refers to many others by id. That is what lets a saved view travel with the data.

## Where things are

- **Entities** — the table of everything, filterable by category, type, tag and text; relationships, types and tags have their own sections.
- **Resources** (Documents, Diagrams, Images, Videos, Audio) — the viewers, each with annotation.
- **Graph** — the 2D and 3D explorers and the collection pages for layouts, filters, styles, analyses, scenes and projects. See [The explorer](/docs/explorer).
- **Workstation** — split panes, each hosting any page as tabs; a saved workstation is an entity too.
- **Projects dialog** — not a page but a dialog, from the project menu in the sidebar (*Open project…*, *Import, examples, export…*) or the old `/datasets` link: opening a project (a file of your own, the demos, the bundles this machine serves), importing files, linked data, a ChatGPT export or Spotify, the examples and the generator, exporting, and the Library itself.
- **Data model** — the registered types, rendered as a page.

## Getting back

The ← → buttons at the top of the sidebar step through every place the app has shown — including tabs inside Entities and the Workstation, which the browser's own history never records — so a chain of relationship jumps can always be retraced. ⌥← and ⌥→ (and a mouse's back/forward buttons) do the same.

## The assistant

An in-app assistant and the Claude Code bridge use the same tool set to read and drive the app. It sees what is on screen — the open project, document, selection, graph and tables — and acts on it: everything documented here — filtering, placing nodes, styling by a value, running an analysis, publishing a project — has a tool. *Ask about this* in any context menu starts a conversation about the thing under the cursor. See [A working session](/docs/workflow) for the walk-through and [Assistant & MCP](/docs/assistant) for the tools.
