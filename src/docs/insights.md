# Insights

The analytics harness: ask "show me interesting things about this dataset" and get ranked findings, each with a visualization ready to show. Five analyses run over the open dataset (the Library, or the open project), off the main thread, in well under a second for ten thousand entities and fifty thousand relationships.

## The five analyses

| Analysis | Question | Findings |
| --- | --- | --- |
| **Key players** | Which entities matter most, and which hold the graph together? | Hubs by PageRank and how concentrated influence is; bridges — entities on many shortest paths despite few connections; connectors whose neighbours span many communities; the shape of the degree distribution. |
| **Community map** | What are the natural groups, what is each made of, and how do they connect? | Louvain communities named after their most central member, with modularity; what each is made of (types, tags); sealed-off versus porous communities; the strongest cross-community ties. |
| **Ontology in use** | How is the ontology actually used, and how complete is the data? | Type mix; the type × relationship × type patterns and polymorphic relationship kinds; cardinality per kind (1:1, 1:n, n:1, n:n); property coverage against the declared schema; declared types with no entities and types in use without a declaration; types whose instances never link. |
| **Activity over time** | How did the dataset grow, when were the bursts, and which parts have gone quiet? | Creation per period by type; bursts far above the trend; still growing or gone quiet; which types arrived last; staleness by type. |
| **Outliers and gaps** | What looks wrong or missing? | Degree outliers (overall and against their type); isolated entities; duplicate labels; entities missing properties their type usually carries; unlinked pairs that share many neighbours (probable missing links); relationships joining an unusual pair of types. |

Every finding carries a **score** — how far it sits from the unremarkable case, weighted by how much of the dataset it concerns — so the page and the assistant lead with what stands out most.

## Showing a finding

Each finding has one visual:

- **Graph** — the Graph Explorer, filtered (the neighbourhood of the entities in question on large datasets), styled (colour by community or type, size by PageRank, betweenness or degree) and with those entities selected.
- **Plot** — a chart on the Scenes page. The run's metric columns are lent to the plot builder, so `metric.community`, `metric.pagerank` and `metric.betweenness` appear in the pickers and work in specs until the dataset changes. A Stats run in the explorer over the whole dataset (no filter) lends its columns the same way, through the shared metrics cache.
- **Table** — the rows behind the claim, on the Insights page.

## Keeping a finding

A finding is a sentence with numbers behind it; it lives only as long as the run. Two actions turn one into knowledge:

- **Save as claim** makes a *claim* entity — the finding's title as its label, the detail as its description, the analysis, score and rows in its data — and links every entity the finding names to it with a `supports` relationship. Saving the same finding after a re-run refreshes the claim (new numbers, new evidence) rather than making a second one. The `claim` type is defined on first use if the workspace has none.
- **Name a community** (on a Community map finding, or *Name this community…* on a node's menu in Unigraph once communities are computed) makes a *community* entity every member belongs to through `member-of`, so a detected group can be filtered, styled, linked and asked about like anything else. Naming it again renames it.

Claims and named communities are listed on the Ontology page's **Claims** tab with their evidence and members, each openable as a table or as a graph of itself and what supports it. They are entities like any other, so the next run sees them too — a large named community becomes a hub in the Key players analysis, which is what it is.

**Ask** on any finding hands it to the assistant with the entities involved, for an explanation and where to look next.

## From the assistant or over MCP

`analyze {action:"run"}` runs the analyses and returns a Markdown briefing plus the ranked findings; `{action:"show", finding:"communities:overview"}` puts one on screen (`save_as` keeps a plot as an entity); `{action:"get"}` returns a finding's data rows; `{action:"findings"}` re-reads the latest run; `{action:"keep", finding}` saves a finding as a claim with its evidence (what **Save as claim** does); `{action:"name_community", community, label}` names a Louvain community of the latest run as a community entity its members belong to; `{action:"catalog"}` lists the analyses. A run over the same nodes and edges is reused until `force` is passed.

## Where it lives

The analyses are a standalone package, `src/analysis/`: pure functions over a columnar input (ids, types, labels, tags, property keys, timestamps, edges as typed arrays), returning findings whose visuals are the app's own plot and filter specs. Nothing in it touches the store, React or the DOM, so it runs in a worker and in tests unchanged, and a new analysis is one file plus a catalogue entry.
