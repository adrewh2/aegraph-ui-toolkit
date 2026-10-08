import { Maximize2, Minimize2, Minus, Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import { isRelationship, type AnyEntity, type EntityId } from '../../core/entity/types'
import { Inspector } from './Inspector'
import '../workstation/workstation.css'
import './DetailPane.css'

/**
 * A detail pane with tabs, the way a workstation pane has them: the first
 * tab follows the page's selection (a node clicked in the graph), and any
 * entity opened from inside a detail view — a conversation from the
 * relationships table, say — opens as another tab instead of leaving the
 * page. “+” finds any entity in the workspace and opens it here too. Each
 * tab is the standard detail view with the entity's app widget.
 */

/** The pane's tabs: the ids pinned open, and which one is in front (`selection` = the page's selection, `lead` = the page's own first tab). */
export interface DetailTabs {
  pinned: EntityId[]
  active: 'lead' | 'selection' | EntityId
}

export function useDetailTabs(): { tabs: DetailTabs; open: (id: EntityId) => void; close: (id: EntityId) => void; activate: (id: 'selection' | EntityId) => void; clear: () => void } {
  const [tabs, setTabs] = useState<DetailTabs>({ pinned: [], active: 'selection' })
  return {
    tabs,
    open: (id) => setTabs((t) => ({ pinned: t.pinned.includes(id) ? t.pinned : [...t.pinned, id], active: id })),
    close: (id) =>
      setTabs((t) => {
        const pinned = t.pinned.filter((x) => x !== id)
        const active = t.active === id ? (pinned[pinned.length - 1] ?? 'selection') : t.active
        return { pinned, active }
      }),
    activate: (id) => setTabs((t) => ({ ...t, active: id })),
    clear: () => setTabs({ pinned: [], active: 'selection' }),
  }
}

export interface DetailPaneProps {
  /** The page's selection: the first tab. Null when nothing is selected — the pane then shows its pinned tabs only. */
  selectedId: EntityId | null
  tabs: DetailTabs
  onTabs: (next: DetailTabs) => void
  /** Something inside a detail view was opened. Return true to handle it on the page (it is a node in view); otherwise it opens as a tab. */
  onOpenOnPage?: (id: EntityId) => boolean
  onDelete?: (ids: EntityId[]) => void
  /** The selection tab was closed: clear the page's selection. The pane itself goes when it has no tabs left. */
  onDeselect: () => void
  /** Fold the pane to a strip (the page keeps its tabs). */
  onMinimize?: () => void
  /** Give the pane the whole width, or hand it back. */
  onMaximize?: () => void
  maximized?: boolean
  /** A tab was clicked: the page may go to the entity (the graph pans to its node) — the tabs double as bookmarks. */
  onActivate?: (id: EntityId) => void
  /** Extra controls at the right end of the tab bar. */
  extra?: ReactNode
  /** Tabs that are always there, first — the page's own tables of what it shows (nodes, edges) — so the pane never has nothing to hold. `active` names one as `lead:<key>` (`lead` = the first). */
  leads?: { key: string; title: string; icon?: ReactNode; render: () => ReactNode }[]
  /** Closable tabs of the page's own making — a table of one type, of one tag — after the leads. `active` names one as `view:<key>`. */
  views?: { key: string; title: string; icon?: ReactNode; render: () => ReactNode; onClose: () => void }[]
}

export function DetailPane({ selectedId, tabs, onTabs, onOpenOnPage, onDelete, onDeselect, onMinimize, onMaximize, maximized = false, onActivate, extra, leads, views }: DetailPaneProps) {
  const store = useEntityStore()
  useStoreVersion(store)
  const registry = useTypeRegistry()
  const [adding, setAdding] = useState(false)
  // The tab in front is kept in view: a tab opened at the end of a full strip would otherwise sit out of sight.
  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('.ws-tab.is-active')
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [tabs.active, selectedId, tabs.pinned.length])
  // A pinned tab that is also the selection shows once, as the selection.
  const pinned = tabs.pinned.filter((id) => id !== selectedId && store.has(id))
  // A lead tab is in front when asked for, or the first one when nothing else is there to show.
  const isLeadKey = (a: string) => a === 'lead' || a.startsWith('lead:')
  const askedLead = leads?.length ? (tabs.active === 'lead' ? leads[0] : leads.find((l) => `lead:${l.key}` === tabs.active)) : undefined
  const view = views?.length && tabs.active.startsWith('view:') ? views.find((v) => `view:${v.key}` === tabs.active) : undefined
  const lead = view ? undefined : askedLead ?? (leads?.length && ((tabs.active === 'selection' && !selectedId && !pinned.length) || (!isLeadKey(tabs.active) && tabs.active !== 'selection' && !store.has(tabs.active) && !selectedId && !pinned.length)) ? leads[0] : undefined)
  const leadActive = !!lead || !!view
  const activeId = leadActive ? null : tabs.active === 'selection' || isLeadKey(tabs.active) ? selectedId : store.has(tabs.active) ? tabs.active : (selectedId ?? pinned[0] ?? null)
  const open = (id: EntityId) => {
    if (onOpenOnPage?.(id)) {
      onTabs({ ...tabs, active: 'selection' })
      return
    }
    onTabs({ pinned: tabs.pinned.includes(id) ? tabs.pinned : [...tabs.pinned, id], active: id })
  }
  const close = (id: EntityId) => {
    const rest = tabs.pinned.filter((x) => x !== id)
    onTabs({ pinned: rest, active: tabs.active === id ? (selectedId ? 'selection' : (rest[rest.length - 1] ?? 'selection')) : tabs.active })
  }
  // The detail view's own close button closes the tab in front: a pinned one, or the selection.
  const closeActive = () => {
    if (activeId && activeId !== selectedId && tabs.pinned.includes(activeId)) close(activeId)
    else onDeselect()
  }
  const dotOf = (e: AnyEntity) => registry.colorOf(e.type)
  // A relationship without a name reads as "source → target", not as its id.
  const nameOf = (e: AnyEntity) => {
    if (!isRelationship(e) || e.label) return displayLabel(e)
    const end = (id: EntityId) => {
      const x = store.get(id)
      return x ? displayLabel(x) : id
    }
    return `${end(e.source.id)} ${e.directed ? '→' : '—'} ${end(e.target.id)}`
  }
  const tab = (id: EntityId, isSelection: boolean) => {
    const e = store.get(id)
    if (!e) return null
    const isActive = !leadActive && (isSelection ? tabs.active === 'selection' || tabs.active === id || isLeadKey(tabs.active) || !store.has(tabs.active) : tabs.active === id)
    // The same element and classes as a workstation tab, so the strip reads as one thing across the app; the type's colour stands in for the view icon.
    return (
      <div key={isSelection ? 'selection' : id} role="tab" aria-selected={isActive} className={`ws-tab dp-tab ${isActive ? 'is-active' : ''}`} title={isSelection ? `Selected: ${nameOf(e)}` : nameOf(e)} onClick={() => (onTabs({ ...tabs, active: isSelection ? 'selection' : id }), onActivate?.(id))}>
        <span className="dp-tab__dot" style={{ background: dotOf(e) }} />
        <span className="ws-tab__label">{nameOf(e)}</span>
        <button className="ws-tab__x" aria-label={isSelection ? 'Clear the selection' : 'Close tab'} title={isSelection ? 'Clear the selection' : 'Close tab'} onClick={(ev) => (ev.stopPropagation(), isSelection ? onDeselect() : close(id))}>
          <X size={13} />
        </button>
      </div>
    )
  }

  return (
    <div className="dp-pane">
      <div className="ws-tabbar">
        <div className="ws-tabs" ref={stripRef}>
          {leads?.map((l) => (
            <div key={l.key} role="tab" aria-selected={lead === l} className={`ws-tab dp-tab dp-tab--lead ${lead === l ? 'is-active' : ''}`} title={l.title} onClick={() => onTabs({ ...tabs, active: `lead:${l.key}` })}>
              {l.icon}
              <span className="ws-tab__label">{l.title}</span>
            </div>
          ))}
          {views?.map((v) => (
            <div key={v.key} role="tab" aria-selected={view === v} className={`ws-tab dp-tab dp-tab--lead ${view === v ? 'is-active' : ''}`} title={v.title} onClick={() => onTabs({ ...tabs, active: `view:${v.key}` })}>
              {v.icon}
              <span className="ws-tab__label">{v.title}</span>
              <button className="ws-tab__x" aria-label="Close tab" title="Close tab" onClick={(ev) => (ev.stopPropagation(), v.onClose())}>
                <X size={13} />
              </button>
            </div>
          ))}
          {selectedId && tab(selectedId, true)}
          {pinned.map((id) => tab(id, false))}
        </div>
        <button className={`ws-tabs__add ${adding ? 'is-active' : ''}`} title={adding ? 'Cancel' : 'Open any entity here'} onClick={() => setAdding((v) => !v)}>
          <Plus size={13} />
        </button>
        <span className="spacer" />
        {extra}
        {onMaximize && (
          <button className="ws-tabs__btn" title={maximized ? 'Restore the panel' : 'Maximize the panel'} aria-label={maximized ? 'Restore the panel' : 'Maximize the panel'} aria-pressed={maximized} onClick={onMaximize}>
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        )}
        {onMinimize && (
          <button className="ws-tabs__btn" title="Minimize the panel" aria-label="Minimize the panel" onClick={onMinimize}>
            <Minus size={13} />
          </button>
        )}
      </div>
      {adding && (
        <EntityFinder
          onPick={(id) => {
            setAdding(false)
            open(id)
          }}
          onClose={() => setAdding(false)}
        />
      )}
      <div className="dp-pane__body">
        {view ? view.render() : lead ? lead.render() : activeId ? <Inspector key={activeId} entityId={activeId} app closable={false} onClose={closeActive} onOpen={open} onDelete={(ids) => onDelete?.(ids)} /> : <div className="dp-pane__empty muted">Select something, or open an entity with +.</div>}
      </div>
    </div>
  )
}

/** A quick search over the workspace, to open something here. */
function EntityFinder({ onPick, onClose }: { onPick: (id: EntityId) => void; onClose: () => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const [q, setQ] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const hits = useMemo(() => {
    const text = q.trim()
    if (!text) return []
    return store
      .query({ kind: 'entity', text })
      .filter((e) => !e.type.startsWith('schema:'))
      .slice(0, 12)
  }, [store, q])
  return (
    <div className="dp-finder">
      <label className="dp-finder__box">
        <Search size={13} className="faint" />
        <input
          ref={ref}
          placeholder="Find an entity to open here…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'Enter' && hits[0]) onPick(hits[0].id)
          }}
        />
        <button type="button" className="dp-finder__x" title="Cancel (Esc)" aria-label="Cancel" onClick={onClose}>
          <X size={13} />
        </button>
      </label>
      {hits.length > 0 && (
        <div className="dp-finder__hits">
          {hits.map((e) => (
            <button key={e.id} className="dp-finder__hit" onClick={() => onPick(e.id)}>
              <span className="res__facet-dot" style={{ background: registry.colorOf(e.type) }} />
              <span className="dp-finder__label">{displayLabel(e)}</span>
              <span className="muted">{registry.get(e.type).label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
