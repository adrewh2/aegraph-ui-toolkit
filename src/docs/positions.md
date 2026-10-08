# Position layouts & placement

A **position layout** is a map from entity id to `{ x, y, z? }`. There can be as many as you like for the same data; each is a layout entity, and the explorer holds one at a time.

## Held vs saved

- **Held** positions are the session's working copy: what dragging, algorithms and placements write to, and what both renderers read. Moving a node changes the layout of your session, never the scene's committed layout — only *Save* writes it back, and *Save as* writes a new layout entity. Held positions survive a reload (per session: in the browser's local storage, or IndexedDB past a thousand nodes): they are written a moment after the last move, and at once when the page is hidden or left, so a reload straight after a drag keeps it. They stop physics when written over the bridge.
  They accumulate: every graph the session has laid out stays held, visible or not, so a saved layout reproduces everything you have been looking at. Moving a node costs that node alone however large the set has grown — the working layout is a granular store, not a copied object.
- **Saved** positions are a layout entity (`graph_save {kind:'layout'}`, or *Save* in the Layout tab). A saved layout keeps the algorithm name, the pinned set and — when the positions came from a placement — the **rule** that produced them.

Loading a layout that lacks positions for some nodes in view leaves those nodes where the algorithm would put them; the rest stay exactly where they were saved.

## 2D and 3D are one layout

Switching `/unigraph/2d` ↔ `/unigraph/3d` never recomputes held positions. The 3D view reads `z` when present (a 2D-made layout is a flat plane at `z = 0`); the 2D view ignores `z`. A layout's `dimensions` field is informational. Only an empty position set triggers a layout run on switch.

## Placement

`graph_positions {action:'place', selector, spec}` (or the Layout tab) arranges the selected nodes from their values in a region of the view.

**Arrangements**

| `arrangement` | What happens |
| --- | --- |
| `grid` | Rows and columns filling the region; `order` (+ `desc`) sorts, `cols` fixes the column count, `spacing` fixes the cell size. |
| `scatter` | `x` and `y` (and `z` in 3D) are value references mapped onto the region with `scale` `linear`, `log` or `rank`. With `bins: {x, y}` it becomes a **heatmap grid**: values snap into cells and nodes sharing a cell are packed on a small sunflower spiral (`jitter: 'none'` stacks them). |
| `circle` | Around the region's centre: evenly in `order`, or at an angle from `x` and a radius from `y`. |
| `line` | Along the region's width by `x` (binned with `bins.x`). |
| `stack` | One column per category of `x` (default `type`), nodes piling upward inside each column (`bins.x` caps the categories; the rest go to *other*). |
| `geo` | Every node where it is on Earth: Web Mercator of `y` (latitude, default `data.lat`) and `x` (longitude, default `data.lng`), north up, fitted to the region **without stretching** — a city keeps its shape. Nodes without coordinates are parked. A map's **Unigraph** button opens its rows with this as the rule in force; the assistant's *"load all the trees into Unigraph with fixed positions"* is `{arrangement: 'geo'}`. |

Nodes missing a value are parked on a strip beside the region and reported as `unplaced`.


**Regions**

```json
{ "of": "viewport", "anchor": "top-left", "size": { "fraction": 0.45 }, "margin": 20 }
```

- `of`: `viewport` (what is on screen right now — the default), `bbox` (the bounding box of everything held) or `rect` (an explicit rectangle).
- `anchor`: one of the nine positions `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right`. **y is up**: `top` means the largest y.
- `size`: `{ fraction }` of the base, or `{ w, h }` in graph units; `margin` insets from the base.

In 3D the viewport is the rectangle the camera sees in the plane through its look-at point (reported `tilted` when the camera is not top-down).

The result reports the region, the axes (domain, scale, nice tick positions in graph coordinates), the non-empty cells with counts, and the placed / unplaced counts. In 2D the **placement overlay** draws the region, the cell shading and the tick labels in graph coordinates, synced to the camera without re-rendering React; toggle it in the Layout tab or with `graph_layout {overlay:false}`.

## The rule

A placement is remembered on the layout as a rule: `{ selector, spec }`. The Layout tab shows *Derived from: scatter degree.in:cites × degree.in:references · 5×5 bins · top-left of viewport*. After the data changes — new citations, edited documents — **Re-derive** (`graph_layout {rederive:true}`) runs the rule again against current values; *Clear rule* keeps the positions and forgets how they were made. Recomputing an algorithmic layout clears the rule.

## Transforms

`graph_positions {action:'transform', selector, transform}` moves a group as a whole: `translate {dx, dy, dz}`, `scale` (a number or per-axis) and `rotate` (degrees) `about` the centroid, the origin or a point; `align` (`left`, `right`, `top`, `bottom`, `center-x`, `center-y`) and `distribute` (`x` or `y`) against `to` (a rectangle; default the group's own box).

## Example

*"Move all my documents into a grid at the top-left of the current view, x = number of citations, y = number of references, colour = most recently edited":*

```json
graph_positions {
  "action": "place",
  "selector": { "types": ["document"] },
  "spec": {
    "arrangement": "scatter",
    "x": "degree.in:cites", "y": "degree.in:references",
    "bins": { "x": 5, "y": 5 },
    "region": { "of": "viewport", "anchor": "top-left", "size": { "fraction": 0.45 } }
  }
}
graph_style {
  "channels": [{ "scope": "nodes", "by": "types", "key": "document", "channel": "color",
                 "mode": "ranking", "attr": { "kind": "value", "ref": "meta.updatedAt" }, "palette": "viridis" }],
  "legend": true
}
```

`graph_query {selector:{types:['document']}, values:['degree.in:cites','degree.in:references','meta.updatedAt']}` shows the numbers first if you want to look before placing. No analysis is involved: citations, references and edit times are dataset facts.
