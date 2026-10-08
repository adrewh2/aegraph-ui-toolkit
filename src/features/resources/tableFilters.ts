import { getActiveProjectId } from '../../core/projects/active'

/**
 * What a table was filtered by — the search box, the column filters, the
 * sort — remembered per table (its `storageKey`) so coming back to a page
 * finds it as it was left, and saved under names to reuse later. Session
 * configuration: it lives in this browser, not in the workspace data.
 *
 * The last state is remembered per project as well as per table: a filter
 * is about the rows it was made over, and the types ticked in one project's
 * map table would hide everything in another's. Named presets stay per
 * table, to carry a way of looking between projects.
 */
export interface TableFilterState {
  quick: string
  filters: Record<string, string | string[]>
  sort: { key: string; dir: 'asc' | 'desc' } | null
}
export interface TableFilterPreset extends TableFilterState {
  name: string
  savedAt: string
}

const LAST = (key: string) => `aegraph:table:last:${getActiveProjectId() ?? 'library'}:${key}`
const PRESETS = (key: string) => `aegraph:table:presets:${key}`

const read = <T>(k: string): T | undefined => {
  try {
    const raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}
const write = (k: string, v: unknown) => {
  try {
    if (v === undefined) localStorage.removeItem(k)
    else localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

export const isEmptyFilter = (s: TableFilterState) => !s.quick.trim() && !s.sort && !Object.values(s.filters).some((v) => (Array.isArray(v) ? v.length : v.trim()))

/** The filter state the table was last left in (undefined when none, or when it was empty). */
export const readLastFilters = (key: string | undefined): TableFilterState | undefined => (key ? read<TableFilterState>(LAST(key)) : undefined)
export function writeLastFilters(key: string | undefined, s: TableFilterState) {
  if (!key) return
  write(LAST(key), isEmptyFilter(s) ? undefined : s)
}

export const readPresets = (key: string | undefined): TableFilterPreset[] => (key ? (read<TableFilterPreset[]>(PRESETS(key)) ?? []) : [])
export function savePreset(key: string, name: string, s: TableFilterState): TableFilterPreset[] {
  const next = [...readPresets(key).filter((p) => p.name !== name), { ...s, name, savedAt: new Date().toISOString() }].sort((a, b) => a.name.localeCompare(b.name))
  write(PRESETS(key), next)
  return next
}
export function deletePreset(key: string, name: string): TableFilterPreset[] {
  const next = readPresets(key).filter((p) => p.name !== name)
  write(PRESETS(key), next.length ? next : undefined)
  return next
}

/** One line a person can read: what the state filters by. */
export function describeFilters(s: TableFilterState, labelOf: (key: string) => string): string {
  const parts: string[] = []
  if (s.quick.trim()) parts.push(`“${s.quick.trim()}”`)
  for (const [k, v] of Object.entries(s.filters)) {
    if (Array.isArray(v) ? !v.length : !v.trim()) continue
    parts.push(`${labelOf(k)}: ${Array.isArray(v) ? v.join(', ') : v}`)
  }
  if (s.sort) parts.push(`sorted by ${labelOf(s.sort.key)} ${s.sort.dir === 'asc' ? '↑' : '↓'}`)
  return parts.join(' · ') || 'no filters'
}
