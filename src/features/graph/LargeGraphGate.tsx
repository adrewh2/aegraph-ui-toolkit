import { Gauge } from 'lucide-react'
import { useMemo, useState } from 'react'
import { breakdown, drawCost, estimateEdges, estimateNodes, heapRoom, suggestTrim, type ViewBudget } from '../../core/graph/budget'
import { useTypeRegistry } from '../../core/entity/hooks'
import { DEFAULT_MAX_NODES } from '../../core/graph/filter'
import { hashColor } from '../../lib/format'
import { useExplorer } from './explorerState'

/**
 * Shown in place of the canvas when the filter would draw more than the view budget, or more than this tab's memory
 * can take (`memoryGates`): what the picture would hold, by node type and relationship type, with the heavy
 * relationship kinds already unticked as a suggestion that fits. Loading a selection is only a filter change (types,
 * relationship types, node cap) — nothing leaves the data. Past memory, showing everything takes a second click: it
 * is what closes the tab.
 */
export function LargeGraphGate() {
  const { state, dispatch, slice, load, gateReason, heap, drawBudget } = useExplorer()
  const registry = useTypeRegistry()
  const budget = drawBudget
  const memory = gateReason === 'memory'
  const [sure, setSure] = useState(false)
  const b = useMemo(() => breakdown(slice), [slice])
  const suggestion = useMemo(() => suggestTrim(b, budget), [b, budget])
  const [nodeTypes, setNodeTypes] = useState(() => suggestion.nodeTypes)
  const [relTypes, setRelTypes] = useState(() => suggestion.relTypes)
  // The default cap is the engine's in this view (`effectiveFilter`), so it is no limit worth starting from.
  const [cap, setCap] = useState(() => (state.filter.maxNodes === undefined || state.filter.maxNodes === DEFAULT_MAX_NODES ? suggestion.maxNodes : Math.min(state.filter.maxNodes, suggestion.maxNodes)))
  const [draft, setDraft] = useState<ViewBudget>(state.viewBudget)

  const estNodes = Math.min(cap, estimateNodes(b, nodeTypes))
  const estEdges = estimateEdges(b, nodeTypes, relTypes)
  const fits = memory && heap ? drawCost({ nodes: estNodes, edges: estEdges }) <= heapRoom(heap) : estNodes <= budget.nodes && estEdges <= budget.edges
  const toggle = (set: Set<string>, v: string, put: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    put(next)
  }
  /** A row: click toggles, double-click (or its “only” button) keeps just that kind — or, when it is already alone, brings every kind back. */
  const row = (kind: 'node' | 'rel', t: { type: string; count: number }) => {
    const set = kind === 'node' ? nodeTypes : relTypes
    const put = kind === 'node' ? setNodeTypes : setRelTypes
    const all = kind === 'node' ? b.nodeTypes : b.relTypes
    const on = set.has(t.type)
    const solo = set.size === 1 && on
    const only = () => put(solo ? new Set(all.map((x) => x.type)) : new Set([t.type]))
    return (
      <div
        key={t.type}
        className={`gx-check ${on ? '' : 'is-off'}`}
        role="checkbox"
        aria-checked={on}
        tabIndex={0}
        title="Click to toggle · double-click to keep only this kind"
        onClick={(e) => (e.detail >= 2 ? only() : toggle(set, t.type, put))}
        onKeyDown={(e) => {
          if (e.key !== ' ' && e.key !== 'Enter') return
          e.preventDefault()
          if (e.key === ' ') toggle(set, t.type, put)
          else only()
        }}
      >
        <input type="checkbox" checked={on} readOnly tabIndex={-1} aria-hidden />
        <span className={`gx-dot ${kind === 'rel' ? 'gx-dot--edge' : ''}`} style={{ background: kind === 'node' ? registry.colorOf(t.type) : hashColor(t.type) }} />
        <span className="gx-checklist__label">{registry.get(t.type).label}</span>
        <button type="button" className="gx-only" onClick={(e) => (e.stopPropagation(), only())}>
          {solo ? 'all' : 'only'}
        </button>
        <span className="count">{n(t.count)}</span>
      </div>
    )
  }
  /** All / none for a list, showing the one that would change something. */
  const bulk = (kind: 'node' | 'rel') => {
    const set = kind === 'node' ? nodeTypes : relTypes
    const put = kind === 'node' ? setNodeTypes : setRelTypes
    const all = kind === 'node' ? b.nodeTypes : b.relTypes
    return (
      <span className="gx-gate__bulk">
        <span className="faint">
          {set.size} of {all.length}
        </span>
        <button type="button" className="btn btn--sm btn--ghost" disabled={set.size === all.length} onClick={() => put(new Set(all.map((t) => t.type)))}>
          All
        </button>
        <button type="button" className="btn btn--sm btn--ghost" disabled={set.size === 0} onClick={() => put(new Set())}>
          None
        </button>
      </span>
    )
  }
  const apply = () => {
    const allNodes = nodeTypes.size === b.nodeTypes.length
    const allRels = relTypes.size === b.relTypes.length
    dispatch({
      type: 'patchFilter',
      patch: {
        // A type left unticked stays out even if the filter listed nothing before (nothing = everything).
        types: allNodes ? state.filter.types : b.nodeTypes.filter((t) => nodeTypes.has(t.type)).map((t) => t.type),
        relationshipTypes: allRels ? state.filter.relationshipTypes : b.relTypes.filter((t) => relTypes.has(t.type)).map((t) => t.type),
        maxNodes: cap,
      },
    })
    dispatch({ type: 'acceptLoad' })
  }
  const saveBudget = () => dispatch({ type: 'setViewBudget', budget: draft })
  const n = (x: number) => x.toLocaleString()
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`
  const everything = () => {
    if (memory && !sure) return setSure(true)
    dispatch({ type: 'acceptLoad', load })
  }

  return (
    <div className="gx-gate" role="dialog" aria-label="Large graph">
      <div className="gx-gate__card">
        <div className="gx-gate__head">
          <Gauge size={18} />
          <div>
            <h2>{memory ? 'Too large for this tab' : 'Large graph'}</h2>
            <p className="muted">
              This view holds <strong>{n(load.nodes)} nodes</strong>
              {slice.candidates > load.nodes ? <> (of {n(slice.candidates)} matching)</> : null} and <strong>{n(load.edges)} edges</strong>
              {memory && heap ? (
                <>
                  {' '}
                  — drawing all of it needs about <strong>{gb(drawCost(load))}</strong> more memory, and this tab can spare about {gb(heapRoom(heap))} ({gb(heap.used)} of its {gb(heap.limit)} in use). Past that the browser stops the tab. Choose what to load; the rest is only filtered out of the picture.
                </>
              ) : memory ? (
                <> — more than this browser is likely to draw without stopping the tab. Choose what to load; the rest is only filtered out of the picture.</>
              ) : (
                <>
                  {' '}
                  — past the {n(budget.nodes)} nodes / {n(budget.edges)} edges it draws without asking. Choose what to load; the rest is only filtered out of the picture.
                </>
              )}
            </p>
          </div>
        </div>
        <div className="gx-gate__cols">
          <section>
            <h3>
              Nodes <span className="faint">by type</span>
              {bulk('node')}
            </h3>
            <div className="gx-checklist gx-gate__list">{b.nodeTypes.map((t) => row('node', t))}</div>
            <label className="gx-gate__cap">
              Keep at most
              <input className="input" type="number" min={100} step={100} value={cap} onChange={(e) => setCap(Math.max(100, Number(e.target.value) || 100))} />
              nodes <span className="faint">(the best-connected stay)</span>
            </label>
          </section>
          <section>
            <h3>
              Edges <span className="faint">by relationship type</span>
              {bulk('rel')}
            </h3>
            <div className="gx-checklist gx-gate__list">{b.relTypes.map((t) => row('rel', t))}</div>
            <p className="faint gx-gate__hint">The most numerous kinds are unticked to start — similarity and co-occurrence links are usually the bulk and the least readable.</p>
          </section>
        </div>
        <div className="gx-gate__foot">
          <span className={`gx-gate__est ${fits ? 'is-ok' : 'is-over'}`}>
            Will draw up to {n(estNodes)} nodes · {n(estEdges)} edges
          </span>
          <span className="gx-gate__spacer" />
          <button className={`btn btn--sm ${memory && sure ? 'btn--danger' : ''}`} onClick={everything} title={memory ? 'Draw the whole view anyway: the tab may run out of memory and close, losing what is not saved' : 'Draw the whole view as filtered now; it may be slow'}>
            {memory ? (sure ? 'Draw it anyway — the tab may close' : 'Show everything…') : 'Show everything'}
          </button>
          <button className="btn btn--sm btn--primary" onClick={apply}>
            Show selection
          </button>
        </div>
        <details className="gx-gate__budget">
          <summary>Ask above {n(state.viewBudget.nodes)} nodes / {n(state.viewBudget.edges)} edges</summary>
          <div className="gx-gate__budget-row">
            <label>
              Nodes <input className="input" type="number" min={100} step={100} value={draft.nodes} onChange={(e) => setDraft({ ...draft, nodes: Number(e.target.value) || 0 })} />
            </label>
            <label>
              Edges <input className="input" type="number" min={100} step={500} value={draft.edges} onChange={(e) => setDraft({ ...draft, edges: Number(e.target.value) || 0 })} />
            </label>
            <button className="btn btn--sm" onClick={saveBudget} disabled={draft.nodes === budget.nodes && draft.edges === budget.edges}>
              Save
            </button>
          </div>
        </details>
      </div>
    </div>
  )
}
