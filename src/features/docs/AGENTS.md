# `src/docs` and `src/features/docs` — the in-app documentation

(This guide lives beside the page registry because every `.md` under `src/docs` is a served page — a test enforces it.)

The manual the app serves at `/docs`, one Markdown file per page, registered with a title, blurb and group in `src/features/docs/pages.ts`, in reading order. The assistant reads these pages too (`docs` tool; it is told which page is on screen), so they double as the model's knowledge of the product. `toolReference.ts` appends the tool reference to the Assistant page from the live manifest; `lookup.ts` splits pages at headings for search and for the tool.

## Groups and pages

- **Start here** — `about` (what it is, the model, *What is built*, where it is going), `roadmap` (the ontology gaps), `overview`, `workflow` (a walk-through), `navigation` (the pages, ⌘K, tables, the inspector, the Workstation, the keys), `use-cases`, `model` (live).
- **Working with data** — `exchange`, `projects` (scopes, bundles, versions, templates, publishing), `resources` (documents & media, annotations), `diagrams`, `maps`.
- **Graph** — `explorer`, `pipeline`, `values`, `positions`, `analysis`, `insights`, `plots`, `scripts`, `datasets`.
- **Reference** — `spec` (the file format), `constraints`, `assistant` (assistant, voice, bridge, the generated tool reference), `smoke`.

A page about a feature a deployment can turn off (`app/features.ts`) carries `feature` in `pages.ts` (`maps`): with it off, `DOC_GROUPS` and `DOC_PAGES` leave it out, so the rail, search, the `docs` tool and its address (which goes to the first page) do not know it. The tool reference leaves out the absent tools by itself, being generated from `createAppTools`.

## The parity checklist

A change a user can see is not done until this is done, in the same commit:

1. **The feature's page** says what it does now — a new section for a new concept, an edited sentence for a changed one. Present tense, the reader is the user of the app; say what and why, not what changed. Name the tool ("Over MCP: …") where the feature is described.
2. **A new capability** is a line in *What is built* on `about.md`.
3. **A new page** is registered in `pages.ts` in its group, with a blurb; it is linked from the pages that lead to it (`about.md`'s closing line, `navigation.md`'s table).
4. **A new `data` key, type, selector or top-level key** in what a file can carry: `spec.md`, `src/core/exchange/ae/aegraph-v1.schema.json` and its copy in `public/spec/` (a test keeps them identical), and `example.ae.json` when an example helps.
5. **A new or changed tool**: its `description` and parameter descriptions (the reference is generated); the feature's page names it.
6. **A new module or a changed architecture**: `README.md`; a new area or convention: the area's `AGENTS.md`.
7. `npx vitest run src/features/docs src/docs` — the docs tests check the registrations and links.

Prose conventions: short sections, one idea each; bold the name of a control the first time (**Types**, **Commit**); code font for keys and ids (`data.at`, `⌘K` in tables); link other pages by their route (`/docs/maps`). Numbers that will drift (counts of tools, of demos) are avoided or said approximately.
