import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { createEntity, createRelationship, displayLabel, parseTags, quoteLabel } from '../../core/entity/entity'
import { validateEntity } from '../../core/entity/schema'
import { textInsights } from '../../core/entity/textInsights'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import { browserHref } from '../../app/openIn'
import { type AnyEntity } from '../../core/entity/types'
import { RESOURCE_TYPES } from '../../core/resources/types'
import { annotateDocument, contentOf, deleteDocument, descendantsOf, isDocument, isFolder } from '../documents/documents'
import { isOwnMemory } from './memory'
import { approveLoadedUrls, json, requireEntity, summarize, openMade } from './toolkit'
import { slimData } from '../scripts/snapshot'
import type { AppHost } from './tools'
import { requireTextDocument } from './documentTools'

/**
 * Entities: search, read, create, update, delete, link, annotate documents.
 */


export function createEntityTools(host: AppHost) {
  const { store } = host

  const searchEntities = betaTool({
    name: 'search_entities',
    description: 'Search the open project (or the Library when none is open; library: true searches everything regardless). Matches id, label, description, tags, and data (case-insensitive); every word of the query must occur, "quoted words" as a phrase — the same reading as the ⌘K box and the Entities table. Filter by type and/or tag.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', description: 'e.g. document, note, webpage, annotation, video' },
        tag: { type: 'string' },
        kind: { type: 'string', enum: ['entity', 'relationship'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        library: { type: 'boolean', description: 'Search the whole Library, not just the open project (e.g. to find things to project_add)' },
      },
      additionalProperties: false,
    } as const,
    run: ({ query, type, tag, kind, limit, library }) => {
      const q = { text: query, type: type || undefined, tags: tag ? [tag] : undefined, kind: kind ?? (type ? undefined : 'entity') }
      const results = library ? store.library.query(q) : store.query(q)
      const cap = limit ?? 25
      return json({ total: results.length, results: results.slice(0, cap).map(summarize) })
    },
  })

  const getEntity = betaTool({
    name: 'get_entity',
    description: 'Get one entity (its fields and data — long strings cut, data over ~16 KB has its largest values replaced by { $omitted, bytes }; read_document for a document\'s text) plus its relationships and neighbours. A hub with thousands of links gets them grouped by relationship type and direction, `relationships_limit` of each listed (default 40) and the count of the rest; graph_query or search_entities reach the others.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, relationships_limit: { type: 'integer', minimum: 0, maximum: 500, description: 'How many neighbours to list per relationship type and direction (default 40)' } }, required: ['id'], additionalProperties: false } as const,
    run: ({ id, relationships_limit }) => {
      const e = requireEntity(store, id)
      const data = slimData({ ...e.data }, { budget: 16_000 })
      if (typeof data.content === 'string' && data.content.length > 2000) data.content = data.content.slice(0, 2000) + '… (use read_document for the full text)'
      if (typeof data.dataUrl === 'string') data.dataUrl = `<${data.dataUrl.length} chars>`
      const limit = relationships_limit ?? 40
      const groups = new Map<string, { type: string; direction: 'in' | 'out'; count: number; listed: Record<string, unknown>[] }>()
      for (const { entity, via } of store.neighbors(e.id)) {
        const direction: 'in' | 'out' = via.source.id === e.id ? 'out' : 'in'
        const k = `${via.type}\u0001${direction}`
        let g = groups.get(k)
        if (!g) groups.set(k, (g = { type: via.type, direction, count: 0, listed: [] }))
        g.count++
        // An annotation's selector sits on the target end (the thing annotated): show it from either side.
        if (g.listed.length < limit) g.listed.push({ relationshipId: via.id, type: via.type, direction, other: summarize(entity), selector: via.target.selector ?? via.source.selector })
      }
      const total = [...groups.values()].reduce((n, g) => n + g.count, 0)
      const listed = [...groups.values()].flatMap((g) => g.listed)
      return json({
        ...e,
        data,
        relationships: listed,
        ...(listed.length < total ? { relationshipsTotal: total, relationshipsByType: [...groups.values()].map((g) => ({ type: g.type, direction: g.direction, count: g.count, listed: g.listed.length })), hint: `${total - listed.length} more neighbours not listed; raise relationships_limit, or query them (graph_query {selector: {roots: ["${e.id}"], depth: 1}})` } : {}),
        issues: validateEntity(e),
      })
    },
  })

  const createEnt = betaTool({
    name: 'create_entity',
    description: 'Create a non-document entity: a note, webpage, annotation, video, or any custom type. For documents use create_document.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Entity type, e.g. note, webpage, or a new custom type' },
        label: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        data: { type: 'object', description: 'Type-specific fields, e.g. {url} for webpage, {text} for note', additionalProperties: true },
        open: { type: 'boolean', description: 'Show it in the Entities browser, its detail pane open, afterwards (default true); false when making many, or as a part of something else' },
      },
      required: ['type', 'label'],
      additionalProperties: false,
    } as const,
    run: async ({ type, label, description, tags, data, open }) => {
      if (type === RESOURCE_TYPES.document) throw new Error('Use create_document for documents.')
      await approveLoadedUrls(host, data as Record<string, unknown> | undefined, `Saving the ${type} ${quoteLabel(label)}`)
      const e = createEntity({ type, label, description, tags, data: (data ?? {}) as Record<string, unknown>, meta: { source: 'assistant' } })
      store.upsert(e)
      if (open !== false) openMade(host, e.id, `${browserHref(e, host.registry ?? new TypeRegistry(store))}&tab=app`)
      return json({ ...summarize(e), issues: validateEntity(e) })
    },
  })

  const updateEntity = betaTool({
    name: 'update_entity',
    description: 'Update an entity\'s label, description, tags, or data properties (field name → value; data is merged, set a field to null to remove it; use set_properties for many entities or to define the property on the type). Works for documents too (e.g. renaming), but use write/edit_document for document text.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replaces the tag list' },
        add_tags: { type: 'array', items: { type: 'string' } },
        remove_tags: { type: 'array', items: { type: 'string' } },
        data: { type: 'object', additionalProperties: true },
      },
      required: ['id'],
      additionalProperties: false,
    } as const,
    run: async ({ id, label, description, tags, add_tags, remove_tags, data }) => {
      const e = requireEntity(store, id)
      await approveLoadedUrls(host, data as Record<string, unknown> | undefined, `Changing ${quoteLabel(displayLabel(e))}`)
      // The assistant's memory is rewritten only after the user has seen what changes (as the memory tool's rewrite).
      if (isOwnMemory(e) && (label !== undefined || description !== undefined || data || tags || add_tags || remove_tags) && !(await host.confirm(`Change the assistant's memory for this project? update_entity would set ${[label !== undefined && 'its name', description !== undefined && 'its description', data && `data (${Object.keys(data).join(', ')})`, (tags || add_tags || remove_tags) && 'its tags'].filter(Boolean).join(', ')}.`, { yes: 'Change', danger: true })))
        throw new Error('The user kept the memory as it was.')
      const patch: Partial<AnyEntity> = {}
      if (label !== undefined) patch.label = label
      if (description !== undefined) patch.description = description
      let nextTags = tags ? parseTags(tags) : e.tags
      if (add_tags) nextTags = parseTags([...nextTags, ...add_tags])
      if (remove_tags) nextTags = nextTags.filter((t) => !remove_tags.includes(t))
      if (tags || add_tags || remove_tags) patch.tags = nextTags
      if (data) {
        const merged: Record<string, unknown> = { ...e.data }
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          if (v === null) delete merged[k]
          else merged[k] = v
        }
        patch.data = merged
      }
      const next = store.update(e.id, patch)
      return json({ ...summarize(next), issues: validateEntity(next) })
    },
  })

  const deleteEntity = betaTool({
    name: 'delete_entity',
    description: 'Delete an entity and the relationships attached to it. Folders delete their contents. The user is asked to confirm first.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } as const,
    run: async ({ id }) => {
      const e = requireEntity(store, id)
      const nested = isDocument(e) && isFolder(e) ? descendantsOf(store, e.id).length : 0
      const ok = await host.confirm(`Delete ${nested ? `${nested + 1} items — ${quoteLabel(displayLabel(e))} and ${nested} nested in it` : quoteLabel(displayLabel(e))}? Attached relationships go too.`, { yes: 'Delete', danger: true })
      if (!ok) return 'The user declined. Nothing was deleted.'
      // Read the context first: once the entity is gone, the open-document lookup comes back empty.
      const openDoc = host.getContext().document?.id
      const removed = isDocument(e) ? deleteDocument(store, e.id) : (store.remove(e.id), [e.id])
      if (openDoc && removed.includes(openDoc)) host.navigate('/documents')
      return json({ deleted: removed })
    },
  })

  const createRel = betaTool({
    name: 'create_relationship',
    description: 'Link two entities. Relationships are entities too: they carry a type (e.g. references, related, derived-from, contains), tags, and an optional label.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'string' },
        target_id: { type: 'string' },
        type: { type: 'string', description: 'Defaults to "related"' },
        label: { type: 'string' },
        directed: { type: 'boolean', description: 'Defaults to true' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['source_id', 'target_id'],
      additionalProperties: false,
    } as const,
    run: ({ source_id, target_id, type, label, directed, tags }) => {
      requireEntity(store, source_id)
      requireEntity(store, target_id)
      const r = createRelationship({ source: source_id, target: target_id, type: type || 'related', label, directed: directed ?? true, tags, meta: { source: 'assistant' } })
      store.upsert(r)
      return json(summarize(r))
    },
  })

  const annotate = betaTool({
    name: 'annotate_document',
    description: 'Attach a comment to an exact passage of a document. Creates an annotation entity linked by an "annotates" relationship with a text-quote selector; it shows as a highlight in the editor preview.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string' },
        quote: { type: 'string', description: 'Exact text from the document to highlight' },
        comment: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['document_id', 'quote', 'comment'],
      additionalProperties: false,
    } as const,
    run: ({ document_id, quote, comment, tags }) => {
      const d = requireTextDocument(store, document_id)
      const content = contentOf(d)
      const at = content.indexOf(quote)
      if (at === -1) throw new Error('The quote was not found verbatim in the document. Copy it exactly from read_document.')
      const span = 32
      const a = annotateDocument(
        store,
        d,
        { exact: quote, prefix: at > 0 ? content.slice(Math.max(0, at - span), at) : undefined, suffix: content.slice(at + quote.length, at + quote.length + span) || undefined },
        comment,
        tags ?? [],
      )
      return json(summarize(a))
    },
  })

  const insights = betaTool({
    name: 'text_insights',
    description:
      'What a passage of text has to do with the open project — the Insights card a right-click on selected text opens. Returns `named`: entities whose name or alias appears in the text as whole words (`how`: whole — the text is the name; phrase — the name is a run of words in it; partial — a short text is part of the name), longest names first; `tags`: tags whose name or last segment (topic:graphs → graphs) appears, with how many entities carry each; `mentions`: for a text of six words or fewer, entities whose own text holds it as a phrase (the reading of search_entities). Case, accents and punctuation are ignored; words shorter than three letters and common words are never names. Use it to find what a quote, a paragraph of a document or a user\'s sentence refers to before linking or annotating; pass the document the text came from as `exclude`.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The passage (up to 4,000 characters are read)' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Entity ids to leave out — the document the text is from' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many of each list (default 30); the totals count them all' },
      },
      required: ['text'],
      additionalProperties: false,
    } as const,
    run: async ({ text, exclude, limit }) => {
      const registry = host.registry ?? new TypeRegistry(store)
      const r = textInsights(store, text, { exclude, limit, skip: (e) => registry.categoryOf(e.type) === 'schema' })
      const brief = (e: AnyEntity) => ({ id: e.id, label: displayLabel(e), type: e.type })
      return json({
        named: r.named.map((m) => ({ ...brief(m.entity), how: m.how, matched: m.matched })),
        namedTotal: r.namedTotal,
        tags: r.tags,
        mentions: r.mentions.map(brief),
        mentionsTotal: r.mentionsTotal,
      })
    },
  })

  return [searchEntities, getEntity, createEnt, updateEntity, deleteEntity, createRel, annotate, insights]
}
