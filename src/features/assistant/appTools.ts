import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { pickHref, relatedTo } from '../../app/openIn'
import { entityHref } from '../../app/routes'
import { displayLabel } from '../../core/entity/entity'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import { BASE_FIELDS, type FieldDef } from '../../core/entity/schema'
import { isRelationship, type AnyEntity, type EntityId } from '../../core/entity/types'
import { isAudio } from '../audio/audio'
import { isVideo } from '../videos/videos'
import { buildVocabulary, type Ranking } from '../../core/search/vocabulary'
import { tagMatrix } from '../ontology/tagStats'
import { rankEntityTexts, semanticRank } from './semantic'
import { embeddingsReady } from '../search/embedder'
import { docsCatalog, readDoc, searchDocs } from '../docs/lookup'
import { HOSTS, mountedHost } from '../workstation/hosts'
import { makeTab, panes } from '../workstation/model'
import { json, requireEntity } from './toolkit'
import type { AppHost } from './tools'

/**
 * The app itself: what is on screen, the vocabulary, and navigation.
 */


export function createAppNavigationTools(host: AppHost) {
  const { store } = host
  const registry = () => host.registry ?? new TypeRegistry(store)

  const getAppContext = betaTool({
    name: 'get_app_context',
    description: 'What the user is looking at right now: the current page, the open document (if any), selected text, and workspace counts. Call this first when a request refers to "this document", "here", or "the selection".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
    run: () => {
      const ctx = host.getContext()
      const counts = Object.fromEntries(store.countByType())
      const project = store.scope ? store.get(store.scope) : undefined
      return json({ ...ctx, project: project ? { id: project.id, label: displayLabel(project) } : null, counts, relationships: store.relationshipCount() })
    },
  })

  const listTags = betaTool({
    name: 'list_tags',
    description: 'All tags in view (the open project, or the Library) with usage counts and any color/description. With `matrix: true`, the Ontology\'s Tags explorer instead: tag keys (a `key:value` tag splits into the key and its values) against entity types — how many entities of each type carry each key and each exact tag, which keys occur together, and how many entities of each type carry no tag — for questions like "which types are tagged with tier:, and with which values?".',
    inputSchema: {
      type: 'object',
      properties: {
        matrix: { type: 'boolean', description: 'The type × tag matrix instead of the flat list' },
        relationships: { type: 'boolean', description: 'matrix: include relationship types as rows (default false)' },
        min_count: { type: 'integer', minimum: 1, description: 'matrix: leave out types and keys carried by fewer entities than this' },
      },
      additionalProperties: false,
    } as const,
    run: ({ matrix, relationships, min_count }) => {
      if (!matrix) return json(store.tags().map((t) => ({ ...store.getTagInfo(t), count: store.tagUsage(t) })))
      const m = tagMatrix(store, registry(), { relationships })
      const min = min_count ?? 1
      const keys = m.keys.filter((k) => k.count >= min)
      const types = m.types.filter((t) => t.count >= min)
      const cell = (type: string, key: string) => m.byKey.get(type)?.get(key) ?? 0
      return json({
        totals: m.totals,
        keys: keys.map((k) => ({ key: k.key, count: k.count, faceted: k.faceted, values: k.values.slice(0, 30).map((v) => ({ value: v, count: k.valueCounts.get(v) ?? 0 })), ...(k.values.length > 30 ? { moreValues: k.values.length - 30 } : {}) })),
        types: types.map((t) => ({ type: t.type, label: t.label, kind: t.kind, count: t.count, untagged: t.untagged, byKey: Object.fromEntries(keys.map((k) => [k.key, cell(t.type, k.key)]).filter(([, n]) => (n as number) > 0)), tags: Object.fromEntries([...(m.byTag.get(t.type) ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 40)) })),
        cooccur: keys.flatMap((a) => keys.filter((b) => b.key > a.key).map((b) => ({ keys: [a.key, b.key], count: m.cooccur.get(a.key)?.get(b.key) ?? 0 }))).filter((c) => c.count > 0).sort((a, b) => b.count - a.count).slice(0, 60),
      })
    },
  })

  const listTypes = betaTool({
    name: 'list_entity_types',
    description: 'The registered entity types (the data model) and the relationship types with what they join — "segment → cluster (5,156)" — so the shape of a dataset takes one call, not a script. Each type with its description, count and its own properties (kind, and a description when one was written), the base fields every type shares said once; `type` describes one type in full, `detail` every type with every field. Plus any unregistered types present in the store. define_entity_type sets descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'One type to describe in full: every field, the base ones included' },
        detail: { type: 'boolean', description: 'Every type with every field (the default lists each type\'s own properties and the base fields once — a fraction of the size)' },
        all: { type: 'boolean', description: 'Include the types nothing in this workspace uses (the default lists the ones with entities, and names the rest)' },
      },
      additionalProperties: false,
    } as const,
    run: ({ type, detail, all }) => {
      const reg = registry()
      const field = (f: FieldDef) => ({ key: f.key, kind: f.kind, required: !!f.required, editable: !!f.editable, ...(f.description ? { description: f.description } : {}) })
      const base = new Set(BASE_FIELDS.map((f) => f.key))
      if (type) {
        const t = reg.get(type)
        return json({ type: t.type, label: t.label, category: t.category, origin: t.origin, ...(t.parent ? { parent: t.parent } : {}), ...(t.description ? { description: t.description } : {}), count: t.count, fields: reg.fieldsFor(t.type).map(field) })
      }
      // Every type the registry knows — built in, defined by a schema:type entity, or inferred from the data — with the
      // fields it declares; the ones only the data brought in are listed as such, so the whole ontology is one answer.
      // The base fields (label, tags, meta.*) are the same on every type: said once, not forty times.
      const known = reg
        .all()
        .filter((t) => t.kind !== 'relationship' && t.type !== 'schema:type' && (t.count > 0 || t.origin !== 'inferred'))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      // A workspace uses a handful of its types; describing the forty it does not is most of the answer and none of
      // the information. They are named instead, and `all` brings them back.
      const inUse = known.filter((t) => t.count > 0)
      const unused = known.filter((t) => t.count === 0)
      const types = (all || detail || !inUse.length ? known : inUse)
        .map((t) => ({
          type: t.type,
          label: t.label,
          category: t.category,
          origin: t.origin,
          ...(t.parent ? { parent: t.parent } : {}),
          ...(t.description ? { description: t.description } : {}),
          count: t.count,
          ...(detail ? { fields: reg.fieldsFor(t.type).map(field) } : { properties: reg.fieldsFor(t.type).filter((f) => !base.has(f.key)).map(field) }),
        }))
      // What each relationship type actually joins, counted off the data: "segment → cluster (5,156)". Without it the
      // only way to learn the shape of a dataset is to run a script over every relationship, which is two round trips
      // and a sandbox load for something the store can count in a few milliseconds.
      const joins = new Map<string, Map<string, number>>()
      for (const r of store.relationships()) {
        const pair = `${store.get(r.source.id)?.type ?? '?'} → ${store.get(r.target.id)?.type ?? '?'}`
        const m = joins.get(r.type) ?? joins.set(r.type, new Map()).get(r.type)!
        m.set(pair, (m.get(pair) ?? 0) + 1)
      }
      const relationshipTypes = reg
        .relationshipTypes()
        .filter((t) => all || detail || t.relationshipCount > 0)
        .map((t) => ({
          type: t.type,
          label: t.label,
          count: t.relationshipCount,
          ...(t.description ? { description: t.description } : {}),
          ...(joins.has(t.type) ? { joins: [...joins.get(t.type)!].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([pair, n]) => `${pair} (${n.toLocaleString()})`) } : {}),
        }))
      return json({ ...(detail ? {} : { baseFields: BASE_FIELDS.map(field), note: 'Every type also has the base fields; `properties` are each type\'s own. list_entity_types {type} describes one type in full, {detail: true} all of them.' }), categories: { resource: 'browsed under /entities?category=resource', knowledge: 'domain entities under /entities?category=knowledge', project: 'what a project holds beyond its data — graph views, filters, layouts, styles, scenes, plots, analyses, workstations, scripts — under /entities?category=project', schema: 'type definitions under /entities?category=types' }, types, ...(all || detail || !unused.length ? {} : { unused: unused.map((t) => t.type) }), relationshipTypes, hint: 'origin: code = built in, schema = defined in the data (a schema:type entity), code+schema = built in and described here, inferred = seen in the data with no definition. list_properties shows what the data actually carries; define_entity_type describes types and properties. `unused` are the types this workspace has none of — list_entity_types {all: true} describes them too.' })
    },
  })

  const open = betaTool({
    name: 'open',
    description:
      'Navigate the app: open an entity where it lives (documents, images, videos and audio open in their viewers; other types are selected in the Entities browser), or go to a page: dashboard, documents, diagrams, images, videos, audio, entities (add ?category=resource|knowledge|graph|relationships|types|tags and/or ?type=<type>), graph/2d (add ?sel=<id,id> to select and frame nodes), graph/3d, graph/layouts, display (2D scenes), analytics (Charts at analytics/charts?plot=new|<id>, Scripts at analytics/scripts?script=<id>), insights (the analytics harness), datasets, model, docs (docs/<page>, optionally #<section> — the ids from the docs tool: about, overview, explorer, pipeline, values, positions, analysis, insights, plots, scripts, exchange, projects, diagrams, maps, spec, constraints, assistant…).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entity id to open' },
        page: { type: 'string', description: 'Page name or path, e.g. "entities", "/entities?category=resource&type=webpage", "graph/3d"' },
        time: { type: 'number', description: 'For videos and audio: seconds to start playback at' },
      },
      additionalProperties: false,
    } as const,
    run: ({ id, page, time }) => {
      if (id) {
        const e = requireEntity(store, id)
        let to = entityHref(e, registry())
        if (time != null && (isVideo(e) || isAudio(e))) to += `?t=${Math.max(0, Math.round(time * 10) / 10)}`
        host.navigate(to)
        return json({ opened: to })
      }
      if (page) {
        const p = page.trim().toLowerCase()
        const to = p.startsWith('/') ? p : p === 'dashboard' || p === 'home' ? '/' : `/${p}`
        host.navigate(to)
        return json({ opened: to })
      }
      throw new Error('Provide an id or a page.')
    },
  })

  const MATCH = {
    type: 'object',
    description: 'Entities matching every field given: any of the types, any of the tags (all of them with tag_mode "all"), and the text anywhere in the entity.',
    properties: {
      types: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      tag_mode: { type: 'string', enum: ['any', 'all'] },
      text: { type: 'string', description: 'Case-insensitive; matched against id, label, description, tags and data' },
      kind: { type: 'string', enum: ['entity', 'relationship'] },
    },
    additionalProperties: false,
  } as const
  type Match = { types?: string[]; tags?: string[]; tag_mode?: 'any' | 'all'; text?: string; kind?: 'entity' | 'relationship' }
  const matching = (m: Match): AnyEntity[] => {
    const anyTags = m.tag_mode !== 'all' && m.tags?.length ? m.tags : undefined
    // Type definitions are vocabulary, not content: a word search never picks them.
    const predicate = (e: AnyEntity) => !e.type.startsWith('schema:') && (!anyTags || anyTags.some((t) => e.tags.includes(t)))
    return store.query({ type: m.types?.length ? m.types : undefined, tags: m.tag_mode === 'all' ? m.tags : undefined, text: m.text?.trim() || undefined, kind: m.kind, predicate })
  }

  const openEntities = betaTool({
    name: 'open_entities',
    description:
      'Open the Entities table on a described set — "everything about architecture", "the incidents and what they hit" — as a new tab titled the way you say. `query` is the phrase: the tool reads the types and tags in use (names, descriptions, counts) and ranks them by meaning with a model (word overlap when no API key is set), takes those above `threshold`, and adds a text search for the distinctive terms; the reply lists the ranking and what was chosen. Pass `dry_run` to see the ranking without opening. Explicit `ids`, `match`/`matches` (types / tags / text) and `related_to` (one hop from those ids, links included) are unioned with it. Relationships between the picked entities come along so the Relationships section shows them.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The tab and table title, e.g. "Architecture"' },
        query: { type: 'string', description: 'What the set is about, in words: "architecture", "payments and the incidents that hit them"' },
        engine: { type: 'string', enum: ['model', 'local', 'lexical'], description: 'How `query` is ranked: model = Claude via the API key in the assistant settings; local = sentence embeddings in the browser (a ~23 MB model downloaded once, after the user agrees in the app); lexical = word overlap. Default: model if a key is set, else local if already downloaded, else the app asks once.' },
        threshold: { type: 'number', description: 'Minimum relevance (0–1) for a type, tag or entity from `query` to be included. Default: 0.6 for model scores; for local similarity, whatever is within 65% of the best match (similarity is relative) — the reply shows the ranking so you can pass an explicit cut.' },
        dry_run: { type: 'boolean', description: 'Return the ranking and counts without opening anything' },
        ids: { type: 'array', items: { type: 'string' } },
        match: MATCH,
        matches: { type: 'array', items: MATCH, description: 'Several matches, unioned' },
        related_to: { type: 'array', items: { type: 'string' }, description: 'Ids whose one-hop neighbours and links are included too' },
        category: { type: 'string', enum: ['all', 'resource', 'knowledge', 'project'], description: 'Section to land on (default all)' },
        include_relationships: { type: 'boolean', description: 'Include the relationships among the picked entities (default true)' },
        limit: { type: 'number', description: 'Cap on entities picked (default 5000)' },
      },
      required: ['title'],
      additionalProperties: false,
    } as const,
    run: async ({ title, query, engine, threshold, dry_run, ids, match, matches, related_to, category, include_relationships, limit }) => {
      const picked = new Set<EntityId>()
      for (const id of ids ?? []) if (store.has(id)) picked.add(id)
      const found: Match[] = [...(match ? [match] : []), ...(matches ?? [])]
      let ranking: (Ranking & { note?: string }) | undefined
      let chosen: { types: string[]; tags: string[]; terms: string[]; entities?: number } | undefined
      let min = threshold ?? 0.6
      if (query?.trim()) {
        const t0 = Date.now()
        const downloaded = embeddingsReady()
        ranking = await semanticRank(query, buildVocabulary(store, registry()), { engine, confirm: host.confirm })
        // Similarity scores are relative, not absolute (a MiniLM cosine of 0.35 can be the best match): without a threshold, keep what is close to the top.
        const cut = (rs: { score: number }[], floor: number) => (threshold != null ? threshold : ranking!.method === 'embedding' ? Math.max(floor, 0.65 * (rs[0]?.score ?? 0)) : min)
        const isView = (name: string) => registry().categoryOf(name) === 'project'
        const types = ranking.method === 'embedding' ? ranking.types.filter((r) => !isView(r.key)) : ranking.types
        const tCut = cut(types, 0.25)
        const gCut = cut(ranking.tags, 0.25)
        if (threshold == null && ranking.method === 'embedding') min = Math.min(tCut, gCut)
        // Word search only where the words were chosen for it (the model's terms); similarity reads the entities itself below.
        const terms = ranking.method === 'embedding' ? [] : ranking.terms
        chosen = { types: types.filter((r) => r.score >= tCut).map((r) => r.key), tags: ranking.tags.filter((r) => r.score >= gCut).map((r) => r.key), terms }
        if (chosen.types.length) found.push({ types: chosen.types })
        if (chosen.tags.length) found.push({ tags: chosen.tags })
        for (const t of terms) found.push({ text: t, kind: 'entity' })
        // With the local model, the entities themselves are read too: a document about the phrase counts whatever its type.
        if (ranking.method === 'embedding') {
          const items = store
            .query({ kind: 'entity' })
            .filter((e) => !e.type.startsWith('schema:') && !isView(e.type) && (e.label || e.description))
            .slice(0, 3000)
            .map((e) => ({ id: e.id, key: `e:${e.id}:${e.meta.updatedAt}`, text: `${e.label ?? ''}${e.description ? ` — ${e.description}` : ''}`.slice(0, 400) }))
          const ranked = await rankEntityTexts(query, items)
          // Entities need a tighter cut than the vocabulary: one strong match should not pull in its loosely worded neighbours.
          const eCut = threshold != null ? threshold : Math.max(0.3, 0.75 * (ranked[0]?.score ?? 0))
          const hits = ranked.filter((h) => h.score >= eCut)
          for (const h of hits) picked.add(h.id)
          chosen.entities = hits.length
        }
        ranking = { ...ranking, note: [ranking.note, ranking.method === 'embedding' && !downloaded ? `The local model was loaded for this call (${((Date.now() - t0) / 1000).toFixed(1)}s); later calls are quick.` : undefined].filter(Boolean).join(' ') || undefined }
      }
      for (const m of found) for (const e of matching(m)) picked.add(e.id)
      if (related_to?.length) {
        const r = relatedTo(store, related_to.filter((id) => store.has(id)))
        for (const id of [...r.entities, ...r.relationships]) picked.add(id)
      }
      const max = limit ?? 5000
      const pickedEntities = [...picked].filter((id) => !isRelationship(store.get(id)!))
      const entities = pickedEntities.slice(0, max)
      const set = new Set(entities)
      const relationships = new Set([...picked].filter((id) => isRelationship(store.get(id)!)))
      if (include_relationships !== false) for (const id of set) for (const r of store.relationshipsOf(id)) if (set.has(r.source.id) && set.has(r.target.id)) relationships.add(r.id)
      const all = [...entities, ...relationships]
      const byType: Record<string, number> = {}
      for (const id of entities) {
        const t = store.get(id)!.type
        byType[t] = (byType[t] ?? 0) + 1
      }
      const about = ranking ? { method: ranking.method, threshold: min, ranking: { types: ranking.types.slice(0, 40), tags: ranking.tags.slice(0, 40), terms: ranking.terms }, chosen, note: ranking.note } : {}
      if (dry_run) return json({ ...about, entities: entities.length, relationships: relationships.size, byType })
      if (!all.length) throw new Error('Nothing matched: check the types and tags with list_entity_types / list_tags, lower the threshold, or loosen the text.')
      const to = pickHref(all, title.trim() || 'Picked', category ?? 'all')
      host.navigate(to)
      return json({ opened: to, title, ...about, entities: entities.length, relationships: relationships.size, byType, truncated: pickedEntities.length > max })
    },
  })

  const docs = betaTool({
    name: 'docs',
    description:
      "The app's own documentation (the Documentation view, /docs) — how each view works, the graph pipeline, values and selectors, the .ae.json file format, constraints, this tool set. Not the user's documents (those are read_document). `list` gives every page with its sections; `read` returns a page (or one `section` of it) as Markdown; `search` finds the sections containing all the words of `query`, with an excerpt each; `open` shows a page (at a section) to the user — as a tab beside what they have when the Workstation is on screen, otherwise as the Documentation view. Answer questions from `read`/`search` and link the page (/docs/<id>#<section>); call `open` only when the user asked to see the page. When a docs_page is in the app context, that is the page the user is reading.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'search', 'open'], description: 'What to do (default: read when an id is given, search when a query is, list otherwise)' },
        id: { type: 'string', description: 'read/open: the page id (from list, or the docs_page in the context), e.g. "explorer"' },
        section: { type: 'string', description: 'read/open: one section — its anchor (from list or a search hit) or heading text' },
        query: { type: 'string', description: 'search: words that must all appear in a section' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: 'search: how many hits (default 8)' },
      },
      additionalProperties: false,
    } as const,
    run: ({ action, id, section, query, limit }) => {
      const act = action ?? (id ? 'read' : query ? 'search' : 'list')
      if (act === 'list') return json({ pages: docsCatalog(), open: { page: 'docs/<id>', section: 'docs/<id>#<section>' } })
      if (act === 'search') {
        if (!query?.trim()) throw new Error('search needs a query')
        const hits = searchDocs(query, limit ?? 8)
        return json({ query, hits: hits.map((h) => ({ id: h.id, page: h.title, section: h.section, heading: h.sectionTitle, excerpt: h.excerpt, read: { action: 'read', id: h.id, section: h.section } })), ...(hits.length ? {} : { note: 'No section contains all those words; try fewer, or list the pages.' }) })
      }
      if (!id) throw new Error(`${act} needs a page id — call docs {action:"list"} for the ids`)
      const page = readDoc(id, section)
      if (!page) throw new Error(`No docs page "${id}" — call docs {action:"list"} for the ids`)
      if (act === 'open') {
        if (section && !page.section) throw new Error(page.note ?? `No section "${section}" on ${page.page.title}.`)
        const path = `/docs/${page.page.id}${page.section ? `#${page.section}` : ''}`
        const live = mountedHost(HOSTS.workstation.key)
        if (live) {
          // The user is at the Workstation: the page goes beside what they have — the tab that already shows it, or a new one in the focused pane.
          const ws = live.get()
          for (const p of panes(ws.root)) {
            const i = p.tabs.findIndex((t) => t.path === path)
            if (i >= 0) {
              live.run({ type: 'focus', paneId: p.id })
              live.run({ type: 'activate', paneId: p.id, index: i })
              return json({ opened: path, title: page.title, where: 'workstation tab', tab: p.tabs[i].id })
            }
          }
          const tab = makeTab(path, page.page.title)
          live.run({ type: 'addTab', paneId: ws.focused, tab })
          return json({ opened: path, title: page.title, where: 'workstation tab', tab: tab.id })
        }
        host.navigate(path)
        return json({ opened: path, title: page.title, where: 'documentation view' })
      }
      return json({ id: page.page.id, title: page.title, path: `/docs/${page.page.id}${page.section ? `#${page.section}` : ''}`, ...(page.section ? { section: page.section } : {}), sections: page.sections, ...(page.note ? { note: page.note } : {}), markdown: page.text })
    },
  })

  return [getAppContext, listTags, listTypes, open, openEntities, docs]
}
