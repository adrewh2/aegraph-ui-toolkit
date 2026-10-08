import { Plus } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { ConfirmDialog } from '../../components/ui/Dialog'
import type { MenuItem } from '../../components/ui/Menu'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { FieldDef } from '../../core/entity/schema'
import type { AnyEntity, Entity, EntityId } from '../../core/entity/types'
import { EntityTable } from './EntityTable'

/** Table row for one tag — tags are labels with optional metadata, not entities, so rows are synthesized. */
type TagRow = Entity<{ tag: string; color?: string; usage: number }>

const rowId = (tag: string) => `tag:${tag}`

const FIELDS: FieldDef[] = [
  { key: 'label', label: 'Tag', kind: 'text', editable: true, width: 240 },
  { key: 'tags', label: 'Chip', kind: 'tags', width: 160 },
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
    width: 360,
  },
  { key: 'data.usage', label: 'Usage', kind: 'number', width: 90 },
]

/** Tags in the shared table: sort, filter, columns, multi-select, and inline edits (rename, color, description). */
export function TagsView({ onFilter, onAdd }: { onFilter: (tag: string) => void; onAdd?: () => void }) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const [selected, setSelected] = useState<Set<EntityId>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null)

  const rows = useMemo<TagRow[]>(
    () =>
      store
        .tags()
        .map((t) => ({
          t,
          usage: store.tagUsage(t),
          info: store.getTagInfo(t),
        }))
        .sort((a, b) => b.usage - a.usage || a.t.localeCompare(b.t))
        .map(({ t, usage, info }) => ({
          id: rowId(t),
          kind: 'entity',
          type: 'tag',
          label: t,
          description: info.description,
          tags: [t],
          data: { tag: t, color: info.color, usage },
          meta: { createdAt: '', updatedAt: '' },
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version],
  )

  const onEdit = useCallback(
    (e: AnyEntity, key: string, value: unknown) => {
      const tag = (e as TagRow).data.tag
      const v = typeof value === 'string' ? value.trim() : ''
      if (key === 'label') {
        if (v && v !== tag) {
          store.renameTag(tag, v)
          setSelected(new Set([rowId(v)]))
        }
      } else if (key === 'data.color') store.setTagInfo(tag, { color: v || undefined })
      else if (key === 'description') store.setTagInfo(tag, { description: v })
    },
    [store],
  )

  const contextItems = useCallback(
    (e: AnyEntity): MenuItem[] => {
      const row = e as TagRow
      return [
        {
          kind: 'item',
          label: `Show ${row.data.usage.toLocaleString()} tagged entities`,
          onSelect: () => onFilter(row.data.tag),
        },
      ]
    },
    [onFilter],
  )

  const tagsOf = (ids: EntityId[]) => rows.filter((r) => ids.includes(r.id)).map((r) => r.data.tag)
  const usageOf = (tags: string[]) => tags.reduce((n, t) => n + store.tagUsage(t), 0)

  return (
    <>
      <EntityTable
        entities={rows}
        fields={FIELDS}
        selected={selected}
        onSelectedChange={setSelected}
        onOpen={(e) => onFilter((e as TagRow).data.tag)}
        onEdit={onEdit}
        inlineEdit
        onDelete={(ids) => setPendingDelete(tagsOf(ids))}
        contextItems={contextItems}
        storageKey="tags"
        emptyMessage="No tags yet — add some to any entity."
        barEnd={
          onAdd ? (
            <button className="btn btn--sm" onClick={onAdd}>
              <Plus size={13} /> Tag
            </button>
          ) : undefined
        }
      />
      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete?.length === 1 ? `Delete tag “${pendingDelete[0]}”?` : `Delete ${pendingDelete?.length ?? 0} tags?`}
        message={`${pendingDelete?.length === 1 ? 'It' : 'They'} will be removed from ${pendingDelete ? usageOf(pendingDelete) : 0} entities. The entities themselves are kept.`}
        confirmLabel={pendingDelete?.length === 1 ? 'Delete tag' : 'Delete tags'}
        danger
        onConfirm={() => {
          pendingDelete?.forEach((t) => store.deleteTag(t))
          setSelected(new Set())
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}
