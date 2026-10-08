# The pipeline

Every graph view is the result of the same six stages, always in this order:

```
Dataset ──▶ Filter ──▶ Layout ──▶ Style ──▶ Analysis ──▶ Export
   │                                              │          │
   │            (preview: layout/style may        │          │
   │             read this view's metrics) ◀──────┘          │
   │                                                         │
   └──────────── a project loads as the next Dataset ◀───────┘
```

| Stage | Reads | Produces |
| --- | --- | --- |
| **Dataset** | the workspace, or a loaded **project** | the nodes and relationships anything downstream may see |
| **Filter** | dataset facts: type, tags, text, data fields, structural degree, neighbourhood | the **view** (a slice: nodes + edges in scope) |
| **Layout** | the view, plus values for placements | held positions |
| **Style** | the view, values, and (as a preview) this view's metrics | colours, sizes, shapes, visibility |
| **Analysis** | the view | metrics per node (`metric.<id>`) and view summaries |
| **Export** | everything above | a **project** entity, or a picture / interchange file |

The explorer's panel buttons — Filter, Layout, Style, then the statistics — are the stages in this order. The statistics panel says when the view changed since the analysis ran; Layout and Style may read metrics from the current view as a preview of the next iteration.

## Why one fixed order

The tempting alternative — analyse first, then filter by the result (*"show me the top 20 by PageRank"*) — creates a loop: the filter changes the view, the view changes the metrics, the metrics change what the filter matches. Two views that look the same could mean different things depending on which ran first.

So the filter **never reads this iteration's metrics**. A predicate on `metric.*` is rejected with a pointer to the export step; `selected` and `pinned` are rejected too, because pruning the selection to the view would make them oscillate. Structural references such as `degree.in:cites` are fine in a filter: they are dataset facts, counted over the Dataset stage, not over the view.

## Iterating with projects

"Filter by analysis" is spelled as an iteration:

1. Run the analysis on the view (Stats tab, or `graph_metrics`).
2. **Export** the view as a **project** (Export ▸ *Export view as a project…*, or `graph_project {action:'export'}`). The project stores the members (node and relationship ids), the metric columns materialised per node, and its provenance (parent project, filter, layout, style, analysis).
3. **Load** the project (Export ▸ *Use a project as the dataset…*, or `graph_project {action:'load'}`). It becomes the Dataset stage; a line above the tabs shows `Workspace ▸ Ranked` with a way back.
4. Now the exported metrics read as **data**: `data.pagerank` works in a filter, a placement, a style channel or a query, exactly like any field.

Each export from a loaded project records its parent, so subprojects on the same data are just the chain: `Workspace ▸ Ranked ▸ Ranked · communities ▸ …`. Unload to return to the workspace.

## Scope

- **View** scope is the filtered slice: what you see. Selection, paths, layouts, styles, analyses and placements all work here; `degree` in a placement or a style means in-view degree.
- **Dataset** scope is everything the filter could see: the workspace, or the loaded project. Filters evaluate their values here; `graph_query` and `graph_positions get` accept `scope: 'dataset'` to reach nodes that are filtered out.

## Staleness and auto mode

The analysis belongs to a specific slice (a key over its node and edge ids). When the filter changes, the Analysis chip and the Stats tab show *stale* and the style channels that read metrics show a warning until you re-run. **Auto** (Stats tab, or `graph_metrics {auto:true}`) re-runs the analysis, debounced, whenever the view changes and something is reading metrics.

## Worked examples

- *Communities of what I'm looking at*: filter, run Louvain, colour by `metric.community`. View scope; one iteration.
- *Top 20 by PageRank*: run PageRank, export as project *Ranked*, load it, filter `data.pagerank` descending with a node cap of 20 (or use `graph_query` with `sort: 'data.pagerank', limit: 20` and select the result).
- *Documents on a grid by citations × references, coloured by recency*: no analysis needed — `degree.in:cites`, `degree.in:references` and `meta.updatedAt` are dataset facts. See [Position layouts](/docs/positions#example).
