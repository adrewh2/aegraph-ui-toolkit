# analysis

The analytics harness: five analyses over one columnar `AnalysisInput`,
each returning ranked `Finding`s with the numbers behind them and a
`Visual` the app can put on screen (a plot spec, a styled graph view, or a
table). Pure TypeScript — no React, no DOM, no store — so it runs in a Web
Worker (`runAnalysesInWorker`) and in tests (`runAnalyses`) unchanged.

| id            | question                                                                      |
| ------------- | ----------------------------------------------------------------------------- |
| `centrality`  | Which entities matter most, and which hold the graph together?                |
| `communities` | What are the natural groups, what is each made of, how do they connect?       |
| `schema`      | How is the ontology actually used, and how complete is the data?              |
| `temporal`    | How did the dataset grow, when were the bursts, what has gone quiet?          |
| `anomalies`   | What looks wrong or missing: outliers, orphans, duplicates, missing links?    |

Adding an analysis: a function `(ctx: Context) => Finding[]` in `analyses/`,
an entry in `ANALYSES` (declaring the metric columns it reads, computed
once per run and shared) and a line in `RUNNERS`. Scores are 0–1
"interestingness": distance from the unremarkable case, weighted by how much
of the dataset the finding concerns; the runner keeps the best few per
analysis and ranks across them.

Dependencies: `core/graph/metrics` (CSR + metric kernels) and the
`PlotSpec` / `FilterSpec` types, so visuals are the app's own specs.
The app side (`src/features/analysis/`) builds the input from the store,
keeps the latest run so plots can read `metric.<id>` refs, and turns
visuals into open views.
