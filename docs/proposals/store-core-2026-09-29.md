# A columnar store core, behind `EntityStore` — 2026-09-29

*Status: proposal, not built. Steps 1 and 2 of the same plan are merged (`b29fd141`); this is steps 3 and 4.*

It follows [`performance-2026-09-26-two-million.md`](performance-2026-09-26-two-million.md), which measured the store
at two million and set the trigger for its later stages as "two million is a size we support", and
[`memory-2026-09-26.md`](memory-2026-09-26.md), which measured the whole tab on Toronto's trees. The trigger has been
pulled: the **WildChat conversation atlas** demo ships a million entities and a million relationships (2,086,285
records, 92 MB as a gzipped `.aeb`, 342 MB decoded), and it opens in a tab with little room to spare.

## Where it stands (measured)

Production-shaped build (`vite build --minify false`, `vite preview`), fresh profiles, software GL, a busy machine
(load 8–12), runs alternated with `main`:

| the atlas | before steps 1–2 | after |
| --- | --- | --- |
| open — heap peak | 2.70 GB | 2.42 GB |
| open — CPU to save it locally | 3.6–10.8 s | 16–28 ms |
| reload — heap peak | 3.67 GB | 2.07 GB |
| on disk | 180 MB | 93 MB |
| live heap after GC | 1.47 GB | 1.41 GB |

Of what is left, a CPU profile of the open puts the store's own indexing at **3.5 s** (`upsertMany` → `index`), the
decode at **1.7 s** (`readPack`), the sidebar's counts at **1–2 s** over the open (`sidebarCounts`, a walk of the store each time it recounts)
and the versioning count at 0.56 s. And where the memory is — the real bundle decoded into a real `EntityStore` in
Node, each index emptied in turn and the difference collected (Node's heap, so the totals run higher than the tab's;
the shares are what count):

| | MB | share |
| --- | --- | --- |
| the entity objects, 2,086,285 of them (~860 B each) | 1,793 | 72 % |
| `byTag` — a `Set` of ids per tag | 269 | 11 % |
| `outgoing` + `incoming` — a `Set` per entity | 202 | 8 % |
| the entity table (ids → handles, the entity array) | 106 | 4 % |
| `byType`, `byProject`, `relationshipIds` | 128 | 5 % |

An entity is five allocations — itself, `meta`, `tags`, `data`, `meta.projects` — two ISO date strings, and a tags
array of a dozen strings; the indexes then hold every id again in a set per tag, per type, per project and per end
of every relationship. No cache touches that. The shape of the fix is the one the engine already uses
(`src/core/packed/`): integers and typed arrays, objects only where someone looks.

## What steps 1 and 2 left to build on

- **Handles.** Every entity has one (`EntityTable`, `store.handleOf` / `entityAt` / `idAt` / `handleCapacity`):
  dense, stable, never reused, voided by `clear`. Remove events name the handles they freed.
- **`HandleSet`** — a growable bitset with its size kept — and the working diff of a project already on it.
- **An opened pack is saved as the file** (`BulkSource`), so the file's bytes, not objects, are what the disk holds.

## Step 3 — the core, in stages

Each stage stands alone, keeps `EntityStore`'s API, and is measured on the atlas before the next starts. In
value-per-risk order:

### 3a. Relationship ends as CSR over handles

`outgoing`/`incoming` (202 MB here; 556 MB per million relationships in the two-million review) become a relationship
column of source and target handles (`Int32Array`, −1 for an end not in the store) and an adjacency built from it on
first use: offsets plus relationship handles, one pair of `Uint32Array`s per direction (~20 MB at this size),
rebuilt lazily after structural writes (the `relStructure` counter already says when). `relationshipsOf`,
`neighbors`, `danglingRelationships` keep their signatures. The engine builds the same structure (`physicsCsr`); the
store's can be the one it reads. **Expected: −180 MB, and the per-entity `Set` churn gone from `upsertMany`.**

### 3b. Tags, types and projects as postings over handles

`byTag` (269 MB) becomes a tag column in CSR form (per handle: offsets into one `Uint32Array` of interned tag ids)
plus, per tag, a sorted `Uint32Array` of handles built on demand for `withTag` / `tagUsage`. A tag carried by a large
share of the store could be a `HandleSet`; most tags are sparse — the atlas has 3,196 distinct tags and 9.3 million
occurrences, and only 23 tags are on more than 100,000 entities — so a bitset each would cost more than it saves.
The column and the postings are then ~75 MB of `Uint32Array`s here. `byType` becomes a type column (`Uint32Array` of
interned type ids) with per-type postings; `byProject` a `HandleSet` per project (projects are few), which also
answers scope membership in O(1) and replaces `scopeOf`'s copied id sets. **Expected: the three indexes' 355 MB
become ~95 MB, −260 MB; `upsertMany` stops doing a dozen `Set.add`s per entity, most of its 3.5 s.**

### 3c. Rows in columns, objects on demand

The large one. An entity's fixed fields live in columns by handle: kind and flags (`Uint8Array`), type, label and
description as interned string ids (`Uint32Array`), `createdAt`/`updatedAt` as epoch milliseconds (`Float64Array`),
tags and projects as in 3b, relationship ends as in 3a. `data` and the rare `meta` keys stay in the pack's value
encoding, in a data arena (chunked `ArrayBuffer`s, a handle's offset and length in two columns), decoded when read.
The pack decodes straight into these columns — no object per entity on open, which takes most of the decode's
1.7 s and the insert's 3.5 s with it, and the whole-file page from step 1 reads back the same way.

`store.get(id)` builds the object from its columns and caches it, keyed by handle, with a per-handle version
(`Uint32Array`) so the same object comes back until the entity changes — React and every `prev === e` check keep
working. The cache is bounded (least recently used, weighed in entities); an evicted object is rebuilt, equal but not
identical, which `WeakMap` caches keyed by entity (`searchTextOf`, the table's row text, `textInsights`) survive by
recomputing. A write takes an object as today, writes its columns and re-encodes its `data`, and keeps that object
as the cached one.

**Expected: the objects' 1.8 GB becomes roughly 150 MB of columns and 250 MB of arena, plus whatever the cache holds
— ~0.5 GB for the atlas where 1.4 GB is live today — and an open measured in seconds rather than tens.** The risk is
entirely in step 4: a caller that asks for every object gets them all back.

## Step 4 — the loops that touch everything

Columns pay only if the paths that walk the whole store stop asking for objects. The profiles name them:

| path | today | reads instead |
| --- | --- | --- |
| `sidebarCounts` / `pageCounts` (1–2 s over an open at this size) | `store.all()`, per type | the type column's per-type counts, kept by writes (the store already tallies; the sidebar should read the tally) |
| the Entities table (`query({ type })`, sort, filter) | objects per matching row | type, label, date columns; objects for the rows on screen |
| the graph filter (`applyFilter`) | objects for every candidate | type and tag postings, the relationship CSR; objects for what it keeps |
| text search (`searchTextOf`) | an object and a lower-cased string per entity | the interned label column first; `data` decoded only for entities the label did not decide |
| versioning (`diffWorkingTree`, `hashEntity`) | objects and a JSON hash each | a hash over the record's columns and arena bytes |
| the Ontology page's property counts | `Object.keys(e.data)` per entity | per-type key counts kept from the arena's maps as they are written |
| scripts' snapshots | objects, then JSON | JSON written from columns directly (already scoped by `data.types`) |
| maps (`allGeo`), charts' selectors, the tallies in `scopeWrite` | objects | the columns they read |

To keep this honest the store counts what it materialises (`store.materialized`, a counter and, in development, a
sampled stack per 10,000), and a test opens a generated million-entity pack, visits the pages, and fails when more
than a few thousand objects were built. The audit that produces the table above in full is the first task of step
4, and the counter is how it is done.

## What this is not

- **Not a worker or shared memory.** A store in a worker with `SharedArrayBuffer` needs cross-origin isolation
  (COOP/COEP), which conflicts with embedding the app and with Pyodide's loading. The store stays on the main thread;
  its work gets smaller instead.
- **Not WASM, not a general framework.** Typed arrays and a string table are enough; the engine is the precedent.
- **Not per-project loading** — the memory review's largest open item (the whole Library is in memory whatever
  project is open). It is complementary and probably the larger win for someone with many projects: with pages per
  project, an unopened atlas costs nothing. Columns make each open project cheaper; per-project loading makes the
  others free. Both are worth doing; this proposal is the former.

## Order, and where to stop

1. **3a and 3b** — low risk, no change to what callers see, ~0.45 GB and most of the insert time back at the
   atlas's size. Do them now.
2. **Step 4's audit with the materialisation counter**, against today's object store, so the list above is complete
   and each path's change can be made and measured on its own — each one is a win even before 3c.
3. **3c** only when 3a, 3b and the audit are in and the atlas still does not fit comfortably (a peak under ~1.5 GB
   is the target that leaves a 4.4 GB tab room for everything else). Stop there if it does.

## How to measure it

The benchmark is the WildChat atlas (`aegraph-ui-demos/demos/conversation-atlas/bundle.aeb`, served from a build's
`dist/demos/conversation-atlas/`). Per the repo's rule, the scripts stay out of it; what they do:

- **open**: `project_open_bundle` over the driver with `Profiler.start` around it; the heap sampled each second;
  "saved" is `window.__aegraph.persistence.getStatus()` idle again; the CPU profile summarised by function
  (inclusive and self, `--minify false` so the names survive).
- **reload**: open, wait until saved, `location.reload()`, time until `store.library.all().length` is back, sample
  the heap, then two `HeapProfiler.collectGarbage` for what stays live.
- **anatomy** (Node): decode the bundle with `readPack`, `upsertMany` it into an `EntityStore`, then clear each
  private index in turn under `--expose-gc` and record what `heapUsed` gives back — the table above.

Alternate each build with `main` on the same machine minutes apart; the machine this was written on runs several
sessions and absolute numbers move by a fifth between runs.
