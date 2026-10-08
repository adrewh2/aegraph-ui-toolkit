# Analysis

The statistics panel and `graph_metrics` compute network statistics for the **current view** — the filtered slice, never the whole workspace. Computation runs in a worker over a compact CSR representation; the explorer stays responsive and a run can be cancelled.

## Metrics

| Metric | `metric.<id>` | What it measures |
| --- | --- | --- |
| Degree, in-degree, out-degree | `degree`, `inDegree`, `outDegree` | Edges touching the node. |
| Weighted degree | `weightedDegree` | Sum of edge weights (needs a weight field). |
| PageRank | `pagerank` | Importance by incoming links from important nodes. |
| Betweenness | `betweenness` | How often the node sits on shortest paths (bridges). |
| Closeness | `closeness` | Inverse average distance to every reachable node. |
| Eigenvector | `eigenvector` | Connected to other influential nodes. |
| HITS hub / authority | `hub`, `authority` | Points at good authorities / pointed at by good hubs. |
| Clustering coefficient | `clustering` | How interconnected the neighbours are (0–1). |
| Component, component size | `component`, `componentSize` | Connected component id (0 = largest) and its size. |
| Community (Louvain) | `community` | Modularity-maximising community id. |

View summaries: node and edge counts, density, average degree, component count, giant component size, diameter and average path length, modularity.

## Sampling

Betweenness and closeness are quadratic; above 3,000 nodes they are estimated from 400 sampled sources. Path statistics are exact below 1,500 nodes and sampled from 200 roots above. The seed is fixed, so a re-run gives the same estimate.

## Using the results

- **Style** by a metric: a ranking channel on `metric.pagerank`, a partition channel on `metric.community`.
- **Place** by a metric: a scatter of `metric.pagerank` × `metric.betweenness`. This is a preview of the next iteration; the pipeline bar draws the feedback arrow.
- **Write back** (`write_to_entities`) copies the values into each node's `data.<prefix><metric>`, making them ordinary fields everywhere — including in filters — at the cost of editing the entities.
- **Export a project** keeps the entities untouched and materialises the values as project data instead. See [The pipeline](/docs/pipeline#iterating-with-projects).
- **Save** the analysis as an entity (columnar, keyed by node id, with the slice key it belongs to); load it later without recomputation. Loading a saved analysis onto a different slice marks it stale.

## Staleness and auto

Every analysis belongs to one slice key. When the view changes, the results are *stale*: they still colour the nodes they cover, the statistics panel says so, and the pipeline bar marks the Analysis chip. *Auto* re-runs (debounced) whenever the view changes and something is reading metrics.

## One result, every caller

Results are kept in a small in-memory cache keyed on the slice and the options that change a column. A request the cache already answers — the same nodes and edges, the same weighting and direction, every column asked for present, and the same Louvain, sampling and path settings where they matter — returns at once, narrowed to the columns asked for; the Stats tab marks it *cached* and `graph_metrics` returns `cached: true`. A request the cache answers only in part — a column or the path statistics missing — computes just that in the worker and merges it with the columns lent by the earlier result (the Stats tab says *n reused*, `graph_metrics` lists them under `reused`); the merged result then answers the next caller whole. [Insights](/docs/insights) consults the same cache: when the explorer shows the whole dataset, a Stats run makes the Insights metrics stage instant, and a Stats run after Insights computes only the path statistics Insights skips. The cache holds a handful of slices (about 64 MB of columns at most) and empties with the page.
