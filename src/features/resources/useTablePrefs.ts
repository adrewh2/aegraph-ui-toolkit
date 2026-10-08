import { useEffect, useMemo, useState } from 'react'
import type { FieldDef } from '../../core/entity/schema'

/**
 * What a table remembers between visits, per storage key: which columns
 * are shown and how wide they are. A different table (another key or
 * field set) adopts its own saved choice during render — so it paints
 * once, with the right columns — and tells the caller to drop the view
 * state (filters, sort, page) that belonged to the previous one.
 */
export function useTablePrefs(storageKey: string | undefined, fields: FieldDef[], onTableChange: () => void) {
  const [visible, setVisible] = useState<Set<string>>(() => loadVisible(storageKey, fields))
  const [widths, setWidths] = useState<Record<string, number>>(() => loadPref(storageKey, 'widths', {}))
  // Column order as the user dragged it; fields not in it keep their definition order after the ones that are.
  const [order, setOrder] = useState<string[]>(() => loadPref(storageKey, 'order', []))
  const tableKey = `${storageKey}|${fields.map((f) => f.key).join('|')}`
  const [seenTable, setSeenTable] = useState(tableKey)
  if (seenTable !== tableKey) {
    setSeenTable(tableKey)
    setVisible(loadVisible(storageKey, fields))
    setWidths(loadPref(storageKey, 'widths', {}))
    setOrder(loadPref(storageKey, 'order', []))
    onTableChange()
  }
  useEffect(() => {
    // Remember which fields the choice was made over, so a field defined later shows up instead of counting as hidden.
    if (seenTable === tableKey) savePref(storageKey, 'visible', { visible: [...visible], known: fields.map((f) => f.key) })
  }, [visible, storageKey, seenTable, tableKey, fields])
  useEffect(() => {
    if (seenTable === tableKey) savePref(storageKey, 'widths', widths)
  }, [widths, storageKey, seenTable, tableKey])
  useEffect(() => {
    if (seenTable === tableKey) savePref(storageKey, 'order', order)
  }, [order, storageKey, seenTable, tableKey])
  // The first field is the row's identity (label / type / tag); it stays even if a saved preference hid it.
  const ordered = useMemo(() => orderFields(fields, order), [fields, order])
  const columns = useMemo(() => ordered.filter((f) => f === fields[0] || visible.has(f.key)), [ordered, fields, visible])
  /** Move column `key` to sit before `beforeKey` (or to the end when omitted), among the visible columns. */
  const moveColumn = (key: string, beforeKey?: string) => {
    if (key === beforeKey) return
    const keys = ordered.map((f) => f.key).filter((k) => k !== key)
    const at = beforeKey ? keys.indexOf(beforeKey) : -1
    if (at < 0) keys.push(key)
    else keys.splice(at, 0, key)
    setOrder(keys)
  }
  return { visible, setVisible, widths, setWidths, columns, moveColumn }
}

export function defaultVisible(fields: FieldDef[]): Set<string> {
  return new Set(fields.filter((f) => !f.hidden).map((f) => f.key))
}

/** The saved column choice, plus any field the choice never saw (a property defined since), shown by default. */
function loadVisible(storageKey: string | undefined, fields: FieldDef[]): Set<string> {
  const saved = loadPref<string[] | { visible: string[]; known?: string[] } | null>(storageKey, 'visible', null)
  if (!saved) return defaultVisible(fields)
  const visible = new Set(Array.isArray(saved) ? saved : saved.visible)
  const known = new Set(Array.isArray(saved) ? saved : (saved.known ?? saved.visible))
  for (const f of fields) if (!known.has(f.key) && !f.hidden) visible.add(f.key)
  return visible
}

function loadPref<T>(storageKey: string | undefined, name: string, fallback: T): T {
  if (!storageKey) return fallback
  try {
    const raw = localStorage.getItem(`aegraph:table:${storageKey}:${name}`)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return (fallback instanceof Set ? new Set(parsed) : parsed) as T
  } catch {
    return fallback
  }
}

function savePref(storageKey: string | undefined, name: string, value: unknown) {
  if (!storageKey) return
  try {
    localStorage.setItem(`aegraph:table:${storageKey}:${name}`, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

/** Fields in saved order, then any the order doesn't know, in definition order. */
export function orderFields(fields: FieldDef[], order: string[]): FieldDef[] {
  if (!order.length) return fields
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const out: FieldDef[] = []
  for (const k of order) {
    const f = byKey.get(k)
    if (f) {
      out.push(f)
      byKey.delete(k)
    }
  }
  return [...out, ...fields.filter((f) => byKey.has(f.key))]
}
