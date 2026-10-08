# Where a regression would go unnoticed — test coverage gaps

*An audit. Status: findings and a ranked list · 16 September 2026.*

Two questions, answered mechanically and then read with the use cases in mind (`src/docs/use-cases.md`): which of the 78 tools in the manifest does no test or smoke step ever call, and which `src/core` modules does no test import, directly or through their package index.

## Tools: 58 of 78 exercised

Exercised means: called through `createAppTools` in `src/features/assistant/__tests__/*` (with the fake host and explorer), or called over the bridge by a step in `mcp/smoke/*.mjs`. Twenty tools are never called:

| Group | Tools never called | What a regression breaks |
| --- | --- | --- |
| Projects | `project_open`, `project_add`, `project_remove`, `project_update`, `project_delete`, `project_publish`, `project_template` | The organising model of the Library (use case 9). `project_create`, `project_list`, `project_save` and `project_open_bundle` are smoke-tested; the seven that change membership or delete are not. `project_delete` is destructive. |
| Maps | `create_map`, `add_location`, `add_path`, `add_area`, `annotate_map`, `enrich_location`, `map_state` | Every map job over MCP (use case 3). The `geo` selector, KML/GeoJSON and Douglas–Peucker have unit tests in `core`; the tools that write locations, paths and areas as entities have none. `enrich_location` calls Nominatim and needs a stubbed `fetch`. |
| Insights | `analyze` | The only MCP entry to the analytics harness (use case 6). `runAnalyses` and the five analyses are tested in `src/analysis`; the tool's five actions — run, findings, get, show, catalog — and the `force` / cache path are not. |
| Media | `capture_video_frame`, `create_video`, `create_image` | Video and image resources over MCP (use case 2). `capture_video_frame` needs a tab; the two creators are plain entity writers. |
| Schema | `list_properties`, `validate_ae` | Property discovery and file validation for agents. Low blast radius; both are thin over tested core code. |

## Core: what no test reaches

Of 91 modules under `src/core`, most are imported by a test or reached through a package index. Reading the remainder:

| Module | Lines | Reached by | Risk |
| --- | --- | --- | --- |
| `entity/persistence.ts` | 318 | `mcp/smoke/2-relaunch.mjs` only (a live relaunch) | **High.** The IndexedDB store of the Library: pages, tombstones, the save queue. A regression loses the user's data; the smoke step catches a total failure, not a partial one (a tombstone that resurrects, a page that is skipped). No unit test because there is no IndexedDB in Node — `fake-indexeddb` is not a dependency. |
| `graph/style.ts` | 67 | nothing (until this audit) | Medium: node and edge colours everywhere; the hsl→hex conversion sigma depends on. **Tests added in this commit** (`graph/__tests__/style.test.ts`). |
| `diagrams/dotPatch.ts` | 199 | `diagrams/__tests__/sync.test.ts`, through `sync.ts` | Covered indirectly by "is edited in place when the drawing moves, adds and removes things"; no direct test of the shapes it refuses (chained edges, several statements a line). Acceptable. |
| `resources/seed.ts` | 202 | nothing | Low: demo seeding. |
| `exchange/pack/bytes.ts` | 200 | `pack/__tests__/bench.test.ts` through the pack index | Covered by the round trip. |
| Workers (`layout.worker.ts`, `analysis.worker.ts`, `generate.worker.ts`) | — | the headless smokes | Not testable in Node; their pure cores are. |

## Ranked

1. **Project tools** (b17). A test file over `createAppTools` with the fake host: create → open → add two entities → `project_update` → `project_remove` → `project_delete` with the confirm stubbed both ways; `project_template` and `project_publish` on the result. Half a day.
2. **Map tools** (b18). `create_map` → `add_location` (by coordinates; the search path with `fetch` stubbed) → `add_path` → `add_area` → `annotate_map` → `map_state`, checking the entities and selectors written; `enrich_location` with a canned Nominatim reply. Half a day.
3. **`analyze` tool** (b19). Run over a small store, then `findings`, `get`, `show` (the fake host records the route), `catalog`; a second `run` without `force` returning the cached report. Two hours.
4. **Persistence** — worth a unit test only if `fake-indexeddb` is added as a dev dependency (a decision for the owner); until then the relaunch smoke stands.

Not a gap: the explorer tools, documents, annotations, diagrams, scripts, plots, datasets and bundles all have tests through the fake explorer or a smoke step.

## Method, for repeating it

```
grep -ho "name: '[a-z_0-9]*'" src/features/assistant/*Tools.ts | sort -u          # the manifest
grep -ho "tool(tools, '[a-z_0-9]*'\|run('[a-z_0-9]*'\|name === '[a-z_0-9]*'" src/**/__tests__/*.ts
grep -ho "call('[a-z_0-9]*'" mcp/smoke/*.mjs                                       # exercised
```

The difference is the first table. For core, a module counts as reached when a test imports it or its package index; the table above was checked by hand for the indirect cases.
