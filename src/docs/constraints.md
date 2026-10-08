# Constraints

A **constraint** is a rule every new or changed entity must satisfy to get into the store. The constraint engine stands guard at the store's writes: a write that fails a *rejecting* constraint is refused — the UI shows why, a tool call (`create_entity`, `create_relationship`, `update_entity`, an import) returns the reason — and a *warning* constraint lets the write in and reports. Constraints are how an ontology becomes a contract: what a person must carry, what may be unique, what a relationship may join.

Constraints are entities of type `constraint` (category *project*), so they travel with a project's bundle and are edited like any other definition. They are **scoped to projects**: one made while a project is open belongs to that project and is in force only there; one made in the Library applies everywhere. Over MCP, `project` on `define` or `update` says which (an id, a label, or `library`). **Disable** a constraint to take it out of force without deleting it — the checkbox on its line, or `enable` / `disable` over MCP. Disabling always goes through: the write that switches a constraint off is never judged, so a rule that refuses everything can still be turned off.

A constraint that arrives in a bundle — one the Library does not have, or a changed copy of one it has — comes in **disabled**, and so does every constraint that follows a template the bundle brings new or changed: a constraint judges every write from the moment it is in force, so you read it on the Ontology page and turn it on yourself. A constraint the bundle leaves as it was keeps your setting.

A constraint **judges** either *each entity* of a write on its own (the default) or *the whole graph* at once. The first is for what an entity must carry and what a relationship may join; the second is for invariants over the graph and the ontology — no cycles through `parent`, every paper has an author, at most *n* of a type, every type in use is declared. Most constraints are best written as code; the quickest way to state a common one is a **template**.

## What a rule can check

Only the parts you fill in are checked; each is one line to write and explains itself.

| Part | Checks | Example |
| --- | --- | --- |
| `required` | paths present and not empty | `label`, `data.born` |
| `forbidden` | paths absent | `data.legacyId` |
| `fields` | conditions in the filter language, all of which must hold | `data.year gte 1900`, `data.severity in S1,S2,S3` |
| `unique` | the value is on no other entity of the same type | `label`, `data.email` |
| `labelPattern` | a regular expression the label matches | `^[A-Z]` |
| `ends` (relationships) | source / target types, no self-links, both ends exist, at most *n* per source or target | `wrote`: source `person`, target `paper`, ≤ 1 per target |
| `js` | an expression over `e` in the rule vocabulary (below): true passes, false or a string — the message — fails | `has('data.born') && get('data.born') > 1000 \|\| 'needs a plausible birth year'` |

`applies` says what the rule watches: entities, relationships or both; only some types; only entities carrying some tag. A rule with no `applies` watches every write.

## Writing a rule in code

A code rule is JavaScript over one entity with a small vocabulary bound as plain names, so it reads like a sentence. It is an **expression** whose value decides — `true` passes; `false`, or a string (the message), fails — or, with a `return` in it, a function body. A throw counts as a failure with the error as the message.

A rule travels with the project it belongs to — in a bundle, an import, a tool call — so it is treated as data, never as code of the app: it runs in its own **QuickJS interpreter** inside the page (WebAssembly, the same engine as JavaScript scripts), where it sees the rule vocabulary and nothing else — no network, no storage, no page, no way back to the app. `e`, `previous` and what the helpers return are copies: changing them changes nothing outside the rule. Each run has a budget — 250 ms for a rule over one entity, 5 s for a graph rule — and 64 MB of memory; a rule that loops or runs out is stopped and fails with a message that says so. A write has 300 ms for all its checks together: a constraint whose turn comes after that is not checked for that write, and the write carries a warning saying so (*not checked*) — the **Audit** still checks it. The interpreter loads the first time a rule needs it, a moment after the app starts; until it has, code rules are left out rather than guessed, and the **Audit** always waits for it.

| name | meaning |
| --- | --- |
| `e` | the entity being written: `id`, `type`, `label`, `description`, `tags`, `data`, `meta` — and `source`, `target`, `directed` for a relationship |
| `get(path)` · `has(path)` · `isEmpty(v)` | a value on `e` by path (`'data.year'`, `'label'`, `'meta.source'`); whether it is set and not empty |
| `matches(path, regex)` | the string at the path matches |
| `out(rel?)` · `inn(rel?)` · `links(rel?)` | the relationships leaving / arriving at / touching `e`, optionally of one type |
| `neighbors(rel?)` | the entities at the other end |
| `source()` · `target()` | for a relationship, the entities at its ends |
| `entity(id)` · `typeOf(id)` · `ofType(type)` | lookups in the store (and in the same write) |
| `unique(path)` | no other entity of `e`'s type carries the value |
| `count(list)` · `others()` · `previous` · `store` · `fail(message)` | a length; the rest of the write; what `e` replaces; the store, read-only (`get`, `has`, `ofType`, `relationshipsOf`, `query`, `all`); fail with a message |

```js
has('data.born') && get('data.born') > 1000 || 'a person needs a plausible birth year'
out('wrote').length <= 3
neighbors('cites').every((p) => p.type === 'paper')
if (e.data.died !== undefined && e.data.died < e.data.born) return fail('died before born')
return true
```

The editor completes as you type — `e.data.` lists the properties the watched types actually carry, with their kind, how many entities carry them and a sample; `out('` the relationship types and what they join; `e.type === '` the types; `tags.includes('` the tags — and every helper explains itself on hover. **Reference** opens the whole vocabulary and the watched types' properties to click into the rule; **Try on** evaluates the rule live against a real entity of the type as you write. The same editor and vocabulary are meant for any place a rule or a value is written in code.

## Rules over the whole graph

A graph-scoped rule is code over the dataset as a whole. It runs once per write — over the store with the write laid on top, so it judges the graph as it *will* be — and once in every audit. Its verdict: `true` passes; `false` or a string fails the write; a list of `violation(id, message)` names the entities at fault. A rejecting graph rule drops the entities of the write it names, or the whole write when it names none of them; only what a write *introduces* is held against it — a violation already in the data is the audit's business and never blocks an unrelated write.

| name | meaning |
| --- | --- |
| `all()` · `entities()` · `relationships(type?)` · `ofType(type)` | the dataset, as it would stand after the write |
| `entity(id)` · `typeOf(id)` · `types()` · `relTypes()` | lookups; the entity and relationship types in use |
| `out(id, rel?)` · `inn(id, rel?)` · `links(id, rel?)` · `neighbors(id, rel?)` · `degree(id, rel?)` | walking from an entity (an entity object works in place of its id) |
| `get(entity, path)` · `has(entity, path)` · `isEmpty(v)` · `count(list)` | reading values |
| `cycle(rel)` | the ids of a cycle through relationships of the type, if there is one |
| `others()` · `violation(id, message)` · `fail(message)` · `params` · `store` | the write being checked; a named violation; fail outright; the template's parameters; the store as it stands, read-only |

```js
ofType('paper').filter((p) => !inn(p, 'wrote').length).map((p) => violation(p, 'no author'))
cycle('parent') ? 'parent must not cycle' : true
count(ofType('project')) <= params.max || 'too many projects'
```

The ontology is in the dataset too — types are `schema:type` entities — so an ontology rule is a graph rule: `ofType('schema:type').filter((d) => !has(d, 'description'))`.

## Templates

A **template** is a rule with holes: it declares its parameters — a type, a relationship, a path, a number, a choice — and renders a constraint from a filled-in form. The Ontology page draws the form from the declaration (**From template**); over MCP, `constraint {action: "templates"}` lists them with the same parameters as a JSON schema, and `define {template, params}` renders one. A constraint made from a template keeps the template's name and its parameters, so it is edited as a form again, and `params` are bound in its rule.

Built-in templates cover the invariants most ontologies want — a property is required / unique / in a range / one of some values / a date before another; labels match a pattern; what a relationship may join, no self-links, at most *n* per entity; and, over the whole graph, at least *n* relationships per entity, no cycles, no orphans, at most *n* of a type, every type in use declared, every property declared on its type, every type described.

A template of your own is an entity of type `constraint-template` (**New template** in the dialog, or the `define_template` action of the `constraint` tool): code in the rule vocabulary of its scope reading its parameters as `params.<name>`, the parameters as rows, the types it watches with `{{name}}` holes, and a name pattern. Constraints made from it follow its code: edit the template and every one of them changes.

## Constraints as scripts

A constraint's rule can also name a **saved script** — JavaScript or Python over `ds`, written and tried on the Scripts page — that judges the whole dataset in the sandbox. What the script returns is the verdict: `true` passes; `false` or a string fails; a list of `{ id, message }`, or a table (a DataFrame) with those columns, names the entities at fault. Scripts are asynchronous, so a script-backed constraint is judged by the **audit**, never at write time; use one where the sandbox earns it — networkx over the graph, pandas over the properties — and a graph rule where a write should be refused.

A script judging a constraint is a **constraint script** (`script:constraint`, a subtype of `script`) — it takes that kind when the constraint is made, whether on this page, with the `constraint` tool, or from the Scripts page, where **Save as a constraint** under a result of the verdict shape makes the constraint for you (scope graph, a warning until you make it reject). See [Scripts › Kinds](/docs/scripts).

## Where

- **Ontology → Constraints**: the rules, whether each is in force, its scope, project and template; **New constraint** (conditions, code over an entity or over the graph, or a script) and **From template**; and **Audit** — every violation in the data as it stands, script-backed constraints included. A new rule does not remove what is already there; audit says what would fail today. A type's page lists the constraints that watch it.
- **Over MCP**: `constraint {action: list | templates | define | update | enable | disable | delete | audit | check | define_template | delete_template}`. `check` asks whether an entity would be accepted without writing it. A refused write comes back as an error naming the constraint and the failing condition, so an agent can correct and retry.

## What is not checked

Restoring the store from disk, and pulling another tab's writes, bypass the guard: what is on disk was accepted when it was written. Bookkeeping writes (an entity opened, a script's last run) never trip a rule; an existing entity is judged again only when a write changes something a rule can see. A graph rule sees writes, not removals: deleting the last author of a paper is caught by the audit, not at the delete.
