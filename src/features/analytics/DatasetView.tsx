import { ArrowDownAZ, ArrowUpAZ, ChevronDown, ClipboardPaste, Code2, Columns3, Copy, Download, EyeOff, MoreHorizontal, Pencil, Play, Plus, Redo2, Rows3, Scissors, Table2, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import {
  blockEdge,
  cellText,
  clearRange,
  columnLabel,
  datasetFromCsv,
  datasetFromScript,
  datasetToCsv,
  datasetsIn,
  deleteColumns,
  deleteRows,
  describeDataset,
  emptyDataset,
  fillRange,
  inferColumnKind,
  insertColumn,
  insertColumns,
  insertRows,
  isDataset,
  moveColumn,
  normalizeRange,
  parseCell,
  parseClipboardBlock,
  pasteBlock,
  rangeToTsv,
  setCell,
  sortRows,
  updateColumn,
  type CellRange,
  type ColumnKind,
  type DatasetData,
  type DatasetEntity,
} from '../../core/datasets/dataset'
import { formatDate } from '../../lib/format'
import { outputsOf } from '../../scripting/outputs'
import { runScript } from '../scripts/runner'
import { isScript } from '../scripts/script'
import { usePaneTitle } from '../workstation/paneContext'
import { registerDatasetHandle } from './datasetHandle'
import { DataGrid, type Cell, type GridHandle } from './grid/DataGrid'
import { cellDiff, EditHistory } from './grid/history'
import '../scenes/scenes.css'
import '../scripts/scripts.css'
import './analytics.css'
import './dataset.css'

/**
 * A Datasets tab: one dataset as a grid you edit in place — the canvas grid
 * in `grid/DataGrid.tsx`, which paints only what is in view and keeps the
 * cursor and selection out of React. Every edit goes to the entity — a
 * cell, a block pasted, rows in or out, a sort — through the pure functions
 * in `core/datasets`; the write to the store is coalesced (a run of typing
 * lands as one write a few hundred milliseconds after the last key), and
 * every edit is undoable (`grid/history.ts`). A dataset a script made says
 * so and reruns the script to refresh its rows; any dataset takes a pasted
 * CSV or a block of cells, and goes out as CSV. `?id=` names the dataset;
 * `/new` makes an empty one and opens it.
 */
const KINDS: { id: ColumnKind; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'number', label: 'Number' },
  { id: 'boolean', label: 'Boolean' },
  { id: 'date', label: 'Date' },
  { id: 'datetime', label: 'Date & time' },
  { id: 'url', label: 'URL' },
  { id: 'json', label: 'JSON' },
]
/** How long after the last edit the entity is written: a run of typing is one write, one version, one persistence pass. */
const WRITE_AFTER_MS = 350
/** Values an undeclared column's kind is read from. */
const KIND_SAMPLE = 5000
const WIDTHS_KEY = 'aegraph:datasets:widths'

type MenuState = { x: number; y: number; items: MenuItem[] }
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl+'

export function DatasetView() {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { pathname } = useLocation()
  const toast = useToast()
  const paneName = usePaneTitle()
  const id = params.get('id') ?? undefined
  // The pane's own router, not the window's: a tab inside the Workstation has a path of its own.
  const isNew = !id && pathname.endsWith('/new')

  // `/new`: one empty dataset, made once, then the page is that dataset's.
  const made = useRef(false)
  useEffect(() => {
    if (!isNew || made.current) return
    made.current = true
    const e = emptyDataset()
    store.upsert(e)
    navigate(`/analytics/datasets?id=${encodeURIComponent(e.id)}`, { replace: true })
  }, [isNew, store, navigate])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => datasetsIn(store).sort((a, b) => displayLabel(a).localeCompare(displayLabel(b))), [store, version])
  const entity = id ? store.get(id) : undefined
  const dataset: DatasetEntity | undefined = isDataset(entity) ? entity : undefined
  const script = dataset?.data.source?.kind === 'script' ? store.get(dataset.data.source.scriptId) : undefined

  // ── The working copy and its write-through ───────────────────────────
  // The grid draws `data`, which leads the entity by at most WRITE_AFTER_MS; a change of the entity from elsewhere
  // (the tool, a rerun, another tab) replaces it, unless an edit is still waiting to be written.
  const [data, setData] = useState<DatasetData | undefined>(dataset?.data)
  const dataRef = useRef(data)
  dataRef.current = data
  const pending = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  /** What this page last wrote: the entity coming back with it is our own write, not someone else's. */
  const written = useRef<DatasetData | undefined>(undefined)
  const history = useRef(new EditHistory())
  const [, tick] = useState(0)
  const flush = useCallback(() => {
    const p = pending.current
    if (!p) return
    clearTimeout(p.timer)
    pending.current = null
    const next = dataRef.current
    const cur = store.get(p.id)
    if (next && isDataset(cur) && cur.data !== next) {
      written.current = next
      store.update(p.id, { data: next })
    }
  }, [store])
  useEffect(() => {
    if (pending.current && pending.current.id === dataset?.id) return
    if (dataset && dataset.data === written.current) return
    // Another dataset, or this one changed elsewhere (a tool, a rerun, another tab): the working copy and its undo start over.
    if (pending.current) flush()
    setData(dataset?.data)
    history.current.clear()
    tick((n) => n + 1)
  }, [dataset, flush])
  useEffect(() => flush, [flush])
  useEffect(() => {
    const onHide = () => flush()
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
    }
  }, [flush])
  /** Apply an edit: the grid shows it now, the entity gets it soon, undo remembers it. */
  const apply = useCallback(
    (next: DatasetData, shape = false) => {
      const cur = dataRef.current
      if (!dataset || !cur || next === cur) return
      history.current.push(shape || next.rows.length !== cur.rows.length || next.columns !== cur.columns ? { kind: 'shape', before: cur, after: next } : { kind: 'cells', ...cellDiff(cur, next) })
      dataRef.current = next
      setData(next)
      if (pending.current?.id === dataset.id) clearTimeout(pending.current.timer)
      else if (pending.current) flush()
      pending.current = { id: dataset.id, timer: setTimeout(flush, WRITE_AFTER_MS) }
    },
    [dataset, flush],
  )
  const undo = useCallback(() => {
    const cur = dataRef.current
    if (!cur || !dataset) return
    const prev = history.current.undo(cur)
    if (!prev) return
    dataRef.current = prev
    setData(prev)
    if (pending.current?.id === dataset.id) clearTimeout(pending.current.timer)
    pending.current = { id: dataset.id, timer: setTimeout(flush, WRITE_AFTER_MS) }
    tick((n) => n + 1)
  }, [dataset, flush])
  const redo = useCallback(() => {
    const cur = dataRef.current
    if (!cur || !dataset) return
    const next = history.current.redo(cur)
    if (!next) return
    dataRef.current = next
    setData(next)
    if (pending.current?.id === dataset.id) clearTimeout(pending.current.timer)
    pending.current = { id: dataset.id, timer: setTimeout(flush, WRITE_AFTER_MS) }
    tick((n) => n + 1)
  }, [dataset, flush])

  // Inferred from a sample: a big table is not read whole after every edit.
  const kinds = useMemo(() => (data ? data.columns.map((_, c) => inferColumnKind(data, c, KIND_SAMPLE)) : []), [data])

  // ── Column widths: session configuration, per dataset and column key ──
  const [widths, setWidthsState] = useState<Record<string, number>>({})
  useEffect(() => {
    try {
      setWidthsState(id ? (JSON.parse(localStorage.getItem(`${WIDTHS_KEY}:${id}`) ?? '{}') as Record<string, number>) : {})
    } catch {
      setWidthsState({})
    }
  }, [id])
  const widthList = useMemo(() => (data ? data.columns.map((c) => widths[c.key] ?? defaultWidth(kinds[data.columns.indexOf(c)])) : []), [data, widths, kinds])
  const setWidths = (list: number[]) => {
    if (!data || !id) return
    const next = { ...widths }
    data.columns.forEach((c, i) => (next[c.key] = list[i]))
    setWidthsState(next)
    try {
      localStorage.setItem(`${WIDTHS_KEY}:${id}`, JSON.stringify(next))
    } catch {
      /* quota */
    }
  }

  // ── Grid intents ─────────────────────────────────────────────────────
  const grid = useRef<GridHandle>(null)
  const [sel, setSel] = useState<{ range: CellRange | null; cursor: Cell | null }>({ range: null, cursor: null })
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [rename, setRename] = useState<{ col: number; label: string; description: string } | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [running, setRunning] = useState(false)

  const onCommit = (cell: Cell, text: string) => {
    const d = dataRef.current
    if (!d) return
    // A declared kind reads the text its way; without one, what is typed reads as typed — 42 a number, true a boolean.
    const value = parseCell(text, d.columns[cell.c]?.kind)
    if (cellText(value) !== cellText(d.rows[cell.r]?.[cell.c])) apply(setCell(d, cell.r, cell.c, value))
  }
  const onPaste = (lines: string[][], at: Cell, over: CellRange) => {
    const d = dataRef.current
    if (!d) return
    const r = pasteBlock(d, lines, at, over)
    apply(r.data, r.data.rows.length !== d.rows.length || r.data.columns.length !== d.columns.length)
    grid.current?.select({ r0: at.r, c0: at.c, r1: at.r + r.rows - 1, c1: at.c + r.cols - 1 }, at)
    if (r.rows * r.cols > 1) toast(`Pasted ${r.rows.toLocaleString('en-US')} × ${r.cols}`)
  }
  const appendRow = () => {
    const d = dataRef.current
    if (d) apply(insertRows(d, 1), true)
  }
  const addRows = (count: number, at?: number) => {
    const d = dataRef.current
    if (!d) return
    apply(insertRows(d, count, at), true)
    const r = at ?? d.rows.length
    selectCells({ r0: r, c0: 0, r1: r + count - 1, c1: d.columns.length - 1 }, { r, c: 0 })
  }
  const selectCells = (range: CellRange, cursor: Cell) => {
    grid.current?.select(range, cursor)
    grid.current?.focus()
  }
  const removeRows = (rows: number[]) => {
    const d = dataRef.current
    if (!d || !rows.length) return
    apply(deleteRows(d, rows), true)
    toast(`Deleted ${rows.length.toLocaleString('en-US')} row${rows.length === 1 ? '' : 's'} — ${MOD}Z undoes`)
  }
  const addColumn = (at?: number) => {
    const d = dataRef.current
    if (!d) return
    apply(insertColumn(d, {}, at), true)
    // No naming dialog: the column is called by the next letter, and the cursor lands in it — rename from the header's menu.
    const c = at ?? d.columns.length
    const r = grid.current?.getCursor()?.r ?? 0
    selectCells({ r0: r, c0: c, r1: r, c1: c }, { r, c })
  }
  const addColumns = (count: number) => {
    const d = dataRef.current
    if (!d) return
    if (count === 1) return addColumn()
    apply(insertColumns(d, count), true)
    const r = grid.current?.getCursor()?.r ?? 0
    selectCells({ r0: r, c0: d.columns.length, r1: r, c1: d.columns.length + count - 1 }, { r, c: d.columns.length })
  }
  const removeColumns = (cols: number[]) => {
    const d = dataRef.current
    if (!d) return
    if (cols.length >= d.columns.length) return toast('A dataset keeps at least one column')
    apply(deleteColumns(d, cols), true)
  }
  const commitRename = () => {
    const d = dataRef.current
    if (!d || !rename) return
    apply(updateColumn(d, rename.col, { label: rename.label.trim() || undefined, description: rename.description.trim() || undefined }), true)
    setRename(null)
    grid.current?.focus()
  }
  const copyText = (range: CellRange) => (dataRef.current ? rangeToTsv(dataRef.current, range) : '')
  const copyRange = async (range: CellRange) => {
    try {
      await navigator.clipboard.writeText(copyText(range))
      const g = normalizeRange(range, dataRef.current!)
      const n = (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1)
      toast(n === 1 ? 'Copied' : `Copied ${n.toLocaleString('en-US')} cells`)
    } catch {
      toast(`Press ${MOD}C to copy`)
    }
  }

  // ── Menus ────────────────────────────────────────────────────────────
  const cellMenu = (cell: Cell, range: CellRange, at: { x: number; y: number }) => {
    const d = dataRef.current
    if (!d) return
    const g = normalizeRange(range, d)
    const many = g.r0 !== g.r1 || g.c0 !== g.c1
    const rows = Array.from({ length: g.r1 - g.r0 + 1 }, (_, i) => g.r0 + i)
    setMenu({
      x: at.x,
      y: at.y,
      items: [
        { kind: 'item', label: many ? 'Copy cells' : 'Copy', icon: Copy, shortcut: `${MOD}C`, onSelect: () => void copyRange(g) },
        { kind: 'item', label: 'Cut', icon: Scissors, shortcut: `${MOD}X`, onSelect: () => (void copyRange(g), apply(clearRange(d, g))) },
        { kind: 'item', label: 'Paste', icon: ClipboardPaste, shortcut: `${MOD}V`, onSelect: () => void navigator.clipboard?.readText().then((t) => t && onPaste(parseClipboardBlock(t), { r: g.r0, c: g.c0 }, g)).catch(() => toast(`Press ${MOD}V to paste`)) },
        { kind: 'item', label: many ? 'Clear cells' : 'Clear', icon: EyeOff, shortcut: '⌫', onSelect: () => apply(clearRange(d, g)) },
        { kind: 'sep' },
        { kind: 'item', label: 'Fill down', shortcut: `${MOD}D`, disabled: g.r0 === g.r1, onSelect: () => apply(fillRange(d, g, 'down')) },
        { kind: 'item', label: 'Fill right', shortcut: `${MOD}R`, disabled: g.c0 === g.c1, onSelect: () => apply(fillRange(d, g, 'right')) },
        { kind: 'sep' },
        { kind: 'item', label: `Insert ${rows.length === 1 ? 'a row' : `${rows.length} rows`} above`, icon: Plus, onSelect: () => addRows(rows.length, g.r0) },
        { kind: 'item', label: `Insert ${rows.length === 1 ? 'a row' : `${rows.length} rows`} below`, icon: Plus, onSelect: () => addRows(rows.length, g.r1 + 1) },
        { kind: 'item', label: rows.length > 1 ? `Delete ${rows.length} rows` : 'Delete row', icon: Trash2, danger: true, onSelect: () => removeRows(rows) },
        { kind: 'sep' },
        { kind: 'item', label: 'Edit cell', icon: Pencil, shortcut: '↵', onSelect: () => grid.current?.startEdit(cell) },
      ],
    })
  }
  const rowMenu = (rows: number[], at: { x: number; y: number }) => {
    const d = dataRef.current
    if (!d) return
    const first = rows[0]
    const last = rows[rows.length - 1]
    const range: CellRange = { r0: first, c0: 0, r1: last, c1: d.columns.length - 1 }
    setMenu({
      x: at.x,
      y: at.y,
      items: [
        { kind: 'item', label: `Copy ${rows.length === 1 ? 'row' : `${rows.length} rows`}`, icon: Copy, shortcut: `${MOD}C`, onSelect: () => void copyRange(range) },
        { kind: 'sep' },
        { kind: 'item', label: `Insert ${rows.length === 1 ? 'a row' : `${rows.length} rows`} above`, icon: Plus, onSelect: () => addRows(rows.length, first) },
        { kind: 'item', label: `Insert ${rows.length === 1 ? 'a row' : `${rows.length} rows`} below`, icon: Plus, onSelect: () => addRows(rows.length, last + 1) },
        { kind: 'item', label: 'Clear cells', icon: EyeOff, onSelect: () => apply(clearRange(d, range)) },
        { kind: 'sep' },
        { kind: 'item', label: rows.length > 1 ? `Delete ${rows.length} rows` : 'Delete row', icon: Trash2, danger: true, onSelect: () => removeRows(rows) },
      ],
    })
  }
  const colMenu = (c: number, at: { x: number; y: number }) => {
    const d = dataRef.current
    if (!d) return
    const col = d.columns[c]
    // Several columns selected (their headers dragged over): the delete and clear act on all of them.
    const s = grid.current?.getSelection()
    const cols = s && s.r0 === 0 && s.r1 === d.rows.length - 1 && c >= s.c0 && c <= s.c1 ? Array.from({ length: s.c1 - s.c0 + 1 }, (_, i) => s.c0 + i) : [c]
    setMenu({
      x: at.x,
      y: at.y,
      items: [
        { kind: 'label', label: `${columnLabel(col)} · ${col.key}` },
        { kind: 'item', label: 'Rename…', icon: Pencil, onSelect: () => setRename({ col: c, label: columnLabel(col), description: col.description ?? '' }) },
        { kind: 'item', label: 'Sort A → Z', icon: ArrowDownAZ, onSelect: () => apply(sortRows(d, c, 'asc'), true) },
        { kind: 'item', label: 'Sort Z → A', icon: ArrowUpAZ, onSelect: () => apply(sortRows(d, c, 'desc'), true) },
        { kind: 'sep' },
        { kind: 'label', label: `Kind${col.kind ? '' : ` (reads as ${kinds[c]})`}` },
        ...KINDS.map<MenuItem>((k) => ({ kind: 'item', label: k.label, icon: col.kind === k.id ? Columns3 : undefined, onSelect: () => apply(updateColumn(d, c, { kind: col.kind === k.id ? undefined : k.id }), true) })),
        { kind: 'sep' },
        { kind: 'item', label: 'Insert column left', icon: Plus, onSelect: () => addColumn(c) },
        { kind: 'item', label: 'Insert column right', icon: Plus, onSelect: () => addColumn(c + 1) },
        { kind: 'item', label: 'Move left', disabled: c === 0, onSelect: () => apply(moveColumn(d, c, c - 1), true) },
        { kind: 'item', label: 'Move right', disabled: c === d.columns.length - 1, onSelect: () => apply(moveColumn(d, c, c + 1), true) },
        { kind: 'sep' },
        { kind: 'item', label: cols.length > 1 ? `Clear ${cols.length} columns` : 'Clear column', icon: EyeOff, onSelect: () => apply(clearRange(d, { r0: 0, c0: cols[0], r1: d.rows.length - 1, c1: cols[cols.length - 1] })) },
        { kind: 'item', label: cols.length > 1 ? `Delete ${cols.length} columns` : 'Delete column', icon: Trash2, danger: true, disabled: d.columns.length <= cols.length, onSelect: () => removeColumns(cols) },
      ],
    })
  }

  // ── The dataset itself ──
  const renameDataset = () => {
    if (!dataset) return
    const label = window.prompt('Name this dataset', displayLabel(dataset))
    if (label && label !== displayLabel(dataset)) store.update(dataset.id, { label })
  }
  const describe = () => {
    if (!dataset) return
    const description = window.prompt('What this dataset holds', dataset.description ?? '')
    if (description !== null) store.update(dataset.id, { description: description.trim() || undefined })
  }
  const remove = () => {
    if (!dataset) return
    if (!window.confirm(`Delete “${displayLabel(dataset)}”?`)) return
    if (pending.current) {
      clearTimeout(pending.current.timer)
      pending.current = null
    }
    store.remove(dataset.id)
    setParams({})
    toast('Deleted')
  }
  const exportCsv = () => {
    const d = dataRef.current
    if (!dataset || !d) return
    const blob = new Blob([datasetToCsv(d)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${displayLabel(dataset).replace(/[^\w.-]+/g, '_') || 'dataset'}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const importCsv = () => {
    const d = dataRef.current
    if (!dataset || !d) return
    const parsed = datasetFromCsv(pasteText)
    if (!parsed.columns.length) {
      toast('Nothing to read: the first line is the header')
      return
    }
    apply({ ...d, columns: parsed.columns, rows: parsed.rows, source: { kind: 'csv', importedAt: new Date().toISOString() } }, true)
    setPasteOpen(false)
    setPasteText('')
    toast(`${parsed.rows.length.toLocaleString('en-US')} rows from CSV`)
  }
  /** A script dataset: run the script again and take the table it returns — the same dataset, fresh rows. */
  const rerun = async () => {
    if (!dataset || !isScript(script)) return
    flush()
    setRunning(true)
    try {
      const r = await runScript(store, registry, script.data.code, { scriptId: script.id, language: script.data.language })
      if (r.error) throw new Error(r.error.message)
      const table = outputsOf(r.value).find((o) => o.kind === 'table')
      if (!table || table.kind !== 'table') throw new Error('The script returned no table this time.')
      store.upsert(datasetFromScript(store, { id: script.id, label: displayLabel(script) }, table, { label: displayLabel(dataset), sceneId: dataset.data.source?.kind === 'script' ? dataset.data.source.sceneId : undefined }))
      toast(`${table.rows.length.toLocaleString('en-US')} rows from ${displayLabel(script)}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  // The assistant drives this page through a handle: which dataset, the cursor and selection, and the same edits.
  useEffect(
    () =>
      registerDatasetHandle({
        getState: () => {
          const s = grid.current?.getSelection() ?? null
          const rows = s && dataRef.current && s.c0 === 0 && s.c1 === dataRef.current.columns.length - 1 ? Array.from({ length: s.r1 - s.r0 + 1 }, (_, i) => s.r0 + i) : []
          return { datasetId: dataset?.id, cursor: grid.current?.getCursor() ?? null, selection: s, selectedRows: rows, editing: false }
        },
        load: (next) => setParams({ id: next }),
        select: (cell, range) => {
          grid.current?.select(range ?? { r0: cell.r, c0: cell.c, r1: cell.r, c1: cell.c }, cell)
          grid.current?.focus()
        },
        flush,
      }),
    [dataset?.id, setParams, flush],
  )

  const pickItems: MenuItem[] = [
    { kind: 'item', label: 'New dataset', icon: Plus, onSelect: () => navigate('/analytics/datasets/new') },
    ...(all.length ? [{ kind: 'sep' as const }, { kind: 'label' as const, label: 'Open' }] : []),
    ...all.map<MenuItem>((e) => ({ kind: 'item', label: displayLabel(e), onSelect: () => setParams({ id: e.id }) })),
  ]
  const moreItems: MenuItem[] = [
    { kind: 'item', label: 'Rename…', icon: Pencil, onSelect: renameDataset },
    { kind: 'item', label: 'Describe…', icon: Pencil, onSelect: describe },
    { kind: 'sep' },
    { kind: 'item', label: 'Paste CSV (replace all)…', icon: ClipboardPaste, onSelect: () => setPasteOpen(true) },
    { kind: 'item', label: 'Export CSV', icon: Download, onSelect: exportCsv },
    ...(isScript(script) ? [{ kind: 'sep' as const }, { kind: 'item' as const, label: 'Open the script', icon: Code2, onSelect: () => navigate(`/analytics/scripts?script=${encodeURIComponent(script.id)}`) }] : []),
    { kind: 'sep' },
    { kind: 'item', label: 'Delete dataset', icon: Trash2, danger: true, onSelect: remove },
  ]
  const at = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: r.left, y: r.bottom + 4 }
  }
  const selRows = sel.range && data && sel.range.c0 === 0 && sel.range.c1 === data.columns.length - 1 ? sel.range.r1 - sel.range.r0 + 1 : 0
  const selCells = sel.range ? (sel.range.r1 - sel.range.r0 + 1) * (sel.range.c1 - sel.range.c0 + 1) : 0

  return (
    <div className="pj dt">
      <div className="sc__top">
        <span className="sc__title" title="A table of values kept as one entity: what a script returns, edited here, read by charts">
          <Table2 size={16} /> Datasets{paneName ? <span className="sc__title-name"> — {paneName}</span> : null}
        </span>
        <button className="btn btn--sm sc__pick" onClick={(e) => setMenu({ ...at(e), items: pickItems })} title={dataset ? 'Switch to another dataset' : 'Pick a dataset'}>
          <span className="sc__pick-label">{dataset ? displayLabel(dataset) : 'No dataset'}</span>
          <ChevronDown size={12} />
        </button>
        {dataset && isScript(script) && (
          <button className="btn btn--sm" onClick={() => void rerun()} disabled={running} title={`Run “${displayLabel(script)}” again and take the table it returns`}>
            <Play size={13} /> {running ? 'Running…' : 'Rerun script'}
          </button>
        )}
        {dataset && (
          <button className="btn btn--sm btn--icon" onClick={(e) => setMenu({ ...at(e), items: moreItems })} title="More">
            <MoreHorizontal size={14} />
          </button>
        )}
      </div>
      {dataset && data ? (
        <>
          <div className="dt__tools">
            <button className="btn btn--sm btn--icon" onClick={undo} disabled={!history.current.canUndo} title={`Undo (${MOD}Z)`}>
              <Undo2 size={13} />
            </button>
            <button className="btn btn--sm btn--icon" onClick={redo} disabled={!history.current.canRedo} title={`Redo (${MOD}⇧Z)`}>
              <Redo2 size={13} />
            </button>
            <span className="dt__sep" />
            <button className="btn btn--sm" onClick={() => addRows(1)} title="A blank row at the end (or press ↓ on the last row)">
              <Rows3 size={13} /> Row
            </button>
            <button className="btn btn--sm" onClick={() => addColumn()} title="A column at the right, named by the next letter">
              <Columns3 size={13} /> Column
            </button>
            {selRows > 0 && (
              <button className="btn btn--sm btn--danger" onClick={() => removeRows(Array.from({ length: selRows }, (_, i) => sel.range!.r0 + i))}>
                <Trash2 size={13} /> Delete {selRows.toLocaleString('en-US')} row{selRows === 1 ? '' : 's'}
              </button>
            )}
            <span className="spacer" />
            <span className="dt__meta muted" title={data.source?.kind === 'script' ? `Ran ${formatDate(data.source.ranAt)}` : undefined}>
              {describeDataset(data, script ? displayLabel(script) : undefined)}
              {data.source?.kind === 'script' && <> · ran {formatDate(data.source.ranAt)}</>}
              {selCells > 1 && <> · {selCells.toLocaleString('en-US')} cells selected</>}
            </span>
            <span className="dt__hint muted">Type to replace · ↵ edits · arrows leave a cell at the end of its text · ⇧+arrows select · {MOD}C / {MOD}V blocks · {MOD}D fills down · ↓ on the last row adds one · drag + for more</span>
          </div>
          {dataset.description && <p className="dt__desc muted">{dataset.description}</p>}
          <DataGrid
            ref={grid}
            data={data}
            kinds={kinds}
            widths={widthList}
            onWidths={setWidths}
            onCommit={onCommit}
            onClear={(range) => apply(clearRange(data, range))}
            onPaste={onPaste}
            onFill={(range, dir) => apply(fillRange(data, range, dir))}
            onCopy={copyText}
            parseBlock={parseClipboardBlock}
            onBlockEdge={(from, dr, dc) => blockEdge(data, from, dr, dc)}
            onAppendRow={appendRow}
            onUndo={undo}
            onRedo={redo}
            onCellMenu={cellMenu}
            onRowMenu={rowMenu}
            onColumnMenu={colMenu}
            onRenameColumn={(c) => setRename({ col: c, label: columnLabel(data.columns[c]), description: data.columns[c].description ?? '' })}
            onAddRows={(n) => addRows(n)}
            onRemoveRows={removeRows}
            onAddColumns={addColumns}
            onRemoveColumns={removeColumns}
            onSelectionChange={(range, cursor) => setSel((s) => (sameRange(s.range, range) && s.cursor?.r === cursor?.r && s.cursor?.c === cursor?.c ? s : { range, cursor }))}
          />
        </>
      ) : (
        <div className="dt__empty">
          {id ? (
            <p className="muted">No dataset with id {id}.</p>
          ) : (
            <>
              <p className="muted">A dataset is a table kept as one entity: what a script returns with table(…), a pasted CSV, or rows typed in here. Charts read it.</p>
              <button className="btn btn--primary" onClick={() => navigate('/analytics/datasets/new')}>
                <Plus size={14} /> New dataset
              </button>
            </>
          )}
        </div>
      )}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <Dialog open={!!rename} title="Column" onClose={() => setRename(null)} footer={<><button className="btn" onClick={() => setRename(null)}>Cancel</button><button className="btn btn--primary" onClick={commitRename}>Save</button></>}>
        {rename && (
          <div className="dt__form">
            <label>
              <span>Header</span>
              <input className="input" autoFocus value={rename.label} onChange={(e) => setRename({ ...rename, label: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && commitRename()} />
            </label>
            <label>
              <span>Description</span>
              <input className="input" value={rename.description} onChange={(e) => setRename({ ...rename, description: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && commitRename()} placeholder="What the column holds" />
            </label>
            {data && <p className="muted">key: {data.columns[rename.col]?.key} — what scripts and charts name the column by; it does not change.</p>}
          </div>
        )}
      </Dialog>
      <Dialog open={pasteOpen} title="Paste CSV" description="The first line is the header. This replaces the rows and columns of the dataset (⌘Z undoes)." onClose={() => setPasteOpen(false)} footer={<><button className="btn" onClick={() => setPasteOpen(false)}>Cancel</button><button className="btn btn--primary" onClick={importCsv} disabled={!pasteText.trim()}>Replace</button></>}>
        <textarea className="input dt__paste" rows={12} autoFocus value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder={'name,count\nalpha,3\nbeta,5'} />
      </Dialog>
    </div>
  )
}

const defaultWidth = (kind: ColumnKind | undefined) => (kind === 'number' || kind === 'boolean' ? 100 : kind === 'date' ? 120 : kind === 'datetime' ? 170 : kind === 'json' ? 220 : 160)
const sameRange = (a: CellRange | null, b: CellRange | null) => (!a && !b) || (!!a && !!b && a.r0 === b.r0 && a.r1 === b.r1 && a.c0 === b.c0 && a.c1 === b.c1)
