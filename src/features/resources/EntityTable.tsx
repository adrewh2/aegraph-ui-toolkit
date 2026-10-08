import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, Check, ChevronDown, Columns3, Filter, Minus, Save, Search, Shapes, Trash2, X } from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Menu, Popover, type MenuItem } from '../../components/ui/Menu'
import { TagChip } from '../../components/ui/TagChip'
import { useEntityMenu } from './entityMenu'
import { patchOf } from './liveRows'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import { edgeColor } from '../../core/graph/style'
import { coerceToKind, getField, humanizeType, type FieldDef } from '../../core/entity/schema'
import { schemaTypeId } from '../../core/entity/categories'
import { PropertyInput, formatDateOnly, formatDateTime } from '../../components/ui/PropertyInput'
import type { AnyEntity, EntityId, EntityRef } from '../../core/entity/types'
import { displayLabel } from '../../core/entity/entity'
import { describeSelector } from '../../core/entity/ids'
import { contrastText, formatDate, formatNumber, hostOf, truncate } from '../../lib/format'
import { TagEditor } from './TagEditor'
import './EntityTable.css'
import { useMarquee } from './useMarquee'
import { defaultVisible, useTablePrefs } from './useTablePrefs'
import { deletePreset, describeFilters, isEmptyFilter, readLastFilters, readPresets, savePreset, writeLastFilters, type TableFilterState } from './tableFilters'
import { Dialog } from '../../components/ui/Dialog'
import { httpUrl } from '../../core/resources/types'
import { Select } from '../../components/ui/Select'
import { DataImage } from '../../components/RemoteImage'

export interface EntityTableProps {
  entities: AnyEntity[]
  fields: FieldDef[]
  selected: Set<EntityId>
  onSelectedChange: (next: Set<EntityId>) => void
  onOpen: (entity: AnyEntity) => void
  /** A cell edited in place — only with `inlineEdit`. */
  onEdit?: (entity: AnyEntity, key: string, value: unknown) => void
  onDelete: (ids: EntityId[]) => void
  /** A table to look at and pick from, not to change: no rename or edit, no delete (menu or key); double-click opens. */
  readOnly?: boolean
  /**
   * Cells edited in place by double-click, through `onEdit`. Off everywhere but the tables whose rows are not entities
   * (the Types and Tags tables, which edit a definition or a tag their own way): a table of entities is read only —
   * a row is changed from its right-click menu (Rename…, Edit…), one write when the dialog is saved.
   */
  inlineEdit?: boolean
  /** This page's own right-click items for a row, after Open and before the menu every entity has (`entityMenu.tsx`). */
  contextItems?: (entity: AnyEntity) => MenuItem[]
  /** Filter the page by one of a row's tags: its tags are listed in the row's menu. */
  filterByTag?: (tag: string) => void
  /** Offer "Open in Entities" in a row's menu (a page that is not the Entities table showing every type). */
  showOpenIn?: boolean
  /** Called with the rows currently visible after filter + sort (for export). */
  onVisibleRowsChange?: (rows: AnyEntity[]) => void
  /** Persist column visibility / widths under this key. */
  storageKey?: string
  emptyMessage?: string
  /** Right end of the table bar — the page's quick actions. (The footer already shows the row count.) */
  barEnd?: ReactNode
  /** Bump to clear the search, column filters and sort from outside (a page-level Reset). */
  resetSignal?: number
  /** The order rows come in until someone sorts, or the table remembers a sort of its own (e.g. a type's `table.sort`). */
  defaultSort?: { key: string; dir: 'asc' | 'desc' } | null
  /** Column filters in force until someone changes them — a preset, such as the kinds a map shows by default. */
  defaultFilters?: Record<string, string | string[]>
  /** Offer a Types multiselect in the bar. Default: when the rows are of more than one type and a type column exists. */
  typeFilter?: boolean
}

type SortState = { key: string; dir: 'asc' | 'desc' } | null

const PAGE_SIZES = [25, 50, 100, 250]

const sameIds = (a: AnyEntity[], b: AnyEntity[]) => {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false
  return true
}

export function EntityTable({
  entities,
  fields,
  selected,
  onSelectedChange,
  onOpen,
  onEdit,
  onDelete,
  contextItems,
  onVisibleRowsChange,
  resetSignal,
  storageKey,
  emptyMessage = 'No entities',
  barEnd,
  readOnly = false,
  inlineEdit = false,
  filterByTag,
  showOpenIn,
  defaultSort = null,
  defaultFilters,
  typeFilter,
}: EntityTableProps) {
  const store = useEntityStore()
  useStoreVersion(store)
  const registry = useTypeRegistry()

  // Filters come back the way the table was last left (per storageKey; session configuration, not workspace data).
  const remembered = useMemo(() => readLastFilters(storageKey), [storageKey])
  const [sort, setSort] = useState<SortState>(remembered?.sort ?? defaultSort)
  /** Per column: a "contains" text, or — for type, tags and option columns — the values ticked in the dropdown. */
  const [filters, setFilters] = useState<Record<string, string | string[]>>(remembered?.filters ?? defaultFilters ?? {})
  const [choiceMenu, setChoiceMenu] = useState<{ key: string; anchor: DOMRect } | null>(null)
  // Quick search across every column; applied after a short pause so big tables don't re-filter per keystroke.
  const [quickDraft, setQuickDraft] = useState(remembered?.quick ?? '')
  const [quick, setQuick] = useState(remembered?.quick ?? '')
  const [presets, setPresets] = useState(() => readPresets(storageKey))
  const [presetMenu, setPresetMenu] = useState<DOMRect | null>(null)
  const [naming, setNaming] = useState<string | null>(null)
  const filterState: TableFilterState = { quick, filters, sort }
  useEffect(() => {
    const t = setTimeout(() => writeLastFilters(storageKey, { quick, filters, sort }), 300)
    return () => clearTimeout(t)
  }, [storageKey, quick, filters, sort])
  const applyFilters = (f: TableFilterState) => {
    setFilters(f.filters)
    setQuickDraft(f.quick)
    setQuick(f.quick)
    setSort(f.sort)
    setPage(0)
  }
  const quickTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(50)
  const [editing, setEditing] = useState<{ id: EntityId; key: string; anchor: DOMRect } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entity: AnyEntity } | null>(null)
  const [colMenu, setColMenu] = useState<DOMRect | null>(null)
  // Column drag: which header is being dragged, and where it would land.
  const [dragCol, setDragColState] = useState<string | null>(null)
  const dragColRef = useRef<string | null>(null)
  const setDragCol = (k: string | null) => {
    dragColRef.current = k
    setDragColState(k)
  }
  const [dropAt, setDropAt] = useState<{ key: string | null; side: 'before' | 'after' } | null>(null)
  const lastClick = useRef<number | null>(null)
  // The click that dismisses an open context menu must not select a row (which would open the detail view).
  const dismissClick = useRef(false)
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menu')) dismissClick.current = true
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [menu])
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const marquee = useMarquee<EntityId>({
    scrollRef,
    itemSelector: 'tbody tr[data-id]',
    selected,
    onChange: onSelectedChange,
    canStart: (t) => !t.closest('thead') && !editing,
  })

  // Columns and widths are remembered per table; a different table drops the view state too.
  const { visible, setVisible, widths, setWidths, columns, moveColumn } = useTablePrefs(storageKey, fields, () => {
    // Another table: its own remembered filters, or none.
    const last = readLastFilters(storageKey)
    setFilters(last?.filters ?? defaultFilters ?? {})
    setQuickDraft(last?.quick ?? '')
    setQuick(last?.quick ?? '')
    setSort(last?.sort ?? defaultSort)
    setPresets(readPresets(storageKey))
    setPage(0)
  })



  /** Columns filtered by ticking values rather than typing: the type, tags, and anything with a fixed set of options. */
  const isChoice = (f: FieldDef) => f.key === 'type' || f.kind === 'tags' || !!f.options
  /** The values a choice column can be filtered to, with how many rows carry each — over every row, so ticking never hides other choices. */
  const choicesFor = useMemo(() => {
    const cache = new Map<string, { value: string; label: string; count: number }[]>()
    return (f: FieldDef) => {
      let out = cache.get(f.key)
      if (out) return out
      const counts = choiceCountsOf(entities, f, store)
      const labelOf = (v: string) => (f.key === 'type' ? typeLabel(registry, v) : (f.options?.find((o) => o.value === v)?.label ?? v))
      out = [...counts].map(([value, count]) => ({ value, label: labelOf(value), count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      cache.set(f.key, out)
      return out
    }
  }, [entities, store, registry])

  /** The Types multiselect in the bar: the type column's choices, grouped under their root type when subtypes are in play. */
  const typeField = fields.find((f) => f.key === 'type')
  const typeChoices = useMemo(() => (typeField ? choicesFor(typeField) : []), [typeField, choicesFor])
  const showTypeFilter = typeField && (typeFilter ?? typeChoices.length > 1)
  const typeGroups = useMemo(() => {
    if (!typeChoices.some((c) => registry.get(c.value).parent)) return undefined
    const groups = new Map<string, string[]>()
    for (const c of typeChoices) {
      const root = registry.rootOf(c.value)
      groups.set(root, [...(groups.get(root) ?? []), c.value])
    }
    return [...groups].map(([root, values]) => ({ label: registry.get(root).pluralLabel ?? registry.get(root).label, values }))
  }, [typeChoices, registry])
  const typesChosen = Array.isArray(filters.type) ? filters.type : []

  // ── Filter + sort ────────────────────────────────────────────────────
  // The columns come from the type registry, which is remade on every store version; the rows depend on them only
  // by key and kind, so they key on that — not on the array's identity — and a city's worth of rows is not filtered
  // and sorted again because a commit landed or a view was remembered.
  const fieldsSig = fields.map((f) => `${f.key}:${f.kind ?? ''}:${f.format ? 1 : 0}`).join('|')
  const rowFields = useMemo(() => fields, [fieldsSig]) // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => {
    const fields = rowFields
    const q = quick.trim().toLowerCase()
    const fieldsKey = fields.map((f) => f.key).join('|')
    const terms = q ? q.split(/\s+/) : []
    // Each active filter resolved once — its column, its ticked values as a set, its text lowercased — not per row.
    const active = Object.entries(filters)
      .filter(([, v]) => (Array.isArray(v) ? v.length : v.trim()))
      .map(([key, v]) => ({ key, f: fields.find((x) => x.key === key), ticked: Array.isArray(v) ? new Set(v) : undefined, text: Array.isArray(v) ? '' : v.trim().toLowerCase() }))
    const passes =
      terms.length || active.length
        ? (e: AnyEntity) => {
            if (terms.length) {
              const text = rowText(e, fields, fieldsKey, store)
              if (!terms.every((t) => text.includes(t))) return false
            }
            for (const { key, f, ticked, text } of active) {
              if (ticked) {
                // Ticked values: a tag column matches when the row has any of them; other columns when the cell is one of them.
                if (f?.kind === 'tags') {
                  if (!e.tags.some((t) => ticked.has(t))) return false
                } else if (!ticked.has(cellText(e, f, getField(e, key), store))) return false
              } else if (!cellText(e, f, getField(e, key), store).toLowerCase().includes(text)) return false
            }
            return true
          }
        : null
    const sortField = sort ? fields.find((x) => x.key === sort.key) : undefined
    const sig = `${fieldsKey}\u0001${q}\u0001${JSON.stringify(filters)}\u0001${sort ? `${sort.key}:${sort.dir}` : ''}`
    let byEntities = tableRows.get(entities)
    const hit = byEntities?.get(sig)
    if (hit) return hit
    // A write that replaced rows in place: this table's rows before it, with those rows moved (`patchSortedRows`).
    const patch = patchOf(entities)
    const base = patch && tableRows.get(patch.prev)?.get(sig)
    let out: AnyEntity[] | undefined
    if (patch && !passes && !sort) {
      // Neither filtered nor sorted: the rows are the entities, already patched, every row where it was.
      out = entities
      if (base) sameOrderAs.set(out, base)
    } else if (patch && base) {
      const made = patchSortedRows(base, patch.changed, passes, sort ? { key: sort.key, f: sortField } : null, store)
      if (made) {
        out = made.rows
        if (made.sameOrder && out !== base) sameOrderAs.set(out, base)
      }
    }
    if (!out) {
      out = passes ? entities.filter(passes) : entities
      if (sort) out = sortRows(out, sort.key, sortField, sort.dir, store)
    }
    if (!byEntities) tableRows.set(entities, (byEntities = new Map()))
    byEntities.set(sig, out)
    return out
  }, [entities, quick, filters, sort, rowFields, store])

  // The parent learns the rows through a ref (its callback identity is not a reason to run) and only when the
  // rows actually differ — the same ids in the same order stay silent, so a parent that stores them in state
  // cannot be driven round in a render loop by a fresh array each time.
  const onRowsRef = useRef(onVisibleRowsChange)
  onRowsRef.current = onVisibleRowsChange
  const prevRows = useRef<AnyEntity[]>([])
  useEffect(() => {
    // A patch that kept every row in its place says so; the id-by-id comparison is for everything else.
    const same = sameOrderAs.get(rows) === prevRows.current || sameIds(rows, prevRows.current)
    prevRows.current = rows
    if (!same) onRowsRef.current?.(rows)
  }, [rows])
  const resetSeen = useRef(resetSignal)
  useEffect(() => {
    if (resetSignal === undefined || resetSignal === resetSeen.current) return
    resetSeen.current = resetSignal
    setFilters({})
    setQuickDraft('')
    setQuick('')
    setSort(defaultSort)
    setPage(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal])

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const pageRows = rows.slice(safePage * pageSize, safePage * pageSize + pageSize)

  // A single selection (a ?sel= handoff, a click elsewhere) is brought into view: the right page, then the row.
  const reveal = useRef<EntityId | null>(null)
  useEffect(() => {
    if (selected.size !== 1) return
    const id = [...selected][0]
    const idx = rows.findIndex((r) => r.id === id)
    if (idx < 0) return
    const page = Math.floor(idx / pageSize)
    if (page !== safePage) {
      reveal.current = id
      setPage(page)
      return
    }
    rootRef.current?.querySelector(`tr[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected, rows, pageSize, safePage])
  useEffect(() => {
    const id = reveal.current
    if (!id) return
    reveal.current = null
    rootRef.current?.querySelector(`tr[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [safePage, pageRows])

  // ── Selection ────────────────────────────────────────────────────────
  const allOnPageSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id))
  const someOnPageSelected = pageRows.some((r) => selected.has(r.id))

  const toggleAllOnPage = () => {
    if (dismissClick.current) return
    const next = new Set(selected)
    if (allOnPageSelected) pageRows.forEach((r) => next.delete(r.id))
    else pageRows.forEach((r) => next.add(r.id))
    onSelectedChange(next)
  }

  // A click selects at once, in a pick table (readOnly) too: the page answers it immediately (the graph flies to the
  // row), and a double-click there opens the row as well as selecting it — the way a file browser works. Waiting a
  // beat to tell the two apart made every click feel late.
  const clickRow = (e: ReactMouseEvent, entity: AnyEntity, index: number) => {
    if (marquee.consumeClick()) return
    if (readOnly && e.detail >= 2) return // the double-click opens (onDoubleClick below); the first click already selected
    const next = new Set(selected)
    if (e.shiftKey && lastClick.current !== null) {
      const [a, b] = [lastClick.current, index].sort((x, y) => x - y)
      for (let i = a; i <= b; i++) next.add(pageRows[i].id)
    } else if (e.metaKey || e.ctrlKey) {
      if (next.has(entity.id)) next.delete(entity.id)
      else next.add(entity.id)
    } else {
      next.clear()
      next.add(entity.id)
    }
    lastClick.current = index
    onSelectedChange(next)
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (editing) return
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
      e.preventDefault()
      if (!readOnly) onDelete([...selected])
    } else if (e.key === 'Escape') {
      onSelectedChange(new Set())
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      onSelectedChange(new Set(rows.map((r) => r.id)))
    } else if (e.key === 'Enter' && selected.size === 1) {
      const ent = store.get([...selected][0])
      if (ent) onOpen(ent)
    }
  }

  // ── Editing ──────────────────────────────────────────────────────────
  const commit = useCallback(
    (entity: AnyEntity, key: string, value: unknown) => {
      onEdit?.(entity, key, value)
      setEditing(null)
    },
    [onEdit],
  )

  const startEdit = (e: ReactMouseEvent, entity: AnyEntity, f: FieldDef) => {
    if (!inlineEdit || !f.editable || readOnly || !onEdit) {
      onOpen(entity)
      return
    }
    setEditing({ id: entity.id, key: f.key, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })
  }

  // ── Column resize ────────────────────────────────────────────────────
  const startResize = (e: ReactMouseEvent, key: string, current: number) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const onMove = (ev: MouseEvent) => setWidths((w) => ({ ...w, [key]: Math.max(60, current + ev.clientX - startX) }))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null))

  const activeFilterCount = Object.values(filters).filter((v) => (Array.isArray(v) ? v.length : v.trim())).length

  // The right-click menu of a row: the table's Open and the page's own items, then the menu every entity has wherever
  // it is right-clicked (`entityMenu.tsx`) — rename, edit, annotate, related, projects, copy, delete. The Types and
  // Tags tables, whose rows are definitions rather than entities, keep a short menu of their own.
  const entityMenu = useEntityMenu()
  const contextMenuItems = (entity: AnyEntity): MenuItem[] => {
    const ids = selected.has(entity.id) ? [...selected] : [entity.id]
    const lead: MenuItem[] = [{ kind: 'item', label: 'Open', onSelect: () => onOpen(entity), shortcut: '↵' }, ...(contextItems?.(entity) ?? [])]
    if (!inlineEdit && store.get(entity.id) === entity) return entityMenu.items(entity, { lead, selected, canDelete: !readOnly, onDelete, filterByTag, showOpenIn })
    return [
      ...lead,
      { kind: 'sep' },
      { kind: 'item', label: 'Copy ID', onSelect: () => navigator.clipboard.writeText(entity.id) },
      { kind: 'item', label: 'Copy as JSON', onSelect: () => navigator.clipboard.writeText(JSON.stringify(entity, null, 2)) },
      ...(readOnly ? [] : [{ kind: 'sep' } as MenuItem, { kind: 'item', label: ids.length > 1 ? `Delete ${ids.length} selected` : 'Delete', danger: true, shortcut: '⌫', onSelect: () => onDelete(ids) } as MenuItem]),
    ]
  }

  // What a row needs from the table, through one ref that never changes identity: the rows are memoised on their
  // data, so a re-render of the table — a map pan, a selection elsewhere — leaves them alone.
  const api = useRef<RowApi>(null!)
  api.current = {
    clickRow,
    contextMenu: (e, entity) => {
      // With nothing selected, the menu acts on this row without opening the detail pane. With a
      // selection (pane open), right-clicking another row switches the pane to it; right-clicking
      // inside the selection keeps it so bulk actions apply.
      e.preventDefault()
      if (selected.size > 0 && !selected.has(entity.id)) onSelectedChange(new Set([entity.id]))
      setMenu({ x: e.clientX, y: e.clientY, entity })
    },
    toggle: (entity) => {
      if (dismissClick.current) return
      const next = new Set(selected)
      if (next.has(entity.id)) next.delete(entity.id)
      else next.add(entity.id)
      onSelectedChange(next)
    },
    startEdit,
    inlineEdit,
    commit,
    cancelEdit: () => setEditing(null),
    openRef: (id) => store.get(id) && onOpen(store.get(id)!),
  }

  return (
    <div className="et" tabIndex={0} onKeyDown={onKeyDown} ref={rootRef}>
      <div className="et__bar">
        <label className="et__search" title="Search every column; several words must all match">
          <Search size={13} className="faint" />
          <input
            placeholder="Search all columns…"
            value={quickDraft}
            onChange={(e) => {
              const v = e.target.value
              setQuickDraft(v)
              clearTimeout(quickTimer.current)
              quickTimer.current = setTimeout(() => (setQuick(v), setPage(0)), 150)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && quickDraft) {
                e.stopPropagation()
                setQuickDraft('')
                setQuick('')
              }
            }}
          />
          {quickDraft && (
            <button className="btn btn--sm btn--icon btn--ghost" onClick={() => (setQuickDraft(''), setQuick(''))} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </label>
        {activeFilterCount > 0 && (
          <button className="btn btn--sm btn--ghost et__clear-filters" onClick={() => (setFilters({}), setPage(0))} title="Clear column filters">
            <Filter size={13} /> {activeFilterCount} {activeFilterCount === 1 ? 'filter' : 'filters'} <X size={12} />
          </button>
        )}
        {storageKey && (
          <button className={`btn btn--sm ${presets.length ? '' : 'btn--ghost'}`} title="Saved filters for this table: apply one, or save what is set now" onClick={(e) => setPresetMenu(e.currentTarget.getBoundingClientRect())}>
            <Bookmark size={13} /> Filters{presets.length ? ` · ${presets.length}` : ''}
          </button>
        )}
        {showTypeFilter && (
          <button className={`btn btn--sm ${typesChosen.length ? '' : 'btn--ghost'}`} title="Which types to show — tick the ones to keep, or a whole group" onClick={(e) => {
              const anchor = e.currentTarget.getBoundingClientRect()
              setChoiceMenu((m) => (m?.key === 'type' ? null : { key: 'type', anchor }))
            }}>
            <Shapes size={13} /> Types{typesChosen.length ? ` · ${typesChosen.length}/${typeChoices.length}` : ''}
          </button>
        )}
        <button className="btn btn--sm" onClick={(e) => setColMenu(e.currentTarget.getBoundingClientRect())}>
          <Columns3 size={13} /> Columns
        </button>
        <span className="spacer" />
        {selected.size > 0 && (
          <span className="et__selected">
            {selected.size} selected ·{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), onSelectedChange(new Set()))}>
              clear
            </a>
          </span>
        )}
        {barEnd}
      </div>

      <div
        className="et__scroll"
        ref={scrollRef}
        onMouseDown={marquee.onMouseDown}
        onClickCapture={(e) => {
          if (dismissClick.current) {
            e.stopPropagation()
            e.preventDefault()
            // Checkbox onChange is dispatched from the same native click; it checks the flag too.
            setTimeout(() => (dismissClick.current = false), 0)
          }
        }}
        onClick={(e) => e.target === e.currentTarget && !marquee.consumeClick() && onSelectedChange(new Set())}>
        <table>
          <colgroup>
            <col style={{ width: 36 }} />
            {columns.map((f) => (
              <col key={f.key} style={{ width: widths[f.key] ?? f.width ?? 160 }} />
            ))}
            {/* Absorbs leftover width so the checkbox and data columns keep their set widths on wide screens. */}
            <col className="col-fill" />
          </colgroup>
          <thead>
            <tr>
              <th className="col-check">
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected
                  }}
                  onChange={toggleAllOnPage}
                  aria-label="Select all on page"
                />
              </th>
              {columns.map((f) => (
                <th
                  key={f.key}
                  className={`${dragCol === f.key ? 'is-dragging' : ''} ${dropAt?.key === f.key ? `is-drop-${dropAt.side}` : ''}`}
                  onDragOver={(e) => {
                    const dragging = dragColRef.current
                    if (!dragging || dragging === f.key) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    const r = e.currentTarget.getBoundingClientRect()
                    setDropAt({ key: f.key, side: e.clientX < r.left + r.width / 2 ? 'before' : 'after' })
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const dragging = dragColRef.current
                    if (!dragging) return
                    const r = e.currentTarget.getBoundingClientRect()
                    const side = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
                    const idx = columns.findIndex((c) => c.key === f.key)
                    const before = side === 'before' ? columns[idx]?.key : columns[idx + 1]?.key
                    moveColumn(dragging, before)
                    setDragCol(null)
                    setDropAt(null)
                  }}
                >
                  <div
                    className="et__th-inner"
                    draggable
                    title="Click to sort · drag to reorder"
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', f.key)
                      setDragCol(f.key)
                    }}
                    onDragEnd={() => {
                      setDragCol(null)
                      setDropAt(null)
                    }}
                    onClick={() => toggleSort(f.key)}
                  >
                    {f.label}
                    {sort?.key === f.key ? (
                      sort.dir === 'asc' ? (
                        <ArrowUp size={12} />
                      ) : (
                        <ArrowDown size={12} />
                      )
                    ) : (
                      <ArrowUpDown size={12} className="sort-icon" style={{ opacity: 0.25 }} />
                    )}
                  </div>
                  <div className="et__resize" onMouseDown={(e) => startResize(e, f.key, widths[f.key] ?? f.width ?? 160)} />
                </th>
              ))}
              <th className="col-fill" />
            </tr>
            {
              <tr className="et__filters">
                <th className="col-check" />
                {columns.map((f) => {
                  const v = filters[f.key]
                  if (isChoice(f)) {
                    const chosen = Array.isArray(v) ? v : []
                    const labels = chosen.map((c) => choicesFor(f).find((o) => o.value === c)?.label ?? c)
                    return (
                      <th key={f.key}>
                        <button
                          className={`et__choice ${chosen.length ? 'is-active' : ''} ${choiceMenu?.key === f.key ? 'is-open' : ''}`}
                          aria-label={`Filter ${f.label}`}
                          aria-haspopup="listbox"
                          title={labels.join(', ') || `Filter ${f.label}`}
                          onClick={(e) => {
                            const anchor = e.currentTarget.getBoundingClientRect()
                            setChoiceMenu((m) => (m?.key === f.key ? null : { key: f.key, anchor }))
                          }}
                        >
                          <span className="et__choice-text">{labels.length ? labels.join(', ') : 'any'}</span>
                          {chosen.length > 0 && (
                            <span
                              className="et__choice-clear"
                              role="button"
                              aria-label="Clear"
                              onClick={(e) => {
                                e.stopPropagation()
                                setFilters((x) => ({ ...x, [f.key]: [] }))
                                setPage(0)
                              }}
                            >
                              <X size={11} />
                            </span>
                          )}
                          <ChevronDown size={12} className="faint" />
                        </button>
                      </th>
                    )
                  }
                  const text = typeof v === 'string' ? v : ''
                  return (
                    <th key={f.key}>
                      <input
                        placeholder="contains…"
                        aria-label={`Filter ${f.label}`}
                        value={text}
                        onChange={(e) => {
                          setFilters((x) => ({ ...x, [f.key]: e.target.value }))
                          setPage(0)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape' && text) {
                            e.stopPropagation()
                            setFilters((x) => ({ ...x, [f.key]: '' }))
                          }
                        }}
                      />
                    </th>
                  )
                })}
                <th className="col-fill" />
              </tr>
            }
          </thead>
          <tbody>
            {pageRows.map((entity, i) => (
              <Row key={entity.id} entity={entity} index={i} columns={columns} selected={selected.has(entity.id)} context={menu?.entity.id === entity.id} editingKey={editing?.id === entity.id ? editing.key : null} api={api} />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="et__empty">{emptyMessage}</div>}
        {marquee.rect && <div className="et__marquee" style={marquee.rect} />}
      </div>

      <div className="et__footer">
        <span>
          {rows.length === 0 ? '0' : `${safePage * pageSize + 1}–${Math.min(rows.length, (safePage + 1) * pageSize)}`} of {rows.length}
        </span>
        <span className="spacer" />
        <label>
          Rows{' '}
          <Select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value))
              setPage(0)
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </label>
        <button className="btn btn--sm btn--ghost" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
          Prev
        </button>
        <span>
          {safePage + 1} / {pageCount}
        </span>
        <button className="btn btn--sm btn--ghost" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
          Next
        </button>
      </div>

      {editing && editing.key && fields.find((f) => f.key === editing.key)?.kind === 'tags' && (
        <Popover anchor={editing.anchor} onClose={() => setEditing(null)}>
          <TagEditor
            value={(getField(store.get(editing.id)!, editing.key) as string[]) ?? []}
            onChange={(tags) => onEdit?.(store.get(editing.id)!, editing.key, tags)}
            onDone={() => setEditing(null)}
          />
        </Popover>
      )}

      {menu && <Menu x={menu.x} y={menu.y} items={contextMenuItems(menu.entity)} onClose={() => setMenu(null)} />}
      {entityMenu.dialogs}

      {choiceMenu && (
        <ChoiceFilter
          anchor={choiceMenu.anchor}
          options={choicesFor(fields.find((f) => f.key === choiceMenu.key)!)}
          groups={choiceMenu.key === 'type' ? typeGroups : undefined}
          chosen={(() => {
            const v = filters[choiceMenu.key]
            return Array.isArray(v) ? v : []
          })()}
          onChange={(next) => {
            setFilters((x) => ({ ...x, [choiceMenu.key]: next }))
            setPage(0)
          }}
          onClose={() => setChoiceMenu(null)}
        />
      )}

      {presetMenu && storageKey && (
        <Menu
          x={presetMenu.left}
          y={presetMenu.bottom + 4}
          onClose={() => setPresetMenu(null)}
          items={[
            { kind: 'label', label: presets.length ? 'Saved filters' : 'No saved filters yet' },
            ...presets.map<MenuItem>((p) => ({ kind: 'item', label: p.name, icon: Bookmark, onSelect: () => applyFilters(p) })),
            { kind: 'sep' },
            { kind: 'item', label: 'Save current filters as…', icon: Save, disabled: isEmptyFilter(filterState), onSelect: () => setNaming('') },
            { kind: 'item', label: 'Clear filters', icon: X, disabled: isEmptyFilter(filterState), onSelect: () => applyFilters({ quick: '', filters: {}, sort: defaultSort }) },
            ...(presets.length ? [{ kind: 'sep' as const }, { kind: 'label' as const, label: 'Delete' }, ...presets.map<MenuItem>((p) => ({ kind: 'item', label: p.name, icon: Trash2, danger: true, onSelect: () => setPresets(deletePreset(storageKey, p.name)) }))] : []),
          ]}
        />
      )}
      {naming !== null && storageKey && (
        <Dialog
          open
          title="Save these filters"
          description={describeFilters(filterState, (k) => fields.find((f) => f.key === k)?.label ?? k)}
          onClose={() => setNaming(null)}
          footer={
            <>
              <button className="btn" onClick={() => setNaming(null)}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                disabled={!naming.trim()}
                onClick={() => {
                  setPresets(savePreset(storageKey, naming.trim(), filterState))
                  setNaming(null)
                }}
              >
                Save
              </button>
            </>
          }
        >
          <div className="field">
            <label>Name</label>
            <input
              className="input"
              autoFocus
              value={naming}
              placeholder="e.g. Open incidents this quarter"
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && naming.trim()) {
                  setPresets(savePreset(storageKey, naming.trim(), filterState))
                  setNaming(null)
                }
              }}
            />
          </div>
        </Dialog>
      )}
      {colMenu && (
        <Popover anchor={colMenu} onClose={() => setColMenu(null)}>
          <div className="col-menu">
            {fields.map((f) => (
              <label key={f.key}>
                <input
                  type="checkbox"
                  checked={visible.has(f.key)}
                  onChange={() =>
                    setVisible((v) => {
                      const next = new Set(v)
                      if (next.has(f.key)) next.delete(f.key)
                      else next.add(f.key)
                      return next
                    })
                  }
                />
                {f.label}
              </label>
            ))}
            <div className="menu__sep" />
            <label onClick={() => setVisible(defaultVisible(fields))}>
              <Minus size={13} /> Reset to defaults
            </label>
          </div>
        </Popover>
      )}
    </div>
  )
}

// ── Cells ──────────────────────────────────────────────────────────────

interface RowApi {
  clickRow: (e: ReactMouseEvent, entity: AnyEntity, index: number) => void
  contextMenu: (e: ReactMouseEvent, entity: AnyEntity) => void
  toggle: (entity: AnyEntity) => void
  startEdit: (e: ReactMouseEvent, entity: AnyEntity, f: FieldDef) => void
  /** Cells are edited in place (the Types and Tags tables); otherwise a double-click opens the row. */
  inlineEdit: boolean
  commit: (entity: AnyEntity, key: string, value: unknown) => void
  cancelEdit: () => void
  openRef: (id: EntityId) => void
}

/** One row. Memoised: it re-renders when its entity, its columns, its selection or its editing state change, not when the table does. */
const Row = memo(function Row({ entity, index, columns, selected, context, editingKey, api }: { entity: AnyEntity; index: number; columns: FieldDef[]; selected: boolean; context: boolean; editingKey: string | null; api: RefObject<RowApi> }) {
  return (
    <tr key={entity.id} data-id={entity.id} className={`${selected ? 'is-selected' : ''} ${context ? 'is-context' : ''}`} onClick={(e) => api.current.clickRow(e, entity, index)} onContextMenu={(e) => api.current.contextMenu(e, entity)}>
      <td className="col-check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={() => api.current.toggle(entity)} aria-label={`Select ${displayLabel(entity)}`} />
      </td>
      {columns.map((f) => {
        const isEditing = editingKey === f.key
        const value = getField(entity, f.key)
        return (
          <td key={f.key} data-key={f.key} className={f.editable && api.current.inlineEdit ? 'et__editable' : ''} title={f.editable && api.current.inlineEdit ? 'Double-click to edit' : undefined} onDoubleClick={(e) => api.current.startEdit(e, entity, f)}>
            {isEditing && f.kind !== 'tags' ? <InlineEditor field={f} value={value} onCommit={(v) => api.current.commit(entity, f.key, v)} onCancel={() => api.current.cancelEdit()} /> : <Cell entity={entity} field={f} value={value} onOpenRef={api.current.openRef} />}
          </td>
        )
      })}
      <td className="col-fill" />
    </tr>
  )
})

function Cell({
  entity,
  field,
  value,
  onOpenRef,
}: {
  entity: AnyEntity
  field: FieldDef
  value: unknown
  onOpenRef: (id: EntityId) => void
}) {
  const registry = useTypeRegistry()
  const store = useEntityStore()
  if (field.format) return <span title={String(value ?? '')}>{field.format(value, entity)}</span>
  if (field.options) return <span>{field.options.find((o) => o.value === value)?.label ?? String(value ?? '')}</span>
  switch (field.kind) {
    case 'tags': {
      const tags = Array.isArray(value) ? (value as string[]) : []
      return (
        <div className="et__tags">
          {tags.map((t) => (
            <TagChip key={t} tag={t} color={store.getTagInfo(t).color} />
          ))}
        </div>
      )
    }
    case 'date':
      return field.key.startsWith('data.') ? <span>{formatDateOnly(value)}</span> : <span title={value ? new Date(String(value)).toLocaleString() : ''}>{formatDate(value)}</span>
    case 'datetime':
      return <span title={String(value ?? '')}>{formatDateTime(value)}</span>
    case 'url': {
      if (!value) return null
      const s = String(value)
      // A link only when it is http(s); anything else is the text it is.
      if (!httpUrl(s)) return <span title={s}>{s}</span>
      return (
        <a href={httpUrl(s)} target="_blank" rel="noreferrer" title={s} onClick={(e) => e.stopPropagation()}>
          {hostOf(s) || s}
        </a>
      )
    }
    case 'image':
      // A picture on another host waits for a click: loading it tells that host, and whatever its URL carries.
      return value ? <DataImage className="et__thumb" src={value} loading="lazy" /> : <span className="faint">—</span>
    case 'availability':
      return value ? (
        <span className="badge badge--ok">
          <Check size={11} /> Available
        </span>
      ) : (
        <span className="badge">Not available</span>
      )
    case 'boolean':
      return value ? <Check size={14} /> : <span className="faint">—</span>
    case 'color':
      return value ? (
        <>
          <span className="swatch" style={{ background: String(value) }} /> <span className="mono">{String(value)}</span>
        </>
      ) : (
        <span className="faint">—</span>
      )
    case 'number':
      return <span>{formatNumber(value)}</span>
    case 'ref': {
      const r = (typeof value === 'string' ? { id: value } : value) as EntityRef | undefined
      if (!r) return null
      const target = store.get(r.id)
      const t = field.withType && target ? registry.get(target.type) : undefined
      return (
        <span
          className="et__ref"
          title={r.id}
          onClick={(e) => {
            e.stopPropagation()
            onOpenRef(r.id)
          }}
        >
          {target ? displayLabel(target) : <span className="badge badge--danger">missing</span>}
          {r.selector && <span className="faint"> {describeSelector(r.selector)}</span>}
          {t && target && (
            <span className="et__ref-type" title={target.type}>
              <span className="res__facet-dot" style={{ background: t.color ?? edgeColor(target.type) }} />
              {t.label}
            </span>
          )}
        </span>
      )
    }
    case 'ref-type': {
      const t = refTypeOf(entity, field.key, store)
      if (!t) return <span className="faint">—</span>
      const def = registry.get(t)
      return (
        <span className="et__type" title={t}>
          <span className="res__facet-dot" style={{ background: def.color ?? edgeColor(t) }} />
          {def.label}
        </span>
      )
    }
    case 'json':
      return <span className="mono">{truncate(JSON.stringify(value ?? null), 60)}</span>
    case 'longtext':
      return <span title={String(value ?? '')}>{truncate(String(value ?? ''), 120)}</span>
    default:
      if (field.key === 'type') {
        const t = registry.get(String(value))
        const bg = t.color ?? edgeColor(String(value))
        // A type reads like a tag: its colour, its label.
        return field.plain ? (
          <span className="et__type">
            <span className="res__facet-dot" style={{ background: bg }} />
            {String(value)}
          </span>
        ) : (
          <span className="chip" style={{ background: bg, color: contrastText(bg) }} title={String(value)}>
            {typeLabel(registry, String(value))}
          </span>
        )
      }
      if (field.key === 'label')
        return entity.label || entity.kind === 'entity' ? (
          <span style={{ fontWeight: 500 }}>{displayLabel(entity)}</span>
        ) : (
          <span className="faint">—</span>
        )
      return <span title={String(value ?? '')}>{value == null ? '' : String(value)}</span>
  }
}

function InlineEditor({
  field,
  value,
  onCommit,
  onCancel,
}: {
  field: FieldDef
  value: unknown
  onCommit: (v: unknown) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<unknown>(value)
  const finish = () => onCommit(field.kind === 'json' && typeof draft === 'string' ? (coerceToKind(draft, 'json') ?? value) : draft)
  return (
    <span
      className="et__cell-editor"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <PropertyInput kind={field.kind} options={field.options} value={draft} onChange={setDraft} onEnter={finish} onEscape={onCancel} onBlur={finish} autoFocus className="et__cell-edit" rows={3} />
    </span>
  )
}

/**
 * The tick-list behind a choice column's filter cell and the Types button: every value the column has, with
 * counts, ticked to filter; a search narrows a long list. With `groups` (the type column, when subtypes are in
 * play) each group gets a header that ticks or clears all of its values at once — "Locations", then Sight, Hotel…
 */
function ChoiceFilter({ anchor, options, groups, chosen, onChange, onClose }: { anchor: DOMRect; options: { value: string; label: string; count: number }[]; groups?: { label: string; values: string[] }[]; chosen: string[]; onChange: (next: string[]) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const shown = q.trim() ? options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase())) : options
  const toggle = (value: string) => onChange(chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value])
  const row = (o: { value: string; label: string; count: number }, indent = false) => (
    <label key={o.value} className={indent ? 'et__choice-sub' : undefined}>
      <input type="checkbox" checked={chosen.includes(o.value)} onChange={() => toggle(o.value)} />
      <span className="et__choice-label">{o.label}</span>
      <span className="et__choice-count muted">{formatNumber(o.count)}</span>
    </label>
  )
  const grouped = groups && !q.trim() ? groups.map((g) => ({ ...g, options: g.values.map((v) => options.find((o) => o.value === v)!).filter(Boolean) })).filter((g) => g.options.length) : undefined
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="col-menu et__choice-menu">
        {options.length > 8 && (
          <div className="et__choice-search">
            <Search size={12} className="faint" />
            <input autoFocus placeholder="Find…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), setQ(''))} />
          </div>
        )}
        <div className="et__choice-list">
          {grouped
            ? grouped.map((g) => {
                const values = g.options.map((o) => o.value)
                const on = values.filter((v) => chosen.includes(v)).length
                // A group of one that is its own root is just that type.
                if (g.options.length === 1 && g.options[0].label === g.label) return row(g.options[0])
                return (
                  <div key={g.label} className="et__choice-group">
                    <label>
                      <input type="checkbox" checked={on === values.length} ref={(el) => {
                        if (el) el.indeterminate = on > 0 && on < values.length
                      }} onChange={() => onChange(on === values.length ? chosen.filter((v) => !values.includes(v)) : [...chosen.filter((v) => !values.includes(v)), ...values])} />
                      <span className="et__choice-label">{g.label}</span>
                      <span className="et__choice-count muted">{formatNumber(g.options.reduce((n, o) => n + o.count, 0))}</span>
                    </label>
                    {g.options.map((o) => row({ ...o, label: o.label.includes(' · ') ? o.label.slice(o.label.indexOf(' · ') + 3) : o.label }, true))}
                  </div>
                )
              })
            : shown.map((o) => row(o))}
          {!shown.length && <div className="muted et__choice-none">{options.length ? 'No match' : 'Nothing to choose from'}</div>}
        </div>
        {chosen.length > 0 && (
          <>
            <div className="menu__sep" />
            <label onClick={() => onChange([])}>
              <Minus size={13} /> Clear ({chosen.length})
            </label>
          </>
        )}
      </div>
    </Popover>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────

/** How a type reads in a table: a subtype says what it is a kind of first — "Area · Island", "Location · Sight". */
export function typeLabel(registry: ReturnType<typeof useTypeRegistry>, type: string): string {
  const t = registry.get(type)
  const root = registry.rootOf(type)
  return root !== type ? `${registry.get(root).label} · ${t.label}` : t.label
}

/**
 * A date column's searchable text: the relative form the cell shows and the full local form, memoised by value —
 * `toLocaleString` costs ~80 µs, and a big table asks for every row's dates on every keystroke.
 */
const dateTexts = new Map<string, string>()
function dateText(value: unknown): string {
  const key = String(value)
  let t = dateTexts.get(key)
  if (t === undefined) {
    if (dateTexts.size > 200_000) dateTexts.clear()
    t = `${formatDate(value)} ${new Date(key).toLocaleString()}`
    dateTexts.set(key, t)
  }
  return t
}

/**
 * Every column's text for a row, joined, lowercased — what the quick search scans. Rows are immutable (the store
 * replaces an entity on update), so the text is computed once per row and per column set, whatever is typed. The
 * texts serve a run of keystrokes, not the page's life: past ROW_TEXT_KEEP_FROM of them, the whole cache is let go
 * ROW_TEXT_IDLE_MS after the last one was asked for (211 MB on 700k trees, kept after one search, before this).
 */
let rowTexts = new WeakMap<AnyEntity, { key: string; text: string }>()
let rowTextsBuilt = 0
let rowTextRelease: ReturnType<typeof setTimeout> | undefined
const ROW_TEXT_KEEP_FROM = 20_000
const ROW_TEXT_IDLE_MS = 30_000
let rowTextUsed = 0
let rowTextCalls = 0
function releaseRowTextsWhenIdle() {
  const idle = Date.now() - rowTextUsed
  if (idle < ROW_TEXT_IDLE_MS) {
    rowTextRelease = setTimeout(releaseRowTextsWhenIdle, ROW_TEXT_IDLE_MS - idle)
    return
  }
  rowTexts = new WeakMap()
  rowTextsBuilt = 0
  rowTextRelease = undefined
}
export function rowText(e: AnyEntity, fields: FieldDef[], fieldsKey: string, store: ReturnType<typeof useEntityStore>): string {
  // The clock is read once per few thousand rows: a keystroke over 700k rows asks this for every one.
  if ((rowTextCalls++ & 4095) === 0) rowTextUsed = Date.now()
  const hit = rowTexts.get(e)
  if (hit && hit.key === fieldsKey) return hit.text
  const text = fields.map((f) => cellText(e, f, getField(e, f.key), store)).join(' \u0000 ').toLowerCase()
  rowTexts.set(e, { key: fieldsKey, text })
  if (++rowTextsBuilt >= ROW_TEXT_KEEP_FROM && !rowTextRelease) rowTextRelease = setTimeout(releaseRowTextsWhenIdle, ROW_TEXT_IDLE_MS)
  return text
}

/** Text used for filtering — mirrors what the cell shows. */
export function cellText(
  e: AnyEntity,
  f: FieldDef | undefined,
  value: unknown,
  store: ReturnType<typeof useEntityStore>,
): string {
  if (f?.format) return f.format(value, e)
  if (value == null && f?.kind !== 'ref-type') return ''
  switch (f?.kind) {
    case 'tags':
      return Array.isArray(value) ? value.join(', ') : ''
    case 'date':
      return dateText(value)
    case 'datetime':
      return `${formatDateTime(value)} ${String(value)}`
    case 'availability':
      return value ? 'available' : 'not available'
    case 'ref': {
      const t = store.get(typeof value === 'string' ? value : (value as EntityRef).id)
      return t ? displayLabel(t) : ''
    }
    case 'ref-type': {
      const t = refTypeOf(e, f!.key, store)
      return t ? (store.get(schemaTypeId(t))?.label ?? humanizeType(t)) : ''
    }
    case 'json':
      return JSON.stringify(value)
    default:
      return f?.key === 'label' ? displayLabel(e) : String(value)
  }
}

/** For a `ref-type` column (`source.type`): the type of the entity the reference under `source` points to. */
function refTypeOf(e: AnyEntity, key: string, store: ReturnType<typeof useEntityStore>): string | undefined {
  const ref = getField(e, key.replace(/\.type$/, '')) as EntityRef | string | undefined
  if (!ref) return undefined
  return store.get(typeof ref === 'string' ? ref : ref.id)?.type
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const nanFree = (n: number) => (Number.isNaN(n) ? undefined : n)

/** Above this many distinct string keys, sorts use code-unit order on lowercased keys instead of the (10× slower) collator. */
const COLLATOR_LIMIT = 50_000

/**
 * Sort with keys extracted once per row (not per comparison). Numbers, dates
 * and booleans sort by value; everything else by the text the cell shows
 * (a reference by its target's label, not its id), so the order reads off
 * the column. Empty values always sink to the bottom regardless of direction.
 *
 * The keys are ranked, not compared: the distinct values are sorted once (a
 * column of a city's worth of rows has a few hundred species, a few thousand
 * diameters), each row gets its value's rank, and the rows go through one
 * native sort of `rank · n + row` — exact in a double while `ranks × rows`
 * stays under 2⁵³, stable because the row index is in the code. Compared with
 * a comparator over 700k rows that is ten times quicker, and the collator can
 * be afforded whenever the distinct values are few, however many the rows.
 */
export function sortRows(rows: AnyEntity[], key: string, f: FieldDef | undefined, dir: 'asc' | 'desc', store: ReturnType<typeof useEntityStore>): AnyEntity[] {
  const n = rows.length
  if (n < 2) return rows
  // The same rows in the same order again — a render React threw away and started over, StrictMode's second call —
  // is the array already made.
  let byOrder = sorted.get(rows)
  if (!byOrder) sorted.set(rows, (byOrder = new Map()))
  const cacheKey = `${key}\n${dir}\n${f?.kind ?? ''}`
  const hit = byOrder.get(cacheKey)
  if (hit) return hit
  const out = sortRowsUncached(rows, key, f, dir, store)
  byOrder.set(cacheKey, out)
  return out
}
const sorted = new WeakMap<AnyEntity[], Map<string, AnyEntity[]>>()

function sortRowsUncached(rows: AnyEntity[], key: string, f: FieldDef | undefined, dir: 'asc' | 'desc', store: ReturnType<typeof useEntityStore>): AnyEntity[] {
  const n = rows.length
  const kind = f?.kind
  const numeric = kind === 'number' || kind === 'date' || kind === 'datetime' || kind === 'boolean' || kind === 'availability'
  // The key of each row, and each distinct key's slot in the order they were first seen.
  const slotOf = new Map<string | number, number>()
  const distinct: (string | number)[] = []
  const slots = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const k = sortKeyOf(rows[i], key, f, store)
    if (k === undefined) {
      slots[i] = -1
      continue
    }
    let slot = slotOf.get(k)
    if (slot === undefined) {
      slot = distinct.length
      distinct.push(k)
      slotOf.set(k, slot)
    }
    slots[i] = slot
  }
  // Rank the distinct keys: numbers by value; text by the collator when there are few enough, else by lowercased code units.
  const d = distinct.length
  const order = new Array<number>(d)
  for (let i = 0; i < d; i++) order[i] = i
  const allNumbers = numeric || distinct.every((k) => typeof k === 'number')
  if (allNumbers) order.sort((x, y) => (distinct[x] as number) - (distinct[y] as number))
  else if (d <= COLLATOR_LIMIT) order.sort((x, y) => collator.compare(String(distinct[x]), String(distinct[y])))
  else {
    const lower = distinct.map((k) => String(k).toLowerCase())
    order.sort((x, y) => (lower[x] < lower[y] ? -1 : lower[x] > lower[y] ? 1 : 0))
  }
  const rankOfSlot = new Int32Array(d)
  const desc = dir === 'desc'
  for (let r = 0; r < d; r++) rankOfSlot[order[r]] = desc ? d - 1 - r : r
  // One code per row — its rank then its index — sorted natively; the empty rows (rank d) come last either way.
  const codes = new Float64Array(n)
  for (let i = 0; i < n; i++) codes[i] = (slots[i] < 0 ? d : rankOfSlot[slots[i]]) * n + i
  codes.sort()
  const out = new Array<AnyEntity>(n)
  for (let i = 0; i < n; i++) out[i] = rows[codes[i] % n]
  sortModes.set(out, { mode: allNumbers ? 'number' : d <= COLLATOR_LIMIT ? 'collator' : 'lower', key, kind, dir })
  return out
}

/** A row's sort key under a column: a number, a string, or none (the empty rows, which sort last either way). */
function sortKeyOf(e: AnyEntity, key: string, f: FieldDef | undefined, store: ReturnType<typeof useEntityStore>): string | number | undefined {
  const kind = f?.kind
  const v = getField(e, key)
  if (kind === 'ref-type') {
    // The value lives on the referenced entity, not under the key.
    const text = cellText(e, f, v, store)
    return text === '' ? undefined : text
  }
  if (v == null || v === '') return undefined
  // A value that does not parse is no value: a NaN key would compare equal to everything and undo the whole sort.
  if (kind === 'number') return nanFree(Number(v))
  if (kind === 'date' || kind === 'datetime') return nanFree(new Date(String(v)).getTime())
  if (kind === 'boolean' || kind === 'availability') return v ? 1 : 0
  if (typeof v === 'number' && !f?.format) return v
  const text = cellText(e, f, v, store)
  return text === '' ? undefined : text
}

/** How a sorted array was ordered, so a row can be put back into it by binary search in the same order. */
type SortMode = { mode: 'number' | 'collator' | 'lower'; key: string; kind: string | undefined; dir: 'asc' | 'desc' }
const sortModes = new WeakMap<readonly AnyEntity[], SortMode>()

/** The order `sortRowsUncached` gives, for two keys: none last, then numbers, the collator or code units, by direction. */
function compareKeys(a: string | number | undefined, b: string | number | undefined, m: SortMode): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
  let c: number
  if (m.mode === 'number') c = (a as number) - (b as number)
  else if (m.mode === 'collator') c = collator.compare(String(a), String(b))
  else {
    const x = String(a).toLowerCase()
    const y = String(b).toLowerCase()
    c = x < y ? -1 : x > y ? 1 : 0
  }
  return m.dir === 'desc' ? -c : c
}

/**
 * The table's rows after a write that replaced some entities in place (`liveRows.ts › patchOf`), made from the rows
 * before it rather than filtered and sorted again: a changed row stays where it is when its sort key did not change,
 * and otherwise leaves its place and is put back by binary search (after any rows with an equal key); one that now
 * fails the filters leaves, one that now passes comes in. `null` when that cannot be done exactly — the rows are then
 * made again.
 */
export function patchSortedRows(prev: readonly AnyEntity[], changed: { before: AnyEntity; after: AnyEntity }[], passes: ((e: AnyEntity) => boolean) | null, sort: { key: string; f: FieldDef | undefined } | null, store: ReturnType<typeof useEntityStore>): { rows: AnyEntity[]; sameOrder: boolean } | null {
  const mode = sort ? sortModes.get(prev) : undefined
  if (sort && !mode) return null
  let rows: AnyEntity[] | null = null
  let sameOrder = true
  const own = () => (rows ??= prev.slice())
  for (const { before, after } of changed) {
    const cur = rows ?? prev
    const pos = cur.indexOf(before)
    const ok = !passes || passes(after)
    if (!sort) {
      // Unsorted rows are in the query's order: a row newly passing the filters has a place only the query knows.
      if (pos < 0) {
        if (ok) return null
        continue
      }
      if (ok) own()[pos] = after
      else {
        own().splice(pos, 1)
        sameOrder = false
      }
      continue
    }
    const k = sortKeyOf(after, sort.key, sort.f, store)
    if (k !== undefined && mode!.mode === 'number' && typeof k !== 'number') return null
    if (pos >= 0) {
      if (ok && sortKeyOf(before, sort.key, sort.f, store) === k) {
        own()[pos] = after
        continue
      }
      own().splice(pos, 1)
      sameOrder = false
    }
    if (!ok) continue
    const list = own()
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareKeys(sortKeyOf(list[mid], sort.key, sort.f, store), k, mode!) <= 0) lo = mid + 1
      else hi = mid
    }
    list.splice(lo, 0, after)
    sameOrder = false
  }
  const out = rows ?? (prev as AnyEntity[])
  if (mode) sortModes.set(out, mode)
  return { rows: out, sameOrder }
}

/** Each rows array's value counts per choice column: counted once, then carried through the patches made from it. */
const choiceCounts = new WeakMap<readonly AnyEntity[], Map<string, Map<string, number>>>()

/**
 * How many rows carry each value of a choice column (the type, tags, a fixed set of options). Counted over every row
 * once; rows patched from those (a rename, a retag — `liveRows.ts`) take the counts before and move the changed rows'
 * values, so the Types filter does not count a million rows again for one edit.
 */
function choiceCountsOf(entities: readonly AnyEntity[], f: FieldDef, store: ReturnType<typeof useEntityStore>): Map<string, number> {
  const key = `${f.key}\u0001${f.kind ?? ''}`
  let per = choiceCounts.get(entities)
  const hit = per?.get(key)
  if (hit) return hit
  const add = (counts: Map<string, number>, e: AnyEntity, by: number) => {
    const bump = (v: string) => {
      const n = (counts.get(v) ?? 0) + by
      if (n > 0) counts.set(v, n)
      else counts.delete(v)
    }
    if (f.kind === 'tags') for (const t of e.tags) bump(t)
    else {
      const v = cellText(e, f, getField(e, f.key), store)
      if (v) bump(v)
    }
  }
  const patch = patchOf(entities)
  const before = patch && choiceCounts.get(patch.prev)?.get(key)
  let counts: Map<string, number>
  if (patch && before) {
    counts = new Map(before)
    for (const c of patch.changed) {
      add(counts, c.before, -1)
      add(counts, c.after, 1)
    }
  } else {
    counts = new Map()
    for (const e of entities) add(counts, e, 1)
  }
  if (!per) choiceCounts.set(entities, (per = new Map()))
  per.set(key, counts)
  return counts
}

/** The rows each `entities` array gave, per filters and sort: a render React repeats is free, and a patch has a base. */
const tableRows = new WeakMap<readonly AnyEntity[], Map<string, AnyEntity[]>>()
/** Rows made from others by replacing entries in place: the same ids in the same order. */
const sameOrderAs = new WeakMap<readonly AnyEntity[], readonly AnyEntity[]>()


