import { useEffect } from 'react'
import { useViewActive } from '../workstation/paneContext'

/**
 * What the tables on screen are showing — so the assistant can answer "these
 * rows" or "this table". A table reports itself while it is visible (a view
 * behind another tab sits out) and withdraws when it unmounts; the app
 * context collects whatever is registered. Page-global like the explorer
 * handles: the tables live in pane hosts, the assistant outside them.
 */
export interface TableOnScreen {
  /** Where the table is: `entities`, `tags`, `types`, `graph-nodes`, … */
  view: string
  /** How it is narrowed, in words: the category and type, the search, a pick. */
  showing: string
  /** Rows after the filters. */
  rows: number
  /** Selected row ids, newest last. */
  selected: string[]
}

const tables = new Map<string, TableOnScreen>()

export function reportTable(key: string, info: TableOnScreen | null) {
  if (info) tables.set(key, info)
  else tables.delete(key)
}

export const tablesOnScreen = (): TableOnScreen[] => [...tables.values()]

/** Keep a table registered while the calling view is on screen. */
export function useReportTable(key: string, info: TableOnScreen) {
  const active = useViewActive()
  const dep = JSON.stringify(info)
  useEffect(() => {
    reportTable(key, active ? info : null)
    return () => reportTable(key, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, dep])
}
