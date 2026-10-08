import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { readPick } from '../../app/openIn'
import type { TypeCategory } from '../../core/entity/categories'
import type { EntityId } from '../../core/entity/types'
import { ENTITY_CATEGORIES, sectionFromParam, type Section } from '../entities/CategoryRail'

export type BrowseCategory = TypeCategory | 'all'

/**
 * The browser's state that lives in the URL: which section and type are
 * in view, the tag and text filters, a handed-over pick or selection, and
 * the inspector tab. Everything here is derived from the route; changing
 * it goes back through `setParam`/`goType`, so the address bar is the
 * single source of truth and links into the page just work.
 */
export function useBrowserUrl({ layout, basePath, categorySwitch, category: categoryProp, view: viewProp }: { layout: 'tabs' | 'facets'; basePath: string; categorySwitch?: boolean; category: BrowseCategory; view: 'entities' | 'relationships' }) {
  const navigate = useNavigate()
  const { tab: tabParam } = useParams()
  const [params, setParams] = useSearchParams()

  // With the switch, the section comes from the URL; otherwise it's fixed by the caller.
  const section: Section | undefined = categorySwitch ? sectionFromParam(params.get('category')) : undefined
  const view: 'entities' | 'relationships' = section === 'relationships' ? 'relationships' : viewProp
  const category: BrowseCategory = section ? (section === 'all' || section === 'relationships' || section === 'types' || section === 'tags' ? 'all' : section) : categoryProp
  const categoriesInView: TypeCategory[] = useMemo(() => (category === 'all' ? ENTITY_CATEGORIES : [category]), [category])
  // Tabs mode reads the type from the path; facets mode from ?type=.
  const selectedType = layout === 'tabs' && view === 'entities' ? (tabParam && tabParam !== 'all' ? tabParam : undefined) : (params.get('type') ?? undefined)
  const tagFilter = params.get('tag') ?? undefined
  const search = params.get('q') ?? ''
  // A hand-off from a plot or another view: `?pick=<key>` names a set of ids kept in sessionStorage.
  const pickKey = params.get('pick') ?? undefined
  const pick = useMemo(() => (pickKey ? readPick(pickKey) : undefined), [pickKey])
  const pickSet = useMemo(() => (pick ? new Set<EntityId>(pick.ids) : undefined), [pick])
  /** One id or a comma-separated list (a selection handed over from another list). */
  const selectedParam = params.get('sel')
  const inspectorTab = params.get('tab') ?? undefined
  /** `?rail=0`: just the table — no category rail, no title block. For a table hosted beside something else (a map). */
  const bare = params.get('rail') === '0'

  /** Set (or clear) one query param; a filter change drops the selection and inspector tab. */
  const setParam = (key: string, value?: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('sel')
    next.delete('tab')
    setParams(next, { replace: true })
  }

  /** Drop every filter and hand-off at once. */
  const clearFilters = () => {
    const next = new URLSearchParams(params)
    for (const k of ['pick', 'tag', 'q', 'sel', 'tab']) next.delete(k)
    setParams(next, { replace: true })
  }

  /** Move between sections of the Entities page, keeping the pick, search and tag — the section narrows the same set. */
  const goSection = (s: Section) => {
    const next = new URLSearchParams(params)
    for (const k of ['type', 'sel', 'tab']) next.delete(k)
    if (s === 'all') next.delete('category')
    else next.set('category', s)
    navigate({ pathname: '/entities', search: next.toString() ? `?${next}` : '' }, { replace: true })
  }

  /** Move to a type (or all of them) — a path in tabs mode, a param in facets mode. */
  const goType = (t?: string) => {
    if (layout === 'tabs') navigate(t ? `${basePath}/${t}` : basePath)
    else setParam('type', t)
  }

  return { section, view, category, categoriesInView, selectedType, tagFilter, search, pickKey, pick, pickSet, selectedParam, inspectorTab, bare, setParam, clearFilters, goSection, goType }
}
