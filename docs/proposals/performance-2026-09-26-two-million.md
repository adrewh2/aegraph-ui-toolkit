# Two million entities: what it costs, and what to do about it — 2026-09-26

The target this measures against: a Library of **1,000,000 nodes and 1,000,000 relationships**, and an app that
feels like an operating system rather than a page — nothing the pointer touches takes longer than a frame or two.

Measured on an M-series Mac against a **production build** (`vite preview` of `dist/`) through the headless driver
(`GL=hw node mcp/drive.mjs`), and in Node for the parts that are pure computation. Wall-clock numbers were taken on
a machine running several other sessions: the ones below that compare two builds were taken back to back on the
same machine minutes apart, and the Node ones are single-threaded and repeatable. The bundle is generated
(`person`/`organisation`/`work`/`place`/`topic`/`event`, four data fields and two tags each, `knows`/`member_of`/
`cites`/`located_in` between them): 106 MB packed, 33 MB gzipped.

## What was wrong, and what it cost

Every one of these was a walk over the whole store, on a path that runs after **every write**:

| Read | Why it walked | 2M, before | after |
| --- | --- | --- | --- |
| `countByTypeAndKind()` | asked every id whether it was a relationship | 385 ms | **0 ms** |
| A `TypeRegistry` after a write | it calls the above | 366 ms | **0 ms** |
| `relationships()` after a write | collected a million ids into a new array | 137 ms | **0 ms** |
| `tags()` / `tagUsage()` in a project | `all().flatMap(e => e.tags)` — an array per entity | 235 ms | **0 ms** |
| **The first reads after one entity is edited** (in the browser, 2M loaded) | all of the above together | **626 ms** | **0 ms** |
| `query({ text })`, warm | a `WeakMap` lookup per entity | 524 ms | **76 ms** |
| `query({ type: [...] })` | an array per type, then a flatMap, then the filter | 234 ms | 167 ms |
| Opening the 2M bundle | one synchronous insert | one **6.4 s** task | 9 tasks, longest **1.5 s** |

The fixes, all in `core/entity/store.ts` unless noted:

- **Counts are kept, not counted.** `entityTypeCounts` / `relationshipTypeCounts` follow `index` / `reindex` /
  `unindex`, so `countByTypeAndKind` is one entry per type however much the store holds.
- **`relationships()` is keyed on the relationships.** `relStructure` is bumped only when a relationship is
  written or removed; an edit to anything else hands back the very same array (the test asserts the identity).
- **A project's tags are a tally on the scope**, maintained in `tally` and in `scopeWrite` — including the case
  that first slipped through, an entity already in scope whose tags changed.
- **`query` by type reads the id indexes straight into the array it returns** — one pass where there were three.
  (Written out rather than handed to a generator: at a million rows a `yield` per entity costs more than the
  array it saves. Measured: the generator was *slower* than what it replaced, 559 ms against 332 ms.)
- **The search text lives on the entity**, under a non-enumerable symbol, instead of in a `WeakMap`: the lookups
  alone were 243 ms of a 394 ms warm scan. `JSON.stringify`, a spread and a structured clone all skip it, and an
  edit makes a new object that has none.
- **A big open goes in chunks** (`importBundleAsync`, `store.transactionAsync`): 25,000 entities, then a turn of
  the event loop, with the transaction still holding the events so nothing downstream sees a half-open project.

## What is still slow at two million, in order

1. **The Entities table materialises every matching row on each write** — `query({ type: typeNames })` at 2M is
   ~170 ms, and the table's own filter/sort passes follow it. This is the bulk of the ~3.5 s task an edit still
   costs with that page open. It wants columns for what it sorts and filters on (label, type, `updatedAt`) so it
   can page over typed arrays and build objects only for the fifty rows on screen.
2. **The Ontology page walks everything for property counts** (`schema.ts`, `tagStats.ts`: `Object.keys(e.data)`
   per entity) — ~2.5 s at 2M. Either sample past a threshold and say so, or keep per-type property counts in the
   registry.
3. **Memory is the ceiling.** 2M entities is 1.7–1.9 GB of heap, and at that size V8's own work (`(program)` and
   GC) is ~2.3 s of a 2.8 s working window during an edit — after the store's share of it was removed. Measured
   per entity at 1M:

   | | object | index | each |
   | --- | --- | --- | --- |
   | id and type only | 296 MB | 113 MB | **409 B** |
   | + label, 2 tags, 4 data fields | 567 MB | 202 MB | **769 B** |
   | 1M relationships | 415 MB | **556 MB** (`outgoing`/`incoming`) | 971 B |

   An entity with nothing in it costs 400 bytes because it is five allocations (the entity, `meta`, `tags`,
   `data`, `projects`) and two ISO date strings. No cache touches that.

## The store, if two million becomes a working set

In value-per-risk order. Nothing here is a rewrite; each stage stands alone.

1. **Relationship endpoints as CSR** rather than `Map<id, Set<id>>`: 556 MB today for a million relationships,
   ~16 MB as two `Uint32Array`s and offsets — **60×** on one structure, behind `relationshipsOf` / `neighbors`,
   which is the whole API surface. The engine already builds exactly this (`engine/engine.ts` › `physicsCsr`).
2. **`meta` dates as epoch numbers; ids and types interned.** Two strings and an object less per entity, and
   sorting by `updatedAt` stops parsing dates.
3. **Columns for what the table sorts and filters on.** This is what makes the Entities page at 2M feel like the
   page at 2k — see (1) above.
4. **Columnar rows with objects materialised on demand** (`store.get(id)` builds one when someone needs one),
   only if 2M is routine. The `.aeb` pack is already column-ish, so decoding straight into columns would also take
   most of the 6.8 s insert away. The hard part is open `data`: follow the ontology's declared properties per type,
   with a JSON column for the rest.

*Followed by [`store-core-2026-09-29.md`](store-core-2026-09-29.md): handles and bitsets are in, and the stages
below are planned there against the million-entity WildChat atlas.*

**Where to stop.** Everything above scales linearly, so at 200,000 entities today's store answers a type query in
17 ms, a text filter in 8 ms, and holds ~170 MB. Below a few hundred thousand none of this pays and the complexity
would cost more than it buys. The trigger for stages 3 and 4 is "two million is a size we support", not "two
million is possible" — it already is.

## How to measure it again

`src/core/entity/__tests__/store-incremental.test.ts` pins the invariants as identities and totals, so it says
nothing about the machine. For the numbers, generate a bundle of the size you want with `packDocument`, serve
`dist/` (`npm run build && npx vite preview`), and drive it: the scripts used here are `scale-ui.mjs` (long tasks
per interaction) and `store-micro.mjs` (the store's own reads, timed in-page, which is far less noisy than
long-task totals on a busy machine). Measure the production build — dev-mode React roughly doubles every number
and its own instrumentation shows up in the profile.
