import { BarChart3, Braces, Copy, ExternalLink, Highlighter, Link2, ListPlus, PenLine, SquarePen, Trash2 } from 'lucide-react'
import { useCallback, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { openInItems, plotHref, relatedItems } from '../../app/openIn'
import { ConfirmDialog } from '../../components/ui/Dialog'
import type { MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { isRelationship, type AnyEntity, type EntityId } from '../../core/entity/types'
import { externalHref } from '../../core/resources/types'
import { askItem } from '../assistant/ask'
import { projectMenuItems } from '../projects/projectMenu'
import { useOpenInTab } from '../workstation/paneContext'
import { AnnotateDialog } from './AnnotateDialog'
import { CreateDialog } from './CreateDialogs'
import { EditEntityDialog, RenameDialog } from './EditEntityDialog'
import { SetPropertyDialog } from './SetPropertyDialog'

/**
 * The right-click menu of an entity, wherever it is right-clicked — a table row, a node or an edge in Unigraph, a
 * pin, path or area on the map — so the same thing reads the same everywhere. A view leads with its own items (a
 * table's Open, the graph's Select neighbours, the map's Show on map); after them come the same items in the same
 * order: rename and edit, annotate and link, what is related and where else it opens, the assistant, a chart and a
 * property, projects, the view's tag filter when it has one, copies, and delete.
 *
 * The hook holds the dialogs those items open (Rename…, Edit…, Annotate…, Link to…, Set property…, the delete
 * confirmation); the view renders `dialogs` once beside its menu.
 */

export interface EntityMenuOptions {
  /** What this view leads with: Open, Show on map, Select neighbours… */
  lead?: MenuItem[]
  /** The selection the entity is in: when it is part of one, related, chart, property, projects and delete act on all of it. */
  selected?: ReadonlySet<EntityId> | readonly EntityId[]
  /** Filter this view by one of the entity's tags (the Entities table). */
  filterByTag?: (tag: string) => void
  /** Offer "Open in Entities" (not from the Entities table showing every type, where the row already is). */
  showOpenIn?: boolean
  /** Delete the view's way (a folder takes its contents; the graph clears its own state too). Default: confirm, then remove from the store. */
  onDelete?: (ids: EntityId[]) => void
  /** Offer Delete (default true). A table to pick from says false; rename and edit, being deliberate dialogs, stay. */
  canDelete?: boolean
}

type Open =
  | { kind: 'rename' | 'edit' | 'annotate' | 'link'; id: EntityId }
  | { kind: 'property'; ids: EntityId[] }
  | { kind: 'delete'; ids: EntityId[] }

export function useEntityMenu(): { items: (e: AnyEntity, o?: EntityMenuOptions) => MenuItem[]; dialogs: ReactNode } {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const openTab = useOpenInTab()
  const toast = useToast()
  const [open, setOpen] = useState<Open | null>(null)
  const close = () => setOpen(null)

  const items = useCallback(
    (e: AnyEntity, o: EntityMenuOptions = {}): MenuItem[] => {
      const sel = o.selected ? (o.selected instanceof Set ? [...o.selected] : [...(o.selected as readonly EntityId[])]) : []
      const ids = sel.includes(e.id) && sel.length > 1 ? sel : [e.id]
      const many = ids.length > 1
      const suffix = many ? ` · ${ids.length} selected` : ''
      const rel = isRelationship(e)
      const out: MenuItem[] = [...(o.lead ?? [])]
      const sep = () => {
        if (out.length && out[out.length - 1].kind !== 'sep') out.push({ kind: 'sep' })
      }
      sep()
      out.push({ kind: 'item', label: 'Rename…', icon: PenLine, onSelect: () => setOpen({ kind: 'rename', id: e.id }) })
      out.push({ kind: 'item', label: 'Edit…', icon: SquarePen, onSelect: () => setOpen({ kind: 'edit', id: e.id }) })
      if (!rel) {
        out.push({ kind: 'item', label: 'Annotate…', icon: Highlighter, onSelect: () => setOpen({ kind: 'annotate', id: e.id }) })
        out.push({ kind: 'item', label: 'Link to…', icon: Link2, onSelect: () => setOpen({ kind: 'link', id: e.id }) })
      }
      const href = externalHref(e)
      if (href) out.push({ kind: 'item', label: 'Open link', icon: ExternalLink, onSelect: () => window.open(href, '_blank', 'noopener') })
      sep()
      out.push(...relatedItems(store, ids, openTab).map((it) => (it.kind === 'item' && many ? { ...it, label: `${it.label}${suffix}` } : it)))
      if (o.showOpenIn) out.push(...openInItems(e, navigate, registry))
      out.push(askItem(store, ids))
      sep()
      out.push({ kind: 'item', label: many ? `Chart the ${ids.length} selected` : 'Chart…', icon: BarChart3, onSelect: () => navigate(plotHref({ ids, label: many ? `${ids.length} selected` : displayLabel(e) })) })
      out.push({ kind: 'item', label: many ? `Set property on ${ids.length}…` : 'Set property…', icon: ListPlus, onSelect: () => setOpen({ kind: 'property', ids }) })
      out.push({ kind: 'sep' }, { kind: 'label', label: many ? `Projects · ${ids.length} selected` : 'Projects' }, ...projectMenuItems(store, ids, toast))
      if (o.filterByTag && e.tags.length) {
        const filter = o.filterByTag
        out.push({ kind: 'sep' }, { kind: 'label', label: 'Filter by tag' })
        for (const t of e.tags.slice(0, 5)) out.push({ kind: 'item', label: t, onSelect: () => filter(t) })
      }
      out.push(
        { kind: 'sep' },
        { kind: 'item', label: 'Copy ID', icon: Copy, onSelect: () => void navigator.clipboard?.writeText(e.id) },
        { kind: 'item', label: 'Copy as JSON', icon: Braces, onSelect: () => void navigator.clipboard?.writeText(JSON.stringify(e, null, 2)) },
      )
      if (o.canDelete !== false) {
        const del = o.onDelete ?? ((d: EntityId[]) => setOpen({ kind: 'delete', ids: d }))
        out.push({ kind: 'sep' }, { kind: 'item', label: many ? `Delete ${ids.length} selected…` : 'Delete…', icon: Trash2, danger: true, shortcut: '⌫', onSelect: () => del(ids) })
      }
      return out
    },
    [store, registry, navigate, openTab, toast],
  )

  const deleting = open?.kind === 'delete' ? open.ids : null
  const dialogs = (
    <>
      {open?.kind === 'rename' && <RenameDialog id={open.id} onClose={close} />}
      {open?.kind === 'edit' && <EditEntityDialog id={open.id} onClose={close} />}
      {open?.kind === 'annotate' && (
        <AnnotateDialog
          targetId={open.id}
          onClose={close}
          onCreated={() => {
            toast(`Annotated “${displayLabel(store.get(open.id) ?? ({ id: open.id } as AnyEntity))}”`)
            close()
          }}
        />
      )}
      {open?.kind === 'link' && <CreateDialog kind="relationship" targetId={open.id} onClose={close} onCreated={(made) => toast(`Added ${displayLabel(made)}`)} />}
      <SetPropertyDialog ids={open?.kind === 'property' ? open.ids : null} onClose={close} />
      <ConfirmDialog
        open={!!deleting}
        title={`Delete ${deleting?.length === 1 ? 'this item' : `${deleting?.length} items`}?`}
        message={
          deleting?.length === 1
            ? `“${displayLabel(store.get(deleting[0]) ?? ({ id: deleting[0] } as AnyEntity))}” and any relationships attached to it will be removed. This can't be undone.`
            : `${deleting?.length} items and any relationships attached to them will be removed. This can't be undone.`
        }
        confirmLabel="Delete"
        danger
        onCancel={close}
        onConfirm={() => {
          if (deleting) {
            store.remove(deleting)
            toast(`Deleted ${deleting.length} ${deleting.length === 1 ? 'item' : 'items'}`)
          }
          close()
        }}
      />
    </>
  )
  return { items, dialogs }
}
