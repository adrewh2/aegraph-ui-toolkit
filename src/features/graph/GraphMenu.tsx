import { Crosshair, Download, ExternalLink, EyeOff, Focus, GitFork, Pin, PinOff, Route, Tag, Users, Waypoints, X } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { Menu, Popover, type MenuItem } from '../../components/ui/Menu'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { isRelationship, type EntityId } from '../../core/entity/types'
import { communityMembers, communityOf } from '../knowledge/claims'
import { requestNameCommunity } from '../knowledge/nameCommunity'
import { useEntityMenu } from '../resources/entityMenu'
import { useExplorer } from './explorerState'
import { useSelectionActions } from './useSelectionActions'
import { Select } from '../../components/ui/Select'

/**
 * The right-click menu of every graph renderer — sigma 2D, force-graph 3D and
 * the GPU view — over a node, an edge or the stage. One place, so the three
 * views offer the same things and everything that can be done to a node or a
 * relationship is a right-click away: open, select, the neighbourhood, paths,
 * linked entities, tables, tags, pins, hiding, export, delete. The menu owns
 * the two dialogs its items need (tags, delete), so a renderer only says
 * where the menu was asked for and on what.
 */
export interface GraphMenuTarget {
  x: number
  y: number
  node?: EntityId
  edge?: EntityId
}

export interface GraphMenuProps {
  menu: GraphMenuTarget | null
  onClose: () => void
  /** Bring the whole picture into view (the stage menu's first item). */
  fit: () => void
  /** The node's neighbours as this renderer knows them; the slice's edges are walked when absent. */
  neighborsOf?: (id: EntityId) => EntityId[]
}

export function GraphMenu({ menu, onClose, fit, neighborsOf }: GraphMenuProps) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const { state, dispatch, slice } = useExplorer()
  const actions = useSelectionActions()
  const [deleting, setDeleting] = useState<{ ids: EntityId[]; what: 'node' | 'relationship' } | null>(null)
  const entityMenu = useEntityMenu()
  const [tagging, setTagging] = useState<{ ids: EntityId[]; anchor: DOMRect } | null>(null)
  const [tagText, setTagText] = useState('')
  const [tagMode, setTagMode] = useState<'add' | 'remove'>('add')

  const neighbours = (id: EntityId): EntityId[] => {
    if (neighborsOf) return neighborsOf(id)
    const out = new Set<EntityId>()
    for (const e of slice.edges) {
      if (e.source.id === id) out.add(e.target.id)
      else if (e.target.id === id) out.add(e.source.id)
    }
    return [...out]
  }
  const labelOf = (id: EntityId) => {
    const e = store.get(id)
    return e ? displayLabel(e) : id
  }

  const items = (): MenuItem[] => {
    if (!menu) return []
    const sel = state.selectedIds
    if (menu.node) {
      const id = menu.node
      const inSel = sel.includes(id)
      // On a node inside the selection the menu acts on the whole selection; on any other node, on that node.
      const targets = inSel && sel.length > 1 ? sel : [id]
      const n = targets.length
      const many = n > 1 ? ` (${n})` : ''
      const pinnedAll = targets.every((t) => state.pinned.includes(t))
      const linked = actions.linkedMissing(targets)
      const metrics = state.metrics
      const community = metrics ? communityOf(metrics, id) : undefined
      const node = store.get(id)
      // The graph's own actions lead; then the menu every entity has (rename, edit, annotate, related, projects, copy,
      // delete — `entityMenu.tsx`), the delete going through the graph's own confirmation.
      const lead: MenuItem[] = [
        { kind: 'label', label: n > 1 ? `${n} selected` : `${node ? registry.get(node.type).label + ' · ' : ''}${labelOf(id).slice(0, 40)}` },
        { kind: 'item', label: 'Open', icon: ExternalLink, onSelect: () => actions.open(id) },
        ...(inSel ? [] : [{ kind: 'item' as const, label: sel.length ? 'Add to selection' : 'Select', onSelect: () => dispatch({ type: 'select', ids: [id], mode: sel.length ? 'add' : 'replace' }) }]),
        { kind: 'item', label: 'Select neighbours', icon: Waypoints, shortcut: 'N', onSelect: () => dispatch({ type: 'select', ids: [id, ...neighbours(id)], mode: inSel ? 'add' : 'replace' }) },
        { kind: 'item', label: `Focus on neighbourhood${many}`, icon: Focus, onSelect: () => actions.focus(targets) },
        { kind: 'item', label: 'Path from here', icon: Route, onSelect: () => (dispatch({ type: 'setTool', tool: 'path' }), dispatch({ type: 'setPathFrom', id })) },
        { kind: 'sep' },
        // Linked entities the filter leaves out come into the view (the filter's Added list); the new graph is a fresh tab of just these.
        { kind: 'item', label: linked.length ? `Add ${linked.length} linked entit${linked.length === 1 ? 'y' : 'ies'}` : 'All linked entities in view', icon: Waypoints, disabled: !linked.length, onSelect: () => actions.addLinked(targets) },
        { kind: 'item', label: `Open in new graph${many}`, icon: GitFork, onSelect: () => actions.openInNewGraph(targets) },
        // With communities computed, the node's community can become an entity its members belong to.
        ...(community !== undefined && metrics ? [{ kind: 'item' as const, label: 'Name this community…', icon: Users, onSelect: () => requestNameCommunity({ community, metricsKey: metrics.sliceKey, members: communityMembers(metrics, community) }) }] : []),
        { kind: 'sep' },
        { kind: 'item', label: `${pinnedAll ? 'Unpin' : 'Pin'}${many}`, icon: pinnedAll ? PinOff : Pin, shortcut: 'P', onSelect: () => actions.pin(targets, !pinnedAll) },
        { kind: 'item', label: `Tag${many}…`, icon: Tag, onSelect: () => (setTagMode('add'), setTagText(''), setTagging({ ids: targets, anchor: new DOMRect(menu.x, menu.y, 1, 1) })) },
        { kind: 'item', label: `Hide${many}`, icon: EyeOff, shortcut: 'H', onSelect: () => actions.hide(targets) },
        { kind: 'item', label: `Download as .ae.json${many}`, icon: Download, onSelect: () => actions.exportJson(targets) },
      ]
      return node ? entityMenu.items(node, { lead, selected: sel, onDelete: (ids) => setDeleting({ ids, what: 'node' }) }) : lead
    }
    if (menu.edge) {
      const edge = menu.edge
      const e = store.get(edge)
      const rel = e && isRelationship(e) ? e : undefined
      const ends = rel ? [rel.source.id, rel.target.id] : undefined
      const lead: MenuItem[] = [
        { kind: 'label', label: rel ? `${rel.type} · ${labelOf(rel.source.id).slice(0, 20)} ${rel.directed ? '→' : '—'} ${labelOf(rel.target.id).slice(0, 20)}` : 'Relationship' },
        { kind: 'item', label: 'Open relationship', icon: ExternalLink, onSelect: () => actions.open(edge) },
        ...(state.selectedEdgeId === edge ? [] : [{ kind: 'item' as const, label: 'Select edge', onSelect: () => dispatch({ type: 'selectEdge', id: edge }) }]),
        ...(ends ? [{ kind: 'item' as const, label: 'Select both ends', icon: Waypoints, onSelect: () => dispatch({ type: 'select', ids: ends, mode: 'replace' }) }] : []),
        ...(ends ? [{ kind: 'item' as const, label: 'Open ends in new graph', icon: GitFork, onSelect: () => actions.openInNewGraph(ends) }] : []),
      ]
      // The link's menu is an entity's like any other (its related table is the link with its ends).
      return e ? entityMenu.items(e, { lead, onDelete: (ids) => setDeleting({ ids, what: 'relationship' }) }) : lead
    }
    return [
      { kind: 'item', label: 'Fit to view', icon: Crosshair, shortcut: 'F', onSelect: fit },
      { kind: 'sep' },
      ...(state.path
        ? [
            { kind: 'item' as const, label: `Select the path (${state.path.length} hop${state.path.length === 1 ? '' : 's'})`, icon: Route, onSelect: actions.addPathToSelection },
            { kind: 'item' as const, label: 'Clear the path', icon: X, onSelect: () => dispatch({ type: 'setPath', path: undefined }) },
            { kind: 'sep' as const },
          ]
        : state.pathFrom
          ? [{ kind: 'item' as const, label: `Cancel the path from ${labelOf(state.pathFrom).slice(0, 30)}`, icon: X, onSelect: () => dispatch({ type: 'setPathFrom', id: undefined }) }, { kind: 'sep' as const }]
          : []),
      { kind: 'item', label: 'Select all', shortcut: '⌘A', onSelect: actions.selectAll },
      { kind: 'item', label: 'Invert selection', shortcut: 'I', disabled: !sel.length, onSelect: actions.invert },
      { kind: 'item', label: 'Clear selection', shortcut: 'Esc', disabled: !sel.length && !state.selectedEdgeId, onSelect: actions.clear },
      { kind: 'sep' },
      { kind: 'item', label: 'Unhide everything', disabled: !state.filter.exclude?.length, onSelect: () => actions.unhide() },
    ]
  }

  const commitTags = () => {
    if (!tagging) return
    const tags = tagText.split(/[,\s]+/).filter(Boolean)
    if (tags.length) actions.tag(tagging.ids, tags, tagMode === 'add')
    setTagging(null)
    setTagText('')
  }

  return (
    <>
      {menu && <Menu x={menu.x} y={menu.y} items={items()} onClose={onClose} />}
      {entityMenu.dialogs}
      {tagging && (
        <Popover anchor={tagging.anchor} onClose={() => setTagging(null)} width={260}>
          <div className="field" style={{ padding: 8 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Select className="gx-select" value={tagMode} onChange={(e) => setTagMode(e.target.value as 'add' | 'remove')}>
                <option value="add">Add tags</option>
                <option value="remove">Remove tags</option>
              </Select>
              <span className="faint">
                {tagging.ids.length} node{tagging.ids.length === 1 ? '' : 's'}
              </span>
            </label>
            <input className="input" autoFocus placeholder="tag, another-tag" value={tagText} onChange={(e) => setTagText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && commitTags()} style={{ marginTop: 6, width: '100%' }} />
            <div className="gx-actions" style={{ marginTop: 6 }}>
              <button className="btn btn--sm btn--primary" onClick={commitTags} disabled={!tagText.trim()}>
                Apply
              </button>
            </div>
          </div>
        </Popover>
      )}
      <DeleteDialog target={deleting} onDone={() => setDeleting(null)} />
    </>
  )
}

/** "Delete N nodes?" / "Delete this relationship?" — the one confirmation every deletion from a graph view goes through (menu or ⌫). */
export function DeleteDialog({ target, onDone }: { target: { ids: EntityId[]; what: 'node' | 'relationship' } | null; onDone: () => void }) {
  const store = useEntityStore()
  const { dispatch } = useExplorer()
  const actions = useSelectionActions()
  const n = target?.ids.length ?? 0
  return (
    <ConfirmDialog
      open={!!target}
      title={target?.what === 'relationship' ? 'Delete this relationship?' : `Delete ${n} node${n === 1 ? '' : 's'}?`}
      message={target?.what === 'relationship' ? 'The entities at either end stay. This cannot be undone.' : 'Attached relationships are removed too. This cannot be undone.'}
      confirmLabel="Delete"
      danger
      onConfirm={() => {
        if (target?.what === 'relationship') {
          store.remove(target.ids)
          dispatch({ type: 'selectEdge', id: undefined })
        } else if (target) actions.remove(target.ids)
        onDone()
      }}
      onCancel={onDone}
    />
  )
}
