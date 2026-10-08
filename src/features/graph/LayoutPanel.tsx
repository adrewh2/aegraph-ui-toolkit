import { Check, ChevronDown, Expand, PinOff, Play, RefreshCw, RotateCcw, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import { sampleDataKeys } from '../../core/graph/fields'
import { canRunLive, DEFAULT_LAYOUT_PARAMS, DEFAULT_UNIGRAPH_FORCE, isDynamicLayout, LAYOUTS, layoutInfo, layoutTooBig, type Dimensions, type LayoutAlgorithm, type LayoutParams, type UnigraphForceParams } from '../../core/graph/layouts'
import { describePlacement } from '../../core/graph/placement'
import { describeSelector } from '../../core/graph/selector'
import { useExplorer } from './explorerState'
import { ScriptSource } from './ScriptSource'
import type { LayoutData } from '../../core/graph/types'
import { Select } from '../../components/ui/Select'


export function LayoutPanel({ dims }: { dims: Dimensions }) {
  const store = useEntityStore()
  const { state, dispatch, slice, runLayout, removeOverlap, primary, rederiveLayout, positionsFor } = useExplorer()
  const info = layoutInfo(state.algorithm)
  // A loaded layout that a script made: the panel says so and can run it again.
  const loadedSource = state.layoutId ? (store.get(state.layoutId)?.data as LayoutData | undefined)?.source : undefined
  const supported = info.dims.includes(dims)
  const tooBig = slice.nodes.length > info.softLimit
  const refused = layoutTooBig(state.algorithm, slice.nodes.length)
  const p = { ...DEFAULT_LAYOUT_PARAMS, ...state.params } as Required<Omit<LayoutParams, 'dimensions' | 'centerId' | 'weightField'>> & Pick<LayoutParams, 'centerId' | 'weightField'>
  const set = (patch: Partial<Omit<LayoutParams, 'dimensions'>>) => dispatch({ type: 'patchParams', patch })
  const edgeKeys = useMemo(() => sampleDataKeys(slice.edges).filter((k) => k.startsWith('data.')), [slice.edges])
  const centre = p.centerId ? store.get(p.centerId) : undefined

  const [algMenu, setAlgMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  // The layouts as a menu — the dynamic ones (simulations that can be kept running) above a line, the static ones
  // below: choosing one sets the algorithm (its parameters appear below) — the Run button then applies it.
  // A layout past its size limit for this view is greyed out, with its limit: it would run for minutes.
  const algItem = (l: (typeof LAYOUTS)[number]): MenuItem => {
    const over = l.maxNodes !== undefined && slice.nodes.length > l.maxNodes
    const note = !l.dims.includes(dims) ? `  ·  ${l.dims.join('/')}D only` : over ? `  ·  up to ${l.maxNodes!.toLocaleString()} nodes` : ''
    return { kind: 'item', label: `${l.label}${note}`, icon: l.id === state.algorithm ? Check : undefined, disabled: !l.dims.includes(dims) || over, onSelect: () => dispatch({ type: 'setAlgorithm', algorithm: l.id as LayoutAlgorithm }) }
  }
  // Custom positions first — what a placement, a set of positions or a loaded hand-made layout selects — then the algorithms.
  const algItems: MenuItem[] = [algItem(layoutInfo('custom')), { kind: 'sep' }, { kind: 'label', label: 'Dynamic' }, ...LAYOUTS.filter((l) => isDynamicLayout(l.id)).map(algItem), { kind: 'sep' }, { kind: 'label', label: 'Static' }, ...LAYOUTS.filter((l) => l.id !== 'custom' && !isDynamicLayout(l.id)).map(algItem)]
  const dynamic = isDynamicLayout(state.algorithm)
  const liveHere = dynamic && canRunLive(state.algorithm)
  const rule = state.layoutRule
  const rederive = () => {
    const b = positionsFor(dims).positions
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const id in b) {
      const p = b[id]
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    const bbox = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    rederiveLayout({ viewport: bbox, bbox })
  }

  return (
    <div className="gx-panel">
      {/* Which layout (a menu of them all), then run: the parameters below are the chosen layout's. */}
      <section className="gx-layout__run">
        <div className="gx-layout__bar">
          <button className="btn btn--sm gx-picker gx-layout__pick" title={info.description} aria-haspopup="menu" aria-expanded={!!algMenu} onClick={(e) => setAlgMenu(algMenu ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget })}>
            <span className="gx-picker__label">{info.label}</span>
            <ChevronDown size={12} />
          </button>
          {algMenu && <Menu x={algMenu.x} y={algMenu.y} anchor={algMenu.anchor} items={algItems} onClose={() => setAlgMenu(null)} />}
          <button className="btn btn--sm btn--icon" title="Forget held positions and recompute" onClick={() => dispatch({ type: 'unloadLayout' })}>
            <RotateCcw size={13} />
          </button>
          {dims === 2 && (
            <button className="btn btn--sm btn--icon" title="Push overlapping nodes apart without changing the overall arrangement" disabled={slice.nodes.length < 2} onClick={removeOverlap}>
              <Expand size={13} />
            </button>
          )}
          <button className="btn btn--sm btn--primary" disabled={!supported || slice.nodes.length === 0 || !!state.layoutJob || !!refused} title={state.layoutJob ? `Laying out ${state.layoutJob.nodes.toLocaleString()} nodes…` : state.algorithm === 'custom' ? 'Custom positions are set, not computed: Run places only nodes that have none. Choose an algorithm to lay the picture out again.' : `Lay out the ${slice.nodes.length.toLocaleString()} nodes the filter keeps (${slice.edges.length.toLocaleString()} edges) with ${info.label}`} onClick={() => runLayout(dims)}>
            {state.layoutJob ? (
              <>
                <span className="spinner" /> Running…
              </>
            ) : (
              <>
                <Play size={13} /> Run
              </>
            )}
          </button>
        </div>
        <p className="gx-panel__note">
          <strong>{info.label}</strong> — {info.description}
          {!supported && <span className="gx-panel__warn"> Not available in {dims}D: pick another.</span>}
          {refused && <span className="gx-panel__warn"> {refused}</span>}
          {tooBig && !refused && <span className="gx-panel__warn"> {slice.nodes.length.toLocaleString()} nodes is above this layout's comfortable range (~{info.softLimit.toLocaleString()}); it may take a while — it runs in the background, and the view stays usable meanwhile.</span>}
        </p>
      </section>
      {rule && (
        <section>
          <h4>
            Derived layout
            <button className="btn btn--sm btn--ghost" title="Forget the rule (positions stay)" onClick={() => dispatch({ type: 'setLayoutRule', rule: undefined })}>
              <X size={12} />
            </button>
          </h4>
          <p className="gx-panel__note">
            <strong>{describePlacement(rule.spec)}</strong>
            <br />
            for {describeSelector(rule.selector)}
          </p>
          <div className="gx-actions">
            <button className="btn btn--sm btn--primary" onClick={rederive} title="Recompute these positions from current values">
              <RefreshCw size={12} /> Re-derive
            </button>
            {dims === 2 && (
              <label className="gx-row" style={{ marginLeft: 'auto' }}>
                <input type="checkbox" checked={state.showPlacementOverlay} onChange={(e) => dispatch({ type: 'showPlacementOverlay', on: e.target.checked })} />
                <span>Show grid</span>
              </label>
            )}
          </div>
          <p className="gx-panel__note">Placements are set by the assistant (graph_positions) or by dragging; this rule remembers how, so it can be re-run when the data or the analysis changes. Saving the layout keeps the rule.</p>
        </section>
      )}

      {dynamic && (
        <section>
          <h4>Simulation</h4>
          {liveHere ? (
            <label className="gx-row" title="Leave the simulation running: it keeps settling, reacts to drags and pins, and the positions it reaches are held. The same switch as Physics in the toolbar.">
              <input type="checkbox" checked={state.physics} onChange={(e) => dispatch({ type: 'setPhysics', on: e.target.checked })} />
              <span>Keep running</span>
              {state.physics && <span className="count">live</span>}
            </label>
          ) : (
            <p className="gx-panel__note">Run computes this simulation in the background for the iterations given. Force (Unigraph) is the simulation the engine runs live — kept running, tunable as it goes.</p>
          )}
        </section>
      )}
      <section>
        <h4>Parameters</h4>
        <label className="gx-row">
          <span>Spacing</span>
          <input type="range" min={0.3} max={3} step={0.1} value={state.params.spacing} onChange={(e) => dispatch({ type: 'patchParams', patch: { spacing: Number(e.target.value) } })} />
          <span className="count">{state.params.spacing.toFixed(1)}×</span>
        </label>
        {state.algorithm === 'force' && (
          <>
            <label className="gx-row">
              <span>Iterations</span>
              <input type="range" min={50} max={1000} step={50} value={state.params.iterations} onChange={(e) => set({ iterations: Number(e.target.value) })} />
              <span className="count">{state.params.iterations}</span>
            </label>
            <label className="gx-row">
              <span>Gravity</span>
              <input type="range" min={0.1} max={5} step={0.1} value={p.gravity} onChange={(e) => set({ gravity: Number(e.target.value) })} />
              <span className="count">{p.gravity.toFixed(1)}</span>
            </label>
            {dims === 2 && (
              <>
                <label className="gx-row">
                  <span>Repulsion</span>
                  <input type="range" min={1} max={50} step={1} value={p.scalingRatio} onChange={(e) => set({ scalingRatio: Number(e.target.value) })} />
                  <span className="count">{p.scalingRatio}</span>
                </label>
                <label className="gx-row">
                  <input type="checkbox" checked={p.linLogMode} onChange={(e) => set({ linLogMode: e.target.checked })} />
                  <span>LinLog mode (tighter clusters)</span>
                </label>
                <label className="gx-row">
                  <input type="checkbox" checked={p.strongGravity} onChange={(e) => set({ strongGravity: e.target.checked })} />
                  <span>Strong gravity</span>
                </label>
              </>
            )}
            <label className="gx-row">
              <span>Weight field</span>
              <input className="input" style={{ flex: 1, height: 26 }} list="gx-layout-edge-keys" placeholder="none" value={p.weightField ?? ''} onChange={(e) => set({ weightField: e.target.value || undefined })} />
              <datalist id="gx-layout-edge-keys">
                {edgeKeys.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </label>
            {p.weightField && dims === 2 && (
              <label className="gx-row">
                <span>Weight influence</span>
                <input type="range" min={0} max={2} step={0.1} value={p.edgeWeightInfluence || 1} onChange={(e) => set({ edgeWeightInfluence: Number(e.target.value) })} />
                <span className="count">{(p.edgeWeightInfluence || 1).toFixed(1)}</span>
              </label>
            )}
          </>
        )}
        {info.uses?.includes('unigraph') && <UnigraphForceControls value={{ ...DEFAULT_UNIGRAPH_FORCE, ...(state.params.unigraph ?? {}) }} onChange={(patch) => set({ unigraph: { ...DEFAULT_UNIGRAPH_FORCE, ...(state.params.unigraph ?? {}), ...patch } })} live={state.physics || !!state.layoutJob} />}
        {info.uses?.includes('iterations') && (
          <label className="gx-row">
            <span>Iterations</span>
            <input type="range" min={20} max={1000} step={20} value={state.params.iterations} onChange={(e) => set({ iterations: Number(e.target.value) })} />
            <span className="count">{state.params.iterations}</span>
          </label>
        )}
        {(state.algorithm === 'layered' || info.uses?.includes('direction')) && (
          <>
            <label className="gx-row">
              <span>Direction</span>
              <Select className="gx-select" value={state.params.direction} onChange={(e) => set({ direction: e.target.value as 'TB' | 'LR' })}>
                <option value="TB">Top → bottom</option>
                <option value="LR">Left → right</option>
              </Select>
            </label>
            {(state.algorithm === 'layered' || state.algorithm === 'elk-layered') && (
              <>
                <label className="gx-row">
                  <span>Rank gap</span>
                  <input type="range" min={0.5} max={4} step={0.25} value={p.ranksep} onChange={(e) => set({ ranksep: Number(e.target.value) })} />
                  <span className="count">{p.ranksep.toFixed(2)}×</span>
                </label>
                <label className="gx-row">
                  <span>Node gap</span>
                  <input type="range" min={0.5} max={4} step={0.25} value={p.nodesep} onChange={(e) => set({ nodesep: Number(e.target.value) })} />
                  <span className="count">{p.nodesep.toFixed(2)}×</span>
                </label>
              </>
            )}
          </>
        )}
        {(state.algorithm === 'radial-by-type' || state.algorithm === 'concentric-by-degree') && (
          <label className="gx-row">
            <span>Centre</span>
            {centre ? (
              <>
                <span className="gx-list__label">{displayLabel(centre)}</span>
                <button className="btn btn--sm btn--ghost" onClick={() => set({ centerId: undefined })}>
                  clear
                </button>
              </>
            ) : (
              <button className="btn btn--sm" disabled={!primary} onClick={() => set({ centerId: primary })} title="Put the selected node at the origin">
                Use selected
              </button>
            )}
          </label>
        )}
        {(state.algorithm === 'force' || state.algorithm === 'random' || state.algorithm === 'circlepack' || info.uses?.includes('iterations')) && (
          <label className="gx-row">
            <span>Seed</span>
            <input className="input" type="number" style={{ width: 80, height: 26 }} value={state.params.seed} onChange={(e) => set({ seed: Number(e.target.value) || 1 })} />
          </label>
        )}
        {dims === 2 && (
          <label className="gx-row">
            <input type="checkbox" checked={p.noverlap} onChange={(e) => set({ noverlap: e.target.checked })} />
            <span>Remove overlap after layout</span>
          </label>
        )}
      </section>

      <section>
        <h4>
          Pinned
          <span className="gx-panel__hint">{state.pinned.length}</span>
          {state.pinned.length > 0 && (
            <button className="btn btn--sm btn--ghost" onClick={() => dispatch({ type: 'setPinned', ids: [] })}>
              <PinOff size={12} /> Unpin all
            </button>
          )}
        </h4>
        <p className="gx-panel__note">Pinned nodes keep their position through layouts and live physics. Select nodes and press P, or use the selection bar.</p>
      </section>

      <section>
        {loadedSource && <ScriptSource kind="layout" source={loadedSource} />}
        <p className="gx-panel__note">
          {state.algorithm === 'custom' ? 'Positions were set — by a placement, by hand or by a tool — not computed; ' : state.layoutId ? 'Positions come from the loaded layout; ' : 'Positions are held once computed; '}
          nodes that enter the view are placed by the selected algorithm. Drag nodes to fine-tune, then save. A layout is the same layout in 2D and 3D (3D shows z, or a flat plane); switching views never moves anything.
        </p>
      </section>
    </div>
  )
}

/**
 * The force model's knobs (see `core/packed/physics.ts`). On a GPU tab they take effect while the simulation runs —
 * Run, or the Physics switch — so a picture can be tuned by eye; elsewhere they apply to the next Run.
 */
function UnigraphForceControls({ value, onChange, live }: { value: UnigraphForceParams; onChange: (patch: Partial<UnigraphForceParams>) => void; live: boolean }) {
  const row = (label: string, key: keyof UnigraphForceParams, min: number, max: number, step: number, fmt: (v: number) => string, title: string) => (
    <label className="gx-row" title={title}>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value[key]} onChange={(e) => onChange({ [key]: Number(e.target.value) })} />
      <span className="count">{fmt(value[key])}</span>
    </label>
  )
  return (
    <>
      {row('Link distance', 'linkDistance', 2, 80, 1, (v) => String(v), 'Rest length of a link, in world units')}
      {row('Link strength', 'linkStrength', 0.02, 1, 0.02, (v) => v.toFixed(2), 'How hard a link pulls its ends to the link distance (hubs pull less)')}
      {row('Repulsion', 'repulsion', 0.02, 2, 0.02, (v) => v.toFixed(2), 'The push between two nodes a link distance apart, in link distances')}
      {row('Gravity', 'gravity', 0, 2, 0.02, (v) => v.toFixed(2), 'Pull toward the centre; against the repulsion it sets how densely the graph packs')}
      {row('Damping', 'damping', 0.05, 0.95, 0.05, (v) => v.toFixed(2), 'Velocity kept from one iteration to the next: low is viscous, high keeps momentum')}
      {row('Cooling', 'alphaDecay', 0.001, 0.05, 0.0005, (v) => v.toFixed(4), 'How fast a run settles: small keeps it moving longer (0.0045 is about 1,500 iterations)')}
      <p className="gx-panel__note">{live ? 'The simulation is running: changes apply as you drag.' : 'On a GPU tab these apply live while the simulation runs (Run, or Physics); Iterations bounds a CPU run on the other tabs.'}</p>
      <button className="btn btn--sm btn--ghost" onClick={() => onChange({ ...DEFAULT_UNIGRAPH_FORCE })}>
        Reset to defaults
      </button>
    </>
  )
}
