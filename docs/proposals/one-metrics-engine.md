# One metrics engine — what is already true, and the one thing missing

*A note. Status: correction and small proposal · 16 September 2026. Amends §3 ("Analysis in three places") and gap #6 of `audit-2026-09-14-model-search-terminology.md`.*

## Correction

The audit said PageRank and Louvain were "computed by three implementations". Reading the two packages side by side shows one implementation and two callers:

| | Stats tab / `graph_metrics` | Insights / `analyze` |
| --- | --- | --- |
| Kernels | `core/graph/metrics/csr.ts` (degree, components, clustering, path stats, betweenness, closeness, PageRank, eigenvector, HITS) + `graphology-communities-louvain` via `compute.ts` | **the same** — `src/analysis/run.ts` imports `computeMetrics` from `core/graph/metrics/compute` and runs it once per analysis run, over the union of the metrics the chosen analyses declare |
| Input | the explorer's slice (`serializeSlice`) | the dataset — Library or open project — as a columnar `AnalysisInput` |
| Worker | `metrics/analysis.worker.ts` | `analysis/worker.ts` (runs the metrics stage then the five analyses) |
| Result kept | `state.metrics` in the explorer (per view; stale when the slice changes) | `features/analysis/latest.ts` (per dataset; lent to plots as `metric.*`) |
| Writes back | `write_to_entities` → `data.<prefix><metric>` | *Save as claim* / *Name this community* → entities |

So there is nothing to unify in the algorithms. The audit's item 6 should read: **one engine, two runs that never share a result, and three names.**

## What is actually duplicated: the run

Open the Graph Explorer on the whole project with the Stats tab, then Insights: PageRank, betweenness and Louvain are computed twice over the same nodes and edges, in two workers, because each side keys its own result. On the 5,000-node view a metrics run is several seconds; Insights repeats it.

## Proposal (small)

1. **A shared result cache in `core/graph/metrics`:** `metricsCache.get(sliceKey, options) / put(result)`, in-memory, a handful of entries, keyed on the slice key (`serialize.ts` already fingerprints node and edge ids) plus the option set. `runMetricsInWorker` and the Insights runner both consult it before starting a worker, and both put their result. When the explorer's view *is* the dataset (no filter), a Stats run makes the Insights metrics stage instant and vice versa; when it is not, nothing changes. `computeMetrics` itself stays pure. Half a day, with a test that the second call with the same key does no work.
2. **Insights can take the explorer's slice as its input** — an *Analyse this view* button on the Stats tab (and `analyze {scope: 'view'}`), which is what a person who has just filtered to a neighbourhood expects. The `AnalysisInput` builder already accepts any entity list; it is a second entry point, not a new path. Half a day.
3. **Names.** Keep *Analysis* for what is computed (the Stats tab's title, the `analysis` entity, `graph_metrics`); keep *Insights* for the findings page; rename the *Analytics* page — which is charts and scripts — to **Workbench** (or *Charts & scripts*), so no two sidebar items share a stem. A copy change plus the route alias; no data changes.

## What this does not touch

The `src/analysis` package's own scoring, narration and visuals; the metrics options and sampling thresholds; the `analysis` entity format.
