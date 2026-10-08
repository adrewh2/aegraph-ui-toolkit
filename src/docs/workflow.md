# A working session

This page walks through one session end to end — from opening a project to handing someone a finished page — using the parts of aegraph that do the most work for you: **⌘K**, the **assistant**, **Insights**, **claims**, and **Publish**. Each step stands on its own; skip to the one you need.

## 1. Jump anywhere with ⌘K

Press **⌘K** (Ctrl+K on Windows and Linux) from any page. One box finds and does everything:

- **Entities** — type a few letters of a name. ↵ opens the entity where it lives: a document in its editor, an image in its viewer, a person or concept as a row in Entities. If Unigraph is on screen and draws that entity, ↵ selects it there instead and brings it into view. **⌘↵** always shows it in the graph.
- **Views and projects** — saved filters, layouts, styles, scenes, charts, analyses and workstations open in place; a project switches on the spot.
- **Findings** — the latest Insights findings, by title.
- **Actions** — open a page, ask the assistant, and on the Graph Explorer: run the layout, fit the view, clear the filter, toggle the legend, turn the view into a table.

↑ ↓ move, ↵ opens, Esc closes. With nothing typed, the box shows what you opened recently.

## 2. Ask about what you are looking at

Open the assistant with **⌘J** or *Assistant* at the bottom of the sidebar. You do not have to describe the screen to it — every message carries what is on it: the project, the document or media that is open, the text you have selected, Unigraph's filter and selection, the tables on screen and which rows are selected, the tabs open in each pane. So these all work as written:

> "What is *this* about?" · "How are *these three* connected?" · "Show me the neighbourhood of the selected node" · "Filter the graph to people and organisations within two hops of Ada" · "Open a table of everything tagged `#ops`"

The assistant acts rather than instructs: it drives the same filters, layouts, styles, selections and tables you would click through, then tells you in a sentence what changed and what you are now looking at.

**Ask about this** is the shortcut. Right-click anything — a row in a table, a node or edge in the graph, a row in the explorer's Nodes and Edges tables, a document, image, video, diagram or map — and pick *Ask about this* (or *Ask about these N* when several are selected). The graph's selection bar has a ✦ button for the same thing. The assistant opens with a question already asked, naming the entity exactly, and you follow up from there.

## 3. Let Insights find what stands out

**Insights** (in the sidebar) runs five analyses over the open project — key players, the community map, the ontology in use, activity over time, outliers and gaps — and returns findings ranked by how much they stand out. Each finding is one sentence with the numbers behind it, and one visual: **Show graph** opens a styled Unigraph tab with the entities in question selected, **Show plot** draws a chart, **Show table** unfolds the rows.

Three more buttons sit on every finding:

- **Ask** hands the finding to the assistant with the entities involved — for an explanation, and for where to look next.
- **Save as claim** keeps it (step 4).
- On Community-map findings, **Name a community** chips turn a detected group into an entity (step 4).

Findings live only as long as the run; the next two steps are how they become part of your knowledge.

## 4. Keep findings as claims; name communities

A **claim** is a statement the workspace supports with evidence — the same `claim` type the demo datasets use for statements like *"Postgres is a single point of failure for the order path"*, supported by incidents and post-mortems.

- **Save as claim** on a finding makes a claim entity: the finding's title as its label, its detail as the description, the analysis, score and rows in its data. Every entity the finding names is linked to it with a `supports` relationship. Save the same finding again after a re-run and the claim is refreshed — new numbers, new evidence — rather than duplicated.
- **Name this community** makes a `community` entity that every member belongs to through `member-of`. You reach it from a Community-map finding (the chips list the communities with their size) or from the graph: once communities have been computed (the Analysis tab, or any style that colours by community with *Auto* on), right-click a node and choose *Name this community…*. The dialog suggests the analysis's own name and shows what the group is made of; naming it again renames it.

Both are ordinary entities from then on: they appear in Entities, can be filtered, styled, tagged, linked to, asked about, and exported with the project. If the workspace had no `claim` or `community` type, one is defined the first time you use it. And because they are entities, the next Insights run sees them — a large named community becomes a hub in the Key players analysis, which is what it is.

On the **Ontology** page, clicking a type opens its own page (`/ontology/type/<type>`, the whole width; shift-click keeps to the chart and shows only that type's links): what it specialises and what specialises it; every property its entities carry — declared kind against the kinds actually seen, coverage, ranges and top values — with a description you can write in place; every relationship pattern in and out with counts and cardinality; its tags; and what changed last. The sections fold, search and open in windows, so a type with hundreds of properties reads as a page rather than a wall. Descriptions of types and properties are kept on the type's definition (a `schema:type` entity) and are what the assistant and MCP clients get from `list_entity_types` and `list_properties`; `define_entity_type` writes them too.

The **Ontology** page's **Claims** tab lists every claim with the entities that support it and every named community with its size. Each opens as a table or as a small graph of itself and its evidence.

## 5. Publish the project as a page

When the work is ready to share, open the project's page (the project switcher at the top of the sidebar → *Manage projects*, then the project) and press **Publish as web page**. You get one file, `<project>.html`, that anyone can open in a browser — no app, no server, nothing to install. On it:

- the **overview** — types with counts, relationship types, the top tags;
- every saved **graph scene**, drawn exactly as the explorer draws it (same filter, same saved positions, same style rules — styles that colour by community or size by PageRank have the metrics computed for them), and the Graph Explorer's current view when it is open on the project;
- every **chart** as a picture;
- the latest **findings**, and the **claims** and **named communities** you kept;
- the **documents**, rendered;
- a searchable **table of every entity** — search by any word, narrow to a type, click a row to see its relationships. Findings, claims and the overview link into it.

The page is a snapshot: it does not change when the project does. Publish again for a new one. Very large projects list the first 20,000 entities and say so at the top of the table.

The same thing over MCP: `project_publish`.

## Where to read more

- [Graph Explorer](/docs/explorer) — filters, layouts, styles and scenes, in 2D and 3D.
- [Insights](/docs/insights) — what each analysis asks and how findings are scored.
- [Projects](/docs/projects) — the Library, projects, bundles, and publishing.
- [Assistant & MCP](/docs/assistant) — what the assistant sees, and every tool it can use.
