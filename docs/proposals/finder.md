# The Finder — from ⌘K to one search over everything

*A design note. Status: draft · 16 September 2026. Builds on §5 of `audit-2026-09-14-model-search-terminology.md` and on ⌘K as shipped in `src/features/search/CommandPalette.tsx`.*

## What ⌘K does today

One box, one keystroke, seven groups — entities (top 8 by substring over label/description/tags/data, label-prefix matches first, views and relationships ranked after), projects (opened on the spot), tags, types, saved views, the latest Insights findings, and the page's actions; recent picks with an empty box. A hit opens where it lives, and ⌘↵ shows it in the graph. It is the right shape and the right keystroke; the rest of this note is about what it cannot yet answer.

## Four questions it cannot answer

1. **"Is it in the Library?"** `store.query` is scoped to the open project, so a thing that exists but is not in the project is simply absent. Finding a known thing is exactly when hiding hurts; and *Add to project* is the action a person wants at that moment.
2. **"Where in the document?"** Bodies are matched (a document's text is in `data`) but never shown: a hit deep in a 40-page document ranks like a label hit and opens at the top.
3. **"Things *about* X"** The local embedding engine exists (`open_entities` uses it) but has no keyboard.
4. **"Give me all of these"** A hit is one thing to open; a set of hits cannot become a table, a graph or a project.

And for agents: `search_entities`, `open_entities`, `graph_query`, `inspect` and ⌘K each define "match" for themselves.

## The engine — one function, two callers

`core/search/finder.ts` (pure; no React, no DOM):

```ts
find(store, registry, q: string, opts: {
  scope: 'project' | 'library'      // default: the open project, else library
  mode: 'text' | 'meaning'          // meaning = local embeddings, opt-in as today
  groups?: Group[]                  // sources | knowledge | views | vocabulary
  limit?: number                    // per group
}) → { groups: { kind, hits: Hit[] }[] }
Hit = { id, label, type, category, score, where: 'project' | 'library', snippet?: { text, selector? } }
```

- **Ranking:** label prefix › label › description › body; a body hit carries a `snippet` (the matching passage, ±80 chars) and, for text bodies, a text-quote selector so the opener lands on it.
- **Scope is a filter on results, not on the store:** `find` reads `store.library` and marks each hit `where`; the caller decides what to show. (Once scope becomes a query facet — audit §5.3 — this is the same call.)
- **Meaning mode:** the vocabulary ranking already in `core/search/vocabulary.ts` picks types and tags; `rankEntityTexts` scores labels+descriptions; for sources, passages (paragraphs / messages) are embedded and cached per entity version by the existing `embedCached`. The download consent is the existing one.

Two callers: the palette, and a `search` tool that returns the same groups (replacing the matching half of `search_entities` and giving `open_entities` its ranking for free). One definition of "match" for people and agents.

## The palette, extended (no new page needed)

- **Scope chip** left of the box: `Project X` ⇄ `Library`, remembered per session. Library-only hits are listed after project hits, greyed, with *Add to project* on ↵⇧ (and in the row menu).
- **Snippet line** under a source hit; ↵ opens at the passage (reader find / video time), the way annotations already do.
- **Meaning toggle** (⌘M in the box, or `?` prefix): the same box, ranked by the local model; the first use asks for the download as today.
- **Group headers are actions:** "Sources · 12" → *Open as a table* (today's pick href) · *Show as a graph* (`roots_match`-style include) · *Add all to project*. This is the "give me all of these" answer without multi-select UI.
- **Full page** `/search?q=` is the same component un-popped, for long result lists; optional, later.

## Sequence

1. `finder.ts` + `search` tool + tests (pure functions; a day). `open_entities` and the palette's entity group switch to it — no visible change yet.
2. Scope chip and Library hits with *Add to project* (needs only `store.library`; half a day).
3. Snippets and open-at-passage for documents and conversations (a day).
4. Meaning mode in the palette (half a day: the engine exists).
5. Group actions (open as table / graph / add all) (half a day).

Each step ships on its own; none touches the store or the file format.

## What this does not do

It does not replace the tables (browsing stays where it is), does not add an inverted index (200 ms over 600k entities measured; passages add a constant factor), and does not decide the navigation question — the Finder works the same whether the sidebar has one door or two.
