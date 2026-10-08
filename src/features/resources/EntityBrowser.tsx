import { BarChart3, ChevronDown, Download, Filter, FolderPlus, Info, ListPlus, MoreHorizontal, Plus, Search, Waypoints, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type DragEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { entityHref } from '../../app/routes'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { TagChip } from '../../components/ui/TagChip'
import { useToast } from '../../components/ui/useToast'
import { useReportTable } from '../assistant/screen'
import { CATEGORIES, type TypeCategory } from '../../core/entity/categories'
import { CategoryRail } from '../entities/CategoryRail'
import { edgeColor } from '../../core/graph/style'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreDataVersion, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import { datasetFromEntities } from '../../core/datasets/fromEntities'
import { BASE_FIELDS, getField, type FieldDef } from '../../core/entity/schema'
import type { ResolvedType } from '../../core/entity/typeRegistry'
import { isRelationship, type AnyEntity, type EntityId } from '../../core/entity/types'
import { entitiesToDocument } from '../../core/exchange/subset'
import { downloadText, toCsv } from '../../lib/download'
import { hashColor } from '../../lib/format'
import { CreateDialog, type CreateKind } from './CreateDialogs'
import { EntityTable } from './EntityTable'
import { useLiveRows } from './liveRows'
import type { EntityQuery } from '../../core/entity/store'
import { Inspector } from './Inspector'
import './ResourcesView.css'
import { graphHref, plotHref, relatedHref, relatedLabel } from '../../app/openIn'
import { useOpenInTab } from '../workstation/paneContext'
import { useResizableWidth } from '../../lib/useResizableWidth'
import { projectMenuItems } from '../projects/projectMenu'
import { useBrowserUrl, type BrowseCategory } from './useBrowserUrl'
import { SetPropertyDialog } from './SetPropertyDialog'
import { commonRowItems, dropTargetFor, type ActionContext, type TypeCapabilities } from './capabilities'

const RELATIONSHIP_FIELDS: FieldDef[] = [
  { key: 'source', label: 'Source', kind: 'ref', width: 240 },
  { key: 'source.type', label: 'Source type', kind: 'ref-type', width: 130 },
  { key: 'type', label: 'Type', kind: 'text', width: 150, plain: true },
  { key: 'target', label: 'Target', kind: 'ref', width: 240 },
  { key: 'target.type', label: 'Target type', kind: 'ref-type', width: 130 },
  { key: 'label', label: 'Label', kind: 'text', editable: true, width: 180 },
  { key: 'tags', label: 'Tags', kind: 'tags', editable: true, width: 180 },
  { key: 'directed', label: 'Directed', kind: 'boolean', width: 80 },
  ...BASE_FIELDS.filter((f) => f.key.startsWith('meta.') || f.key === 'id' || f.key === 'description'),
]

export type { BrowseCategory } from './useBrowserUrl'

export interface EntityBrowserProps {
  /** Which category of types to browse; 'all' spans resource, knowledge and project. Ignored when `view` is 'relationships'. */
  category: BrowseCategory
  /** Bounded, registered categories use tabs; open-ended ones use a facet rail. */
  layout: 'tabs' | 'facets'
  /** The Entities page: sections (All / Resources / Knowledge / Relationships / Project) in the rail, driven by `?category=`. */
  categorySwitch?: boolean
  /** Creation actions per category, used with `categorySwitch`; falls back to `newActions`. */
  newActionsByCategory?: Partial<Record<BrowseCategory, { label: string; kind: CreateKind }[]>>
  view?: 'entities' | 'relationships'
  title: string
  subtitle: string
  /** Base path for tab routes, e.g. '/resources' → '/resources/:type'. */
  basePath: string
  /** Creation actions offered in the toolbar for this category. */
  newActions: { label: string; kind: CreateKind }[]
  /** Creation actions offered per type (tabs mode). */
  typeNewActions?: Record<string, { label: string; kind: CreateKind }[]>
  /** Per-type create/import/manage actions mirrored from the types' dedicated pages. Takes precedence over `typeNewActions`. */
  capabilities?: Record<string, TypeCapabilities>
}


/** Menu position below a trigger button, remembering the button so a second click closes instead of reopening. */
const under = (el: Element) => ({ x: el.getBoundingClientRect().left, y: el.getBoundingClientRect().bottom + 4, anchor: el })

export function EntityBrowser({ category: categoryProp, layout, view: viewProp = 'entities', title, subtitle, basePath, newActions: newActionsProp, newActionsByCategory, categorySwitch, typeNewActions = {}, capabilities = {} }: EntityBrowserProps) {
  const store = useEntityStore()
  useStoreVersion(store) // re-render on every write (the inspector, counts), even the bookkeeping ones
  // The rows and the facet counts are a query over the whole store: only data changes re-run it, not a row being opened.
  const dataVersion = useStoreDataVersion(store)
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const toast = useToast()
  const openTab = useOpenInTab()
  const url = useBrowserUrl({ layout, basePath, categorySwitch, category: categoryProp, view: viewProp })
  const { section, view, category, categoriesInView, selectedType, tagFilter, search, pick, pickSet, selectedParam, inspectorTab: tabParamInspector, bare, setParam } = url
  const newActions = newActionsByCategory?.[category] ?? newActionsProp

  const [selected, setSelected] = useState<Set<EntityId>>(new Set())
  const [creating, setCreating] = useState<CreateKind | null>(null)
  const [createTarget, setCreateTarget] = useState<EntityId | undefined>()
  const [newMenu, setNewMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  const [propertyIds, setPropertyIds] = useState<EntityId[] | null>(null)
  const [pendingDelete, setPendingDelete] = useState<EntityId[] | null>(null)
  const [visibleRows, setVisibleRows] = useState<AnyEntity[]>([])
  const [facetQuery, setFacetQuery] = useState('')
  const [featureDialog, setFeatureDialog] = useState<((close: () => void) => ReactNode) | null>(null)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  const [dropping, setDropping] = useState(false)
  const inspector = useResizableWidth({ storageKey: 'aegraph:browser:inspector-width', initial: 380, min: 280, max: 800, edge: 'start' })
  // Search box is local state; the URL (and the query) update after a short pause so big stores don't re-filter per keystroke.
  const [searchDraft, setSearchDraft] = useState(search)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => setSearchDraft(search), [search])

  useEffect(() => {
    // `sel` is one id or a comma-separated list (a selection handed over from another list).
    const ids = selectedParam ? selectedParam.split(',').filter((id) => store.has(id)) : []
    if (ids.length) setSelected(new Set(ids))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedParam])

  // With any filter on (a pick, a tag, a search), every count is "x of y": x within the filters, y in the whole store.
  const filtersOn = !!pickSet || !!tagFilter || !!search.trim()
  // The assistant's app context: what this table shows and which rows are selected.
  useReportTable(`browser:${basePath}`, {
    view: view === 'entities' ? (section ?? category) : view,
    showing: [selectedType ? `type ${selectedType}` : `every ${view === 'entities' ? section ?? category : view}`, pick ? `pick "${pick.label}" (${pick.ids.length} ids)` : '', tagFilter ? `tag ${tagFilter}` : '', search.trim() ? `search "${search.trim()}"` : ''].filter(Boolean).join(', '),
    rows: visibleRows.length,
    selected: [...selected],
  })
  const scope = useMemo(() => {
    if (!filtersOn) return undefined
    // The text query walks the store once; tag and pick narrow that.
    const rows = store.query({ text: search }).filter((e) => (!pickSet || pickSet.has(e.id)) && (!tagFilter || e.tags.includes(tagFilter)))
    const byType = new Map<string, number>()
    const relByType = new Map<string, number>()
    let relationships = 0
    for (const e of rows) {
      if (isRelationship(e)) {
        relationships++
        relByType.set(e.type, (relByType.get(e.type) ?? 0) + 1)
      } else byType.set(e.type, (byType.get(e.type) ?? 0) + 1)
    }
    const byCategory = new Map<TypeCategory, number>()
    for (const [t, n] of byType) {
      const c = registry.categoryOf(t)
      byCategory.set(c, (byCategory.get(c) ?? 0) + n)
    }
    return { byType, relByType, byCategory, relationships, total: [...byType.values()].reduce((a, b) => a + b, 0) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersOn, pickSet, tagFilter, search, registry, dataVersion])
  /** What the filters are, in words — the banner's tooltip. */
  const filterLines = useMemo(() => {
    const lines: string[] = []
    if (pick) lines.push(`${pick.label} (${pick.ids.length})`)
    if (tagFilter) lines.push(`Tag: ${tagFilter}`)
    if (search.trim()) lines.push(`Search: “${search.trim()}”`)
    return lines
  }, [pick, tagFilter, search])
  const scoped = useCallback((t: ResolvedType): ResolvedType & { of?: number } => (scope ? { ...t, count: scope.byType.get(t.type) ?? 0, of: t.count } : t), [scope])

  // Types in this category. Tabs: registered only (bounded). Facets: everything with instances, plus registered. In a pick: only types present, with their counts.
  const types = useMemo(
    () => {
      const base = categoriesInView.flatMap((c) => (layout === 'tabs' ? registry.inCategory(c).filter((t) => t.origin !== 'inferred') : registry.inCategory(c)))
      return scope ? base.map(scoped).filter((t) => t.count > 0 || t.type === selectedType) : base
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, category, layout, scope, selectedType],
  )
  // The rail: one tree per category in view (headed when more than one).
  const trees = useMemo(
    () =>
      categoriesInView
        .map((c) => ({ category: c, tree: registry.tree(c).map(({ type: t, children }) => ({ type: scoped(t), children: children.map(scoped).filter((ch) => !scope || ch.count > 0) })).filter(({ type: t, children }) => !scope || t.count > 0 || children.length > 0) }))
        .filter((t) => category !== 'all' || t.tree.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, category, scope],
  )
  // By content, not identity: the registry is made again on every write, and a new array here would query the whole
  // project again for an edit that changed no type.
  const typeNamesKey = types.map((t) => t.type).join('\u0001')
  const typeNames = useMemo(() => (typeNamesKey ? typeNamesKey.split('\u0001') : []), [typeNamesKey])
  const activeDef: ResolvedType | undefined = selectedType ? scoped(registry.get(selectedType)) : undefined
  const totalInStore = useMemo(() => categoriesInView.reduce((n, c) => n + registry.countInCategory(c), 0), [registry, category]) // eslint-disable-line react-hooks/exhaustive-deps
  const totalInCategory = useMemo(() => (scope ? categoriesInView.reduce((n, c) => n + (scope.byCategory.get(c) ?? 0), 0) : totalInStore), [totalInStore, category, scope]) // eslint-disable-line react-hooks/exhaustive-deps

  // "All entities" means all of them: relationships are entities too, so they join the mixed table (their own columns appear alongside).
  const mixed = categorySwitch && section === 'all' && view === 'entities' && !selectedType
  // The rows are queried when what is asked changes, and after that kept by the store's events (`useLiveRows`): a
  // write that only changes rows already listed — a rename, a tag, a property — patches them, so an edit in a
  // million-entity project costs that edit, not a query, a filter and a sort of the whole project.
  const queries = useMemo((): EntityQuery[] => {
    if (view === 'relationships') return [{ kind: 'relationship', text: search, ...(selectedType ? { type: selectedType } : {}) }]
    if (selectedType) return [{ type: selectedType, text: search }]
    return mixed ? [{ type: typeNames, text: search }, { kind: 'relationship', text: search }] : [{ type: typeNames, text: search }]
  }, [view, selectedType, typeNames, search, mixed])
  const entities = useLiveRows(
    store,
    () => {
      let base = queries.length === 1 ? store.query(queries[0]) : queries.flatMap((q) => store.query(q))
      if (pickSet) base = base.filter((e) => pickSet.has(e.id))
      return tagFilter ? base.filter((e) => e.tags.includes(tagFilter)) : base
    },
    [store, queries, tagFilter, pickSet],
    (e) => queries.some((q) => store.matches(e, q)) && (!pickSet || pickSet.has(e.id)) && (!tagFilter || e.tags.includes(tagFilter)),
  ) as AnyEntity[]

  const fields = useMemo(() => {
    if (view === 'relationships') return RELATIONSHIP_FIELDS
    const base = registry.fieldsFor(selectedType)
    if (!mixed) return base
    // Most rows aren't relationships, so Source/Target trail the shared columns instead of leading them.
    const i = base.findIndex((f) => f.key === 'meta.updatedAt')
    const at = i < 0 ? base.length : i + 1
    return [...base.slice(0, at), ...RELATIONSHIP_FIELDS.filter((f) => f.key === 'source' || f.key === 'target'), ...base.slice(at)]
  }, [view, selectedType, mixed, registry])
  const relationshipTypes = useMemo(() => {
    const all = view === 'relationships' ? registry.relationshipTypes() : []
    return scope ? all.map((t) => ({ ...t, relationshipCount: scope.relByType.get(t.type) ?? 0, of: t.relationshipCount })).filter((t) => t.relationshipCount > 0 || t.type === selectedType) : all
  }, [registry, view, scope, selectedType])

  const goType = (t?: string) => {
    setSelected(new Set())
    url.goType(t)
  }

  const openEntity = useCallback(
    (e: AnyEntity) => {
      store.touch(e.id)
      // A chart, a script or a scene is worked on elsewhere: Open goes there. Everything else opens in the inspector beside the table.
      if (!isRelationship(e) && (e.type === 'plot' || e.type === 'script' || e.type.startsWith('script:') || e.type === 'projection' || e.type === 'scene:script')) return navigate(entityHref(e, registry))
      setSelected(new Set([e.id]))
    },
    [store, navigate, registry],
  )

  /** Open by id; leaves the current view if the entity lives elsewhere. */
  const openById = useCallback(
    (id: EntityId) => {
      const e = store.get(id)
      if (!e) return
      const inView = view === 'relationships' ? isRelationship(e) : isRelationship(e) ? mixed : selectedType ? e.type === selectedType : categoriesInView.includes(registry.categoryOf(e.type))
      if (inView) openEntity(e)
      else navigate(entityHref(e, registry))
    },
    [store, view, selectedType, registry, categoriesInView, mixed, navigate, openEntity],
  )


  const ctx: ActionContext = {
    store,
    navigate,
    toast,
    openById,
    create: (kind) => setCreating(kind),
    showDialog: (render) => setFeatureDialog(() => render),
    requestDelete: (ids) => setPendingDelete(ids),
  }
  const capsOf = (e: AnyEntity) => (isRelationship(e) ? undefined : capabilities[e.type])
  const runAction = (a: { run: (ctx: ActionContext) => void | Promise<void> }) => void a.run(ctx)

  const confirmDelete = () => {
    if (!pendingDelete) return
    // Types with their own deletion semantics (folders cascade) handle their ids; the rest go straight to the store.
    const plain: EntityId[] = []
    const byType = new Map<string, EntityId[]>()
    for (const id of pendingDelete) {
      const e = store.get(id)
      if (e && capsOf(e)?.deleteMany) byType.set(e.type, [...(byType.get(e.type) ?? []), id])
      else plain.push(id)
    }
    for (const [t, ids] of byType) capabilities[t].deleteMany!(store, ids)
    if (plain.length) store.remove(plain)
    setSelected((s) => {
      const n = new Set(s)
      pendingDelete.forEach((id) => n.delete(id))
      return n
    })
    toast(`Deleted ${pendingDelete.length} ${pendingDelete.length === 1 ? 'item' : 'items'}`)
    setPendingDelete(null)
  }

  // A row's menu is the menu every entity has (`entityMenu.tsx`, through the table), led by what its type can do here:
  // Open page, and the type's own row items.
  const contextItems = (e: AnyEntity): MenuItem[] => {
    const caps = capsOf(e)
    if (!caps) return []
    const own = caps.rowItems?.(e, ctx) ?? []
    return [...commonRowItems(e, ctx), ...(own.length ? [{ kind: 'sep' } as MenuItem, ...own] : [])]
  }

  const exportJson = (rows: AnyEntity[], name: string) => downloadText(`${name}.ae.json`, JSON.stringify(entitiesToDocument(store, rows), null, 2))

  // The table as a dataset entity: its rows, the columns it shows — then the Datasets page opens on it.
  const keepAsDataset = (rows: AnyEntity[], name: string) => {
    const e = datasetFromEntities(registry, rows, { label: name, columns: fields.filter((f) => !f.hidden && f.kind !== 'ref-type').map((f) => f.key), source: { kind: 'entities', at: new Date().toISOString(), count: rows.length, selector: name } })
    store.upsert(e)
    navigate(`/analytics/datasets?id=${encodeURIComponent(e.id)}`)
  }
  const exportCsv = (rows: AnyEntity[], name: string) => {
    const cols = fields.filter((f) => !f.hidden).map((f) => ({ key: f.key, label: f.label }))
    const data = rows.map((r) => Object.fromEntries(cols.map((c) => [c.key, c.key === 'label' ? displayLabel(r) : getField(r, c.key)])))
    downloadText(`${name}.csv`, toCsv(data, cols), 'text/csv')
  }

  const dropAccepts = (dt: DataTransfer | null) => !!dt && [...dt.items].some((i) => i.kind === 'file') && Object.values(capabilities).some((c) => c.drop)
  const onDrop = async (ev: DragEvent) => {
    ev.preventDefault()
    setDropping(false)
    const files = [...(ev.dataTransfer?.files ?? [])]
    let last: AnyEntity | undefined
    let added = 0
    let skipped = 0
    for (const f of files) {
      const t = dropTargetFor(f, capabilities, selectedType)
      if (!t) {
        skipped++
        continue
      }
      try {
        last = await capabilities[t].drop!.importFile(store, f)
        added++
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err))
      }
    }
    if (added) toast(added === 1 && last ? `Added ${displayLabel(last)}` : `Added ${added} files`)
    if (skipped) toast(`${skipped} ${skipped === 1 ? 'file' : 'files'} skipped — no resource type takes that kind of file`)
    if (last) openById(last.id)
  }

  const selectedEntity = selected.size ? store.get([...selected].at(-1)!) : undefined
  const exportName = view === 'relationships' ? 'relationships' : (selectedType ?? (category === 'all' ? 'entities' : category))
  const typeCaps = selectedType ? capabilities[selectedType] : undefined
  const toolbarActions = typeCaps ? [] : selectedType && typeNewActions[selectedType] ? typeNewActions[selectedType] : newActions.slice(0, layout === 'facets' ? 1 : 2)
  const primaryActions = typeCaps?.actions.filter((a) => a.primary) ?? []
  const secondaryActions = typeCaps?.actions.filter((a) => !a.primary) ?? []
  const facetTypes = facetQuery.trim() ? types.filter((t) => t.label.toLowerCase().includes(facetQuery.trim().toLowerCase())) : undefined

  /** Quick actions for the table bar: what you'd add where you are, one click, so the New menu is for everything else. */
  const quickActions = (): ReactNode => {
    if (!categorySwitch) return null
    const btn = (key: string, label: string, onClick: () => void, Icon: ComponentType<{ size?: number }> = Plus) => (
      <button key={key} className="btn btn--sm" onClick={onClick}>
        <Icon size={13} /> {label}
      </button>
    )
    if (view === 'relationships') return btn('rel', 'Relationship', () => setCreating('relationship'))
    const typeDef = selectedType ? registry.get(selectedType) : undefined
    if (typeDef && capabilities[typeDef.type]) {
      const acts = capabilities[typeDef.type].actions
      const shown = acts.slice(0, 4)
      const more = acts.slice(4)
      return (
        <>
          {shown.map((a) => btn(a.id, a.label, () => runAction(a), a.icon ?? Plus))}
          {more.length > 0 && (
            <button className="btn btn--sm btn--icon" title="More ways to add" aria-label="More ways to add" onClick={(e) => setMoreMenu(moreMenu ? null : under(e.currentTarget))}>
              <MoreHorizontal size={13} />
            </button>
          )}
        </>
      )
    }
    if (typeDef) return btn('type', typeDef.label, () => setCreating('entity'))
    if (category === 'knowledge') return btn('entity', 'Knowledge entity', () => setCreating('entity'))
    if (category === 'resource') return btn('note', 'Note', () => setCreating('note'))
    return null
  }

  /** The New menu: what fits where you are first, then every other kind of thing, grouped. */
  const newMenuItems = (): MenuItem[] => {
    const simple = (kind: CreateKind, label: string): MenuItem => ({ kind: 'item', label, onSelect: () => setCreating(kind) })
    const resourceGroups: MenuItem[] = Object.keys(capabilities).length
      ? registry
          .inCategory('resource')
          .filter((t) => capabilities[t.type])
          .flatMap<MenuItem>((t) => [{ kind: 'label', label: t.pluralLabel }, ...capabilities[t.type].actions.map<MenuItem>((a) => ({ kind: 'item', label: a.label, icon: a.icon, onSelect: () => runAction(a) }))])
      : []
    const covered = new Set([...Object.keys(capabilities), ...(capabilities.document ? ['pdf'] : [])])
    const simpleResources = (newActionsByCategory?.resource ?? newActionsProp).filter((a) => !covered.has(a.kind)).map((a) => simple(a.kind, a.label))
    if (!categorySwitch) return [...(resourceGroups.length ? resourceGroups : newActions.map((a) => simple(a.kind, a.label))), { kind: 'sep' }, simple('relationship', 'Relationship')]
    const typeDef = selectedType ? registry.get(selectedType) : undefined
    const first: MenuItem[] = []
    if (view === 'relationships') first.push(simple('relationship', 'Relationship…'))
    else if (typeDef && typeDef.category === 'knowledge') first.push({ kind: 'item', label: `${typeDef.label}…`, onSelect: () => setCreating('entity') })
    else if (typeDef && capabilities[typeDef.type]) first.push(...capabilities[typeDef.type].actions.filter((a) => a.primary).map<MenuItem>((a) => ({ kind: 'item', label: a.label, icon: a.icon, onSelect: () => runAction(a) })))
    else if (category === 'knowledge' || category === 'all') first.push(simple('entity', 'Knowledge entity…'))
    const general: MenuItem[] = [
      ...(first.some((i) => i.kind === 'item' && i.label === 'Knowledge entity…') ? [] : [simple('entity', 'Knowledge entity…')]),
      simple('type', 'Type…'),
      simple('tag', 'Tag…'),
      ...(view === 'relationships' ? [] : [simple('relationship', 'Relationship…')]),
    ]
    // Grouped resource actions carry their own headings; a plain 'Resources' heading only when the list is flat.
    return [...first, ...(first.length ? [{ kind: 'sep' } as MenuItem] : []), ...general, { kind: 'sep' }, ...(resourceGroups.length ? [] : [{ kind: 'label', label: 'Resources' } as MenuItem]), ...simpleResources, ...resourceGroups]
  }

  return (
    <div className={`res ${bare ? 'res--bare' : ''}`}>
      <div className={`res__head ${bare ? 'res__head--bare' : ''}`}>
        <div>
          <h1 className="page-title">{pick ? pick.label : title}</h1>
          <p className="page-subtitle">
            {categorySwitch && activeDef?.description ? activeDef.description : subtitle}
            {categorySwitch && tagFilter && (
              <span className="res__tagfilter">
                {' '}
                · filtered by <TagChip tag={tagFilter} color={store.getTagInfo(tagFilter).color} onRemove={() => setParam('tag')} />
              </span>
            )}

          </p>
        </div>
        <div className="res__head-actions">
          {categorySwitch && selected.size > 0 && (
            <>
              <button className="btn" title={view === 'relationships' ? 'Open a table of the selected relationships with their source and target entities' : 'Open a tab with everything linked to the selection'} onClick={() => openTab(relatedHref(store, [...selected]), relatedLabel(store, [...selected]))}>
                <Waypoints size={14} /> {view === 'relationships' ? 'Source & target' : 'Related to'} {selected.size}
              </button>
              <button className="btn" title="Set a data property on every selected entity" onClick={() => setPropertyIds([...selected])}>
                <ListPlus size={14} /> Set property
              </button>
              <button className="btn" title="Add the selection to a project, or take it out of one" onClick={(e) => setProjectMenu(projectMenu ? null : under(e.currentTarget))}>
                <FolderPlus size={14} /> Projects <ChevronDown size={13} />
              </button>
              <button className="btn btn--danger" onClick={() => setPendingDelete([...selected])}>
                Delete {selected.size}
              </button>
            </>
          )}
          <button className="btn" disabled={!visibleRows.length} title={selected.size ? `Show the ${selected.size} selected in Unigraph, the view restricted to them` : 'Show these rows in the Graph Explorer — the view restricted to them, the filters applied'} onClick={() => navigate(graphHref(selected.size ? [...selected] : visibleRows.map((e) => e.id), selected.size ? `${selected.size} selected` : (pick?.label ?? title), '2d', true))}>
            <Waypoints size={14} /> Graph{selected.size ? ` ${selected.size}` : ''}
          </button>
          {view !== 'relationships' && (
            <button className="btn" title={selected.size ? `Chart the ${selected.size} selected` : 'Chart these rows on the Scenes page'} onClick={() => navigate(plotHref(selected.size ? { ids: [...selected], label: `${selected.size} selected` } : { types: selectedType ? [selectedType] : categoriesInView.flatMap((c) => registry.inCategory(c).map((t) => t.type)), tags: tagFilter ? [tagFilter] : undefined, text: search || undefined, label: selectedType ? registry.get(selectedType).pluralLabel : undefined }))}>
              <BarChart3 size={14} /> Chart
            </button>
          )}
          <button className="btn" onClick={(e) => setExportMenu(exportMenu ? null : under(e.currentTarget))}>
            <Download size={14} /> Export <ChevronDown size={13} />
          </button>
          {(newActions.length > 0 || categorySwitch) && (
            <button className="btn btn--primary" onClick={(e) => setNewMenu(newMenu ? null : under(e.currentTarget))}>
              <Plus size={14} /> New <ChevronDown size={13} />
            </button>
          )}
        </div>
      </div>

      {layout === 'tabs' && view === 'entities' && (
        <div className="res__tabs">
          <TabButton active={!selectedType} onClick={() => goType()} label="All" count={totalInCategory} />
          {types.map((d) => (
            <TabButton key={d.type} active={selectedType === d.type} onClick={() => goType(d.type)} label={d.pluralLabel} count={d.count} icon={d.icon} color={d.color} />
          ))}
          <span className="spacer" />
          <SearchBox value={searchDraft} onChange={(v) => {
            setSearchDraft(v)
            clearTimeout(searchTimer.current)
            searchTimer.current = setTimeout(() => setParam('q', v), 200)
          }} onClear={() => (setSearchDraft(''), setParam('q'))} />
        </div>
      )}

      {!categorySwitch && (
      <div className="res__toolbar">
        {activeDef?.description ? <span>{activeDef.description}</span> : view === 'relationships' ? <span>A relationship is itself an entity — it can carry a type, tags, and data.</span> : null}
        {tagFilter && (
          <span className="res__tagfilter">
            · filtered by <TagChip tag={tagFilter} color={store.getTagInfo(tagFilter).color} onRemove={() => setParam('tag')} />
          </span>
        )}
        <span className="spacer" />
        {!categorySwitch && (layout === 'facets' || view === 'relationships') && (
          <SearchBox value={searchDraft} onChange={(v) => {
            setSearchDraft(v)
            clearTimeout(searchTimer.current)
            searchTimer.current = setTimeout(() => setParam('q', v), 200)
          }} onClear={() => (setSearchDraft(''), setParam('q'))} />
        )}
        {selected.size > 0 && (
          <>
            <button className="btn btn--sm" title={view === 'relationships' ? 'Open a table of the selected relationships with their source and target entities' : 'Open a tab with everything linked to the selection'} onClick={() => openTab(relatedHref(store, [...selected]), relatedLabel(store, [...selected]))}>
              <Waypoints size={13} /> {view === 'relationships' ? 'Source & target' : 'Related to'} {selected.size}
            </button>
            <button className="btn btn--sm" title="Set a data property on every selected entity" onClick={() => setPropertyIds([...selected])}>
              <ListPlus size={13} /> Set property
            </button>
            <button className="btn btn--sm" title="Add the selection to a project, or take it out of one" onClick={(e) => setProjectMenu(projectMenu ? null : under(e.currentTarget))}>
              <FolderPlus size={13} /> Projects
            </button>
            <button className="btn btn--sm btn--danger" onClick={() => setPendingDelete([...selected])}>
              Delete {selected.size}
            </button>
          </>
        )}
        {!categorySwitch && toolbarActions.map((a) => (
          <button key={a.kind} className="btn btn--sm" onClick={() => setCreating(a.kind)}>
            <Plus size={13} /> {a.label}
          </button>
        ))}
        {!categorySwitch && primaryActions.map((a) => {
          const Icon = a.icon ?? Plus
          return (
            <button key={a.id} className="btn btn--sm" onClick={() => runAction(a)}>
              <Icon size={13} /> {a.label}
            </button>
          )
        })}
        {!categorySwitch && secondaryActions.length > 0 && (
          <button className="btn btn--sm btn--icon" title="More ways to add" aria-label="More ways to add" onClick={(e) => setMoreMenu(moreMenu ? null : under(e.currentTarget))}>
            <MoreHorizontal size={13} />
          </button>
        )}
      </div>
      )}

      <div
        className={`res__body ${dropping ? 'is-dropping' : ''}`}
        onDragOver={(e) => {
          if (!dropAccepts(e.dataTransfer)) return
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
        }}
        onDrop={(e) => void onDrop(e)}
      >
        {dropping && <div className="res__drop">Drop to add to the library</div>}
        {layout === 'facets' && (view === 'entities' || categorySwitch) && !bare && (
          <aside className="res__facets">
            {categorySwitch ? (
              <>
                <CategoryRail
                  current={section!}
                  typeSelected={!!selectedType}
                  sections={scope ? ['all', 'resource', 'knowledge', 'relationships', 'project'] : undefined}
                  counts={scope ? (s) => (s === 'all' ? scope.total + scope.relationships : s === 'relationships' ? scope.relationships : s === 'types' || s === 'tags' ? 0 : (scope.byCategory.get(s) ?? 0)) : undefined}
                  banner={
                    scope ? (
                      <FilterBanner
                        lines={filterLines}
                        shown={scope.total + scope.relationships}
                        onClear={() => {
                          setSearchDraft('')
                          url.clearFilters()
                        }}
                      />
                    ) : undefined
                  }
                  onSection={(s) => {
                    setSelected(new Set())
                    url.goSection(s)
                  }}
                />
                <div className="res__facet-head">{view === 'relationships' ? 'By relationship type' : category === 'all' ? 'By type' : `${CATEGORIES[category].pluralLabel} by type`}</div>
              </>
            ) : (
              <FacetRow label="All" count={totalInCategory} of={scope ? totalInStore : undefined} active={!selectedType} onClick={() => goType()} />
            )}
            {view === 'relationships' &&
              relationshipTypes.map((t) => <FacetRow key={t.type} label={t.type} count={t.relationshipCount} of={(t as { of?: number }).of} color={t.color ?? edgeColor(t.type)} active={selectedType === t.type} onClick={() => goType(selectedType === t.type ? undefined : t.type)} />)}
            {view === 'entities' && types.length > 12 && <input className="input res__facet-search" placeholder="Filter types…" value={facetQuery} onChange={(e) => setFacetQuery(e.target.value)} />}
            {view === 'relationships' ? null : facetTypes
              ? facetTypes.map((t) => <FacetRow key={t.type} type={t} active={selectedType === t.type} onClick={() => goType(t.type)} />)
              : trees.map(({ category: c, tree }) => (
                  <div key={c}>
                    {trees.length > 1 && <div className="res__facet-head">{CATEGORIES[c].pluralLabel}</div>}
                    {tree.map(({ type: t, children }) => (
                      <div key={t.type}>
                        <FacetRow type={t} active={selectedType === t.type} onClick={() => goType(t.type)} childCount={children.reduce((n, ch) => n + ch.count, 0)} childOf={children.reduce((n, ch) => n + ((ch as ResolvedType & { of?: number }).of ?? ch.count), 0)} />
                        {children.map((ch) => (
                          <FacetRow key={ch.type} type={ch} active={selectedType === ch.type} onClick={() => goType(ch.type)} nested />
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
            {view === 'entities' && types.length === 0 && <div className="faint" style={{ padding: 8, fontSize: 12 }}>No types yet.</div>}
            {view === 'entities' && activeDef && !typeNames.includes(activeDef.type) && (
              <>
                <div className="res__facet-head">From {CATEGORIES[activeDef.category].pluralLabel}</div>
                <FacetRow type={activeDef} active onClick={() => goType(activeDef.type)} />
              </>
            )}
          </aside>
        )}
        <div className="res__table">
          <EntityTable
            entities={entities}
            fields={fields}
            selected={selected}
            onSelectedChange={setSelected}
            onOpen={openEntity}
            filterByTag={(t) => setParam('tag', t)}
            showOpenIn={!!selectedType || view === 'relationships'}
            onDelete={(ids) => setPendingDelete(ids)}
            contextItems={contextItems}
            onVisibleRowsChange={setVisibleRows}
            storageKey={`${category}:${selectedType ?? view}`}
            defaultSort={selectedType ? (registry.tableOf(selectedType)?.sort ?? null) : null}
            barEnd={quickActions()}
            emptyMessage={search || tagFilter ? 'Nothing matches the current filters.' : activeDef ? `No ${activeDef.pluralLabel.toLowerCase()} yet.` : 'Nothing here yet.'}
          />
        </div>
        {selectedEntity && (
          <div className="pane-gutter" onPointerDown={inspector.onPointerDown} onDoubleClick={inspector.reset} title="Drag to resize · double-click to reset" />
        )}
        {selectedEntity && (
          <div className="res__inspector" style={{ width: inspector.width }}>
            <Inspector entityId={selectedEntity.id} onClose={() => setSelected(new Set())} onOpen={openById} onDelete={(ids) => setPendingDelete(ids)} app initialTab={tabParamInspector} />
          </div>
        )}
      </div>

      {newMenu && (
        <Menu
          x={newMenu.x}
          y={newMenu.y}
          items={newMenuItems()}
          onClose={() => setNewMenu(null)}
          anchor={newMenu.anchor}
        />
      )}
      {moreMenu && <Menu x={moreMenu.x} y={moreMenu.y} items={(categorySwitch && selectedType && capabilities[selectedType] ? capabilities[selectedType].actions.slice(4) : secondaryActions).map<MenuItem>((a) => ({ kind: 'item', label: a.label, icon: a.icon, onSelect: () => runAction(a) }))} onClose={() => setMoreMenu(null)} anchor={moreMenu.anchor} />}
      {featureDialog?.(() => setFeatureDialog(null))}
      <SetPropertyDialog ids={propertyIds} onClose={() => setPropertyIds(null)} />
      {projectMenu && <Menu x={projectMenu.x} y={projectMenu.y} anchor={projectMenu.anchor} onClose={() => setProjectMenu(null)} items={[{ kind: 'label', label: `Selected (${selected.size})` }, ...projectMenuItems(store, [...selected], toast)]} />}
      {exportMenu && (
        <Menu
          x={exportMenu.x}
          y={exportMenu.y}
          onClose={() => setExportMenu(null)}
          anchor={exportMenu.anchor}
          items={[
            { kind: 'label', label: `Visible rows (${visibleRows.length})` },
            { kind: 'item', label: 'JSON (aegraph document)', onSelect: () => exportJson(visibleRows, exportName) },
            { kind: 'item', label: 'CSV', onSelect: () => exportCsv(visibleRows, exportName) },
            { kind: 'item', label: 'Keep as a dataset', onSelect: () => keepAsDataset(visibleRows, exportName) },
            { kind: 'sep' },
            { kind: 'label', label: selected.size ? `Selected (${selected.size})` : 'Selected' },
            { kind: 'item', label: 'JSON', disabled: !selected.size, onSelect: () => exportJson(entities.filter((e) => selected.has(e.id)), `${exportName}-selection`) },
            { kind: 'sep' },
            { kind: 'item', label: 'Everything, other formats…', onSelect: () => navigate('/datasets') },
          ]}
        />
      )}

      <CreateDialog
        kind={creating}
        targetId={createTarget}
        defaultType={selectedType}
        onClose={() => (setCreating(null), setCreateTarget(undefined))}
        onCreated={(e) => {
          setCreating(null)
          setCreateTarget(undefined)
          if (e.type === 'tag' && !store.has(e.id)) {
            toast(`Created tag “${e.label}”`)
            return
          }
          toast(`Created ${isRelationship(e) ? 'relationship' : registry.get(e.type).label.toLowerCase()}`)
          openById(e.id)
        }}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete ${pendingDelete?.length === 1 ? 'this item' : `${pendingDelete?.length} items`}?`}
        message={
          pendingDelete?.length === 1
            ? `“${displayLabel(store.get(pendingDelete[0]) ?? ({ id: pendingDelete[0] } as AnyEntity))}” and any relationships attached to it will be removed. This can't be undone.`
            : `${pendingDelete?.length} items and any relationships attached to them will be removed. This can't be undone.`
        }
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

function SearchBox({ value, onChange, onClear }: { value: string; onChange: (v: string) => void; onClear: () => void }) {
  return (
    <label className="res__search">
      <Search size={14} className="faint" />
      <input placeholder="Search…" value={value} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button className="btn btn--sm btn--icon btn--ghost" onClick={onClear} aria-label="Clear search">
          <X size={12} />
        </button>
      )}
    </label>
  )
}

function TabButton({ active, onClick, label, count, icon: Icon, color }: { active: boolean; onClick: () => void; label: string; count: number; icon?: ComponentType<{ size?: number }>; color?: string }) {
  return (
    <button className={`res__tab ${active ? 'is-active' : ''}`} onClick={onClick}>
      {Icon && <Icon size={14} {...(color ? { style: { color } } : {})} />}
      {label}
      <span className="count">{count}</span>
    </button>
  )
}

function FacetRow({ type, label, count, of, color, active, onClick, nested, childCount = 0, childOf = 0 }: { type?: (ResolvedType & { of?: number }); label?: string; count?: number; of?: number; color?: string; active: boolean; onClick: () => void; nested?: boolean; childCount?: number; childOf?: number }) {
  const Icon = type?.icon
  const n = count ?? (type?.count ?? 0) + childCount
  const total = of ?? (type?.of !== undefined ? type.of + childOf : undefined)
  const dot = color ?? (type ? (type.color ?? hashColor(type.type)) : undefined)
  return (
    <button className={`res__facet ${active ? 'is-active' : ''} ${nested ? 'res__facet--nested' : ''}`} onClick={onClick} title={type?.description}>
      {Icon ? <Icon size={14} /> : <span className="res__facet-dot" style={{ background: dot ?? 'transparent', border: dot ? undefined : 0 }} />}
      <span className="res__facet-label">
        {label ?? type?.pluralLabel}
        {type?.origin === 'inferred' && <span className="faint" title="No definition — inferred from data"> ·</span>}
      </span>
      <span className="count">{total !== undefined && total !== n ? <><span className="count__of">{n} of</span> {total}</> : n}</span>
    </button>
  )
}

/** Above the rail whenever a filter narrows the table: how many rows survive, and (on hover) which filters. */
function FilterBanner({ lines, shown, onClear }: { lines: string[]; shown: number; onClear: () => void }) {
  return (
    <div className="res__filterbar" role="status">
      <Filter size={13} />
      <span className="res__filterbar-text">
        {lines.length === 1 ? 'Filter' : `${lines.length} filters`} applied ({shown.toLocaleString()})
      </span>
      <span className="res__filterbar-info" tabIndex={0} aria-label={lines.join('; ')}>
        <Info size={13} />
        <span className="res__filterbar-tip" role="tooltip">
          {lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </span>
      </span>
      <button className="res__filterbar-x" title="Clear all filters" aria-label="Clear all filters" onClick={onClear}>
        <X size={12} />
      </button>
    </div>
  )
}
