# Charts

A chart is a picture over entities drawn with Plotly, built in a **Charts** tab of the [Analytics](/analytics) page (a **Scripts** tab is the same in code — a chart's **Script** button writes it out into a new tab beside it). Tabs are named by double-clicking, and right-clicking one lists the saved charts to open. A saved chart opens from the picker or `/analytics/charts?plot=<id>`; older `/scenes?plot=` links land in the same place.

The **Charts** page lists the saved charts as a gallery, each card with a picture of the chart across its top — the marks only, no labels, so a glance tells a monthly line from a pie. The picture is drawn when the chart is saved, from the chart itself rather than from a screen, so a chart saved by the `plot` tool, by the assistant or by the headless engine has one as well as a chart saved here, and it travels with the chart in a bundle (`data.preview`, an SVG). A chart saved before pictures were kept is drawn when the page is idle, one card at a time, and nothing is written back. The picture is the chart as it was saved; open it for the chart as the data stands now.

The builder on the right walks through it: **1 Which entities** (type chips; nothing chosen = the whole dataset), **2 Chart** (the kind as a row of icons, then only the fields that kind needs — *across*, *measure*, *split into series by* — with dates grouped per month by default), **3 Titles and axes**. Between them, **Ready-made charts for these rows** offers a first picture in one click: activity over any date the rows carry, counts over properties with a handful of values, the spread of each number, the first two numbers against each other. Underneath, a chart is a small spec — which rows, one or more traces, a layout — where every axis, colour, size and grouping is a [value reference](/docs/values); the **JSON** toggle shows it. Saved charts are entities (of type `plot`, the spec's name in the data model); the assistant drives the same spec through the `plot` tool.

## Rows

The chart's `selector` picks rows from the **whole dataset** (or the loaded project) — never from the explorer's filter. Leave it empty for everything; choose types with the chips, or narrow further with tags, text and predicates. A trace may carry its own selector.

Or the rows are a **[dataset](/docs/datasets)'s**: **Rows from** at the top of the panel picks one, and the chart draws a point or a bar per row, its axes, groups, colours and sizes reading the dataset's columns (the pickers list them). In the spec that is `dataset: "<id>"`, and a column is `data.<column>` — or, from the assistant, just its name: `{ "dataset": "<id>", "traces": [{ "kind": "bar", "x": "type", "y": "count" }] }` is a bar per type of a table of counts.

## Traces

| `kind` | What it draws | Needs |
| --- | --- | --- |
| `scatter` | one marker per row (or per bin when aggregated) | `x`, `y` — or `x` + `agg` |
| `line`, `area` | the same, joined; `area` fills to zero | same |
| `bar` | bars; several bar traces stack by default | same |
| `histogram` | Plotly's own binning of `x` | `x` |
| `box` | distribution of `y`, one box per `x` category | `y` |
| `heatmap` | counts in `x` × `y` cells (`bin`, `ybin`) | `x`, `y` |
| `pie` | share of rows per value of `x` (default: type) | — |

- **`bin`** snaps `x` before anything else: a time unit (`hour`, `day`, `week`, `month`, `quarter`, `year`) for temporal refs, a width for numbers. Temporal refs are `meta.*` and any `data.*` key whose name says so (`created`, `updated`, `_ts`, `date`, `time`); ISO strings and second-precision stamps are read as dates.
- **`agg`** folds rows that share an `x` (and group) into one point: `count` (no `y` needed), `sum`, `mean`, `median`, `min`, `max`, `distinct` of `y`. When `y` is absent the default is `count`; when `y` is present the default is no aggregation — one point per row. `cumulative` runs a running total.
- **`group`** makes one trace per distinct value (the legend); the 23 largest categories are kept and the rest fold into *other*.
- **`color`** and **`size`** map numeric refs onto markers (scatter/line without aggregation); `palette` picks the colour scale.
- **`text`** is the hover label (default: the entity label).

## Layout

`title`, axis titles and types (`linear`, `log`, `date`, `category` — dates are detected), `barmode` (`stack`, `group`, `overlay`), `showlegend`, `height`.

## Examples

Activity per month, with a running total:

```json
{ "selector": { "types": ["segment"] },
  "traces": [
    { "kind": "bar",  "x": "meta.createdAt", "bin": "month" },
    { "kind": "line", "x": "meta.createdAt", "bin": "month", "cumulative": true, "name": "cumulative" } ] }
```

What the conversations were about, month by month:

```json
{ "selector": { "types": ["segment"] },
  "traces": [ { "kind": "area", "x": "meta.createdAt", "bin": "month", "group": "data.region" } ] }
```

Each segment as a point — messages vs characters, coloured by when, sized by salience:

```json
{ "selector": { "types": ["segment"] },
  "traces": [ { "kind": "scatter", "x": "data.n_messages", "y": "data.chars", "color": "meta.createdAt", "size": "data.salience" } ],
  "layout": { "yaxis": { "type": "log" } } }
```

## From a point to the entities

Every point knows the entities behind it. **Click** or **right-click** a point:

- a single entity (scatter, box, pie of one) — *Inspect here* (the panel becomes the inspector), *Show in Entities*, *Open* (its own page), *Show in 2D graph* (selected and framed);
- a bin or slice with many — *Show all N in Entities* (the table shows exactly those rows, with a removable chip), *Show in 2D graph*, and the first few by name.

**Rows → Entities** in the toolbar sends everything the chart draws to the table.

## Moving around

Drag moves the view; scroll zooms at the pointer; double-click (or **Fit**, or `0`) shows everything again. The hand / box switch in the toolbar changes what a drag does — box mode draws a rectangle to zoom into. **+** and **−** zoom about the centre; arrow keys pan (shift for bigger steps) when the chart has focus.

## Over MCP

`plot {action:"preview", spec}` computes without drawing and returns the stats and the first points of every trace — the way to check a spec. `show` draws it on the Scenes page (and saves it when given a `name`); `save` creates or updates a plot entity; `open`, `list`, `get`, `delete` do what they say. The **JSON** toggle in the panel shows the same spec the tool takes.
