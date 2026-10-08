import { BarChart3, BookOpen, Box, Command, CornerDownLeft, FolderOpen, Lightbulb, Maximize2, Mic, Play, Search, Sparkles, Table2, Tag as TagIcon } from 'lucide-react'
import { UnigraphIcon } from '../../components/icons/UnigraphIcon'
import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import { voice } from '../voice/voice'
import { isRelationship, type AnyEntity } from '../../core/entity/types'
import { listProjects } from '../../core/projects/project'
import { switchProject } from '../../core/projects/active'
import { useToast } from '../../components/ui/useToast'
import { useFocusTrap } from '../../components/ui/useFocusTrap'
import { entityHref, typeHref } from '../../app/routes'
import { getExplorerHandle } from '../graph/explorerHandle'
import { getLatestAnalysis } from '../analysis/latest'
import { searchDocs } from '../docs/lookup'
import { searchEntities, type Snippet } from './search'
import './CommandPalette.css'

/**
 * ⌘K: one box that finds anything and does anything. Entities by name, tag
 * or description; the text they carry (a document's body, a transcript, a
 * page) shown with the line that matched; tags, types, saved views
 * (filters, layouts, styles, scenes, plots, analyses, workstations),
 * projects, the latest Insights findings, the documentation, and the app's
 * own actions — each opening where it lives: a node selected in the Graph
 * Explorer when one is on screen and holds it, a row in Entities, a finding
 * on Insights, a document in its viewer. The full result set is one row
 * away: "all N in Entities" opens the table with the same query. Recent
 * choices come first while the box is empty. The sidebar's search box opens
 * this same palette, typed text carried over.
 */
interface Item {
  key: string
  group: 'Recent' | 'Actions' | 'Entities' | 'Content' | 'Tags' | 'Types' | 'Views' | 'Projects' | 'Findings' | 'Documentation' | 'More'
  label: string
  hint?: string
  /** For a text match: the line it matched on, the match marked. */
  snippet?: Snippet
  icon?: ComponentType<{ size?: number }>
  color?: string
  run: () => void
  /** ⌘↵: a second way to open it (an entity in the graph, say). */
  alt?: { label: string; run: () => void }
}

/** Opens the palette from elsewhere (the sidebar's search box), with text to start from. */
export const OPEN_EVENT = 'aegraph:search'
export function openSearch(query = '') {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { query } }))
}

/** The typed text a few keystrokes behind, so a large Library is searched once per pause rather than once per key. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

const RECENT_KEY = 'aegraph:palette:recent'
const readRecent = (): { key: string; label: string; group: Item['group']; href?: string }[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  // The keyboard stays in the palette while it is open, and goes back where it was when it closes; the input is
  // where it starts.
  useFocusTrap(boxRef, open)
  const store = useEntityStore()
  useStoreVersion(store)
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()

  // ⌘K opens (capture phase, so the sidebar's older ⌘K handler stays out of it); Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
  useEffect(() => {
    if (open) setCursor(0)
    else setQ('')
  }, [open])
  // The sidebar's search box (and anything else) opens the palette with text to start from.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const query = (e as CustomEvent<{ query?: string }>).detail?.query ?? ''
      setQ(query)
      setOpen(true)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.setSelectionRange(query.length, query.length)
      }, 0)
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])
  const debounced = useDebounced(q, 90)

  const go = (href: string) => {
    setOpen(false)
    navigate(href)
  }
  const remember = (it: Item, href?: string) => {
    try {
      const rest = readRecent().filter((r) => r.key !== it.key)
      localStorage.setItem(RECENT_KEY, JSON.stringify([{ key: it.key, label: it.label, group: it.group, href }, ...rest].slice(0, 8)))
    } catch {
      /* ignore */
    }
  }

  /** An entity opens where it lives; when Unigraph is on screen and draws it, it is selected there instead. */
  const openEntity = (e: AnyEntity) => {
    const h = getExplorerHandle()
    const onGraph = location.pathname.startsWith('/unigraph') && h && h.getSlice().nodes.some((n) => n.id === e.id)
    if (onGraph && h) {
      h.select(e.id)
      h.fitTo([e.id], { padding: 2 })
      setOpen(false)
      return
    }
    go(entityHref(e, registry))
  }

  const items = useMemo<Item[]>(() => {
    const text = debounced.trim().toLowerCase()
    const out: Item[] = []
    const has = (s: string | undefined) => !!s && s.toLowerCase().includes(text)
    const dot = (type: string) => registry.colorOf(type)

    // Actions: what the app can do from anywhere; the graph's own only while an explorer is on screen.
    const h = getExplorerHandle()
    const onGraph = location.pathname.startsWith('/unigraph') && !!h
    const actions: Item[] = [
      { key: 'go:entities', group: 'Actions', label: 'Open Entities', icon: Table2, run: () => go('/entities') },
      { key: 'go:unigraph', group: 'Actions', label: 'Open Unigraph', hint: 'the graph explorer', icon: UnigraphIcon, run: () => go('/unigraph/2d') },
      { key: 'go:unigraph3d', group: 'Actions', label: 'Open Unigraph in 3D', icon: Box, run: () => go('/unigraph/3d') },
      { key: 'go:insights', group: 'Actions', label: 'Open Insights', icon: Lightbulb, run: () => go('/insights') },
      { key: 'go:plot', group: 'Actions', label: 'New plot', hint: 'chart your entities', icon: BarChart3, run: () => go('/scenes?plot=new') },
      { key: 'go:ontology', group: 'Actions', label: 'Open Ontology', icon: Command, run: () => go('/ontology') },
      { key: 'go:workstation', group: 'Actions', label: 'Open Workstation', icon: Command, run: () => go('/workstation') },
      { key: 'go:datasets', group: 'Actions', label: 'Open Datasets', hint: 'import, demos, bundles', icon: FolderOpen, run: () => go('/datasets') },
      { key: 'assistant', group: 'Actions', label: 'Ask the assistant', hint: '⌘J', icon: Sparkles, run: () => (setOpen(false), window.dispatchEvent(new CustomEvent('aegraph:assistant', { detail: { open: true } }))) },
      { key: 'voice', group: 'Actions', label: voice.getState().enabled ? 'Turn voice off' : 'Talk to the assistant', hint: voice.getState().enabled ? '⌘⇧U' : 'voice control · ⌘⇧U', icon: Mic, run: () => (setOpen(false), voice.toggle()) },
      ...(onGraph && h
        ? [
            { key: 'gx:layout', group: 'Actions' as const, label: 'Run layout', hint: `${h.getState().algorithm} over the view`, icon: Play, run: () => (setOpen(false), void h.runLayout()) },
            { key: 'gx:fit', group: 'Actions' as const, label: 'Fit the graph', icon: Maximize2, run: () => (setOpen(false), h.fit()) },
            { key: 'gx:table', group: 'Actions' as const, label: 'Graph view as a table', icon: Table2, run: () => (setOpen(false), void import('../../app/openIn').then((m) => navigate(m.pickHref([...h.getSlice().nodes.map((n) => n.id), ...h.getSlice().edges.map((e) => e.id)], 'Graph view')))) },
            { key: 'gx:clear', group: 'Actions' as const, label: 'Clear the graph filter', run: () => (setOpen(false), h.clearFilter()) },
            { key: 'gx:legend', group: 'Actions' as const, label: 'Toggle the legend', run: () => (setOpen(false), h.setLegend(!h.getState().showLegend)) },
          ]
        : []),
    ]
    if (!text) {
      for (const r of readRecent()) {
        const e = store.get(r.key)
        if (e) out.push({ key: e.id, group: 'Recent', label: displayLabel(e), hint: registry.get(e.type).label, color: dot(e.type), run: () => openEntity(e) })
        else if (r.href) out.push({ key: r.key, group: 'Recent', label: r.label, hint: r.group.toLowerCase(), run: () => go(r.href!) })
      }
      out.push(...actions.slice(0, 6))
      return out
    }
    out.push(...actions.filter((a) => has(a.label) || has(a.hint)))

    // Entities: by name, tag or description — and by the text they carry, each with the line that matched.
    const found = searchEntities(store, registry, text, { limit: 8 })
    const entityItem = (h: (typeof found.entities)[number]): Item => {
      const e = h.entity
      const label = displayLabel(e)
      const isView = registry.categoryOf(e.type) === 'project'
      const kind = isRelationship(e) ? `${e.type} · relationship` : registry.get(e.type).label
      return {
        key: e.id,
        group: h.where === 'content' ? 'Content' : isView ? 'Views' : 'Entities',
        label,
        hint: h.where === 'content' ? `${kind} · in ${h.field}` : h.where === 'tag' ? `${kind} · tagged` : h.where === 'description' ? `${kind} · description` : kind,
        snippet: h.snippet,
        color: dot(e.type),
        run: () => (remember({ key: e.id, group: 'Entities', label } as Item), openEntity(e)),
        alt: isRelationship(e) || isView ? undefined : { label: 'Show in graph', run: () => go(`/unigraph/2d?sel=${encodeURIComponent(e.id)}`) },
      }
    }
    for (const h of found.entities) out.push(entityItem(h))
    for (const h of found.content) out.push(entityItem(h))
    const shown = found.entities.length + found.content.length
    if (found.total > shown || found.partial) {
      const href = `/entities?q=${encodeURIComponent(debounced.trim())}`
      out.push({ key: 'more:entities', group: 'More', label: found.partial ? `All matches in the Entities table (${found.total.toLocaleString()}+ so far — a big Library, refine the words or open the table)` : `All ${found.total.toLocaleString()} matches in the Entities table`, hint: 'filter, sort, select', icon: Table2, run: () => go(href) })
    }
    // Projects.
    for (const p of listProjects(store).filter((p) => has(displayLabel(p))).slice(0, 4)) {
      out.push({ key: `project:${p.id}`, group: 'Projects', label: displayLabel(p), hint: store.scope === p.id ? 'open now' : 'open this project', icon: FolderOpen, run: () => (setOpen(false), switchProject(store, p.id) ? toast(`Opened “${displayLabel(p)}”`) : toast('Could not open that project')) })
    }
    // Tags and types.
    for (const t of store.tags().filter((t) => t.toLowerCase().includes(text)).slice(0, 5)) {
      out.push({ key: `tag:${t}`, group: 'Tags', label: t, hint: `${store.tagUsage(t).toLocaleString()} tagged`, icon: TagIcon, color: store.getTagInfo(t).color, run: () => (remember({ key: `tag:${t}`, group: 'Tags', label: t } as Item, `/entities?tag=${encodeURIComponent(t)}`), go(`/entities?tag=${encodeURIComponent(t)}`)) })
    }
    for (const t of registry.all().filter((t) => t.kind !== 'relationship' && (has(t.label) || has(t.type))).slice(0, 5)) {
      const href = typeHref(t.type, t.category)
      out.push({ key: `type:${t.type}`, group: 'Types', label: t.pluralLabel ?? t.label, hint: `${t.count.toLocaleString()} entities`, color: dot(t.type), run: () => (remember({ key: `type:${t.type}`, group: 'Types', label: t.label } as Item, href), go(href)) })
    }
    // The latest Insights findings.
    const latest = getLatestAnalysis()
    if (latest) {
      const findings = latest.report.runs.flatMap((r) => r.findings).filter((f) => has(f.title) || has(f.detail))
      for (const f of findings.slice(0, 5)) {
        const href = `/insights?finding=${encodeURIComponent(f.id)}`
        out.push({ key: `finding:${f.id}`, group: 'Findings', label: f.title, hint: f.analysis, icon: Lightbulb, run: () => (remember({ key: `finding:${f.id}`, group: 'Findings', label: f.title } as Item, href), go(href)) })
      }
    }
    // The documentation: the sections that hold every word.
    for (const d of searchDocs(text, 3)) {
      const href = `/docs/${d.id}${d.section ? `#${d.section}` : ''}`
      out.push({ key: `docs:${d.id}#${d.section}`, group: 'Documentation', label: d.section ? `${d.title} › ${d.sectionTitle}` : d.title, hint: 'docs', icon: BookOpen, run: () => (remember({ key: `docs:${d.id}#${d.section}`, group: 'Documentation', label: d.title } as Item, href), go(href)) })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, store, registry, location.pathname, open])

  useEffect(() => setCursor(0), [debounced])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.cp__item.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])
  if (!open) return null

  const groups: Item['group'][] = ['Recent', 'Actions', 'Entities', 'Content', 'More', 'Views', 'Projects', 'Findings', 'Tags', 'Types', 'Documentation']
  const ordered = groups.flatMap((g) => items.filter((it) => it.group === g))
  const current = ordered[cursor]
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setCursor((c) => Math.min(ordered.length - 1, c + 1)))
    else if (e.key === 'ArrowUp') (e.preventDefault(), setCursor((c) => Math.max(0, c - 1)))
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (current) {
        if ((e.metaKey || e.ctrlKey) && current.alt) current.alt.run()
        else current.run()
      } else if (q.trim()) go(`/entities?q=${encodeURIComponent(q.trim())}`) // nothing listed (yet): the table searches the same words
    }
  }
  const counts = { entities: items.filter((it) => it.group === 'Entities').length, content: items.filter((it) => it.group === 'Content').length }
  const titleOf = (g: Item['group']) => (g === 'Content' ? 'In text' : g === 'More' ? '' : g === 'Entities' && counts.content ? 'By name' : g)

  return (
    <div className="cp" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="cp__box" ref={boxRef} role="dialog" aria-modal="true" aria-label="Search and commands" tabIndex={-1}>
        <div className="cp__input">
          <Search size={15} className="faint" aria-hidden />
          {/* A combobox over the results: the focus stays in the box, ↑ ↓ move the active result, which is announced
              through aria-activedescendant. */}
          <input
            ref={inputRef}
            data-autofocus
            value={q}
            placeholder="Search everything — names, tags, text inside documents, types, views, docs — or type an action"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            role="combobox"
            aria-label="Search everything, or type an action"
            aria-autocomplete="list"
            aria-expanded={ordered.length > 0}
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-${cursor}` : undefined}
          />
          <kbd aria-hidden>esc</kbd>
        </div>
        <div className="cp__list" ref={listRef} id={listId} role="listbox" aria-label="Results">
          {ordered.length === 0 && (
            <div className="cp__empty muted" role="status">
              {q.trim() && q !== debounced ? 'Searching…' : q.trim() ? 'Nothing matches — every word must occur; put a phrase in "quotes" to match it as written. ↵ opens the Entities table with these words.' : 'Nothing matches.'}
            </div>
          )}
          {groups.map((g) => {
            const rows = items.filter((it) => it.group === g)
            if (!rows.length) return null
            const title = titleOf(g)
            return (
              <div key={g} className="cp__group" role="group" aria-labelledby={title ? `${listId}-g-${g}` : undefined}>
                {title && (
                  <div className="cp__group-title" id={`${listId}-g-${g}`} role="presentation">
                    {title}
                  </div>
                )}
                {rows.map((it) => {
                  const i = ordered.indexOf(it)
                  const Icon = it.icon
                  return (
                    <div
                      key={it.key}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === cursor}
                      className={`cp__item ${it.snippet ? 'cp__item--snippet' : ''} ${i === cursor ? 'is-active' : ''}`}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => it.run()}
                    >
                      {Icon ? <Icon size={14} /> : <span className="cp__dot" style={{ background: it.color ?? 'var(--border-strong)' }} aria-hidden />}
                      <span className="cp__label">
                        {it.label}
                        {it.snippet && <SnippetLine s={it.snippet} />}
                      </span>
                      {it.hint && <span className="cp__hint">{it.hint}</span>}
                      {i === cursor && it.alt && (
                        <span className="cp__alt">
                          <kbd>⌘↵</kbd> {it.alt.label}
                        </span>
                      )}
                      {i === cursor && !it.alt && (
                        <span className="cp__alt">
                          <CornerDownLeft size={12} />
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** The line a text match sits on, the match marked. */
function SnippetLine({ s }: { s: Snippet }): ReactNode {
  return (
    <span className="cp__snippet">
      {s.before}
      <mark>{s.match}</mark>
      {s.after}
    </span>
  )
}
