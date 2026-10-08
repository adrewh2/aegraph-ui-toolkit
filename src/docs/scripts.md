# Scripts

Scripts are code over a read-only snapshot of the dataset, written by you or by the assistant, returning a figure, a table, an image or a scene the app draws — or, as a Visual script, drawing anything at all with three.js, d3 or a canvas. They are the flexible path: any aggregation, join, before/after comparison, rolling window, custom Plotly figure (2D, or 3D and WebGL — `scatter3d`, `surface`, `mesh3d`, `scattergl`) or computed layout that a plot spec cannot express. A Scripts tab of the Analytics page (sidebar → Analytics; right-click a tab to open a saved script beside it) is the editor, with syntax highlighting in the page's own colours — keywords in its rust, strings green, numbers amber, what is called in teal, comments faint — and a language that is detected from the code or pinned; the assistant's `script` tool runs the same engines.

## Querying: one vocabulary, both languages

`entities` and `relationships` are **collections**: the array (JavaScript) or list (Python) of records, with a chained vocabulary that is the same in both languages. Every step returns a new collection, so a question reads as one line:

```js
entities.types.paper.filter({ min_degree: 2 }).neighbors('wrote').sort('label').table(['label', 'data.born'])
```
```python
entities.types.paper.filter(min_degree=2).neighbors('wrote').sort('label').table(['label', 'data.born'])
```

| step | meaning |
| --- | --- |
| `entities.types.person` · `entities.types['schema:type']` · `.type('a', 'b')` | the members of a type — a plural finds the singular (`types.documents`); `.types.list()` names them |
| `.get(id)` · `.ids()` · `.labels()` · `.count()` · `.first()` · `.last()` · `.take(n)` · `.skip(n)` · `.sample(n)` | lookups and slices |
| `.filter(fn)` · `.filter({ … })` / `.filter(key=…)` · `.where(fn)` · `.exclude(…)` | a predicate, or a spec. Entity keys: `types`, `tags` (any of), `all_tags`, `text` (in the label or description), `has` (a property present), `data` (`{ key: value \| [values] \| fn }`), `min_degree` / `max_degree` (`rel` narrows to one relationship type), `ids`, `created_after` / `created_before` / `updated_after` / `updated_before`, `where`. Relationship keys: `types`, `source`, `target` (an id or a collection), `source_type`, `target_type`, `directed`, `has`, `data`, `text`, `where`. Keys are snake_case as in Python; JavaScript takes camelCase too |
| `.sort(key, desc?)` · `.top(key, n)` | by a field, a `data.x` path or a function — a copy, missing values last |
| `.unique(key)` · `.pluck(path)` · `.group(key)` · `.rollup(key, value?, agg?)` | values, `{ key: collection }`, and `[{ key, value, n, items }]` with `count`, `sum`, `mean`, `median`, `min`, `max`, `distinct` |
| `.out(rel?)` · `.into(rel?)` · `.links(rel?)` | the relationships leaving / arriving at / touching the members |
| `.neighbors(rel?, dir?)` · `.degrees(rel?)` · `.tagged(tag)` | the entities at the other ends; degrees by id; members carrying a tag |
| `relationships.sources()` · `.targets()` · `.ends()` · `.from(x)` · `.to(x)` | from relationships to the entities at their ends, and the members touching one (Python: `from_`) |
| `.tags()` · `.properties()` · `.describe()` · `.table(columns?)` · `.json()` | what the members carry; a table output (a collection returned as the result draws as one) |

The array or list is still there — `entities.map(...)`, `for (const e of entities)`, `len(entities)`, slicing — and in Python anything a collection does not define is asked of its DataFrame: `entities.df`, `entities['type']`, `entities.groupby(...)`, `entities.head()` work as before. The editor follows a chain as it is typed: after `entities.types.person.neighbors('wrote').first().data.` it offers the properties of what a person's `wrote` reaches, and inside `filter({ types: '` the types, `tags: '` the tags, `data: { role: '` the values `role` takes.

## Switching the language

Pick the other language in the selector and the assistant translates the script — the two preludes share one vocabulary, so a JavaScript script over `entities.types.paper.filter({ … })` becomes the same Python over `entities.types.paper.filter(…)`, records read as dicts, the trailing expression stands in for `return`. The conversion goes through whichever assistant backend you have (Claude Code over the bridge, or the Claude API with your credentials) and writes nothing to the chat; without one, the language switches and the code is left as it was. Switch back with the converted side untouched and the original returns exactly as it was, nothing converted twice; edit first and it is translated afresh. Visual scripts are not converted (they draw with the DOM).

## Knowing what there is

The editor **completes as you type** from the data as it stands, and it follows the data through your code. `ds.` lists the dataset's members with their signatures; `ds.byType('` the types with counts; `ds.out(id, '` the relationship types and what they join; `ds.tagged('` the tags; `ds.metric('` the metrics the latest analysis computed. A variable bound to entities of a type — `const people = ds.byType('person')`, `for (const p of people)`, `people.filter((p) => …)` — completes *that* type's properties after `.data.`, each with its kind, how many entities carry it and a sample; a relationship knows its ends, so `ds.get(r.target).data.` offers the properties of what `r` points at; a categorical property offers the values it takes after `=== '`; `e.type === '` the types, `e.tags.includes('` the tags. The ontology, the project, `ds.properties()`, `ds.tags()`, `ds.describe()` and rollups are followed the same way, and a bare name lists the script's own variables with what they hold beside the helpers of the language. Python has the same for `by_type('…')` frames (`df['`), rows, `ds['entities']` dicts and `describe()`. Hovering a name shows its signature and a sentence — or, for a variable, what it holds; ^Space asks for completion anywhere, and Tab (or Enter) takes the suggestion.

**Reference** (the button on the bar) opens the same knowledge in a browser tab of its own: the API by group, the **types** with their properties, the **relationships**, the **tags**, and the **project** with the metrics — every row copies its call to paste into the editor. Each type and relationship has a **scaffold**: a whole script written from it (copied too) — every entity of the type as a table with one column per real property (kind, coverage and a sample as comments), or every relationship of the type with both ends. The project tab's scaffold is a *function over the project state*: `main({ project, ontology, entities, relationships, tags, metrics })`, each argument described with the real counts, so there is something concrete to dig into from the first line.

The project state is in the snapshot itself: `ds.project` (the open project, or null), `ds.ontology` (every type in use or declared, with its declared properties), `ds.type(name)`, `ds.properties(type)` (what entities of a type carry, declared or seen, with coverage), `ds.tags()`, `ds.metricNames()` — and `ds.describe()`, everything at once as one plain object: `log(ds.describe())` is the quickest way to look around. Python has `project`, `ontology`, `tags`, `type_def(name)`, `properties(name)` and `describe()`. Over MCP, `script {action:"schema"}` returns the same summary for an agent about to write a script.

## Three languages

**JavaScript** runs in a QuickJS interpreter compiled to WebAssembly, inside a worker. Instant, with a small helper library (`ds`, `bin`, `rollup`, stats, `figure`/`table`/`scene`). The interpreter has no I/O at all — no `fetch`, no DOM, no storage, no timers.

**Python** runs in Pyodide — CPython 3.12 in WebAssembly — with **numpy, pandas and plotly** loaded, and **matplotlib, scipy, scikit-learn, networkx and statsmodels** loading on first import. It is a notebook cell with a namespace of its own — what one run defines is gone at the next, so a script never leans on what another left behind: every statement runs, the value of the trailing expression is displayed (a plotly figure, a DataFrame, a matplotlib figure, a string), `print()` goes to the logs, and top-level `await` works (asyncio, or a JavaScript promise via `from js import …`). The runtime boots on first use in a few seconds and stays warm; runs after that take milliseconds. It starts afresh after a script that came from elsewhere has run, and when you open another project.

**Visual** runs an ES module in a sandboxed iframe that has a DOM, a canvas and WebGL — for custom three.js scenes, d3 layouts, Plotly by hand, anything drawn directly. The frame is the output: it fills the pane and keeps animating. three.js is importable (`import * as THREE from 'three'`, addons under `three/addons/`), d3 and Plotly load with `await aegraph.load('d3' | 'plotly')`, and `ds` plus every JavaScript helper are in scope; `aegraph.result(v)` can send a figure, table or scene back too, and `aegraph.remember(key, value)` / `aegraph.recall(key, fallback)` keep something — the camera, a toggle — per script across runs and reloads, up to 256 KB of it. The last result of every script stays on screen when you leave the page and come back. After a browser reload a JavaScript or Python script you have run or saved in this browser runs again by itself — the same code, not an edited copy — and so does one the inspector runs on open. A script that came in a bundle, an import, a template or from another browser waits for you to press **Run** (it says so); so does a Visual script, always, and one whose last run never finished because the page was reloaded or closed under it. Over MCP, `script {action:"run", id}` runs a saved script the same way: one you have not run here runs walled off from the next.

## The sandbox

Both engines run in workers, so a long script never blocks the page, and Stop terminates the worker (the next run starts a fresh one). Every run is capped in wall-clock time (5 s for JavaScript, 30 s for Python by default) and, for JavaScript, heap — sized to the dataset, about six times its snapshot. The snapshot is a copy — the store is never touched — and long text fields (document bodies, page HTML) are truncated so it stays small; it is written and handed to the worker in pieces, so the page stays responsive while a big one crosses, and loaded once per dataset version and reused across runs. Loading it (parsing, indexing, freezing) is not charged to the script's time: a dataset of a few hundred thousand entities takes some seconds to land and then every run starts warm. A dataset that does not fit the JavaScript heap says so, and says what to do about it.

**Reading only part of a project.** A script sees the whole project unless it names the types it reads — `script {types: ["genus", "ward"]}` over MCP, the **Types** line in a script's Details on the page — and then it is handed those types (subtypes with their parent) and the relationships between them, and nothing else. This is what makes a project of hundreds of thousands of entities scriptable at all: the 688,335 street trees of Toronto are 307 MB of snapshot and fit in no sandbox, while the 73 genera, the 302 species and the 25 wards they belong to are four hundred entities that load in a tenth of a second — the demo's own scripts are written that way. It is worth doing on smaller projects too: the first run after every change pays for what it loads. What a script was given is in `ds.scope.types`.

Python and Visual scripts additionally run inside a **sandboxed iframe**: an opaque origin (none of the app's cookies, storage or DOM) with a Content-Security-Policy that allows network access only to where the runtime and wheels come from — this origin, which serves them from `public/pyodide` (`npm run pyodide` fetches ~100 MB once, each file checked against a pinned digest; `npm run dev` and `npm run build` do it for you). A copy of the app that does not serve them says to run `npm run pyodide`; Python is never loaded from a CDN, where nothing is pinned or checked. A Python or Visual script cannot send data anywhere else, and the Visual frame cannot read this origin's storage or navigate the app (its probes: `fetch` fails, `localStorage` throws). Visual libraries come from `public/vendor` (`npm run vendor` copies three.js, d3 and Plotly from node_modules). A production host must send `Access-Control-Allow-Origin: *` for `/pyodide/` and `/vendor/` (the dev and preview servers do), because the sandboxes' requests are cross-origin.

**What a run sends back is bounded:** 2,000 log lines and 512 KB of log text (a last line counts the rest), 64 MB of result as JSON (past that the result is dropped with an error saying to return a summary), and a Visual script's remembered state as above. A figure is cleaned before it is drawn: Plotly fetches what a figure names — background images, image traces, a map's style, its layers, sprites, glyphs and tiles — so a figure keeps no address of its own choosing (a `data:` image stays, and a map keeps only a named style, whose tiles come from that style's provider).

Nothing is executed on Anthropic's servers and nothing leaves the machine: the assistant writes the code, the engines run it here.

## JavaScript reference

```
A script is JavaScript (ES2020) run in a sandbox with no I/O; \
```

## Python reference

```
 its result. Globals:

ds — the dataset snapshot (the open project, or the Library):
  ds.entities: [{ id, type, label, description?, tags: string[], data: {...}, createdAt, updatedAt }]  (ISO dates; long text fields truncated)
  ds.relationships: [{ id, type, source, target, directed, data }]
  ds.get(id) · ds.byType('incident', 'deploy') · ds.types() · ds.tagged(tag) · ds.where(fn) · ds.count()
  ds.out(id, type?) / ds.in(id, type?) → relationships (without a type, the list itself: read it, don't change it) · ds.neighbors(id, type?) → entities · ds.degree(id, type?)
  ds.metric('pagerank' | 'betweenness' | 'community' | 'degree' | …, id) — from the latest Insights/analyze run, else undefined

time: ms(v) → epoch ms · bin(v, 'hour'|'day'|'week'|'month'|'quarter'|'year') → ISO string of the floored period · daysBetween(a, b) · hoursBetween(a, b) · isoDate(v)

collections: groupBy(items, key) → Map · rollup(items, key, value?, agg = 'count'|'sum'|'mean'|'median'|'min'|'max'|'distinct'|fn) → [{ key, value, n, items }] sorted by key · sortBy(items, key, desc?) · topK(items, key, k) · rolling(xs, n) · range(a, b, step) — keys are field names or functions
stats: sum · count · mean · median · quantile(xs, p) · min · max · distinct · correlation(xs, ys)

outputs (return one object; it may carry several):
  figure(traces, layout) — Plotly traces via line(x, y, opts) · scatter · bar · area · box(y) · histogram(x) · heatmap(x, y, z) · pie(labels, values); opts merge into the trace (name, marker, text, …); layout is Plotly's (title, barmode, xaxis, yaxis, …)
  table(rows, columns?) — row objects or arrays
  scene(positions, { label?, groups?, scale? }) — positions: { [entityId]: { x, y, width?, height? } }; opens on the Scenes page
  { text: '…' } — prose; a bare string works too
log(...) collects lines shown with the result.

Example — MTTR per month before and after 2025-11-14:
  const inc = ds.byType('incident')
  const m = rollup(inc, (e) => bin(e.data.startedAt, 'month'), (e) => e.data.duration_min, 'median')
  return figure([line(m.map((r) => r.key), m.map((r) => r.value), { name: 'median MTTR' })], { title: 'MTTR by month', shapes: [{ type: 'line', x0: '2025-11-14', x1: '2025-11-14', y0: 0, y1: 1, yref: 'paper', line: { dash: 'dot' } }] })
```

## Visual reference

```
Python scripts run in Pyodide (CPython 3.12 in WebAssembly) with numpy, pandas and plotly loaded; matplotlib, scipy, scikit-learn, networkx and statsmodels load on first import. Jupyter-style: every statement runs and the value of a trailing expression is displayed (or assign \
```

## Outputs

A script's result may carry several outputs:

- **figure** — Plotly: from `figure(traces, layout)` in either language, or a plotly.py figure (`plotly.express`, `graph_objects`). Drawn with the same chart as plots; drag to zoom, double-click to reset.
- **table** — `table(rows, columns?)`, or a DataFrame / Series in Python. **Keep as a dataset** under it writes the table as a [dataset](/docs/datasets) entity and opens it on the Datasets page; a saved script's dataset is refreshed by the next run rather than duplicated. This is the analytics flow's hand-off: scene → script → dataset → chart.
- **image** — a matplotlib figure, or anything drawn with `pyplot`.
- **scene** — `scene(positions, …)`: positions per entity id. *Open on the Scenes page* saves it as a **script scene** (type `scene:script`, a subtype of scene — named after the script, remembering which script made it) and shows it; running the script again and opening the result updates that same scene, keeping its name and any groups you drew on it, rather than adding another. An unsaved script's picture is a plain scene named after the output.
- **layout** — `layout(positions, { label?, dimensions? })`: a position per entity id (`{ x, y, z? }`) for the Graph Explorer. **Apply on the Graph Explorer** holds them as the view's positions and saves them as a **layout** entity that remembers the script (algorithm `script`, one per script, updated on each run); a graph scene saved afterwards keeps it, and the Layout panel says which script it came from and can run it again.
- **style** — `style(nodes, { edges?, legend?, label?, spec? })`: a style per entity id — nodes `{ color, size, opacity, shape, visible, label }`, edges `{ color, width, opacity, visible, arrow }` — with a legend (`{ title, items: [{ label, color }] }` or `{ title, palette, domain }`) and, optionally, a rendering spec for what the ids leave unset. **Apply on the Graph Explorer** draws it and saves it as a **style** (rendering) entity that remembers the script; the styles ride on top of the style's defaults and type/tag rules, the legend shows the script's own. The Style panel names the script, runs it again, or drops the scripted styles. Metrics to style by are computed in the script itself — `ds.compute(['pagerank', 'community'])` — and the colour and scale helpers (`colorOf`, `colorRamp`, `scaleSqrt`, `extent`, `PALETTES`) turn values into looks.
- **text** — `{ text: '…' }`, or a bare string.

Anything else is shown as JSON. `log(...)` (JavaScript) and `print()` (Python) lines appear under the result.

A chart exported from a Charts tab (its **Script** button) arrives here as JavaScript written with the plot tool's own conventions — `axisValue`, `binAxis`, `axisOut`, `seriesOf`, `plotColor`, `markerSizes`, `aggregate` — so it draws the same picture: the same reading of dates and numeric strings, the same bins, series order, colours and marker sizes. They are ordinary helpers; use them in any script.

## Kinds: filter, constraint, scene, layout and style scripts

A saved script that is put to use has a **kind** — a subtype of `script` in the ontology, the way a scene a script made is a `scene:script`: it reads as *Script · Filter* in tables and can be listed on its own. A draft has none, and a script stays a plain `script` until it is saved with a kind or first connected to what it is for:

- **Filter** (`script:filter`) — the script returns the entities the Graph Explorer should keep: a collection (`return entities.types.person.filter({ min_degree: 3 })`), a list of ids, `{ ids }`, or a table with an `id` column. **Keep these in Unigraph** under the output opens the explorer on just those; in the explorer's Filter panel the **Script** section picks a saved script and **Apply** runs it — the view keeps what it returned (*Just these*, with **Re-run** to run the script again over the data as it stands, and **Lift** to let it go). The other filters still apply on top, and the restriction is saved with the filter, script and all. Filters set by hand in the panel, or through the assistant, stay as they are; a filter script is for the filtering the panel cannot say.
- **Constraint** (`script:constraint`) — the script judges the dataset: `true` passes; `false` or a string fails; a list of `{ id, message }`, or a table with those columns, names the entities at fault. **Save as a constraint** under a result of that shape makes a `constraint` entity whose rule is the script (scope graph, a warning until you make it reject); naming a script in a constraint on the Ontology page, or with the `constraint` tool, marks it the same way. The audit runs it — see [Constraints](/docs/constraints).
- **Scene** (`script:scene`) — the script returns `scene(positions)`; **Open on the Scenes page** saves the scene and shows it, and the scene knows the script it came from.
- **Layout** (`script:layout`) — the script returns `layout(positions)`; **Apply on the Graph Explorer** saves the layout and holds it in the view. Over MCP, `graph_layout {script}` does the same and `script {action:"apply", kind:"layout"}` too — a scene script's positions serve when asked for a layout.
- **Style** (`script:style`) — the script returns `style(nodes, …)`; **Apply on the Graph Explorer** saves the style and draws it. Over MCP, `graph_style {script}` and `script {action:"apply", kind:"style"}`. "Colour by community and size by PageRank" is then one script: it computes the metrics with `ds.compute`, maps them with the colour and scale helpers, and returns the style — saved as a script entity, applied on the explorer, kept by a graph scene.

A Visual script cannot be a filter, a constraint, a layout or a style: it draws in a frame of its own and returns nothing those can use, and each refuses one with a sentence.

Saving a draft reads the kind off what its last run returned — a style, a layout, a scene, entities, a verdict — and the **Details** dialog changes or removes it; a kind a script already has is kept through later saves and connections.

## From the assistant or over MCP

`script {action:"api", language}` returns the reference; `{action:"run", code, language?}` executes and returns a summary (traces with their first points, table head, logs, errors with a stack) — the loop for getting a script right; `{action:"show", code}` opens the Scripts page and draws the result (`save_as` keeps it as a script entity); `save` (with `kind`, or the kind read off what the code returns; `locked` locks or unlocks — a locked script refuses save, edit and delete until then, and a save with a new name makes a copy), `list`, `get`, `delete` manage saved scripts; `{action:"apply", id}` puts a saved script to use by its kind — a filter opens the explorer on what it returns, a constraint is defined from it, a scene is saved and shown — and `graph_filter {script}` applies a filter script in the explorer. The language is detected from the code unless given. Saved scripts are entities of type `script` and can sit in workstation panes at `/analytics/scripts?script=<id>` (`/scripts?script=<id>` still works).

## The page

The editor has the whole page until a script runs; the **Output** then opens beside it (or under it — the ⋯ menu's *Layout* chooses, and either way the split drags and is remembered) and its × puts it away until the next run. **Reference** opens in a browser tab of its own (`/analytics/scripts/reference`), to sit beside the editor rather than in it: the API by group, the **types** with their properties, the **relationships**, the **tags**, and the **project** with the metrics, for JavaScript or Python. Across tabs there is no cursor to insert at, so a row **copies** its call and each type, relationship and the project has a **scaffold** that copies a whole script — paste into the editor; what was copied last is shown beside the list. Nothing takes room from the code.

The script's **name** is the title at the top left: edit it there (Enter or leave the field to rename). Beside it, the kind badge, the lock, and *edited* or *unsaved* when what is in the editor differs from what is saved; the chevron opens the list of saved scripts (a lock marks the locked ones, *draft* the ones with edits kept) and *New script*. Then the language, **Run** / **Stop**, **Save** (⌘S), **Details** and **Reference**; the ⋯ menu has **Save as…**, *Discard changes*, *Delete script*, the layout, the templates and the docs.

**Details** is where a saved script's other fields live — it is disabled until the script is saved, since they are stored on the script entity: the **description** (Markdown; until there is one, the comment block the code opens with stands in as the description everywhere it is shown), the **kind** (filter, constraint, scene, or none — see *Kinds*), and the **lock**. A **locked** script cannot be overwritten — its code, name, description and kind — or deleted; **Save** becomes **Save as…**, which keeps a copy under a new name and leaves the original as it was, and the name at the top left is read-only. Unticking *Locked* in Details is the way back. The scripts a demo project ships with are locked, so what a demo shows stays as built while you work on your own copy.

**Unsaved changes.** Every edit is kept as a draft as you type — per script, and one for the unsaved script — so a reload, a tab switch or a trip to another page loses nothing and brings the edits back. If this browser's storage will not keep a draft (it is full), the page says so the first time — save the script then, since a reload would not bring those edits back. What does ask first is an action that would replace the editor's contents: opening another script, *New script*, a template, a scaffold. The dialog offers **Save** (or **Save as…** when the script is unsaved or locked), **Discard** (the draft is dropped) or **Cancel**. Saving an unsaved script for the first time asks for a name, offering the one typed at the top left or the script's first comment line.

