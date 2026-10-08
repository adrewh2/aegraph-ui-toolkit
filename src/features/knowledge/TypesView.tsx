import { Plus } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { typeHref } from '../../app/routes'
import { ConfirmDialog } from '../../components/ui/Dialog'
import type { MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { CATEGORIES, CATEGORY_ORDER, SCHEMA_TYPE, schemaTypeId, type TypeCategory } from '../../core/entity/categories'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import type { FieldDef } from '../../core/entity/schema'
import { schemaTypeEntity, type ResolvedType } from '../../core/entity/typeRegistry'
import type { AnyEntity, Entity, EntityId } from '../../core/entity/types'
import { EntityTable } from '../resources/EntityTable'
import { NewTypeDialog, typeEditHref } from '../ontology/TypeEditor'
import './TypesView.css'

/** Table row for one type. Backed by the `schema:type` entity when one exists; otherwise synthesized from the registry. */
type TypeRow = Entity<{
  name: string
  category: TypeCategory
  parent?: string
  color?: string
  count: number
  origin: ResolvedType['origin']
  kind: 'entity' | 'relationship'
  properties: string
}>

const FIELDS: FieldDef[] = [
  { key: 'label', label: 'Label', kind: 'text', editable: true, width: 200 },
  { key: 'data.name', label: 'Type', kind: 'text', width: 160 },
  {
    key: 'data.kind',
    label: 'Kind',
    kind: 'text',
    width: 110,
    options: [
      { value: 'entity', label: 'Entity' },
      { value: 'relationship', label: 'Relationship' },
    ],
  },
  {
    key: 'data.category',
    label: 'Category',
    kind: 'text',
    editable: true,
    width: 130,
    options: CATEGORY_ORDER.map((c) => ({
      value: c,
      label: CATEGORIES[c].label,
    })),
  },
  {
    key: 'data.parent',
    label: 'Parent',
    kind: 'text',
    editable: true,
    width: 150,
  },
  {
    key: 'data.color',
    label: 'Color',
    kind: 'color',
    editable: true,
    width: 130,
  },
  {
    key: 'description',
    label: 'Description',
    kind: 'longtext',
    editable: true,
    width: 320,
  },
  {
    // Read here; defined in the type's editor (Edit type…, or the Properties button), a row per property.
    key: 'data.properties',
    label: 'Properties',
    kind: 'text',
    width: 240,
  },
  { key: 'data.count', label: 'Count', kind: 'number', width: 80 },
  {
    key: 'data.origin',
    label: 'Defined by',
    kind: 'text',
    width: 170,
    // Built-in types ship with aegraph-ui; the rest come from this workspace's data or its own definitions.
    options: [
      { value: 'code', label: 'Built in' },
      { value: 'code+schema', label: 'Built in · customised' },
      { value: 'schema', label: 'Defined here' },
      { value: 'inferred', label: 'Inferred from data' },
    ],
  },
  {
    key: 'meta.updatedAt',
    label: 'Updated',
    kind: 'date',
    width: 110,
    hidden: true,
  },
]

/**
 * `/entities?category=types` — the types. Every type in use or defined, with its
 * category, parent, color, and count, in the same table as everything else.
 * Edits are stored as `schema:type` entities so they persist and travel with exports.
 */
export function TypesView({ embedded }: { embedded?: boolean } = {}) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const toast = useToast()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const highlight = params.get('type') ?? undefined
  const [selected, setSelected] = useState<Set<EntityId>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<TypeRow[] | null>(null)

  // `?type=` from elsewhere (e.g. a type chip) preselects that row.
  const [seenHighlight, setSeenHighlight] = useState<string | undefined>()
  if (highlight !== seenHighlight) {
    setSeenHighlight(highlight)
    if (highlight) setSelected(new Set([schemaTypeId(highlight)]))
  }

  const rows = useMemo<TypeRow[]>(() => {
    const order = new Map(CATEGORY_ORDER.map((c, i) => [c, i]))
    const toRow = (t: ResolvedType, kind: 'entity' | 'relationship'): TypeRow => {
      const schema = store.get(schemaTypeId(t.type))
      return {
        id: schemaTypeId(t.type),
        kind: 'entity',
        type: SCHEMA_TYPE,
        label: t.label,
        description: t.description,
        tags: schema?.tags ?? [],
        data: {
          name: t.type,
          category: t.category,
          parent: t.parent,
          color: t.color,
          count: kind === 'relationship' ? t.relationshipCount : t.count,
          origin: t.origin,
          kind,
          // "born:number, nickname" — the data-defined properties, editable as text.
          properties: registry
            .propertiesOf(t.type)
            .map((p) => (p.kind && p.kind !== 'text' ? `${p.key}:${p.kind}` : p.key))
            .join(', '),
        },
        meta: schema?.meta ?? { createdAt: '', updatedAt: '' },
      }
    }
    const ents = registry
      .all()
      .filter((t) => t.kind !== 'relationship' && t.type !== '__relationship__')
      .sort((a, b) => order.get(a.category)! - order.get(b.category)! || a.label.localeCompare(b.label))
      .map((t) => toRow(t, 'entity'))
    const rels = registry
      .relationshipTypes()
      .filter((t) => t.type !== '__relationship__')
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((t) => toRow(t, 'relationship'))
    return [...ents, ...rels]
  }, [registry, store])

  const save = useCallback((row: TypeRow, patch: Parameters<typeof schemaTypeEntity>[1]) => store.upsert(schemaTypeEntity(row.data.name, patch, store.get(row.id))), [store])

  const onEdit = useCallback(
    (e: AnyEntity, key: string, value: unknown) => {
      const row = e as TypeRow
      const v = typeof value === 'string' ? value.trim() : value
      if (key === 'label') save(row, { label: (v as string) || row.data.name })
      else if (key === 'description') save(row, { description: v as string })
      else if (key === 'data.parent') save(row, { parent: (v as string) || undefined })
      else if (key === 'data.color') save(row, { color: (v as string) || undefined })
      else if (key === 'data.category') {
        if (row.data.kind === 'relationship') toast('Relationship types always live in Knowledge')
        else save(row, { category: v as TypeCategory })
      }
    },
    [save, toast, registry],
  )

  const browse = useCallback((row: TypeRow) => navigate(row.data.kind === 'relationship' ? `/entities?category=relationships&type=${encodeURIComponent(row.data.name)}` : typeHref(row.data.name, row.data.category)), [navigate])

  const contextItems = useCallback(
    (e: AnyEntity): MenuItem[] => {
      const row = e as TypeRow
      return [
        ...(row.data.kind === 'relationship'
          ? []
          : [{ kind: 'item' as const, label: 'Edit type…', onSelect: () => navigate(typeEditHref(row.data.name)) }]),
        {
          kind: 'item',
          label: `Browse ${row.data.count.toLocaleString()} ${row.data.kind === 'relationship' ? 'relationships' : 'entities'}`,
          onSelect: () => browse(row),
        },
        {
          kind: 'item',
          label: 'Show in graph',
          onSelect: () => navigate(`/unigraph/2d?type=${encodeURIComponent(row.data.name)}`),
        },
      ]
    },
    [browse, navigate],
  )

  const requestDelete = useCallback(
    (ids: EntityId[]) => {
      const defs = rows.filter((r) => ids.includes(r.id) && store.has(r.id))
      const builtIn = rows.filter((r) => ids.includes(r.id) && (r.data.origin === 'code' || r.data.origin === 'code+schema'))
      if (!defs.length) toast(builtIn.length ? 'Built-in types come with aegraph-ui and can be customised, not removed.' : 'Nothing to delete — these types have no stored definition. Types disappear when their last entity does.')
      else setPendingDelete(defs)
    },
    [rows, store, toast],
  )



  const entityCount = rows.filter((r) => r.data.kind === 'entity').length

  return (
    <div className={`types ${embedded ? 'types--embedded' : ''}`}>
      {!embedded && (
        <div className="res__head">
          <div>
            <h1 className="page-title">Types</h1>
            <p className="page-subtitle">
              Every type the workspace knows about — {entityCount} entity types, {rows.length - entityCount} relationship types. {rows.filter((r) => r.data.origin === 'code' || r.data.origin === 'code+schema').length} are built into aegraph-ui (see <em>Defined by</em>): they can be customised but not removed. Definitions are entities too, so they export with the data.
            </p>
          </div>
          <div className="types__add">
            <DefineType />
          </div>
        </div>
      )}

      <EntityTable
        entities={rows}
        fields={FIELDS}
        selected={selected}
        onSelectedChange={setSelected}
        onOpen={(e) => browse(e as TypeRow)}
        onEdit={onEdit}
        inlineEdit
        onDelete={requestDelete}
        contextItems={contextItems}
        storageKey="types"
        emptyMessage="No types yet"
        barEnd={embedded ? <DefineType compact /> : undefined}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete?.length === 1 ? `Remove the definition of “${pendingDelete[0].label}”?` : `Remove ${pendingDelete?.length ?? 0} type definitions?`}
        message="Only the stored definition (label, category, parent, color, description) is removed. Entities of these types are kept; the types fall back to their code or inferred definition."
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (pendingDelete) {
            store.remove(pendingDelete.map((r) => r.id))
            setSelected(new Set())
          }
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

/** "Define type" — opens the New type dialog (the ontology's type editor). Lives in the page head, or in the Entities frame's toolbar. */
export function DefineType({ compact }: { compact?: boolean } = {}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className={`btn ${compact ? 'btn--sm' : 'btn--primary'}`} onClick={() => setOpen(true)}>
        <Plus size={compact ? 13 : 14} /> Define type
      </button>
      {open && <NewTypeDialog onClose={() => setOpen(false)} />}
    </>
  )
}

/** Counts for the frame's toolbar note. */
export function useTypeCounts(): { entity: number; relationship: number; builtIn: number } {
  const registry = useTypeRegistry()
  const all = registry.all().filter((t) => t.type !== '__relationship__')
  const relationship = all.filter((t) => t.kind === 'relationship' || (t.relationshipCount > 0 && t.count === 0)).length
  const builtIn = all.filter((t) => t.origin === 'code' || t.origin === 'code+schema').length
  return { entity: all.length - relationship, relationship, builtIn }
}
