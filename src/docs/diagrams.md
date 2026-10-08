# Diagrams

A diagram is a resource whose content is a drawing. It comes in three formats, and the format tabs move between them without losing anything (see *Switching formats* below):

| Format | What it is | Best for |
| --- | --- | --- |
| **Graphviz** (DOT) | Text; laid out by an engine (dot, neato, fdp, circo, twopi). | Graphs you describe rather than draw. |
| **Mermaid** | Text; flowcharts, class, ER, state, mindmap, sequence diagrams. | Quick structured sketches, docs. |
| **Excalidraw** | A drawing: shapes, arrows, text, images, with positions. | Anything you want to draw by hand. |

## Looking around

A Graphviz or Mermaid diagram shows its picture beside the source. The **arrow keys** pan the picture and **−** / **+** zoom it about the middle of the view, gliding while the key is held; **Shift** makes both fast. The zoom buttons in the toolbar step the same zoom, and the fit button frames the whole picture. The keys are listed, faintly, in the picture's bottom-right corner — as Unigraph lists its own. They belong to the picture only when nothing else has the keyboard: typing in the source, a field or a menu is left alone.

The picture is drawn as an image, the way a diagram that came in a bundle, an import or from the assistant has to be: its source is someone else's text, and as an image it cannot run anything, fetch anything or restyle the page around it. Before that it is rebuilt from what draws — shapes, text, gradients, markers, filters, the diagram's own stylesheet — and anything else is left out. So a Graphviz `URL=` is not a link you can click in the preview (it is still in the source and in a downloaded SVG). A few sources are not rendered at all, with the reason shown where the picture would be: a Graphviz font name (`fontname`, `labelfontname`, `<FONT FACE>`) or `stylesheet` with a quote or an angle bracket in it, which Graphviz would write into the picture as markup; a Mermaid image shape (`A@{ img: … }`), which Mermaid fetches the moment it lays the diagram out; and a Mermaid style that loads something from elsewhere (`url(…)`, `@import`, `image-set`). Mermaid's `%%{init: …}%%` directives are ignored, and front matter can choose a theme or a layout but not CSS, fonts or what counts as HTML (`themeCSS`, `themeVariables`, `fontFamily`, `htmlLabels`, `securityLevel`).

## Drawing

**Draw** opens the canvas — the Excalidraw editor, whole: shapes, arrows that bind to shapes, text, freehand, images, frames, groups, alignment, undo, keyboard shortcuts (`R` rectangle, `A` arrow, `T` text, `?` for all of them). A Graphviz or Mermaid diagram opened in Draw is converted to a drawing first, placed where its render put things; the text formats stay one tab away. An embedded web page (Excalidraw's *web embed*) is kept with its link but not framed: a drawing can come from anyone, and a frame would load that page the moment the drawing is shown.

**Source** shows the text (for a drawing, the scene file) beside the live render. **New diagram** starts from a template; *Blank canvas* is the first.

## Switching formats

A diagram keeps its text in every format it has been shown in, each remembered with the structure it matched. Switching to a format the diagram already has, when nothing changed since, shows that text **exactly as you left it** — a drawing comes back with every stroke, colour and freehand scribble; Graphviz comes back with your own formatting. When something did change, the target is *brought up to date* rather than regenerated: the drawing keeps its styling, arrow routes and anything the graph never modelled; Graphviz text is edited in place — your formatting, comments, defaults and attribute order stay, and only the statements that changed are touched (a moved node gets its `pos`, a new node a line in its cluster, a removed arrow its line taken out).

Positions travel too. A drawing writes each node's position and size into Graphviz (`pos="x,y!"`, `width`, `height`, with `layout=neato; inputscale=72` so Graphviz renders it as drawn — same places, shapes, fills and strokes); edit a `pos` in the DOT and the drawing moves that node when you come back. Mermaid has no positions — it gets the drawing's shapes, colours and reading direction, and the drawing keeps its own positions across a trip through it.

The toolbar says which happened: *as you left it*, *brought up to date*, or *converted* (first time).

## Saving

The diagram is an entity; edits save to it on their own after a short pause. **Save** (top right) writes at once and shows **Saved** when there is nothing pending; its menu has **Save as new diagram…** (a copy under a new name, in every format it has), the downloads, and **Export to dataset…**.

## Out and in

Copy or download the source (`.dot`, `.mmd`, `.excalidraw`), SVG or PNG. Drop `.dot`/`.gv`/`.mmd`/`.excalidraw` files on the Diagrams page to import them, or paste their text (**From clipboard**). **Export to dataset** turns a diagram's nodes and edges into entities and relationships, with a mapping you can adjust — by default node types come from the cluster (its label put back into the singular: *Services* → `service`), class or shape, and relationship types from the edge labels; running it again updates what it made before.

Over MCP: `create_diagram`, `view_diagram` (the rendered picture, as an image the model can look at, plus the parse summary and optionally the source), `write_diagram` (edit the source), `diagram_to_dataset`.
