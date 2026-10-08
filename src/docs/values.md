# Values & selectors

One grammar names a value on a node everywhere it matters — filter predicates, placement axes, style channels, sorting, queries. One selector JSON names a set of nodes for every tool that acts on nodes.

## Value references

| Reference | Meaning | Type |
| --- | --- | --- |
| `data.<key>` | A field of the entity's `data` (dotted paths reach nested keys). While a project is loaded, its exported metrics read as `data.<metric>` too. | as stored |
| `meta.updatedAt` · `meta.createdAt` · `meta.accessedAt` | Timestamps as epoch milliseconds — so "most recent" is just "largest". | number |
| `label` · `type` · `id` | The entity's label, type or id. | categorical |
| `tags` | The entity's tags (first tag when a single category is needed). | categorical |
| `degree` · `degree.in` · `degree.out` | Number of edges touching the node, in the current scope. | number |
| `degree:<relType>` · `degree.in:<relType>` · `degree.out:<relType>` | Same, counting only relationships of one type — `degree.in:cites` is "how many things cite this". | number |
| `metric.<id>` | A result of the current view's analysis: `metric.pagerank`, `metric.community`, … | number / categorical |
| `selected` · `pinned` | Whether the node is selected / pinned. | boolean |
| `dataset:<id>.<column>` | A [dataset](/docs/datasets)'s column, read on the entity its row matches: by the dataset's `id` column, else its `type` column (a table per type — every person reads the `person` row), else its first column matched against id, type and label. `dataset:<id>.count` over a table of counts per type colours each node by how many of its type there are. | as stored |

A dataset's column costs one index per version of the dataset — built the first time a reference reads it, rebuilt after an edit — and then one lookup per node. Anywhere a value reference is taken, a dataset's column is too; Unigraph's Style panel lists a dataset keyed by id or type under **From datasets**.

Degrees are counted **lazily**: the first use of `degree.in:cites` builds one index over the scope's edges and reuses it until the scope changes. Untyped view degree short-circuits to the slice's own degree map.

Where a reference is allowed:

| Place | `data.*`, `meta.*`, `label`, `type`, `tags` | `degree…` | `metric.*` | `selected`, `pinned` |
| --- | --- | --- | --- | --- |
| Filter predicate | yes | yes (dataset scope) | **no** — export a project first | **no** |
| Placement axis / order | yes | yes | yes (preview) | yes |
| Style channel | yes | yes | yes (preview) | yes |
| Query sort / values | yes | yes | yes | yes |

`graph_state.valueRefs` lists what the current dataset offers: sampled `data.*` keys with a categorical/numeric hint, degree variants for every relationship type seen, metrics with availability, and the timestamps.

## Predicates

A field predicate is `{ path, op, value }` where `path` is any value reference and `op` is one of `eq`, `neq`, `contains`, `gt`, `gte`, `lt`, `lte`, `between` (value: `[lo, hi]`), `in` (value: a list) or `exists` (no value). Strings compare case-insensitively; numbers as numbers; timestamps as numbers.

## Selectors

Every tool that acts on nodes takes the same selector object. All fields are optional; the empty selector is "every node in view".

| Field | Meaning |
| --- | --- |
| `ids` | Exactly these ids. |
| `selection` | `true` — the current selection. |
| `types`, `tags`, `tag_mode` | Entity types; tags with `any` (default) or `all`. |
| `text` | Free-text match on label, description and data. |
| `fields` | Predicates as above (any value reference). |
| `roots`, `depth`, `direction` | The neighbourhood of `roots`, up to `depth` hops, `out` / `in` / `both`. |
| `scope` | `view` (default) or `dataset`. |
| `sort`, `desc`, `limit` | Order by a value reference and take the first `limit`. |

The result reports `total` (how many matched), `skipped` (predicates that could not be evaluated, e.g. a metric with no analysis), and `outsideView` (how many more would match in the dataset) — the hint to pass `scope: 'dataset'` or loosen the filter.

Examples:

```json
{ "types": ["document"] }
{ "selection": true }
{ "types": ["person"], "fields": [{ "path": "degree.out:authored", "op": "gte", "value": 3 }] }
{ "roots": ["ki-system-aegraph"], "depth": 2, "direction": "both" }
{ "scope": "dataset", "sort": "meta.updatedAt", "desc": true, "limit": 20 }
```

`graph_query { selector, values }` returns the matching nodes as rows of `{ id, type, label, values }` — the way to *look* before you place, style or select.
