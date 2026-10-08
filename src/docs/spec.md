# File format (.ae.json)

An **`.ae.json` file is one aegraph document**: JSON, `$schema: "aegraph/v1"`, a list of entities. It is exactly what aegraph loads — drop it on the Projects dialog (*Open project…* in the project menu), open it with `/open?url=…`, or hand it to the assistant's `import_graph` — and exactly what every export writes. Other systems that want to produce aegraph data write this format.

- **Specification:** [`/spec/aegraph-v1.schema.json`](/spec/aegraph-v1.schema.json) — a JSON Schema (draft 2020-12) for the whole document.
- **Example:** [`/spec/example.ae.json`](/spec/example.ae.json) — a small valid document covering every construct below.
- **Validation:** the `validate_ae` assistant/MCP tool (or `validateAe()` in `src/core/exchange/ae/validate.ts`) reports each problem with a JSON pointer.

The loader is deliberately lenient (anything with an `id` gets in, missing timestamps are filled, `kind` is inferred from `source`/`target`), so a producer that cuts corners still loads. The schema describes the *proper* document: what aegraph itself writes, and what round-trips without loss.

## The document

```json
{
  "$schema": "aegraph/v1",
  "exportedAt": "2026-09-13T12:00:00.000Z",
  "entities": [ … ],
  "tags": [ { "tag": "reading", "color": "#3b82f6", "description": "Things to read" } ]
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `$schema` | yes | Always the string `aegraph/v1`. |
| `entities` | yes | Entities and relationships, any order. |
| `exportedAt` | no | ISO 8601 time the file was written. |
| `tags` | no | Colour and description for tags in use. Tags on entities are plain strings and need no entry here. |
| `project` | no | *Bundle key:* the id of the `project` entity in `entities` that this file *is*. See [Projects](/docs/projects). |
| `state` | no | *Bundle key:* `{ route?, ui? }` — the screen to reopen on. |

Unknown top-level keys are ignored. Loading **merges by id**: an entity already in the workspace is replaced by the one in the file; nothing else is touched. Deterministic ids (a slug of the source system's id, say `chatgpt-<uuid>` or `doi:10.1000/…`) therefore let a re-import update rather than duplicate.

## Entities

Everything is an entity: a webpage, a person, a claim, a layout, a type definition. One shape:

```json
{
  "id": "tim-berners-lee",
  "type": "person",
  "label": "Tim Berners-Lee",
  "description": "Inventor of the World Wide Web",
  "tags": ["pioneer"],
  "data": { "born": "1955-06-08" },
  "meta": { "createdAt": "2026-09-13T12:00:00.000Z", "updatedAt": "2026-09-13T12:00:00.000Z", "source": "import:wikidata" }
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Any non-empty string, unique in the workspace. |
| `kind` | no | `entity` (default) or `relationship`. Structure only; meaning is in `type`. |
| `type` | yes | One word: a [registered type](/docs/model), a type the document defines itself (below), or any new word — unregistered types land in the **Knowledge** category and get columns inferred from their data. Use `entity` when there is no better word. |
| `label` | no | Display name; the id shows when absent. |
| `description` | no | Free text. |
| `tags` | yes | Array of strings, unique, `[]` when none. |
| `data` | yes | Object of application attributes, `{}` when none. Registered types expect certain keys (see *Well-known types*); anything else is kept and shown. |
| `meta` | yes | Provenance: `createdAt` and `updatedAt` (ISO 8601) are required; `accessedAt`, `createdBy` (a person or agent), `source` (`user`, `extension`, `import:<system>`, an agent name…), `derivedFrom` (a [reference](#references-and-selectors)), `projects` (ids of `project` entities) are optional. |

## Relationships

A relationship is an entity with `kind: "relationship"`, a `source` and a `target`. Because it is an entity it has its own id, type, tags, data and meta — so a link can be described, attributed, and itself annotated or linked.

```json
{
  "id": "rel-author",
  "kind": "relationship",
  "type": "authored",
  "tags": [],
  "data": {},
  "source": { "id": "tim-berners-lee" },
  "target": { "id": "w3c-semantic-web" },
  "directed": true,
  "meta": { "createdAt": "…", "updatedAt": "…" }
}
```

`type` is the predicate (`authored`, `annotates`, `contains`, `references`, `derived-from`, `related`, `shows`, or your own). `directed` defaults to `true`; `false` means the link reads the same both ways. A relationship may appear before the entities it links, and may point at ids that are not in the file (they may already be in the workspace) — the validator lists those as *unresolved* rather than failing.

## References and selectors

`source`, `target` and `meta.derivedFrom` are references: `{ "id": "…" }`, optionally narrowed to a **part** of the entity by a `selector`. Selectors are how highlights, image regions, moments in a video and places on a map are addressed without minting an entity for each.

| `kind` | Keys | Addresses |
| --- | --- | --- |
| `text` | `exact`, `prefix?`, `suffix?` | A quote in the entity's text. |
| `range` | `start`, `end` | A character range. |
| `region` | `x`, `y`, `width`, `height` | A pixel rectangle in an image's natural size. |
| `time` | `start`, `end?`, `region?` | Seconds into audio/video; `region` is a fraction (0–1) of the frame. |
| `geo` | `lat`, `lng`, `radius?`, `at?`, `until?` | A point on a map (WGS84), a radius in metres, a moment or span. |
| `fragment` | `value` | A fragment id (`#section-2`). |

```json
"target": { "id": "w3c-semantic-web", "selector": { "kind": "text", "exact": "The Semantic Web is a Web of Data" } }
```

An **annotation** is the usual pairing: an `annotation` entity carrying the comment, and an `annotates` relationship from it to the annotated entity with the selector on the target.

## Defining types in the file

Vocabulary travels with the data. A type definition is an entity of type `schema:type` whose id is `type:<name>`:

```json
{
  "id": "type:claim",
  "type": "schema:type",
  "label": "Claim",
  "tags": [],
  "data": {
    "name": "claim",
    "category": "knowledge",
    "parent": "statement",
    "color": "#e11d48",
    "pluralLabel": "Claims",
    "properties": [
      { "key": "stance", "label": "Stance", "kind": "text", "options": ["supports", "disputes", "neutral"], "required": true },
      { "key": "confidence", "kind": "number" }
    ],
    "table": { "columns": ["data.stance", "data.confidence"], "hidden": ["meta.createdAt"], "sort": { "key": "data.confidence", "dir": "desc" } }
  },
  "meta": { "createdAt": "…", "updatedAt": "…" }
}
```

`table` says how the type's entities are laid out wherever they are tabled: `columns` come first, in this order, and are shown even if the field is hidden by default; `hidden` are hidden by default (still in the Columns menu and the inspector); `sort` is the order rows open in until someone clicks a header. Keys are `label`, `type`, `tags`, `description`, `data.<key>`, `meta.createdAt`…; the label column always stays first. A subtype inherits its parent's layout unless it sets its own, so a `table` on `location` lays out every `airport` and `hotel` under it. The `table_layout` tool writes it. A `map` entity's `data.table` takes the same keys, plus `types` — the kinds (`location`, `path`, `area`) or types its page's All tab shows by default.

`category` is one of `resource` (things people read, watch, edit), `knowledge` (what they are about — the default), `project` (what a project holds beyond its data: graph views, filters, layouts, styles, scenes, plots, analyses, workstations, scripts; older files say `graph`, which is read the same), `schema`. `properties` name `data` keys; each becomes a column and an inspector row, `kind` is one of `text longtext number boolean date datetime url image color tags ref json availability`, `options` fixes the allowed values, `required` blocks creating one by hand without it. `kind: "relationship"` says the name is relationship vocabulary rather than a kind of entity — without it a definition with no instances reads as an unused entity type, and relationship types are exactly that until a link uses them. A definition for a type aegraph already knows (say `person`) customises that type rather than replacing it.

## Well-known types

The full, live list — every registered type with its fields — is the [Data model](/docs/model) page. The ones a producer most often writes, with the `data` keys they expect:

| `type` | Category | `data` |
| --- | --- | --- |
| `document` | resource | `extension` (`md`, `txt`, `pdf`, `folder`), `content` (text for md/txt), `sourceUrl?`, `dataUrl?` (a `data:` URL for PDFs), `parentId?` (a folder). |
| `note` | resource | `text?`. |
| `webpage` | resource | `url`; `metadata?` (title, author…). |
| `image` | resource | `src` (URL or `data:` URL), `width?`, `height?`, `mimeType?`, `sourceUrl?`. |
| `video` | resource | `url` (YouTube), `videoId`, `channel?`, `duration?` (s), `thumbnailUrl?`. |
| `audio` | resource | `url`, `provider: "spotify"`, `spotifyType`, `spotifyId`, `uri`, `artist?`, `duration?` (s). |
| `annotation` | resource | `annotationType` (`text`, `image`, `note`), `comment`, `selectedText?`, `imageUrl?` — plus an `annotates` relationship to the target. |
| `diagram` | resource | `format` (`dot`, `mermaid`, `excalidraw`), `source` (the text). |
| `map` | resource | `center: {lat, lng}`, `zoom`, `layer` (`streets`, `satellite`, `terrain`), `pins?` (`points`: every location a dot on one canvas; `bubbles`: a pin each, bubbled where they crowd; unset: points from 2,000 locations up), `table?` (how its page's table opens: `types`, `sort`, `columns`, `hidden`). |
| `location` | knowledge | `lat`, `lng`, `address?`, `at?`, `until?`, `mapId?` (the map it belongs to). |
| `path` | knowledge | `geometry` (GeoJSON LineString, `[lng, lat]` pairs), `lat`/`lng` (its start), `lengthM?`, `at?`, `until?`, `mapId?`. |
| `area` | knowledge | `geometry` (GeoJSON Polygon, outer ring closed), `lat`/`lng` (its centroid), `areaM2?`, `at?`, `until?`, `mapId?`. |
| `conversation` | resource | A chat transcript; see the ChatGPT loader for the shape it writes. A chat with the assistant (`data.source: "assistant"`) also carries `data.artifacts`: `[{ id, tool, at? }]`, what the chat made or changed, latest touch last. |
| `filter` | graph | What Unigraph keeps: `types?`, `relationshipTypes?`, `tags?` / `tagMode?`, `text?`, `roots?` / `depth?` / `direction?`, `minDegree?`, `maxNodes?`, `fields?` (predicates), `exclude?` / `include?`, `only?` (keep just these ids) and `script?` (the filter script `only` came from, so it can run again). |
| `layout` | graph | `positions: { [entityId]: {x, y, z?} }`, `dimensions?` (2 or 3), `algorithm?`, `params?` (the algorithm's settings, as the Layout tab holds them). An id missing from `positions` is not placed by the layout and is laid out by its `algorithm` when the layout is opened; `positions` may be empty (`{}`), and the layout is then an algorithm to run rather than a picture to restore — what the demos open on, so the picture is computed on the machine that opens it. |
| `script` | graph | `code`, `language?` (`js`, `python`, `view`), `locked?` (true: the app refuses to overwrite or delete it — the scripts a demo ships with), `lastRun?`. A script put to use is one of the subtypes `script:filter`, `script:constraint`, `script:scene` (`parent: script`; see [Scripts](/docs/scripts)) — same `data`, the type says what it is for. |
| `projection` | graph | A **scene** (the type key is `projection`): `kind: "2d"`, `width`, `height`, `nodes` / `edges` / `groups` keyed by entity id — what [diagram imports](/docs/diagrams) capture and the Scenes page draws; `source` says where it came from (`{ diagramId, format, engine?, capturedAt }`). Scene is the parent of two subtypes: `scene:script` and `scene` (below). |
| `scene:script` | graph | A **script scene**: the same shape as a scene, `parent: "projection"`, with `source: { scriptId, ranAt }` — the picture a [script](/docs/scripts) returned with `scene(positions)`; rerunning the script updates it. |
| `scene` | graph | A **graph scene**, `parent: "projection"`: a Unigraph composition rather than fixed positions — `renderer` (`"2d"` \| `"3d"`, the view's dimensions), `mode?` (what scenes saved on the Graph Explorer named: `gpu` and `gpu3d` were the engine's tabs there, `2d` and `3d` its sigma and three.js renderers; read as the dimensions), `filterId?`, `layoutId?`, `renderingId?`, `analysisId?`, `projectId?`, `algorithm?`, `params?`, `analysis?`, `view?` (the view and the UI as saved: `camera` — 2D `{ kind, x, y, ratio, angle, center }` or 3D `{ kind, position, lookAt }` — `labels`, `showEdges`, `showLegend`, `slides` (the 3D slide layer: `{ show, decks?, focus?, parts?, story?, spatial?, final? }` — every deck when `decks` is absent; `parts`, default true, hangs composed slides' blocks as plates; `story` and `spatial`, on by default when the project has stories, show the story layer and the slides' blueprints; `final`, default true, the finished slides), `physics`, `hops`, `tool`, `pathOptions`, `selectedIds`, `selectedEdgeId`, `panel` (`filter` … `selection` or `null`), `sideWidth`, `detail: { minimized, maximized, active, pinned, width? }`), `stats?` (`{ nodes, edges }` in view after the filter when saved), `preview?` (the card's picture, 320 × 200: a `data:image/jpeg` URL of the view captured in a tab, or a `data:image/svg+xml` URL drawn from the layout's positions when the scene was composed headlessly — any other scheme is ignored). The Scenes page lists it; it opens in [Unigraph](/docs/explorer). A save writes the subtype `scene:unigraph` (the same `data`); the bare `scene` (older files) and `scene:explorer` (saved on the Graph Explorer that Unigraph replaced) are read the same and open there too. |
| `deck` | project | An ordered set of [slides](/docs/explorer#slides): `color?` (its slides' accent and beams — a CSS colour; anything else is ignored), `order?` (among the decks, lowest first), `description?`. |
| `slide` | project | A page made from the data: the title is its `label`; `deck` (the deck's id), `order?` (its place in the deck, from 1), `kicker?`, `body?` (a few Markdown lines: `- ` bullets, `**bold**`), `plane?` (`{ x, y, z, yaw?, tilt?, width? }`, a fixed place in radii of the graph from its centre — without it the slide hangs on its deck's place in the ring), `compose?` (a `block` id: the slide is composed of that block — its `body` is then a one-line subtitle — with a `composes` relationship to it), `beat?` (the chapter of a story it realizes, with a `realizes` relationship). What it shows is `shows` relationships from the slide to each entity, and for a composed slide its blocks' too. Unigraph's 3D view hangs it over the graph. |
| `block` | project | A reusable piece of a [composed slide](/docs/explorer#slides): `kind` (`flow`, `stats`, `list`, `timeline`, `text`, `row`, `column`); the four kinds with boxes have `items: [{ ref?, label?, value?, note? }]` — `ref` the entity the box is bound to (`label` defaults to its label; `value` a figure, a timeline's date; `note` a line under it) — `text` has `text` (Markdown), `row` and `column` have `children` (block ids, in order); `showTitle?` (default true), `beat?` (the point of a story it realizes, with a `realizes` relationship). Its relationships match its data: `shows` to each bound entity, `composes` to each child block. |
| `story` | project | The directed outline of a document a deck is made from: `deck` (the deck it becomes), `order?`, `summary?`. Its outline is its beats. |
| `beat` | project | A line of a story's outline: `story`, `kind` (`chapter` \| `point`), `parent?` (a point's chapter), `order` (among its chapter's points, or the story's chapters, from 1), `text?`. Relationships: `cites` to each entity it draws on, `next` to the beat after it in reading order (each chapter, then its points). A slide `realizes` a chapter, a leaf block a point. |
| `dataset` (and its subtypes `dataset:csv`, `dataset:tsv`, `dataset:text`, `dataset:excel`, `dataset:parquet` — what it was read from, `parent: dataset`) | project | A **table** kept as one entity ([Datasets](/docs/datasets)): `columns: [{ key, label?, kind?, description? }]` (keys unique; `kind` one of `text number boolean date datetime url json`, read from the values when absent), `rows: [[…], …]` (one array per row, in the columns' order; numbers, strings, booleans, `null` or JSON), `source?` — `{ kind: "script", scriptId, ranAt, sceneId? }` for a table a script returned (rerunning the script refreshes it), `{ kind: "csv", filename?, importedAt }` for pasted CSV, `{ kind: "file", filename, format, sheet?, importedAt }` for a file read whole (`format` one of `csv tsv txt xlsx parquet`; `sheet` the workbook sheet it came from), `{ kind: "entities", at, count, selector? }` for rows that are entities (their fields the columns), or `{ kind: "hand" }`. |
| `project` | graph | A named scope; membership is `meta.projects` on the members. See [Projects](/docs/projects). |
| `schema:type` | schema | A type definition, above. |

Anything not in this table is fine too: a `person` with `data.born`, an `organization` with `data.founded`, a `paper` with `data.doi` — columns and the detail panel follow the data.

## Conventions

- **Ids** are opaque strings; keep them stable across exports so re-imports update. Prefix ids from a source system (`arxiv:2401.00001`).
- **Timestamps** are ISO 8601 with a timezone (`Z`). `updatedAt` decides which of two copies of an entity is newer when bundles merge.
- **`meta.source`** says where information came from; `meta.createdBy` who or which agent wrote it. Agents should fill both.
- **Naming:** `.ae.json` — the `.ae` marks it as an aegraph document, the `.json` keeps editors, GitHub and MIME detection happy. A bare `.ae` also loads.
- **Sizes:** an `.ae.json` file is parsed in one go — fine to ~100 MB. Above that write **JSON Lines** (`.ae.jsonl`: one entity per line, an optional first line `{ "$schema": "aegraph/v1" }`, tag entries as `{ "$tag": "…", "color": … }`) or CSV; both stream. Any of them may be gzipped (`.ae.json.gz`). For aegraph's own use there is also the **pack** (`.aeb`, below): the same document as bytes, about a sixth the size and quicker to load.
- **Binary content** (PDFs, images) travels inline as `data:` URLs or by `src`/`sourceUrl` reference; there is no attachment container.

## The pack (.aeb)

`.aeb` is the same `aegraph/v1` document as bytes — what aegraph itself writes when size and speed matter (project bundles on request, and every page of its own IndexedDB store). Other tools should keep producing `.ae.json`; a reader is small, though, and this is the layout (all integers little-endian; *uvar* is unsigned LEB128, *svar* the zigzag-signed form):

```
magic "AEPK"  version u8 (=1)  flags u8 (=0)
string table:  count uvar · each string's length in UTF-16 units (uvar) · byte length u32 · the strings' UTF-8, concatenated
header length uvar
header value   — { exportedAt, tags[], project?, state? } in the value encoding
entity count uvar · entities…
```

A **value** is a tag byte then its payload: `0` null · `1` false · `2` true · `3` integer (svar) · `4` float64 · `5` string (table index, uvar) · `6` array (count uvar, values) · `7` map (count uvar, then key index uvar + value per entry). JSON's rules apply: `undefined` is dropped from maps and becomes null in arrays, NaN and infinities are null, `toJSON` is honoured.

An **entity** is: flags u8 (bit 0 relationship · 1 has label · 2 has description · 3 has extra meta · 4 directed · 5 source has a selector · 6 target has a selector · 7 has data) · id, type (table indices) · label, description when flagged · tag count uvar + indices · `createdAt` and `updatedAt`, each as a marker byte `1` followed by an svar of milliseconds (created relative to the previous entity's created, updated relative to this entity's created) or `0` followed by the original value when it is not an ISO instant with millisecond precision · when flagged, a count uvar of further `meta` entries as key index + value · for a relationship: source id index, its selector value when flagged, target id index, its selector value when flagged · when flagged, the `data` map body (count + entries, without the map tag).

The file is usually **gzipped** as a whole; readers look at the first bytes (`1f 8b` for gzip, `AEPK` for a raw pack) rather than the name. Every string is in the table, decoded with one call and sliced; decoding a pack is faster than parsing the JSON it stands for, and the bytes are about a sixth of the JSON before compression (a third to a half of it after).

## Minimal producer

The smallest useful document a script can emit:

```json
{ "$schema": "aegraph/v1", "entities": [
  { "id": "p1", "type": "person", "label": "Ada Lovelace", "tags": [], "data": {}, "meta": { "createdAt": "2026-09-13T00:00:00Z", "updatedAt": "2026-09-13T00:00:00Z", "source": "import:my-tool" } },
  { "id": "w1", "type": "webpage", "label": "Notes of the Translator", "tags": [], "data": { "url": "https://example.org/notes" }, "meta": { "createdAt": "2026-09-13T00:00:00Z", "updatedAt": "2026-09-13T00:00:00Z", "source": "import:my-tool" } },
  { "id": "r1", "kind": "relationship", "type": "authored", "tags": [], "data": {}, "source": { "id": "p1" }, "target": { "id": "w1" }, "directed": true, "meta": { "createdAt": "2026-09-13T00:00:00Z", "updatedAt": "2026-09-13T00:00:00Z" } }
] }
```

Save it as `something.ae.json`, drop it on *Open project…*, and the person, the page and the link are there — with `person` and `authored` as new types you can then describe.
