import type { ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CATEGORIES, type TypeCategory } from '../../core/entity/categories'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'

/**
 * The sections of the Entities page, at the top of its rail: every entity
 * by category, then the relationships between them, the types they use and
 * the tags on them. One page, one URL (`/entities?category=…`); nothing
 * here is a separate route.
 */
export type Section = 'all' | TypeCategory | 'relationships' | 'types' | 'tags'

export const ENTITY_CATEGORIES: TypeCategory[] = ['resource', 'knowledge', 'project']
export const SECTION_IDS: Section[] = ['all', ...ENTITY_CATEGORIES, 'relationships', 'types', 'tags']

export function sectionFromParam(v: string | null): Section {
  if (v === 'graph') return 'project' // the section's old name, in bookmarks and saved tabs
  return v && (SECTION_IDS as string[]).includes(v) ? (v as Section) : 'all'
}

export const sectionHref = (s: Section) => (s === 'all' ? '/entities' : `/entities?category=${s}`)

export function CategoryRail({ current, typeSelected, onSection, counts, sections, banner }: { current: Section; typeSelected?: boolean; onSection?: (s: Section) => void; /** Counts within a narrowed set; rows then read "x of y". */ counts?: (s: Section) => number; /** Which rows to show (default: all of them). */ sections?: Section[]; /** Drawn above the rows (the filter banner). */ banner?: ReactNode }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const total = (s: Section) =>
    s === 'all' ? ENTITY_CATEGORIES.reduce((n, c) => n + registry.countInCategory(c), 0) + store.relationshipCount() : s === 'relationships' ? store.relationshipCount() : s === 'types' ? registry.all().length : s === 'tags' ? store.tags().length : registry.countInCategory(s)
  const label = (s: Section) => (s === 'all' ? 'All entities' : s === 'relationships' ? 'Relationships' : s === 'types' ? 'Types' : s === 'tags' ? 'Tags' : CATEGORIES[s].pluralLabel)
  const go = (s: Section) => {
    if (onSection) return onSection(s)
    // Keep the search/tag filters when moving between sections of the table; drop the type and selection.
    const next = new URLSearchParams(params)
    next.delete('type')
    next.delete('sel')
    next.delete('tab')
    if (s === 'all') next.delete('category')
    else next.set('category', s)
    navigate({ pathname: '/entities', search: next.toString() ? `?${next}` : '' }, { replace: true })
  }
  const row = (s: Section) => {
    const isCurrent = current === s
    const active = isCurrent && !typeSelected
    return (
      <button key={s} className={`res__facet res__cat ${isCurrent ? 'is-current' : ''} ${active ? 'is-active' : ''}`} onClick={() => go(s)} title={s === 'all' ? 'Every entity' : s in CATEGORIES ? CATEGORIES[s as TypeCategory].description : undefined}>
        <span className="res__facet-label">{label(s)}</span>
        <span className="count">{counts && counts(s) !== total(s) ? <><span className="count__of">{counts(s)} of</span> {total(s)}</> : total(s)}</span>
      </button>
    )
  }
  return (
    <div className="res__cats" role="tablist" aria-label="Section">
      {banner}
      {/* Subsets of the entity table: the data (resources, knowledge, the relationships between them), then the views built on it. */}
      {(['all', 'resource', 'knowledge', 'relationships', 'project'] as Section[]).filter((s) => !sections || sections.includes(s)).map(row)}
      {/* Different tables: the vocabulary and the labels. */}
      {(!sections || sections.includes('types') || sections.includes('tags')) && <div className="res__cats-sep" />}
      {(['types', 'tags'] as Section[]).filter((s) => !sections || sections.includes(s)).map(row)}
    </div>
  )
}
