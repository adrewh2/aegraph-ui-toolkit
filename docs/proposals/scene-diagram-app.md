# Diagrams as scenes: a diagram scene and its app

*A note for later. Status: intent, not yet planned · September 2026.*

## The intent

Two things, in order:

1. **Diagrams export to scenes.** A diagram (Graphviz, Mermaid, Excalidraw — `src/core/diagrams/`) can be turned into a scene the way a script's `scene(positions)` or a diagram import's captured geometry already is: the drawing's boxes, edges, routes and groups become a scene over the entities the mapping wizard resolved. Today the wizard captures geometry into a plain scene (`projection`, `source: { diagramId, format, … }`); the export makes that a deliberate, repeatable step from the Diagrams page and over MCP (`diagram_to_dataset` with `capture_geometry` is the seed).

2. **A diagram scene, with a first-class app.** The scene family (`src/core/graph/projection.ts`: `projection` as the root; `scene:script` and the graph scenes as subtypes through `parent`) gains **`scene:diagram`**: a scene whose geometry is authored as a drawing. Its app is a diagram editor built into aegraph — not an embedded Excalidraw or a text box for DOT — where **diagram construction is ES-integrated**: every box is an entity (existing, picked from the store, or created in place with a type), every connector a relationship of a chosen type, every group a container; deleting a box does not delete the entity, only its place in the scene; the ES is the source of truth for what the boxes *are*, the scene for where they *sit*. Drawing and modelling are the same gesture.

## What it builds on

- The scene family and `sceneKindOf` / `SCENE_FAMILY`: a new kind, listed on the Scenes page with the others, opened by the `display` tool.
- The diagram core: parsers and writers with no rendering dependency, geometry extraction, the mapping wizard, `sync.ts` (the same diagram in every format). A diagram scene should still write out as DOT / Mermaid / Excalidraw, so the drawing can leave.
- The Scenes page's canvas (`features/scenes/`: SceneLayer, groups, rels) — the diagram app is that canvas made editable, with a palette of types and relationship types from the ontology.
- The rule from the root guide: a view that draws something the ES does not hold is incomplete. The diagram app never holds a box that is not an entity.

## Open questions

- Whether `scene:diagram` keeps a `source` (the diagram entity it came from) and stays in sync with it, or cuts the tie once exported — probably: exported once, then the scene is the drawing, with *export as diagram* the way back.
- Edge routes: scenes carry routes per edge (`edges[id].points`); the app needs to author them (the elbow routes in `geometry.ts` are the default).
- How the Analytics flow meets it: a diagram scene is a scene, so it can be a script's input like any other.

This note exists so the next session that touches scenes or diagrams knows the direction; nothing here is built.
