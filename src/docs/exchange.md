# Import & export

## Whole workspaces

The Projects dialog's Import and Export tabs (and the assistant's `import_graph` / `graph_export`) read and write aegraph documents: `aegraph/v1` JSON (`{ entities[], tags[] }`), JSONL (one entity per line) and CSV, optionally gzipped — and the **pack** (`.aeb`), aegraph's own binary form of the same document: every string once, fields as flags and varints, gzipped inside; about a sixth the size of the JSON and quicker to load (see File format → The pack). Projects save as `.ae.json` or, from the project menu, as `.aeb`; both open the same way. Imports merge by id; type definitions travel with the data, so vocabulary comes along.

## Graph interchange

| Format | Read | Write | Notes |
| --- | --- | --- | --- |
| GEXF (Gephi) | yes | yes | Positions and colours go into `viz` attributes; node attributes become `data.*`. |
| GraphML | yes | yes | Keys become data fields; positions as `x`/`y` (and `z`). |
| Cytoscape JSON (`.cyjs`) | yes | yes | `elements.nodes[].position` round-trips with the layout. |
| Gephi two-file CSV | yes | yes | `nodes.csv` + `edges.csv` with `Source`/`Target`. |
| Node-link JSON (d3, NetworkX) | yes | — | `{ nodes, links }` (or `edges`): a node is its `id`, else its `name`, else its place in the list; a link's ends are ids, names or indices; the rest are attributes. Through `import_graph`, which also recognises it in a plain `.json` URL. |
| RDF (`.nt`, `.ttl`, `.nq`, `.trig`, `.n3`) | yes | — | Linked data — DBpedia, Wikidata, any triple store. See below. |
| Apache Parquet (`.parquet`) | yes | — | A table of points, and optionally a table of links — how Cosmograph and data tools ship large graphs. See below. |
| PNG / SVG | — | yes | Rendered from the current view with resolved colours, sizes and labels. |

Every CSV aegraph writes — `.ae.csv`, the Gephi pair, a dataset's CSV, a table downloaded from the entity browser — is safe to open in a spreadsheet: a cell that would be a formula there (one starting `=`, `+`, `-`, `@`, a tab or a carriage return, unless it is a number) is written with a `'` in front, which Excel, Numbers and Sheets show as text and do not run. Reading a CSV takes that one `'` off again, so a file round-trips unchanged.

Imported nodes become entities (the type comes from an attribute or a fixed value), edges become relationships, and positions become a **saved layout**. Ids are deterministic per import name, so re-importing updates rather than duplicates. Files over 2 MB go through the dialog's Import tab rather than inline text.

An import touches only what imports made. A node whose id names an entity you already have gets an id of its own unless you tick **Node ids that match existing entities update them** (`mapping.reuse_existing_ids` over MCP, off by default) — and even then it never changes a type definition, a layout, a view, a project or a diagram, and never changes an entity's type. A relationship already there is never rewired to other ends. A node's colour is kept only when it is a colour.

A graph file is read within limits, refused at the bound with a sentence rather than cut short: 128 MB per file (checked before it is read, and as a download arrives), 1,000,000 nodes and 2,000,000 edges; for Parquet, 1,000 columns, 20 million cells, 512 MB once decompressed. A GEXF or GraphML file that declares a document type (`<!DOCTYPE`, `<!ENTITY`) or is not well-formed XML is refused before it is read, and so is one that uses a name like `__proto__` or `constructor` as a key.

### Parquet (Cosmograph, data tools)

Parquet is the columnar file data tools write tables in, and how graph tools such as Cosmograph keep a large graph: a **points** table, one row a node, and optionally a **links** table, one row an edge. Drop one file, or a points and a links file together, on the Import tab; the assistant imports one from a URL with `import_graph` (`url`, and the links file as `edges_url`). Columns are matched by name, as with the Gephi CSV pair:

- **A node's id** is the `id` column (or `node`, `key`, `name`); with none, rows are numbered. When an id repeats — a points table's "id" is often a title, and two papers can share one — the repeat is a node of its own, `id#2`, and a link to the id goes to the first.
- **Its label** is `label` (or `title`, `name`); **its place and look** are `x`, `y` (and `z`), `size`, `color`. Every other column becomes a field, and the wizard (or the tool's mapping) can make one of them the type — a `cluster` column colours the map by cluster.
- **An edge** is a `source` and a `target` (or `from`/`to`, `src`/`dst`), with `label` and `weight` when present; the rest become fields.
- **Positions are rescaled** to a spread that suits the number of points, centred: tools write positions in their own units (Cosmograph's run from 0 to about 12, and it scales them itself), and a hundred thousand points in a twelve-unit square would be a dot. The layout is saved like any imported layout.
- **Snappy-compressed and uncompressed files** are read; a file compressed otherwise (ZSTD, GZIP, Brotli, LZ4) is refused with the codec named — re-save it with Snappy.

A points file is read whole, but only the columns asked for are decoded: over MCP, `parquet.columns` leaves out what is heavy and not needed (a column of abstracts), and `parquet.limit` reads the first rows. Cosmograph's 100,000-paper arXiv map (53 MB) imports in a few seconds and opens in Unigraph with its own layout.

When two different ids would make the same entity id — ids differing only in punctuation, or long ones sharing their first 80 characters — the second gets a distinct id with a short hash, for every graph format; ids that never collide keep the ids they always had.

### Linked data (RDF, DBpedia)

RDF is the standard the web's knowledge graphs are published in — DBpedia (Wikipedia as data), Wikidata, library and museum catalogues, biology — as **triples**: subject, predicate, object. The importer reads N-Triples, Turtle, N-Quads and TriG and turns them into entities the same way each time:

- **Subjects become entities under their compact IRI** — `dbr:Berlin`, `wd:Q64` — so a second file about the same things extends them instead of duplicating, and anything you import later from the same source lands on the same entity. The full IRI stays in `data.iri`.
- **`rdf:type` picks the type**: the most specific class in the ontology's own namespace (`dbo:ProgrammingLanguage` beats `dbo:Work`, `owl:Thing` and the Wikidata/YAGO classes are ignored), written as words (`programming language`).
- **`rdfs:label`** (or `skos:prefLabel`, `foaf:name`, `schema:name`) is the label and **`rdfs:comment`** (or `schema:description`) the description, in the language you ask for (English by default; another only when it is the only one). A DBpedia **`dbo:abstract`** stays in `data.abstract` in full.
- **Other literals become data** keyed by the predicate's local name — `birthDate`, `wikiPageID`, `year` — with numbers and booleans typed by their XSD datatype and several values kept as a list.
- **Categories become tags**: `dct:subject` → *Object-oriented programming languages*.
- **Every other IRI-valued predicate becomes a relationship** typed by the predicate — `influenced by`, `designer`, `birth place` — between the two entities. Things that are only referred to get a stub entity with a label (switch stubs off to leave them out).
- **Wiki plumbing is skipped**: `wikiPageWikiLink`, external links, redirects, revisions, `owl:sameAs`.

The dialog's Import tab has a **Linked data** card: drop a file, fetch DBpedia resources by name (`Berlin, Ada_Lovelace` → `https://dbpedia.org/data/….ntriples`), or open the sample. Everything you fetch or drop goes through the import wizard, which lists the types, tags and predicates it found before writing. Over MCP: `import_graph {format:'rdf', url:'https://dbpedia.org/data/Berlin.ntriples'}` (or `text`), `rdf:{lang, stubs, skip_predicates}` to tune, `dry_run` to look first; `load_dataset {sources:['dbpedia-programming-languages']}` opens the sample.

**Straight from an endpoint.** A SPARQL `CONSTRUCT` URL — Wikidata's `https://query.wikidata.org/sparql?query=…`, DBpedia's — imports in one step: `import_graph` asks the endpoint for N-Triples or Turtle (endpoints such as Wikidata's answer a `CONSTRUCT` in RDF/XML unless asked, whatever `format=` says). Who influenced whom among nineteenth- and twentieth-century philosophers is about 1,300 people and 2,100 links.

**The sample** — the *Programming languages (DBpedia)* demo project, from the `aegraph-ui-demos` repository — is a slice of DBpedia built with SPARQL `CONSTRUCT` and imported through this importer (its generator keeps the N-Triples and the script that fetched them): about a hundred programming languages with what influenced what, who designed and developed them, paradigms, typing, licences, first-release years, categories, and one hop out — the designers with birth dates and places, the companies and universities — every triple exactly as DBpedia serves it.

### Spotify

Your Spotify library as a project, fetched from the Web API by this browser (nothing passes through a server of ours). The dialog's Import tab has a **Spotify** card:

1. **Create an app** at [developer.spotify.com](https://developer.spotify.com/dashboard) (Web API), add the card's callback address as a redirect URI — `https://aegraph.dev/spotify/callback`, or for a local build `http://127.0.0.1:5173/spotify/callback` (Spotify refuses `localhost`) — and paste its **Client ID** into the card. Sign-in is the Authorization Code flow with PKCE, so no secret is involved; the tokens stay in this browser's storage until you sign out.
2. **Import library**: pick what to bring — playlists (with their tracks in order), liked songs, saved albums, followed artists, your top artists and tracks over three time ranges — and whether to make the extra calls that get every artist's genres and every album's record label. Progress is shown page by page; a large library is a few hundred calls.

What comes out is one project, `Spotify · <you>`, with an ontology of six entity types — **listener**, **playlist**, **track**, **album**, **artist**, **genre** — and nine relationship types: a playlist **includes** a track (`position`, `addedAt`, `addedBy`), a track **appears on** an album, a track or album is **performed by** an artist (`position` in the credits), an artist is **in genre** a genre (its genres are also its tags), and the listener **owns** or **follows playlist**, **follows** an artist, **saved** a track or album (`addedAt`), and has **top** artists and tracks (`rank`, `range`). Tracks carry duration, popularity, explicitness, track and disc number, ISRC and the album's release date (`releaseDate` as Spotify gives it, `releaseYear` as a number for charts); albums their kind, release date and precision, track count, record label and popularity; artists popularity and followers; everything links back to Spotify (`url`) and has a cover or image. Ids are Spotify URIs (`spotify:track:…`), so importing again updates the same entities. The project opens on a workstation with the Ontology page beside the whole graph in 2D.

## Views

A view export (`graph_export`, or the Export menu) carries what is in view: the filtered nodes and edges, held positions, and the styles the channels resolved to. The PNG comes back as an image over the bridge so an assistant can look at the result.

## Projects and scenes

A **project** (see [The pipeline](/docs/pipeline#iterating-with-projects)) is the export that stays inside the workspace: members, materialised metrics and provenance as one entity. A **scene** is the whole arrangement — renderer, filter, layout, style, project, analysis options — as one entity. Both are ordinary entities, so they travel in an aegraph document like everything else.
