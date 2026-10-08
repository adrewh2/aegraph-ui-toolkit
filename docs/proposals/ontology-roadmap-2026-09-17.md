# Where aegraph stands as an ontology harness, and what to build next

Date: 2026-09-17. Written after a full pass over the codebase (`src/core/entity`, `src/features/ontology`, `src/features/knowledge`, the assistant tools, the exchange formats) against the ontology-harness model: entities, types-as-entities, relationship schemas, validation vs. inference, provenance and assertions, entity resolution, versioning and migrations, linting, proposals, ontology-aware queries.

## Where aegraph stands

Mapping the principles onto the code, honestly:

| Principle | Status | What exists |
| --- | --- | --- |
| Small primitive set: entity, relationship, ref + selector, tag, type | Done | `src/core/entity/types.ts`; the `.ae.json` spec and validator |
| Types are entities (meta-circular) | Done | `schema:type` entities; `TypeRegistry` merges code definitions with data definitions |
| Type, tag and property kept distinct; progressive formalisation | Done | Untyped → tagged → typed → declared properties all work without migration |
| Presentation state as entities; views as data | Done | filters, layouts, styles, scenes, charts, scripts, workstations are entities |
| Documents and annotations as the bridge | Done | selectors on text, images, video, audio, maps |
| AI behind the ontology, via tools | Partly | 78 tools, `define_entity_type`, `validate_ae`; but the tools cannot validate against domain/range because none is declared |
| Inheritance | Partly | a single `parent`, presentation only; `fieldsFor` walks the chain, nothing else does (filters, queries, counts do not include subtypes) |
| Validation | Partly | `required` on properties plus code-level `validate()`; no kind checking at write time, no severity levels beyond error/warning, no ontology-wide report |
| Relationship schemas (domain, range, cardinality, inverse) | Missing | relationship types are only inferred from usage; nothing declares or checks them |
| Constraints with severity levels | Missing | |
| Inference with explanations | Missing | no "Andrew is an Agent because…" |
| Assertions, provenance, confidence | Missing | only the `meta.source` string; claims exist as a domain type, not as a reification of a relationship |
| Entity resolution (aliases, external ids, canonical URI) | Missing | the RDF importer drops `sameAs`; there is no alias field |
| Namespaces | Missing | type names are bare strings (`person`); no prefix or URI |
| Ontology versioning and migrations | Missing | renaming a type means rewriting every entity by hand |
| Ontology linter | Missing | `TypeDetail` and `ontology/schema.ts` compute the statistics a linter needs, but nothing judges them |
| Schema-change proposals from agents | Missing | `define_entity_type` writes immediately |
| Ontology-aware queries | Missing | `store.query` matches type strings exactly; no subtype expansion |
| Ontology tests | Missing | |

## The gaps, in the order to close them

### 1. Relationship schemas

The biggest hole, and a prerequisite for everything below. Give relationship types a definition entity (`schema:relationship`, or reuse `schema:type` with `kind: 'relationship'`) carrying `domain[]`, `range[]`, `cardinality`, `inverse`, `symmetric` and a description. The Ontology page already draws every type → relationship → type triple from usage; add "declare this" on a triple, and show "18% of targets are not in range" underneath once it is declared. The assistant's `create_relationship` gets the check.

Files: `src/core/entity/schema.ts`, `typeRegistry.ts`, `src/features/ontology/OntologyView.tsx` and `TypeDetail.tsx`, `src/features/assistant/entityTools.ts`.

### 2. Real inheritance

A DAG (`parents[]`), with subtype expansion everywhere a type is matched: filters (`types: [person]` includes engineers), `store.query`, the Entities rail counts, style rules, relationship domain and range. Property inheritance with conflict rules for parents that disagree. This touches `filter.ts`, `store.query`, `TypeRegistry` and the rail — a moderate blast radius, so it needs the regression pass.

### 3. Constraints with severity, and an ontology-wide validation report

Extend `PropertyDef` with `severity: 'info' | 'warning' | 'strict'`, value-kind checks, options and cardinality. Add a **Validation** tab on the Ontology page that runs the whole store and groups issues by type and rule, with fix actions (set a default, retype, remove). Strict violations block writes from tools; warnings do not.

### 4. Ontology linter

Cheap once 1–3 exist: cycles in parents, unused types, near-duplicate type labels, relationship types used against undeclared domain or range, properties declared but never set, properties set but never declared, tags that behave like types (a large share of one type carries them). Ontology page → **Lint** tab; also an MCP tool so an agent can read it.

### 5. Assertions with provenance and confidence

Relationships already have identity, so this is fields, not a new primitive: `meta.confidence`, `meta.provenance { source, extractor, verifiedBy, verifiedAt }`, `validFrom` / `validUntil`. Then the inspector shows lineage, styles can fade low-confidence edges, and the AI tools stamp what they create. Conflicting claims from two sources coexist as two relationships tagged by source; a "verify" action promotes one.

### 6. Entity resolution and namespaces

`aliases[]` and `externalIds{}` on entities; the RDF importer keeps `sameAs`; a **Duplicates** view (same label, alias or external id, across types) with merge — relationships re-pointed, `derivedFrom` kept. Namespaces come with it: `prefix:local` type names with a prefix table on the project.

### 7. Schema-change proposals and ontology versioning

A `proposal` entity (`ops[]`, reason, affected count, conflicts, confidence, status) that `define_entity_type` and friends can write instead of apply when called by an agent; a review UI that previews "31,493 affected / 160 invalid" and applies the change as a migration; ontology snapshots on the project with a diff. This is where "pull requests for the ontology" lives.

### 8. Inference with explanations, and ontology-aware queries

Subtype closure; inverse relationships materialised on read; transitive relationships declared on the relationship schema (`partOf`); a "why?" on every derived fact. Queries in the assistant and `store.query` expand types and follow declared inverses.

### 9. Ontology tests

Fixtures plus assertions (valid and invalid counts, query results, inference results) run against schema changes. The existing `src/data/demo` tests are the seed.

## Assessment

aegraph is a strong entity system with an emergent ontology. Items 1–4 are what turn it into an ontology manager; 5–7 are what make it safe for AI-generated knowledge. Start with 1 and 3 together (relationship schemas and severity-graded validation share the same definition entity and the same Ontology-page surface), then 2, then 4 as the quick win it becomes.
