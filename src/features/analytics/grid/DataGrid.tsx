import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { cellText, columnLabel, normalizeRange, type CellRange, type ColumnKind, type DatasetData } from '../../../core/datasets/dataset'
import { measure } from '../../../lib/measure'
import { editorArrow, MOVE_STEP, type EditorMove } from './keys'
import { currentTheme, onThemeChange, themeInfo } from '../../../app/theme'

/** The ink at an alpha, for the selection's wash: `#rrggbb` → `rgba(…)` (the canvas takes no `color-mix`). */
const tint = (hex: string, a: number) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})` : `rgba(31, 30, 27, ${a})`
}

/**
 * The dataset grid, drawn on a canvas. The DOM holds a scroll box the size
 * of the whole table and one canvas the size of the viewport, redrawn on
 * every scroll and change; the row numbers and the header are painted in
 * place, so they never move. What is drawn is what is in view — a table of
 * a million rows costs the same frame as one of ten — and the cursor, the
 * selection and a drag never touch React: they live in refs and repaint.
 * React sees the data (from the page) and the editor (one input over the
 * cell being edited). The page gets intents — commit this text here, clear
 * this range, paste this block, fill down — and answers with new data.
 *
 * The keys are a spreadsheet's: arrows and Tab/Enter move (Enter at the
 * last row adds one), ⇧ extends, ⌘+arrow jumps to the edge of the block,
 * Home/End the row, ⌘Home/⌘End the table, Page keys a screen; typing over
 * a cell replaces it, Enter/F2 edit it, Esc cancels; in the editor an arrow
 * moves the caret until it reaches the edge of the text, then commits and
 * moves on (`keys.ts`: → at the end, ← at the start, ↑/↓ always); ⌫/Del clear the
 * selection; ⌘C/⌘X/⌘V copy, cut and paste blocks; ⌘D/⌘R fill down and
 * right; ⌘A selects all; ⌘Z/⌘⇧Z are the page's undo and redo.
 */
export const ROW_H = 26
export const HEADER_H = 30
const ADD_COL_W = 34
const MIN_COL_W = 40
const RESIZE_GRIP = 5
const FILL_HANDLE = 7
const FONT = '12.5px Inter, system-ui, -apple-system, sans-serif'
const MONO = '12px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace'

export interface Cell {
  r: number
  c: number
}

export interface GridHandle {
  /** The focus cell (where typing goes) and the selection around it. */
  getCursor: () => Cell | null
  getSelection: () => CellRange | null
  select: (range: CellRange, cursor?: Cell) => void
  focus: () => void
  /** Bring a cell into view. */
  scrollTo: (cell: Cell) => void
  startEdit: (cell: Cell, text?: string) => void
}

export interface DataGridProps {
  data: DatasetData
  kinds: ColumnKind[]
  widths: number[]
  onWidths: (widths: number[]) => void
  /** The cell's new text, read by the page: `move` says where the cursor goes next. */
  onCommit: (cell: Cell, text: string, move: 'down' | 'right' | 'stay') => void
  onClear: (range: CellRange) => void
  /** A block from the clipboard at the cursor (over the selection when it is a single value). */
  onPaste: (lines: string[][], at: Cell, over: CellRange) => void
  onFill: (range: CellRange, dir: 'down' | 'right') => void
  /** The selection as text for the clipboard (tab-separated). */
  onCopy: (range: CellRange) => string
  /** Clipboard text as cells (tabs, or CSV, or lines). */
  parseBlock: (text: string) => string[][]
  /** ⌘+arrow: the edge of the block of filled cells from here. */
  onBlockEdge?: (from: Cell, dr: number, dc: number) => Cell
  /** Enter or ↓ past the last row: the page adds one (and the cursor moves onto it). */
  onAppendRow: () => void
  /** The + under the last row or right of the last column, dragged: that many rows or columns on the end, or these trailing empty ones taken off. */
  onAddRows: (count: number) => void
  onRemoveRows: (rows: number[]) => void
  onAddColumns: (count: number) => void
  onRemoveColumns: (cols: number[]) => void
  onUndo: () => void
  onRedo: () => void
  onCellMenu: (cell: Cell, range: CellRange, at: { x: number; y: number }) => void
  onRowMenu: (rows: number[], at: { x: number; y: number }) => void
  onColumnMenu: (col: number, at: { x: number; y: number }) => void
  onRenameColumn: (col: number) => void
  /** The selection changed (throttled to a frame), for the toolbar. */
  onSelectionChange?: (sel: CellRange | null, cursor: Cell | null) => void
}

type Drag =
  | { kind: 'select'; anchor: Cell }
  | { kind: 'rows'; anchor: number }
  | { kind: 'cols'; anchor: number }
  | { kind: 'resize'; col: number; startX: number; startW: number }
  | { kind: 'fill'; base: CellRange }
  /** The + handle dragged: `count` rows or columns to add (or, negative, to take off the end — at most `removable`, the trailing empty ones). */
  | { kind: 'grow'; axis: 'rows' | 'cols'; start: number; count: number; removable: number; at: { x: number; y: number } }
  | null

export const DataGrid = forwardRef<GridHandle, DataGridProps>(function DataGrid(props, ref) {
  const { data, kinds, widths } = props
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  // The view's own state, outside React: repainted, never re-rendered.
  const cursor = useRef<Cell | null>(null)
  const anchor = useRef<Cell | null>(null) // the other corner of the selection
  const drag = useRef<Drag>(null)
  const fillPreview = useRef<CellRange | null>(null)
  const hoverEdge = useRef<number | null>(null)
  const frame = useRef(0)
  /** The theme's colours, read from the stylesheet once in a while rather than every frame (getComputedStyle forces style). */
  const theme = useRef<{ at: number; c: Record<string, string> } | null>(null)
  const [editing, setEditing] = useState<(Cell & { text: string }) | null>(null)
  const editingRef = useRef(editing)
  editingRef.current = editing

  // Column geometry: x of each column's left edge, after the row-number column.
  // The row-number column's width, then each column's left edge, then the right edge of the last: `xs[0]` is the number
  // column's width. A ref, like `propsRef`: `draw` and the window's mouse handlers are closures of an earlier render.
  const xs = useRef<number[]>([])
  const totalW = (() => {
    const out: number[] = []
    // Room for three digits at least, so the columns do not shift as the first rows are keyed in.
    let x = 14 + Math.max(3, String(data.rows.length).length) * 7.5
    for (let i = 0; i < data.columns.length; i++) {
      out.push(x)
      x += widths[i] ?? 120
    }
    out.push(x)
    xs.current = out
    return x + ADD_COL_W
  })()
  const totalH = HEADER_H + data.rows.length * ROW_H + ROW_H

  // Reads the table through the ref: `draw` runs from a frame scheduled by a closure of the first render.
  const selection = (): CellRange | null => {
    const c = cursor.current
    if (!c) return null
    const a = anchor.current ?? c
    return normalizeRange({ r0: a.r, c0: a.c, r1: c.r, c1: c.c }, propsRef.current.data)
  }
  const announce = () => propsRef.current.onSelectionChange?.(selection(), cursor.current)

  const schedule = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      draw()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // A new theme: its colours are read afresh and the grid painted in them at once.
  useEffect(() => onThemeChange(() => ((theme.current = null), schedule())), [schedule])

  // ── Painting ─────────────────────────────────────────────────────────
  const draw = () => {
    const box = boxRef.current
    const canvas = canvasRef.current
    if (!box || !canvas) return
    const { data, kinds, widths } = propsRef.current
    const W = box.clientWidth
    const H = box.clientHeight
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
    }
    const sx = box.scrollLeft
    const sy = box.scrollTop
    canvas.style.transform = `translate(${sx}px, ${sy}px)`
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const t0 = performance.now()
    if (!theme.current || t0 - theme.current.at > 2000) {
      const css = getComputedStyle(box)
      const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
      theme.current = { at: t0, c: { bg: v('--surface', '#fff'), head: v('--surface-2', '#f5f4f0'), line: v('--border', '#e5e3dd'), text: v('--text', '#1f1e1b'), muted: v('--text-muted', '#6b6963'), faint: v('--text-faint', '#9b9993'), accent: v('--accent', '#1f1e1b'), url: themeInfo(currentTheme()).scheme === 'dark' ? v('--select', '#6fa3ee') : '#1d4ed8' } }
    }
    const C = theme.current.c
    ctx.fillStyle = C.bg
    ctx.fillRect(0, 0, W, H)
    ctx.font = FONT
    ctx.textBaseline = 'middle'

    const rows = data.rows
    const cols = data.columns
    const x = xs.current
    const numW = x[0]
    const r0 = Math.max(0, Math.floor((sy - HEADER_H) / ROW_H))
    const r1 = Math.min(rows.length, Math.ceil((sy + H - HEADER_H) / ROW_H) + 1)
    let c0 = 0
    while (c0 < cols.length - 1 && x[c0 + 1] - sx < numW) c0++
    let c1 = c0
    while (c1 < cols.length && x[c1] - sx < W) c1++
    const sel = selection()
    const cur = cursor.current
    const fill = fillPreview.current
    const ed = editingRef.current

    // Body cells.
    for (let r = r0; r < r1; r++) {
      const y = HEADER_H + r * ROW_H - sy
      const row = rows[r]
      for (let c = c0; c < c1; c++) {
        const cx = x[c] - sx
        const w = widths[c] ?? 120
        const inSel = sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1
        const inFill = fill && r >= fill.r0 && r <= fill.r1 && c >= fill.c0 && c <= fill.c1 && !inSel
        if (inSel && !(sel.r0 === sel.r1 && sel.c0 === sel.c1)) {
          ctx.fillStyle = tint(C.text, 0.07)
          ctx.fillRect(cx, y, w, ROW_H)
        } else if (inFill) {
          ctx.fillStyle = tint(C.text, 0.04)
          ctx.fillRect(cx, y, w, ROW_H)
        }
        if (ed && ed.r === r && ed.c === c) continue
        const v = row[c]
        if (v === null || v === undefined || v === '') continue
        const kind = kinds[c]
        const text = cellText(v)
        const numeric = kind === 'number' || typeof v === 'number'
        ctx.save()
        ctx.beginPath()
        ctx.rect(cx + 1, y, w - 2, ROW_H)
        ctx.clip()
        ctx.fillStyle = kind === 'url' ? C.url : typeof v === 'boolean' ? C.muted : C.text
        ctx.font = kind === 'json' ? MONO : FONT
        ctx.textAlign = numeric ? 'right' : 'left'
        ctx.fillText(fit(ctx, text, w - 16), numeric ? cx + w - 8 : cx + 8, y + ROW_H / 2 + 0.5)
        ctx.restore()
      }
    }
    // Grid lines: rows, then columns.
    ctx.strokeStyle = C.line
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let r = r0; r <= r1; r++) {
      const y = Math.round(HEADER_H + r * ROW_H - sy) + 0.5
      ctx.moveTo(numW, y)
      ctx.lineTo(Math.min(W, x[cols.length] - sx), y)
    }
    for (let c = c0; c <= cols.length; c++) {
      const cx = Math.round(x[c] - sx) + 0.5
      ctx.moveTo(cx, HEADER_H)
      ctx.lineTo(cx, Math.min(H, HEADER_H + rows.length * ROW_H - sy))
    }
    ctx.stroke()
    // The + handles: under the last row (kept at the left as the view scrolls sideways) and right of the last column
    // (kept at the top as it scrolls down). A click adds one; a drag adds or takes off as many as it covers.
    const grow = drag.current?.kind === 'grow' ? drag.current : null
    ctx.font = FONT
    ctx.fillStyle = C.muted
    {
      const y = HEADER_H + rows.length * ROW_H - sy
      if (y < H && y + ROW_H > HEADER_H && !(grow && grow.axis === 'rows')) {
        ctx.textAlign = 'left'
        ctx.fillText(rows.length === 0 ? '+  type here, or paste a block of cells' : '+', numW + 8, y + ROW_H / 2 + 0.5)
      }
      const cx = x[cols.length] - sx
      if (cx < W && !(grow && grow.axis === 'cols')) {
        ctx.textAlign = 'center'
        ctx.fillText('+', cx + ADD_COL_W / 2, HEADER_H + ROW_H / 2 + 0.5)
      }
    }
    if (grow && grow.count !== 0) {
      // Ghost rows or columns for what a drag would add, a red wash over what it would take off, and the count by the pointer.
      const n = Math.abs(grow.count)
      ctx.save()
      if (grow.count > 0) {
        ctx.setLineDash([3, 3])
        ctx.strokeStyle = C.muted
        ctx.lineWidth = 1
        ctx.beginPath()
        if (grow.axis === 'rows') {
          const y0 = HEADER_H + rows.length * ROW_H - sy
          const right = Math.min(W, x[cols.length] - sx)
          for (let i = 1; i <= n; i++) {
            const y = Math.round(y0 + i * ROW_H) + 0.5
            if (y > H) break
            ctx.moveTo(numW, y)
            ctx.lineTo(right, y)
          }
        } else {
          const x0 = x[cols.length] - sx
          const bottom = Math.min(H, HEADER_H + rows.length * ROW_H - sy)
          const step = widths[cols.length - 1] ?? 120
          for (let i = 1; i <= n; i++) {
            const gx = Math.round(x0 + i * step) + 0.5
            if (gx > W) break
            ctx.moveTo(gx, HEADER_H)
            ctx.lineTo(gx, bottom)
          }
        }
        ctx.stroke()
      } else {
        ctx.fillStyle = 'rgba(220, 38, 38, 0.10)'
        if (grow.axis === 'rows') ctx.fillRect(numW, HEADER_H + (rows.length - n) * ROW_H - sy, Math.min(W, x[cols.length] - sx) - numW, n * ROW_H)
        else ctx.fillRect(x[cols.length - n] - sx, HEADER_H, x[cols.length] - x[cols.length - n], Math.min(H, HEADER_H + rows.length * ROW_H - sy) - HEADER_H)
      }
      ctx.restore()
      const label = `${grow.count > 0 ? '+' : '−'}${n} ${grow.axis === 'rows' ? 'row' : 'column'}${n === 1 ? '' : 's'}`
      const b = box.getBoundingClientRect()
      const lx = grow.at.x - b.left + 14
      const ly = grow.at.y - b.top + 14
      ctx.font = '600 11px Inter, system-ui, sans-serif'
      const lw = ctx.measureText(label).width + 12
      ctx.fillStyle = C.text
      ctx.fillRect(lx, ly, lw, 18)
      ctx.fillStyle = C.bg
      ctx.textAlign = 'left'
      ctx.fillText(label, lx + 6, ly + 9.5)
    }
    // Cursor and fill handle.
    if (cur && !ed && cur.r < rows.length && cur.c < cols.length) {
      const cx = x[cur.c] - sx
      const y = HEADER_H + cur.r * ROW_H - sy
      ctx.strokeStyle = C.accent
      ctx.lineWidth = 2
      ctx.strokeRect(cx + 1, y + 1, (widths[cur.c] ?? 120) - 2, ROW_H - 2)
    }
    if (sel && !ed) {
      const sx1 = x[sel.c1 + 1] - sx
      const sy1 = HEADER_H + (sel.r1 + 1) * ROW_H - sy
      if (!(sel.r0 === sel.r1 && sel.c0 === sel.c1)) {
        ctx.strokeStyle = C.accent
        ctx.lineWidth = 1
        ctx.strokeRect(x[sel.c0] - sx + 0.5, HEADER_H + sel.r0 * ROW_H - sy + 0.5, x[sel.c1 + 1] - x[sel.c0] - 1, (sel.r1 - sel.r0 + 1) * ROW_H - 1)
      }
      ctx.fillStyle = C.accent
      ctx.fillRect(sx1 - FILL_HANDLE + 1, sy1 - FILL_HANDLE + 1, FILL_HANDLE - 1, FILL_HANDLE - 1)
      ctx.strokeStyle = C.bg
      ctx.lineWidth = 1
      ctx.strokeRect(sx1 - FILL_HANDLE + 0.5, sy1 - FILL_HANDLE + 0.5, FILL_HANDLE, FILL_HANDLE)
    }

    // Row numbers (frozen at the left).
    ctx.fillStyle = C.head
    ctx.fillRect(0, HEADER_H, numW, H - HEADER_H)
    ctx.font = FONT
    ctx.textAlign = 'right'
    for (let r = r0; r < r1; r++) {
      const y = HEADER_H + r * ROW_H - sy
      const on = sel && r >= sel.r0 && r <= sel.r1
      if (on) {
        ctx.fillStyle = tint(C.text, 0.12)
        ctx.fillRect(0, y, numW, ROW_H)
      }
      ctx.fillStyle = on ? C.text : C.muted
      ctx.fillText(String(r + 1), numW - 6, y + ROW_H / 2 + 0.5)
    }
    ctx.strokeStyle = C.line
    ctx.beginPath()
    ctx.moveTo(numW + 0.5, HEADER_H)
    ctx.lineTo(numW + 0.5, H)
    for (let r = r0; r <= r1; r++) {
      const y = Math.round(HEADER_H + r * ROW_H - sy) + 0.5
      ctx.moveTo(0, y)
      ctx.lineTo(numW, y)
    }
    ctx.stroke()

    // Header (frozen at the top).
    ctx.fillStyle = C.head
    ctx.fillRect(0, 0, W, HEADER_H)
    for (let c = c0; c < c1; c++) {
      const cx = x[c] - sx
      const w = widths[c] ?? 120
      const on = sel && c >= sel.c0 && c <= sel.c1
      if (on) {
        ctx.fillStyle = tint(C.text, 0.12)
        ctx.fillRect(cx, 0, w, HEADER_H)
      }
      ctx.save()
      ctx.beginPath()
      ctx.rect(cx + 1, 0, w - 2, HEADER_H)
      ctx.clip()
      ctx.fillStyle = on ? C.text : C.text
      ctx.textAlign = 'left'
      ctx.font = '600 12px Inter, system-ui, -apple-system, sans-serif'
      ctx.fillText(fit(ctx, columnLabel(cols[c]), w - 30), cx + 8, HEADER_H / 2 + 0.5)
      // The kind, in small grey, at the right.
      ctx.fillStyle = C.faint
      ctx.font = '10px Inter, system-ui, -apple-system, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(KIND_MARK[kinds[c]] ?? '', cx + w - 6, HEADER_H / 2 + 0.5)
      ctx.restore()
    }
    ctx.fillStyle = C.head
    ctx.fillRect(0, 0, numW, HEADER_H)
    ctx.strokeStyle = C.line
    ctx.beginPath()
    ctx.moveTo(0, HEADER_H + 0.5)
    ctx.lineTo(W, HEADER_H + 0.5)
    for (let c = c0; c <= cols.length; c++) {
      const cx = Math.round(x[c] - sx) + 0.5
      ctx.moveTo(cx, 0)
      ctx.lineTo(cx, HEADER_H)
    }
    ctx.moveTo(numW + 0.5, 0)
    ctx.lineTo(numW + 0.5, HEADER_H)
    ctx.stroke()
    // The resize grip under the pointer.
    if (hoverEdge.current !== null && drag.current === null) {
      const cx = Math.round(x[hoverEdge.current + 1] - sx) + 0.5
      ctx.strokeStyle = C.accent
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(cx, 0)
      ctx.lineTo(cx, HEADER_H)
      ctx.stroke()
    }
    // A frame's cost, on record for the profiler and the headless checks (`performance.getEntriesByName('dg:draw')`).
    measure('dg:draw', { start: t0, end: performance.now() })
  }

  useLayoutEffect(() => {
    schedule()
  })
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const ro = new ResizeObserver(schedule)
    ro.observe(box)
    return () => ro.disconnect()
  }, [schedule])
  useEffect(
    () => () => {
      // Drop a pending frame — and forget it, or a remount (StrictMode's, a pane's) would never schedule again.
      cancelAnimationFrame(frame.current)
      frame.current = 0
    },
    [],
  )
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  // ── Geometry ─────────────────────────────────────────────────────────
  const cellAt = (clientX: number, clientY: number): { r: number; c: number; zone: 'head' | 'num' | 'body' | 'addcol' | 'addrow' | 'corner' | 'none'; edge: number | null; onHandle: boolean } => {
    const box = boxRef.current!
    const b = box.getBoundingClientRect()
    const px = clientX - b.left
    const py = clientY - b.top
    const ax = px + box.scrollLeft
    const ay = py + box.scrollTop
    const x = xs.current
    const numW = x[0]
    const cols = propsRef.current.data.columns.length
    let c = -1
    if (ax >= numW) {
      // Binary search the column under ax.
      let lo = 0, hi = cols - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (x[mid + 1] <= ax) lo = mid + 1
        else if (x[mid] > ax) hi = mid - 1
        else {
          c = mid
          break
        }
      }
    }
    let edge: number | null = null
    if (py < HEADER_H) for (let i = 0; i < cols; i++) if (Math.abs(x[i + 1] - ax) <= RESIZE_GRIP) edge = i
    const r = Math.floor((ay - HEADER_H) / ROW_H)
    const rows = propsRef.current.data.rows.length
    // Right of the last column the body is the add-column handle (the header there is nothing); under the last row, the add-row one.
    const zone =
      py < HEADER_H ? (px < numW ? 'corner' : c < 0 && ax >= x[cols] ? 'none' : 'head') : px < numW ? 'num' : c < 0 && ax >= x[cols] ? (ax < x[cols] + ADD_COL_W && r < Math.max(rows, 1) ? 'addcol' : 'none') : r >= rows ? (r === rows ? 'addrow' : 'none') : 'body'
    // The fill handle: the square at the selection's bottom-right corner.
    const sel = selection()
    let onHandle = false
    if (sel) {
      const hx = x[sel.c1 + 1] - box.scrollLeft
      const hy = HEADER_H + (sel.r1 + 1) * ROW_H - box.scrollTop
      onHandle = px >= hx - FILL_HANDLE - 2 && px <= hx + 2 && py >= hy - FILL_HANDLE - 2 && py <= hy + 2
    }
    return { r: Math.max(0, Math.min(rows - 1, r)), c: Math.max(0, Math.min(cols - 1, c)), zone, edge, onHandle }
  }
  const scrollTo = (cell: Cell) => {
    const box = boxRef.current
    if (!box) return
    const x = xs.current
    const top = HEADER_H + cell.r * ROW_H
    if (top < box.scrollTop + HEADER_H) box.scrollTop = top - HEADER_H
    else if (top + ROW_H > box.scrollTop + box.clientHeight) box.scrollTop = top + ROW_H - box.clientHeight
    const left = x[cell.c]
    const w = propsRef.current.widths[cell.c] ?? 120
    if (left < box.scrollLeft + x[0]) box.scrollLeft = left - x[0]
    else if (left + w > box.scrollLeft + box.clientWidth) box.scrollLeft = left + w - box.clientWidth
  }

  // ── The cursor ───────────────────────────────────────────────────────
  const setCursor = (cell: Cell, extend = false) => {
    const rows = propsRef.current.data.rows.length
    const cols = propsRef.current.data.columns.length
    if (!rows || !cols) return
    const next = { r: Math.max(0, Math.min(rows - 1, cell.r)), c: Math.max(0, Math.min(cols - 1, cell.c)) }
    if (!extend) anchor.current = null
    else if (!anchor.current) anchor.current = cursor.current ?? next
    cursor.current = next
    scrollTo(next)
    schedule()
    announce()
  }
  const selectAll = () => {
    const d = propsRef.current.data
    if (!d.rows.length) return
    anchor.current = { r: 0, c: 0 }
    cursor.current = { r: d.rows.length - 1, c: d.columns.length - 1 }
    schedule()
    announce()
  }
  const move = (dr: number, dc: number, extend: boolean) => {
    const cur = cursor.current ?? { r: 0, c: 0 }
    const rows = propsRef.current.data.rows.length
    if (dr > 0 && cur.r + dr >= rows && !extend) {
      // Past the last row: a new one, and the cursor on it.
      propsRef.current.onAppendRow()
      cursor.current = { r: rows, c: cur.c }
      anchor.current = null
      requestAnimationFrame(() => {
        scrollTo(cursor.current!)
        schedule()
        announce()
      })
      return
    }
    setCursor({ r: cur.r + dr, c: cur.c + dc }, extend)
  }

  const startEdit = (cell: Cell, text?: string) => {
    const d = propsRef.current.data
    if (cell.r >= d.rows.length || cell.c >= d.columns.length) return
    anchor.current = null
    cursor.current = cell
    scrollTo(cell)
    const next = { ...cell, text: text ?? cellText(d.rows[cell.r][cell.c]) }
    // Known at once, not after the render: a key that lands before the input has mounted still finds the edit.
    editingRef.current = next
    setEditing(next)
    schedule()
  }
  const endEdit = (how: 'commit' | 'cancel', moveNext: 'down' | 'right' | 'stay' = 'stay') => {
    const ed = editingRef.current
    if (!ed) return
    editingRef.current = null
    setEditing(null)
    if (how === 'commit') propsRef.current.onCommit({ r: ed.r, c: ed.c }, ed.text, moveNext)
    if (moveNext === 'down') move(1, 0, false)
    else if (moveNext === 'right') move(0, 1, false)
    boxRef.current?.focus({ preventScroll: true })
    schedule()
  }

  useImperativeHandle(ref, () => ({
    getCursor: () => cursor.current,
    getSelection: selection,
    select: (range, cur) => {
      // Kept as given and clipped when read, so a range set right after a shape change — before the grid has the new
      // table — is not clipped to the old one; the scroll and the announcement wait a frame for the same reason.
      const r0 = Math.min(range.r0, range.r1)
      const r1 = Math.max(range.r0, range.r1)
      const c0 = Math.min(range.c0, range.c1)
      const c1 = Math.max(range.c0, range.c1)
      cursor.current = cur ?? { r: r1, c: c1 }
      // The anchor is the corner across from the cursor, so the range spans between them.
      anchor.current = { r: cursor.current.r === r0 ? r1 : r0, c: cursor.current.c === c0 ? c1 : c0 }
      schedule()
      requestAnimationFrame(() => {
        const d = propsRef.current.data
        if (cursor.current) cursor.current = { r: Math.max(0, Math.min(cursor.current.r, d.rows.length - 1)), c: Math.max(0, Math.min(cursor.current.c, d.columns.length - 1)) }
        if (cursor.current) scrollTo(cursor.current)
        schedule()
        announce()
      })
    },
    focus: () => boxRef.current?.focus({ preventScroll: true }),
    scrollTo,
    startEdit,
  }))

  // ── Keys ─────────────────────────────────────────────────────────────
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // The input's keys bubble up here: they are the editor's (onEditKey), never the grid's.
    if (e.target !== e.currentTarget) return
    const ed = editingRef.current
    if (ed) {
      // A fast typist's keys can arrive before the input has mounted and taken focus: they join the edit here.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const next = { ...ed, text: ed.text + e.key }
        editingRef.current = next
        setEditing(next)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        endEdit('commit', e.key === 'Enter' ? (e.shiftKey ? 'stay' : 'down') : e.shiftKey ? 'stay' : 'right')
      } else if (e.key === 'Escape') {
        e.preventDefault()
        endEdit('cancel')
      } else if (e.key.startsWith('Arrow')) {
        // Before the input has mounted the caret is at the end of what has been typed.
        const to = editorArrow(e.key, { start: ed.text.length, end: ed.text.length, length: ed.text.length }, e)
        if (to) {
          e.preventDefault()
          leaveEdit(to, e.repeat)
        }
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        const next = { ...ed, text: ed.text.slice(0, -1) }
        editingRef.current = next
        setEditing(next)
      }
      return
    }
    const p = propsRef.current
    const meta = e.metaKey || e.ctrlKey
    const cur = cursor.current
    const d = p.data
    const key = e.key
    const stop = () => e.preventDefault()
    if (meta && (key === 'z' || key === 'Z')) {
      stop()
      if (e.shiftKey) p.onRedo()
      else p.onUndo()
      return
    }
    if (meta && (key === 'y' || key === 'Y')) return (stop(), p.onRedo())
    if (!d.rows.length) {
      // An empty table: the first key makes the first row and starts typing into it.
      if (key.length === 1 && !meta && !e.altKey) {
        stop()
        p.onAppendRow()
        requestAnimationFrame(() => startEdit({ r: 0, c: 0 }, key))
      } else if (key === 'Enter') {
        stop()
        p.onAppendRow()
        requestAnimationFrame(() => setCursor({ r: 0, c: 0 }))
      }
      return
    }
    if (meta && (key === 'a' || key === 'A')) return (stop(), selectAll())
    if (meta && (key === 'd' || key === 'D') && cur) return (stop(), p.onFill(selection()!, 'down'))
    if (meta && (key === 'r' || key === 'R') && cur) return (stop(), p.onFill(selection()!, 'right'))
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'ArrowLeft' || key === 'ArrowRight') {
      stop()
      const dr = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0
      const dc = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0
      if (!cur) return setCursor({ r: 0, c: 0 })
      if (meta) {
        const to = p.onBlockEdge ? p.onBlockEdge(cur, dr, dc) : null
        return setCursor(to ?? { r: dr > 0 ? d.rows.length - 1 : dr < 0 ? 0 : cur.r, c: dc > 0 ? d.columns.length - 1 : dc < 0 ? 0 : cur.c }, e.shiftKey)
      }
      // A held ↓ repeats: it walks to the last row and stops there, rather than appending a row per repeat.
      if (e.repeat && dr > 0 && cur.r + 1 >= d.rows.length) return
      return move(dr, dc, e.shiftKey)
    }
    if (key === 'Tab') return (stop(), move(0, e.shiftKey ? -1 : 1, false))
    if (key === 'Enter') {
      stop()
      if (e.altKey || (e.shiftKey && !cur)) return
      if (!cur) return setCursor({ r: 0, c: 0 })
      return startEdit(cur)
    }
    if (key === 'F2') return (stop(), cur ? startEdit(cur) : setCursor({ r: 0, c: 0 }))
    if (key === 'Home') return (stop(), setCursor({ r: meta ? 0 : (cur?.r ?? 0), c: 0 }, e.shiftKey))
    if (key === 'End') return (stop(), setCursor({ r: meta ? d.rows.length - 1 : (cur?.r ?? 0), c: d.columns.length - 1 }, e.shiftKey))
    if (key === 'PageDown' || key === 'PageUp') {
      stop()
      const page = Math.max(1, Math.floor(((boxRef.current?.clientHeight ?? 400) - HEADER_H) / ROW_H) - 1)
      return setCursor({ r: (cur?.r ?? 0) + (key === 'PageDown' ? page : -page), c: cur?.c ?? 0 }, e.shiftKey)
    }
    if (key === 'Escape') {
      stop()
      anchor.current = null
      fillPreview.current = null
      schedule()
      announce()
      return
    }
    if ((key === 'Backspace' || key === 'Delete') && cur) {
      stop()
      p.onClear(selection()!)
      return
    }
    if (key.length === 1 && !meta && !e.altKey && cur) {
      // Typing over a cell starts a fresh value, the way a spreadsheet does.
      stop()
      startEdit(cur, key)
    }
  }
  /**
   * An arrow that leaves the editor: the edit is committed where it is (as leaving a cell by click does) and the
   * cursor steps to the neighbour, which is selected, not opened — type over it, or ↵ to edit it. ↓ on the last row
   * adds one, as ↵ does, except while held down.
   */
  const leaveEdit = (to: EditorMove, repeat: boolean) => {
    endEdit('commit', 'stay')
    const { dr, dc } = MOVE_STEP[to]
    const cur = cursor.current
    if (repeat && dr > 0 && cur && cur.r + 1 >= propsRef.current.data.rows.length) return
    move(dr, dc, false)
  }
  const onEditKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key.startsWith('Arrow')) {
      const el = e.currentTarget
      const to = editorArrow(e.key, { start: el.selectionStart, end: el.selectionEnd, length: el.value.length }, e)
      if (to) {
        e.preventDefault()
        leaveEdit(to, e.repeat)
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      endEdit('commit', e.shiftKey ? 'stay' : 'down')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      endEdit('commit', e.shiftKey ? 'stay' : 'right')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      endEdit('cancel')
    }
  }

  // ── Clipboard ────────────────────────────────────────────────────────
  const onCopy = (e: ReactClipboardEvent<HTMLDivElement>) => {
    if (editingRef.current) return
    const sel = selection()
    if (!sel) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', propsRef.current.onCopy(sel))
  }
  const onCut = (e: ReactClipboardEvent<HTMLDivElement>) => {
    if (editingRef.current) return
    const sel = selection()
    if (!sel) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', propsRef.current.onCopy(sel))
    propsRef.current.onClear(sel)
  }
  const onPaste = (e: ReactClipboardEvent<HTMLDivElement>) => {
    if (editingRef.current) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    const cur = cursor.current ?? { r: 0, c: 0 }
    propsRef.current.onPaste(propsRef.current.parseBlock(text), cur, selection() ?? { r0: cur.r, c0: cur.c, r1: cur.r, c1: cur.c })
  }

  // ── Mouse ────────────────────────────────────────────────────────────
  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (editingRef.current) {
      // A click elsewhere commits the edit first.
      const ed = editingRef.current
      const hit = cellAt(e.clientX, e.clientY)
      if (!(hit.zone === 'body' && hit.r === ed.r && hit.c === ed.c)) endEdit('commit')
      else return
    }
    if (e.button !== 0) return
    const hit = cellAt(e.clientX, e.clientY)
    const d = propsRef.current.data
    boxRef.current?.focus({ preventScroll: true })
    if (hit.zone === 'head' && hit.edge !== null) {
      e.preventDefault()
      drag.current = { kind: 'resize', col: hit.edge, startX: e.clientX, startW: widths[hit.edge] ?? 120 }
      return
    }
    if (hit.zone === 'none') return
    if (hit.zone === 'addcol' || hit.zone === 'addrow') {
      // The + handle: a drag grows or shrinks the table by what it covers; a plain click (resolved on mouseup) adds one.
      e.preventDefault()
      const axis = hit.zone === 'addrow' ? 'rows' : 'cols'
      drag.current = { kind: 'grow', axis, start: axis === 'rows' ? e.clientY : e.clientX, count: 0, removable: trailingEmpty(d, axis), at: { x: e.clientX, y: e.clientY } }
      schedule()
      return
    }
    if (hit.zone === 'corner') return selectAll()
    if (hit.zone === 'head') {
      e.preventDefault()
      if (!d.rows.length) return
      if (e.shiftKey && cursor.current) anchor.current = { r: 0, c: anchor.current?.c ?? cursor.current.c }
      else anchor.current = { r: 0, c: hit.c }
      cursor.current = { r: d.rows.length - 1, c: hit.c }
      drag.current = { kind: 'cols', anchor: anchor.current.c }
      schedule()
      announce()
      return
    }
    if (hit.zone === 'num') {
      e.preventDefault()
      if (e.shiftKey && cursor.current) anchor.current = { r: anchor.current?.r ?? cursor.current.r, c: 0 }
      else anchor.current = { r: hit.r, c: 0 }
      cursor.current = { r: hit.r, c: d.columns.length - 1 }
      drag.current = { kind: 'rows', anchor: anchor.current.r }
      schedule()
      announce()
      return
    }
    if (hit.onHandle) {
      e.preventDefault()
      drag.current = { kind: 'fill', base: selection()! }
      return
    }
    // A body cell: the cursor (⇧ extends), and a drag from here selects a range.
    e.preventDefault()
    if (e.shiftKey && cursor.current) setCursor(hit, true)
    else {
      setCursor(hit)
      drag.current = { kind: 'select', anchor: hit }
    }
  }
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const dr = drag.current
      const box = boxRef.current
      if (!box) return
      if (!dr) {
        // The resize grip shows itself under the pointer on the header.
        const b = box.getBoundingClientRect()
        const inside = e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom
        const hit = inside ? cellAt(e.clientX, e.clientY) : null
        const edge = hit && hit.zone === 'head' ? hit.edge : null
        const pointer = edge !== null ? 'col-resize' : !hit ? '' : hit.onHandle ? 'crosshair' : hit.zone === 'addrow' ? 'ns-resize' : hit.zone === 'addcol' ? 'ew-resize' : hit.zone === 'head' || hit.zone === 'num' ? 'default' : ''
        if (edge !== hoverEdge.current) {
          hoverEdge.current = edge
          schedule()
        }
        box.style.cursor = pointer
        return
      }
      if (dr.kind === 'grow') {
        const step = dr.axis === 'rows' ? ROW_H : (propsRef.current.widths.at(-1) ?? 120) // a new column takes the last one's width
        const raw = Math.round(((dr.axis === 'rows' ? e.clientY : e.clientX) - dr.start) / step)
        dr.count = Math.max(-dr.removable, raw)
        dr.at = { x: e.clientX, y: e.clientY }
        schedule()
        return
      }
      if (dr.kind === 'resize') {
        const next = widths.slice()
        next[dr.col] = Math.max(MIN_COL_W, dr.startW + (e.clientX - dr.startX))
        propsRef.current.onWidths(next)
        return
      }
      const hit = cellAt(e.clientX, e.clientY)
      const d = propsRef.current.data
      if (dr.kind === 'select') {
        anchor.current = dr.anchor
        cursor.current = { r: hit.r, c: hit.c }
      } else if (dr.kind === 'rows') {
        anchor.current = { r: dr.anchor, c: 0 }
        cursor.current = { r: hit.r, c: d.columns.length - 1 }
      } else if (dr.kind === 'cols') {
        anchor.current = { r: 0, c: dr.anchor }
        cursor.current = { r: d.rows.length - 1, c: hit.c }
      } else if (dr.kind === 'fill') {
        // Down or right from the base, whichever way the pointer went further.
        const b = dr.base
        const down = hit.r - b.r1
        const right = hit.c - b.c1
        fillPreview.current = down >= right && down > 0 ? { r0: b.r0, c0: b.c0, r1: hit.r, c1: b.c1 } : right > 0 ? { r0: b.r0, c0: b.c0, r1: b.r1, c1: hit.c } : null
        schedule()
        return
      }
      // Keep the pointer's cell in view while dragging near an edge.
      const b = box.getBoundingClientRect()
      if (e.clientY > b.bottom - 8) box.scrollTop += ROW_H
      else if (e.clientY < b.top + HEADER_H + 8) box.scrollTop -= ROW_H
      schedule()
      announce()
    }
    const onUp = () => {
      const dr = drag.current
      if (!dr) return
      drag.current = null
      if (dr.kind === 'grow') {
        const p = propsRef.current
        const d = p.data
        const n = d.rows.length
        const m = d.columns.length
        const gone = Array.from({ length: -dr.count }, (_, i) => (dr.axis === 'rows' ? n : m) + dr.count + i)
        if (dr.count > 0) {
          if (dr.axis === 'rows') p.onAddRows(dr.count)
          else p.onAddColumns(dr.count)
        } else if (dr.count < 0) {
          if (dr.axis === 'rows') p.onRemoveRows(gone)
          else p.onRemoveColumns(gone)
        } else if (dr.axis === 'cols') p.onAddColumns(1)
        else {
          p.onAppendRow()
          cursor.current = { r: n, c: cursor.current?.c ?? 0 }
          anchor.current = null
          requestAnimationFrame(() => (scrollTo(cursor.current!), schedule(), announce()))
        }
        schedule()
        return
      }
      if (dr.kind === 'fill' && fillPreview.current) {
        const range = fillPreview.current
        fillPreview.current = null
        const dir = range.r1 > dr.base.r1 ? 'down' : 'right'
        propsRef.current.onFill(range, dir)
        anchor.current = { r: range.r0, c: range.c0 }
        cursor.current = { r: range.r1, c: range.c1 }
        announce()
      }
      fillPreview.current = null
      schedule()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widths])
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const hit = cellAt(e.clientX, e.clientY)
    if (hit.zone === 'head' && hit.edge !== null) {
      // Double-click on a grip: the column takes the width of its widest cell in view.
      const box = boxRef.current!
      const d = propsRef.current.data
      const ctx = canvasRef.current!.getContext('2d')!
      ctx.font = FONT
      const r0 = Math.max(0, Math.floor((box.scrollTop - HEADER_H) / ROW_H))
      const r1 = Math.min(d.rows.length, r0 + 200)
      let w = ctx.measureText(columnLabel(d.columns[hit.edge])).width + 40
      for (let r = r0; r < r1; r++) w = Math.max(w, ctx.measureText(cellText(d.rows[r][hit.edge])).width + 18)
      const next = widths.slice()
      next[hit.edge] = Math.min(600, Math.max(MIN_COL_W, Math.ceil(w)))
      propsRef.current.onWidths(next)
      return
    }
    if (hit.zone === 'head') return propsRef.current.onRenameColumn(hit.c)
    if (hit.zone === 'body') startEdit(hit)
  }
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (editingRef.current) endEdit('commit')
    const hit = cellAt(e.clientX, e.clientY)
    const at = { x: e.clientX, y: e.clientY }
    const p = propsRef.current
    if (hit.zone === 'head') return p.onColumnMenu(hit.c, at)
    if (hit.zone === 'addcol' || hit.zone === 'addrow' || hit.zone === 'corner' || hit.zone === 'none') return
    if (hit.zone === 'num') {
      const sel = selection()
      const rows = sel && hit.r >= sel.r0 && hit.r <= sel.r1 ? Array.from({ length: sel.r1 - sel.r0 + 1 }, (_, i) => sel.r0 + i) : [hit.r]
      if (!(sel && hit.r >= sel.r0 && hit.r <= sel.r1)) {
        anchor.current = { r: hit.r, c: 0 }
        cursor.current = { r: hit.r, c: p.data.columns.length - 1 }
        schedule()
        announce()
      }
      return p.onRowMenu(rows, at)
    }
    const sel = selection()
    const inside = sel && hit.r >= sel.r0 && hit.r <= sel.r1 && hit.c >= sel.c0 && hit.c <= sel.c1
    if (!inside) setCursor(hit)
    p.onCellMenu(hit, selection()!, at)
  }

  // The editor over the cell being edited, in the scroll box's coordinates.
  const edStyle = editing ? { left: xs.current[editing.c], top: HEADER_H + editing.r * ROW_H, width: widths[editing.c] ?? 120, height: ROW_H } : undefined
  return (
    <div ref={boxRef} className="dg" tabIndex={0} onKeyDown={onKey} onMouseDown={onMouseDown} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} onCopy={onCopy} onCut={onCut} onPaste={onPaste} onScroll={schedule}>
      <div className="dg__space" style={{ width: totalW, height: totalH }}>
        <canvas ref={canvasRef} className="dg__canvas" />
        {editing && (
          <input
            ref={inputRef}
            className={`dg__input ${kinds[editing.c] === 'number' ? 'is-num' : ''}`}
            style={edStyle}
            value={editing.text}
            onChange={(e) => {
              const next = { ...editing, text: e.target.value }
              editingRef.current = next
              setEditing(next)
            }}
            onKeyDown={onEditKey}
            onBlur={() => endEdit('commit')}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  )
})

/** A word or a mark for the column's kind, small and grey at the header's right. */
const KIND_MARK: Record<string, string> = { number: '#', boolean: 'T/F', date: 'date', datetime: 'time', url: 'url', json: '{ }', text: '' }

/** Text cut to fit a width, with an ellipsis; measured widths are cached, since a frame asks for the same strings again. */
const widthCache = new Map<string, number>()
const blank = (v: unknown) => v === null || v === undefined || v === ''

/** How many rows (or columns) at the end hold nothing — what a drag on the + handle may take off. A table keeps one column. */
function trailingEmpty(d: DatasetData, axis: 'rows' | 'cols'): number {
  let n = 0
  if (axis === 'rows') {
    for (let r = d.rows.length - 1; r >= 0 && d.rows[r].every(blank); r--) n++
  } else {
    for (let c = d.columns.length - 1; c > 0 && d.rows.every((row) => blank(row[c])); c--) n++
  }
  return n
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (max <= 0) return ''
  const key = ctx.font + '|' + text
  let w = widthCache.get(key)
  if (w === undefined) {
    w = ctx.measureText(text).width
    if (widthCache.size > 20000) widthCache.clear()
    widthCache.set(key, w)
  }
  if (w <= max) return text
  // Estimate the cut from the average glyph, then trim to fit.
  let n = Math.max(1, Math.floor((text.length * max) / w) - 1)
  let s = text.slice(0, n) + '…'
  while (n > 1 && ctx.measureText(s).width > max) {
    n--
    s = text.slice(0, n) + '…'
  }
  return s
}
