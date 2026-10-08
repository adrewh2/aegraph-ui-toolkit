import { setCells, type CellPatch, type DatasetData } from '../../../core/datasets/dataset'

/**
 * Undo and redo for the dataset grid. Cell edits are kept as patches — the
 * cells' values before and after — and put back through `setCells`, so a
 * hundred edits on a table of a hundred thousand rows keep a hundred small
 * lists, not a hundred copies of the row array. Edits that change the shape
 * (rows and columns in or out, a sort, a move, a paste that grew the
 * table) keep the data before and after: the pure functions share every
 * row that did not change, so that is cheap too. Capped, oldest first.
 */
export type Edit = { kind: 'cells'; before: CellPatch[]; after: CellPatch[] } | { kind: 'shape'; before: DatasetData; after: DatasetData }

const MAX = 200

export class EditHistory {
  private past: Edit[] = []
  private future: Edit[] = []

  /** Remember an edit that has been applied. */
  push(edit: Edit) {
    this.past.push(edit)
    if (this.past.length > MAX) this.past.shift()
    this.future = []
  }
  get canUndo() {
    return this.past.length > 0
  }
  get canRedo() {
    return this.future.length > 0
  }
  undo(current: DatasetData): DatasetData | undefined {
    const e = this.past.pop()
    if (!e) return undefined
    this.future.push(e)
    return e.kind === 'cells' ? setCells(current, e.before) : e.before
  }
  redo(current: DatasetData): DatasetData | undefined {
    const e = this.future.pop()
    if (!e) return undefined
    this.past.push(e)
    return e.kind === 'cells' ? setCells(current, e.after) : e.after
  }
  clear() {
    this.past = []
    this.future = []
  }
}

/** The patches that turn `before`'s cells into `after`'s, over the rows `after` replaced — for an edit made with `setCells`. */
export function cellDiff(before: DatasetData, after: DatasetData): { before: CellPatch[]; after: CellPatch[] } {
  const b: CellPatch[] = []
  const a: CellPatch[] = []
  const n = Math.min(before.rows.length, after.rows.length)
  for (let r = 0; r < n; r++) {
    const rb = before.rows[r]
    const ra = after.rows[r]
    if (rb === ra) continue
    for (let c = 0; c < ra.length; c++) {
      if (rb[c] !== ra[c]) {
        b.push({ r, c, value: rb[c] })
        a.push({ r, c, value: ra[c] })
      }
    }
  }
  return { before: b, after: a }
}
