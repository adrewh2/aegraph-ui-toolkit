import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { browserHref } from '../../app/openIn'
import { displayLabel, parseTags } from '../../core/entity/entity'
import { CATEGORY_ORDER, SCHEMA_TYPE, schemaTypeId, type TypeCategory } from '../../core/entity/categories'
import { TypeRegistry, schemaTypeEntity, type TableLayout } from '../../core/entity/typeRegistry'
import { applyTypeDraft, checkTypeDraft, typeDraft, type PropertyDraft } from '../../core/entity/typeEdit'
import { isRelationship, type AnyEntity } from '../../core/entity/types'
import { applyPlan, detectDiagramFormat, inferMapping, parseDiagram, planImport, writeDiagram, type DiagramFormat, type MappingSpec } from '../../core/diagrams'
import { createAnnotation } from '../../core/resources/annotations'
import { RESOURCE_TYPES, type WebpageData } from '../../core/resources/types'
import { createDiagram, isDiagram } from '../diagrams/diagrams'
import { attachStill } from '../videos/capture'
import { extractGeometry, layoutEngine, renderDiagram, svgToPng } from '../diagrams/render'
import { projectionFromPlan, projectionIdFor } from '../../core/graph/projection'
import { waitForWebpage } from '../resources/webpageHandle'
import { annotateMap, createArea, createLocation, createMap, createPath, geocode, geoAnnotationsOf, geoOf, importFeatures, isGeo, isMap, parseGeoJson, parseGoogleMapsUrl, parseKml, placesToGeoJson, placesToKml } from '../maps/maps'
import { enrichGeo, wikiPreviewOf } from '../maps/wikipedia'
import type { AppHost } from './tools'
import { fetchHandedUrl, openMade } from './toolkit'

const json = (v: unknown) => JSON.stringify(v)

/**
 * Tools for what the Entities browser and its inspector can do: open an entity on a
 * given inspector tab, annotate saved pages (with tab capture), edit and
 * convert diagrams and push them into the dataset, shape the ontology and
 * tags, and the maps (create a map, put locations, paths and areas on it,
 * pin notes, import KML/GeoJSON, read its state, enrich a place). Registered
 * alongside the core tools, so the assistant and the MCP bridge both get them.
 */
/** The `table` argument of define_entity_type and table_layout. */
const TABLE_LAYOUT_SCHEMA = {
  type: 'object',
  description: 'How the type\'s entities are laid out in tables: columns first (in this order, shown even if hidden by default), columns hidden by default, and the sort rows open in. Inherited by subtypes; exported with the data.',
  properties: {
    columns: { type: 'array', items: { type: 'string' } },
    hidden: { type: 'array', items: { type: 'string' } },
    sort: { type: 'object', properties: { key: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['key'], additionalProperties: false },
  },
  additionalProperties: false,
} as const

/** A layout from tool input: only the fields given, `dir` defaulting to ascending. */
function tableLayoutOf(input: { columns?: readonly string[]; hidden?: readonly string[]; sort?: { key: string; dir?: string } }): TableLayout {
  const out: TableLayout = {}
  if (input.columns !== undefined) out.columns = [...input.columns]
  if (input.hidden !== undefined) out.hidden = [...input.hidden]
  if (input.sort !== undefined) out.sort = { key: input.sort.key, dir: input.sort.dir === 'desc' ? 'desc' : 'asc' }
  return out
}

export function createMoreTools(host: AppHost) {
  const { store } = host
  const registry = () => host.registry ?? new TypeRegistry(store)
  const requireEntity = (id: string): AnyEntity => {
    const e = store.get(id)
    if (!e) throw new Error(`No entity with id ${id}. Use search_entities to find ids.`)
    return e
  }

  /** Where the Entities browser shows this entity: its category and type, selected, on a tab. */
  const inspectHref = (e: AnyEntity, tab?: string) => {
    const base = browserHref(e, registry())
    return tab ? `${base}&tab=${encodeURIComponent(tab)}` : base
  }

  const inspect = betaTool({
    name: 'inspect',
    description:
      'Show an entity in the Entities browser with the detail pane open on a tab. Tabs: app (the interactive form — editor, image annotator, player, diagram workbench, page frame), fields, annotations, relationships, json. Use this to put something on screen for the user, or before annotate_webpage so the page is visible to capture.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entity id' },
        tab: { type: 'string', enum: ['app', 'fields', 'annotations', 'relationships', 'json'], description: 'Detail pane tab (default: app when the type has one)' },
      },
      required: ['id'],
      additionalProperties: false,
    } as const,
    run: ({ id, tab }) => {
      const e = requireEntity(id)
      const to = inspectHref(e, tab)
      host.navigate(to)
      return json({ opened: to, label: displayLabel(e), type: e.type })
    },
  })

  const annotateWebpage = betaTool({
    name: 'annotate_webpage',
    description:
      'Annotate a saved webpage. With a region (fractions 0–1 of the visible frame: x, y, width, height), the page is shown in the detail pane and the tab is captured so the annotation stores a still with the region in still pixels — the user may be asked once to share the tab. Without a region it is a note about the whole page; set capture=true to also save a still.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Webpage entity id' },
        comment: { type: 'string' },
        tags: { type: 'string', description: 'Comma-separated tags' },
        region: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
          description: 'Part of the visible frame, as fractions of its width/height',
        },
        capture: { type: 'boolean', description: 'Save a still of the page with the annotation (always true when a region is given)' },
      },
      required: ['id', 'comment'],
      additionalProperties: false,
    } as const,
    run: async ({ id, comment, tags, region, capture }) => {
      const e = requireEntity(id)
      if (isRelationship(e) || e.type !== RESOURCE_TYPES.webpage) throw new Error(`Entity ${id} is a ${e.type}, not a webpage.`)
      const url = (e.data as WebpageData).url
      const wantStill = !!region || !!capture
      let still
      if (wantStill) {
        host.navigate(inspectHref(e, 'app'))
        const h = await waitForWebpage(e.id)
        if (!h) throw new Error('The page did not open in the detail pane; try inspect first, then annotate again.')
        still = await h.capture()
        if (!still) throw new Error('Tab capture was declined or unavailable, so no still could be saved. Retry without a region to add a plain note.')
      }
      let selector
      if (region && still) {
        const clamp = (v: number) => Math.max(0, Math.min(1, v))
        const x = clamp(region.x)
        const y = clamp(region.y)
        const w = clamp(region.width)
        const hgt = clamp(region.height)
        if (w <= 0 || hgt <= 0) throw new Error('Region width and height must be positive fractions.')
        selector = { kind: 'region' as const, x: Math.round(x * still.width), y: Math.round(y * still.height), width: Math.round(Math.min(1 - x, w) * still.width), height: Math.round(Math.min(1 - y, hgt) * still.height) }
      }
      const a = createAnnotation(store, e.id, selector, { comment, tags: parseTags(tags ?? ''), annotationType: still ? 'image' : 'note', data: { pageUrl: url } })
      if (still) attachStill(store, a.id, still)
      host.notify?.(selector ? 'Annotated a region of the page' : 'Annotated the page')
      return json({ id: a.id, selector, still: still ? { width: still.width, height: still.height } : undefined })
    },
  })

  const createDiagramTool = betaTool({
    name: 'create_diagram',
    description: 'Create a diagram resource from Graphviz DOT or Mermaid source. The format is detected when not given. Returns the parse summary.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        source: { type: 'string', description: 'DOT or Mermaid source text' },
        format: { type: 'string', enum: ['dot', 'mermaid'] },
        tags: { type: 'string', description: 'Comma-separated tags' },
        open: { type: 'boolean', description: 'Show it in its workbench afterwards (default true); false to make it without leaving the page, e.g. one of several' },
      },
      required: ['label', 'source'],
      additionalProperties: false,
    } as const,
    run: ({ label, source, format, tags, open }) => {
      const fmt: DiagramFormat = format ?? detectDiagramFormat(source)
      const e = createDiagram(store, { label, source, format: fmt, tags: parseTags(tags ?? ''), source_: 'assistant' })
      if (open !== false) openMade(host, e.id, inspectHref(e, 'app'))
      return json({ id: e.id, format: fmt, ...summarizeDiagram(source, fmt) })
    },
  })

  const viewDiagram = betaTool({
    name: 'view_diagram',
    description: 'Look at a diagram: its picture (rendered from the source — Graphviz, Mermaid, or the Excalidraw geometry — as a PNG you can see), the parse summary and, with `source: true`, the text itself. Use it to check a diagram before writing to it, or to describe one to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        source: { type: 'boolean', description: 'Include the source text (default false)' },
        scale: { type: 'number', minimum: 0.5, maximum: 4, description: 'Raster scale (default 2)' },
      },
      required: ['id'],
      additionalProperties: false,
    } as const,
    run: async ({ id, source, scale }) => {
      const e = requireEntity(id)
      if (!isDiagram(e)) throw new Error(`Entity ${id} is a ${e.type}, not a diagram.`)
      const summary = summarizeDiagram(e.data.source, e.data.format)
      const head = { id: e.id, label: displayLabel(e), format: e.data.format, ...summary, ...(source ? { source: e.data.source } : {}) }
      let svg = ''
      try {
        svg = await renderDiagram(e.data.source, e.data.format, layoutEngine(e.data.source) ?? 'dot')
      } catch (err) {
        return json({ ...head, renderError: err instanceof Error ? err.message : String(err) })
      }
      if (!svg) return json({ ...head, note: 'Nothing to draw: the source is empty.' })
      const png = await svgToPng(svg, scale ?? 2)
      return [
        { type: 'text' as const, text: JSON.stringify(head) },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: png.split(',')[1] } },
      ]
    },
  })

  const writeDiagramTool = betaTool({
    name: 'write_diagram',
    description:
      'Replace a diagram\'s source, or convert it between Graphviz, Mermaid and Excalidraw (structure, groups, colours and line styles are kept; the rendered geometry is carried into Excalidraw). Returns the parse summary of the result.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Diagram entity id' },
        source: { type: 'string', description: 'New source text (format detected unless given)' },
        format: { type: 'string', enum: ['dot', 'mermaid', 'excalidraw'], description: 'Format of `source`' },
        convert_to: { type: 'string', enum: ['dot', 'mermaid', 'excalidraw'], description: 'Convert the current (or new) source to this format' },
        engine: { type: 'string', description: 'Graphviz engine used to lay the diagram out when converting DOT to Excalidraw (default dot)' },
      },
      required: ['id'],
      additionalProperties: false,
    } as const,
    run: async ({ id, source, format, convert_to, engine }) => {
      const e = requireEntity(id)
      if (!isDiagram(e)) throw new Error(`Entity ${id} is a ${e.type}, not a diagram.`)
      let src = source ?? e.data.source
      let fmt: DiagramFormat = source ? (format ?? detectDiagramFormat(source)) : e.data.format
      const conversionWarnings: string[] = []
      if (convert_to && convert_to !== fmt) {
        const laid = await parsedWithGeometry(src, fmt, convert_to, engine)
        conversionWarnings.push(...laid.warnings)
        src = writeDiagram(laid, convert_to)
        fmt = convert_to
      }
      if (!source && !convert_to) throw new Error('Give a new source, a convert_to format, or both.')
      const parsed = parseDiagram(src, fmt)
      store.update(e.id, { data: { ...e.data, source: src, format: fmt, kind: parsed.kind } })
      const summary = summarizeDiagram(src, fmt)
      return json({ id: e.id, format: fmt, ...summary, warnings: [...new Set([...(summary.warnings ?? []), ...conversionWarnings])] })
    },
  })

  /** Excalidraw needs positions: render the source (Graphviz / Mermaid) and carry its geometry; other targets take the plain parse. */
  async function parsedWithGeometry(src: string, fmt: DiagramFormat, target: DiagramFormat, engine?: string) {
    const parsed = parseDiagram(src, fmt)
    if (target !== 'excalidraw' || parsed.geometry) return parsed
    try {
      return { ...parsed, geometry: await extractGeometry(src, fmt, parsed, engine ?? 'dot') }
    } catch (err) {
      // The writer lays it out itself, but the caller should know the renderer's routes were lost.
      parsed.warnings.push(`layout fell back to a simple grid: ${err instanceof Error ? err.message : String(err)}`)
      return parsed
    }
  }

  const diagramToDataset = betaTool({
    name: 'diagram_to_dataset',
    description:
      'Turn a diagram\'s nodes and edges into entities and relationships in the dataset — what the Export to dataset wizard does. Without a mapping the inferred one is used (node type from group/class/shape, edge type from label). Set dry_run to preview counts without writing. Re-running updates what it created before.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Diagram entity id' },
        mapping: {
          type: 'object',
          description: 'Partial MappingSpec overrides: nodeTypeBy (group|class|shape|fixed), nodeTypes {key: type}, fixedNodeType, edgeTypeBy (label|style|fixed), edgeTypes {key: type}, fixedEdgeType, tags [..], mergeByLabel, linkToDiagram, attrsToData',
          additionalProperties: true,
        },
        dry_run: { type: 'boolean' },
        capture_geometry: { type: 'boolean', description: 'Also capture positions/sizes/routes as a scene for the Scenes page (default true)' },
        engine: { type: 'string', description: 'Graphviz layout engine for the capture (dot, neato, fdp, sfdp, circo, twopi, osage, patchwork)' },
      },
      required: ['id'],
      additionalProperties: false,
    } as const,
    run: async ({ id, mapping, dry_run, capture_geometry, engine }) => {
      const e = requireEntity(id)
      if (!isDiagram(e)) throw new Error(`Entity ${id} is a ${e.type}, not a diagram.`)
      const parsed = parseDiagram(e.data.source, e.data.format)
      const spec: MappingSpec = { ...inferMapping(parsed, e.label), ...((e.data.mapping as Partial<MappingSpec> | undefined) ?? {}), ...((mapping as Partial<MappingSpec> | undefined) ?? {}) }
      const plan = planImport(store, e, parsed, spec)
      const summary = { entities: plan.entities.length, relationships: plan.relationships.length, created: plan.created, updated: plan.updated, reused: plan.reused.length, collapsed: plan.collapsed, skippedEdges: plan.skippedEdges, mapping: spec }
      if (dry_run) return json({ dryRun: true, ...summary })
      applyPlan(store, plan)
      let projectionId: string | undefined
      if (capture_geometry !== false) {
        try {
          const geometry = await extractGeometry(e.data.source, e.data.format, parsed, engine ?? 'dot')
          const proj = projectionFromPlan(e, parsed, geometry, plan, store.get(projectionIdFor(e.id)), e.data.format === 'dot' ? (engine ?? 'dot') : undefined)
          store.upsert(proj)
          projectionId = proj.id
        } catch (err) {
          host.notify?.(`Geometry not captured: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      store.update(e.id, { data: { ...e.data, mapping: spec as unknown as Record<string, unknown>, lastImport: { at: new Date().toISOString(), entities: plan.entities.length, relationships: plan.relationships.length, projectionId } } })
      host.notify?.(`Exported ${plan.entities.length} entities and ${plan.relationships.length} relationships from “${displayLabel(e)}”`)
      return json({ ...summary, projectionId, display: projectionId ? `/scenes?id=${projectionId}` : undefined })
    },
  })

  const defineType = betaTool({
    name: 'define_entity_type',
    description: 'Define or update an entity type in the ontology (stored as a schema:type entity, so it exports with the data) — what the New type dialog and a type\'s Edit view do: label, plural label, category, parent type, colour, description, and its properties (key, label, kind, description, allowed values, required). Renaming a property moves the value on every entity of the type and its subtypes; giving a property a kind converts the values that can be read as it (the rest stay as written) — the result says how many of each. Removing a property takes it off the definition; entities keep their values.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Type name, e.g. "architect"' },
        label: { type: 'string' },
        plural_label: { type: 'string', description: 'How a list of them is headed, e.g. "Cities" (default: the label with an s)' },
        category: { type: 'string', enum: ['resource', 'knowledge', 'project', 'schema'] },
        parent: { type: 'string', description: 'Broader type this one specialises ("" to make it a type of its own)' },
        color: { type: 'string', description: 'Hex color ("" for its own colour from the palette)' },
        description: { type: 'string' },
        properties: {
          type: 'array',
          description: 'Properties (data fields) entities of this type carry; each becomes a column and an inspector row. Merged by key with what is already defined.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'The data key, e.g. "year"' },
              label: { type: 'string' },
              kind: { type: 'string', enum: ['text', 'longtext', 'number', 'boolean', 'date', 'datetime', 'url', 'image', 'color', 'json'], description: 'Which widget and column format the property gets: date and datetime give pickers, number a number box, boolean true/false, colour a swatch' },
              description: { type: 'string' },
              options: { type: 'array', items: { type: 'string' }, description: 'Fixed set of allowed values' },
              required: { type: 'boolean', description: 'Must be given when an entity of the type is made by hand' },
            },
            required: ['key'],
            additionalProperties: false,
          },
        },
        remove_properties: { type: 'array', items: { type: 'string' }, description: 'Property keys to drop from the definition (entities keep their values)' },
        rename_properties: {
          type: 'array',
          description: 'Properties to rename: the value moves from the old key to the new on every entity of the type and its subtypes. Applied before `properties`, which may then describe the new key.',
          items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false },
        },
        table: TABLE_LAYOUT_SCHEMA,
      },
      required: ['name'],
      additionalProperties: false,
    } as const,
    run: ({ name, label, plural_label, category, parent, color, description, properties, remove_properties, rename_properties, table }) => {
      const n = name.trim()
      if (!n) throw new Error('Type name is required.')
      if (category && !CATEGORY_ORDER.includes(category as TypeCategory)) throw new Error(`Unknown category ${category}.`)
      // The editor's own path (core/entity/typeEdit.ts): a draft of the type as it is, the call's changes on it, then saved.
      const reg = new TypeRegistry(store)
      const existing = store.get(schemaTypeId(n))
      const draft = typeDraft(store, reg, n)
      if (!existing) {
        draft.label = n.charAt(0).toUpperCase() + n.slice(1)
        draft.pluralLabel = ''
      }
      if (label) draft.label = label
      if (plural_label !== undefined) draft.pluralLabel = plural_label
      if (category) draft.category = category as TypeCategory
      if (parent !== undefined) draft.parent = parent || undefined
      if (color !== undefined) draft.color = color || undefined
      if (description !== undefined) draft.description = description
      for (const r of rename_properties ?? []) {
        const p = draft.properties.find((q) => q.key === r.from)
        if (!p) throw new Error(`${n} has no property ${r.from} to rename.`)
        p.key = r.to
      }
      const drop = new Set(remove_properties ?? [])
      draft.properties = draft.properties.filter((p) => !drop.has(p.key))
      for (const q of properties ?? []) {
        const at = draft.properties.findIndex((p) => p.key === q.key)
        if (at >= 0) draft.properties[at] = { ...draft.properties[at], ...q }
        else draft.properties.push({ ...q } as PropertyDraft)
      }
      const issues = checkTypeDraft(draft, reg, { isNew: false, store })
      if (issues.length) throw new Error(issues.map((i) => i.message).join(' '))
      const { plan } = applyTypeDraft(store, reg, draft)
      if (table) store.upsert(schemaTypeEntity(n, { table: tableLayoutOf(table) }, store.get(schemaTypeId(n))))
      const after = new TypeRegistry(store)
      const t = after.get(n)
      return json({
        id: schemaTypeId(n),
        type: SCHEMA_TYPE,
        name: n,
        label: t.label,
        plural_label: t.pluralLabel,
        category: t.category,
        parent: t.parent,
        color: t.color,
        count: t.count,
        properties: after.propertiesOf(n),
        table: after.tableOf(n),
        ...(plan.renamed.length || plan.converted.length ? { changed: { renamed: plan.renamed, converted: plan.converted } } : {}),
      })
    },
  })

  const tableLayout = betaTool({
    name: 'table_layout',
    description:
      'Say how entities are laid out in tables. With `type`: the column order, hidden columns and default sort for that type\'s entities everywhere they are tabled — stored on the type definition (`data.table`), inherited by subtypes, exported with the data. With `map_id`: the map page\'s own table — which kinds (`location`, `path`, `area`) or types its All tab shows by default (the rest stay a tick away in the Types menu), its sort, and columns on top of the types\' layouts. Column keys are as list_properties gives them: `label`, `type`, `tags`, `description`, `data.<key>`, `meta.createdAt`… Omit every layout field to read the layout in force; pass `clear` to remove it.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'A type name, e.g. "location" — its layout applies to subtypes too unless they set their own' },
        map_id: { type: 'string', description: 'A map entity id: lay out the map page\'s table instead' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Columns that come first, in this order; a column named here is shown even if hidden by default. The label column always stays first.' },
        hidden: { type: 'array', items: { type: 'string' }, description: 'Columns hidden by default (still in the Columns menu and the inspector)' },
        sort: { type: 'object', properties: { key: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }, required: ['key'], additionalProperties: false, description: 'The order rows come in until someone clicks a header' },
        types: { type: 'array', items: { type: 'string' }, description: 'Maps only: the kinds or types the All tab shows by default, e.g. ["location", "path"] to leave areas out' },
        clear: { type: 'boolean', description: 'Remove the layout' },
      },
      additionalProperties: false,
    } as const,
    run: ({ type, map_id, columns, hidden, sort, types, clear }) => {
      if (!type && !map_id) throw new Error('Pass a type name or a map_id.')
      if (type && map_id) throw new Error('Pass a type name or a map_id, not both.')
      const setting = clear || columns !== undefined || hidden !== undefined || sort !== undefined || types !== undefined
      if (map_id) {
        const m = store.get(map_id)
        if (!isMap(m)) throw new Error(`${map_id} is not a map.`)
        if (setting) {
          const prev = m.data.table ?? {}
          const next = clear ? undefined : { ...prev, ...tableLayoutOf({ columns, hidden, sort }), ...(types !== undefined ? { types } : {}) }
          store.update(m.id, { data: { ...m.data, table: next } })
        }
        const now = store.get(map_id)
        return json({ map: map_id, table: isMap(now) ? (now.data.table ?? null) : null, ...(setting ? {} : { note: 'Nothing changed; pass columns, hidden, sort or types to set the layout.' }) })
      }
      const n = type!.trim()
      const existing = store.get(schemaTypeId(n))
      if (setting) {
        const reg = new TypeRegistry(store)
        const patch: Parameters<typeof schemaTypeEntity>[1] = { table: clear ? undefined : { ...(reg.get(n).table ?? {}), ...tableLayoutOf({ columns, hidden, sort }) } }
        if (!existing) {
          const t = reg.get(n)
          patch.label = t.label
          patch.category = t.category
        }
        const e = schemaTypeEntity(n, patch, existing)
        if (clear) delete e.data.table
        store.upsert(e)
      }
      const reg = new TypeRegistry(store)
      return json({ type: n, table: reg.tableOf(n) ?? null, own: reg.get(n).table ?? null, columns: reg.fieldsFor(n).map((f) => ({ key: f.key, label: f.label, hidden: !!f.hidden })), ...(setting ? {} : { note: 'Nothing changed; pass columns, hidden or sort to set the layout.' }) })
    },
  })

  const updateTag = betaTool({
    name: 'update_tag',
    description: 'Rename a tag across every entity, or set its color / description. Use list_tags to see tags.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string' },
        rename_to: { type: 'string' },
        color: { type: 'string', description: 'Hex color, or empty to clear' },
        description: { type: 'string' },
      },
      required: ['tag'],
      additionalProperties: false,
    } as const,
    run: ({ tag, rename_to, color, description }) => {
      let name = tag.trim()
      if (!name) throw new Error('Tag is required.')
      if (color !== undefined || description !== undefined) store.setTagInfo(name, { ...(color !== undefined ? { color: color || undefined } : {}), ...(description !== undefined ? { description } : {}) })
      if (rename_to && rename_to.trim() !== name) {
        store.renameTag(name, rename_to.trim())
        name = rename_to.trim()
      }
      const info = store.getTagInfo(name)
      return json({ tag: name, usage: store.tagUsage(name), color: info.color, description: info.description })
    },
  })

  const createMapTool = betaTool({
    name: 'create_map',
    description: 'Create a map resource (OpenStreetMap). Optionally centred on a place name (geocoded) or coordinates. `pins` says how its locations are drawn: "points" — every one a dot on one canvas (Unigraph\'s engine), however many, at every zoom; "bubbles" — a pin each, piling into counted bubbles where they crowd; unset, a map of 2,000 locations or more draws points. Change it later with update_entity on the map\'s data.pins, or the Layers menu on the map page.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        center: { type: 'string', description: 'A place name to geocode, a "lat, lng" pair, or a Google Maps link' },
        zoom: { type: 'number' },
        layer: { type: 'string', enum: ['streets', 'satellite', 'terrain'] },
        pins: { type: 'string', enum: ['points', 'bubbles'], description: 'How locations are drawn (see above); unset decides by count' },
        open: { type: 'boolean', description: 'Open the map page afterwards (default true); false to make it without leaving the page' },
      },
      required: ['label'],
      additionalProperties: false,
    } as const,
    run: async ({ label, center, zoom, layer, pins, open }) => {
      let c = center ? parseGoogleMapsUrl(center) : null
      if (center && !c) {
        const hits = await geocode(center, 1)
        if (!hits.length) throw new Error(`Nowhere found for “${center}”.`)
        c = { lat: hits[0].lat, lng: hits[0].lng }
      }
      const m = createMap(store, { label, center: c ?? undefined, zoom: zoom ?? (c ? 12 : 2), layer: layer as 'streets' | 'satellite' | 'terrain' | undefined, pins: pins as 'points' | 'bubbles' | undefined })
      if (open !== false) openMade(host, m.id, `/maps/${m.id}`)
      return json({ id: m.id, center: m.data.center, zoom: m.data.zoom })
    },
  })

  const addPlace = betaTool({
    name: 'add_location',
    description:
      'Add a location (a knowledge entity with coordinates), on a map when map_id is given (else on the Maps home only). Give coordinates, a Google Maps link, or an address / place name to geocode. Optional time (ISO) for when it mattered. For lines and regions use add_path / add_area.',
    inputSchema: {
      type: 'object',
      properties: {
        map_id: { type: 'string', description: 'The map it belongs to (optional)' },
        label: { type: 'string' },
        where: { type: 'string', description: '"lat, lng", a Google Maps link, or a place name / address to geocode' },
        at: { type: 'string', description: 'ISO date-time' },
        until: { type: 'string', description: 'ISO date-time' },
        tags: { type: 'string', description: 'Comma-separated' },
        description: { type: 'string' },
      },
      required: ['where'],
      additionalProperties: false,
    } as const,
    run: async ({ map_id, label, where, at, until, tags, description }) => {
      const parsed = parseGoogleMapsUrl(where)
      let lat: number
      let lng: number
      let address: string | undefined
      let source = 'manual'
      if (parsed) {
        lat = parsed.lat
        lng = parsed.lng
        address = parsed.label
        if (/^https?:/.test(where.trim())) source = 'google-maps'
      } else {
        const hits = await geocode(where, 1)
        if (!hits.length) throw new Error(`Nowhere found for “${where}”.`)
        lat = hits[0].lat
        lng = hits[0].lng
        address = hits[0].label
        source = 'geocode'
      }
      const m = map_id ? requireEntity(map_id) : undefined
      if (m && !isMap(m)) throw new Error(`Entity ${map_id} is a ${m.type}, not a map.`)
      const p = createLocation(store, { label: label ?? address ?? where, lat, lng, address, at, until, tags: parseTags(tags ?? ''), description, source, url: source === 'google-maps' ? where.trim() : undefined, mapId: m?.id })
      return json({ id: p.id, lat, lng, address, onMap: m?.id })
    },
  })

  /** "lat, lng; lat, lng; …" or a GeoJSON-style array of [lng, lat] pairs. */
  const parsePoints = (points: string | number[][]): [number, number][] => {
    if (Array.isArray(points)) return points.map((c) => [Number(c[0]), Number(c[1])] as [number, number])
    return points
      .split(/[;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const c = parseGoogleMapsUrl(s)
        if (!c) throw new Error(`Not a "lat, lng" pair: “${s}”`)
        return [c.lng, c.lat] as [number, number]
      })
  }
  const pointsSchema = {
    oneOf: [
      { type: 'string', description: '"lat, lng; lat, lng; …" — semicolon- or newline-separated pairs' },
      { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, description: 'GeoJSON order: [[lng, lat], …]' },
    ],
  } as const
  const geoInit = (input: { map_id?: string; at?: string; until?: string; tags?: string; description?: string }) => {
    const m = input.map_id ? requireEntity(input.map_id) : undefined
    if (m && !isMap(m)) throw new Error(`Entity ${input.map_id} is a ${m.type}, not a map.`)
    return { mapId: m?.id, at: input.at, until: input.until, tags: parseTags(input.tags ?? ''), description: input.description, source: 'assistant' }
  }

  const addPathTool = betaTool({
    name: 'add_path',
    description: 'Add a path — a line on Earth: a route, a journey, a border — from its points in order (at least two), on a map when map_id is given. Optional time span (ISO) for when it was travelled. Length is computed.',
    inputSchema: {
      type: 'object',
      properties: {
        map_id: { type: 'string', description: 'The map it belongs to (optional)' },
        label: { type: 'string' },
        points: pointsSchema,
        at: { type: 'string', description: 'ISO date-time' },
        until: { type: 'string', description: 'ISO date-time' },
        tags: { type: 'string', description: 'Comma-separated' },
        description: { type: 'string' },
      },
      required: ['label', 'points'],
      additionalProperties: false,
    } as const,
    run: ({ map_id, label, points, at, until, tags, description }) => {
      const p = createPath(store, { label, coordinates: parsePoints(points as string | number[][]), ...geoInit({ map_id, at, until, tags, description }) })
      return json({ id: p.id, points: (p.data.geometry as { coordinates: unknown[] }).coordinates.length, lengthM: p.data.lengthM, onMap: p.data.mapId })
    },
  })

  const addAreaTool = betaTool({
    name: 'add_area',
    description: 'Add an area — a region on Earth: a site, a district, a zone — from the points of its outline in order (at least three; closed automatically), on a map when map_id is given. Optional time span (ISO). Area is computed.',
    inputSchema: {
      type: 'object',
      properties: {
        map_id: { type: 'string', description: 'The map it belongs to (optional)' },
        label: { type: 'string' },
        points: pointsSchema,
        at: { type: 'string', description: 'ISO date-time' },
        until: { type: 'string', description: 'ISO date-time' },
        tags: { type: 'string', description: 'Comma-separated' },
        description: { type: 'string' },
      },
      required: ['label', 'points'],
      additionalProperties: false,
    } as const,
    run: ({ map_id, label, points, at, until, tags, description }) => {
      const a = createArea(store, { label, ring: parsePoints(points as string | number[][]), ...geoInit({ map_id, at, until, tags, description }) })
      return json({ id: a.id, points: (a.data.geometry as { coordinates: unknown[][] }).coordinates[0].length - 1, areaM2: a.data.areaM2, onMap: a.data.mapId })
    },
  })

  const annotateMapTool = betaTool({
    name: 'annotate_map',
    description: 'Pin a note on a map at a point, optionally with a radius (metres) and a time or span (ISO). The note is an annotation with a geo selector.',
    inputSchema: {
      type: 'object',
      properties: {
        map_id: { type: 'string' },
        comment: { type: 'string' },
        where: { type: 'string', description: '"lat, lng", a Google Maps link, or a place name / address to geocode' },
        radius: { type: 'number' },
        at: { type: 'string' },
        until: { type: 'string' },
        tags: { type: 'string' },
      },
      required: ['map_id', 'comment', 'where'],
      additionalProperties: false,
    } as const,
    run: async ({ map_id, comment, where, radius, at, until, tags }) => {
      const m = requireEntity(map_id)
      if (!isMap(m)) throw new Error(`Entity ${map_id} is a ${m.type}, not a map.`)
      let c = parseGoogleMapsUrl(where)
      if (!c) {
        const hits = await geocode(where, 1)
        if (!hits.length) throw new Error(`Nowhere found for “${where}”.`)
        c = { lat: hits[0].lat, lng: hits[0].lng }
      }
      const a = annotateMap(store, m, { lat: c.lat, lng: c.lng, radius, at, until }, comment, parseTags(tags ?? ''), 'assistant')
      return json({ id: a.id, lat: c.lat, lng: c.lng, at })
    },
  })

  const enrich = betaTool({
    name: 'enrich_location',
    description: 'Give locations, paths and areas a rich preview — a photo and a summary paragraph from Wikipedia — stored on the entity (data.preview: title, extract, image, url) and shown on the map’s hover card, in the table and in details. Pass one id, or a map_id to do everything on that map; already-enriched ones are skipped unless force. No key needed; a few requests per item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A location / path / area' },
        map_id: { type: 'string', description: 'Every location, path and area on this map' },
        lang: { type: 'string', description: 'Wikipedia language edition (default en)' },
        force: { type: 'boolean', description: 'Refetch even when a preview exists' },
      },
      additionalProperties: false,
    } as const,
    run: async ({ id, map_id, lang, force }) => {
      const targets = id ? [requireEntity(id)] : map_id ? geoOf(store, (() => { const m = requireEntity(map_id); if (!isMap(m)) throw new Error(`Entity ${map_id} is a ${m.type}, not a map.`); return m })()) : []
      if (!targets.length) throw new Error('enrich_location needs an id or a map_id.')
      const out: { id: string; label: string; found: boolean; title?: string; image?: boolean }[] = []
      for (const e of targets) {
        if (!isGeo(e)) throw new Error(`Entity ${e.id} is a ${e.type}, not a location, path or area.`)
        const p = await enrichGeo(store, e, { lang, force }).catch(() => undefined)
        await new Promise((r) => setTimeout(r, 600)) // gently: Wikimedia throttles bursts
        out.push({ id: e.id, label: displayLabel(e), found: !!p, title: p?.title, image: !!p?.image })
      }
      return json({ enriched: out.filter((o) => o.found).length, of: out.length, items: out })
    },
  })

  const mapState = betaTool({
    name: 'map_state',
    description: 'What a map shows: its locations, paths and areas (with coordinates, shapes and times) and pinned notes.',
    inputSchema: { type: 'object', properties: { map_id: { type: 'string' }, format: { type: 'string', enum: ['geojson', 'kml'], description: 'Return the map as a file instead: GeoJSON (a FeatureCollection) or KML (Google Earth), notes included — what the map page\'s Export downloads' } }, required: ['map_id'], additionalProperties: false } as const,
    run: ({ map_id, format }) => {
      const m = requireEntity(map_id)
      if (!isMap(m)) throw new Error(`Entity ${map_id} is a ${m.type}, not a map.`)
      if (format) {
        const places = geoOf(store, m)
        const notes = geoAnnotationsOf(store, m.id)
        return format === 'kml' ? placesToKml(displayLabel(m), places, notes) : placesToGeoJson(places, notes)
      }
      return json({
        id: m.id,
        label: displayLabel(m),
        center: m.data.center,
        zoom: m.data.zoom,
        layer: m.data.layer,
        pins: m.data.pins ?? null,
        features: geoOf(store, m).map((p) => ({ id: p.id, type: p.type, label: displayLabel(p), lat: p.data.lat, lng: p.data.lng, geometry: p.data.geometry, lengthM: p.data.lengthM, areaM2: p.data.areaM2, address: p.data.address, at: p.data.at, until: p.data.until, tags: p.tags, description: p.description, preview: wikiPreviewOf(p) ? { title: wikiPreviewOf(p)!.title, image: !!wikiPreviewOf(p)!.image } : undefined })),
        notes: geoAnnotationsOf(store, m.id).map((n) => ({ id: n.annotation.id, comment: n.annotation.data.comment, lat: n.geo.lat, lng: n.geo.lng, radius: n.geo.radius, at: n.geo.at, until: n.geo.until, tags: n.annotation.tags })),
      })
    },
  })
  const mapImport = betaTool({
    name: 'map_import',
    description: 'Import places onto a map from KML (Google Earth) or GeoJSON — the text itself, or a URL to fetch it from (same-origin or CORS-enabled). Points become locations, LineStrings paths, Polygons areas, each with the feature\'s name, description and time when it has them. The format is detected. Returns what was created.',
    inputSchema: {
      type: 'object',
      properties: {
        map_id: { type: 'string' },
        text: { type: 'string', description: 'The KML or GeoJSON' },
        url: { type: 'string', description: 'Fetch the file from here instead of `text`' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for every entity created' },
      },
      required: ['map_id'],
      additionalProperties: false,
    } as const,
    run: async ({ map_id, text, url, tags }) => {
      const m = requireEntity(map_id)
      if (!isMap(m)) throw new Error(`Entity ${map_id} is a ${m.type}, not a map.`)
      let src = text ?? ''
      if (!src && url) {
        const r = await fetchHandedUrl(host, url, 'Importing onto a map')
        if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`)
        src = await r.text()
      }
      if (!src.trim()) throw new Error('Pass `text` or `url`.')
      const kml = /^\s*(<\?xml|<kml)/i.test(src)
      const parsed = kml ? parseKml(src) : parseGeoJson(src)
      if (!parsed.features.length) throw new Error('No features with coordinates in the file.')
      const added = importFeatures(store, m, parsed.features, kml ? 'kml' : 'geojson', tags ?? [])
      return json({ map: m.id, name: parsed.name, added: added.length, locations: added.filter((e) => e.type === 'location').length, paths: added.filter((e) => e.type === 'path').length, areas: added.filter((e) => e.type === 'area').length, ids: added.slice(0, 50).map((e) => e.id) })
    },
  })
  return [inspect, annotateWebpage, createDiagramTool, viewDiagram, writeDiagramTool, diagramToDataset, defineType, tableLayout, updateTag, createMapTool, addPlace, addPathTool, addAreaTool, annotateMapTool, enrich, mapState, mapImport]
}

function summarizeDiagram(source: string, format: DiagramFormat) {
  try {
    const p = parseDiagram(source, format)
    return { kind: p.kind, nodes: p.nodes.length, edges: p.edges.length, groups: p.groups.length, warnings: p.warnings.slice(0, 5) }
  } catch (err) {
    return { kind: 'unknown', nodes: 0, edges: 0, groups: 0, warnings: [err instanceof Error ? err.message : String(err)] }
  }
}
