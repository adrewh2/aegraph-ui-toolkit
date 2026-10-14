import { Minus, Hand, MousePointer2, PinOff, Plus, Route, X } from 'lucide-react'
import { useMemo } from 'react'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { sampleDataKeys } from '../../core/graph/fields'
import { useExplorer } from './explorerState'
import { useSelectionActions } from './useSelectionActions'
import { prefersReducedMotion } from '../../lib/motion'

const MAX_LIST = 60

/**
 * The selection and what clicking does, in the order they are reached for: what is selected (and how to select, while
 * nothing is) with the ways to change it; the click tool; how far the highlight reaches; the pinned nodes; the camera.
 * Every control keeps its place whatever the state — an action that needs a selection is there, idle, until there is one.
 */
export function SelectionPanel() {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const { state, dispatch, slice, primary } = useExplorer()
  const a = useSelectionActions()
  const edgeKeys = useMemo(() => sampleDataKeys(slice.edges).filter((k) => k.startsWith('data.')), [slice.edges])
  const none = !slice.nodes.length
  const hops = Math.max(1, state.hops)
  const setHops = (n: number) => dispatch({ type: 'setHops', hops: Math.max(1, Math.min(6, n)) })

  return (
    <div className="gx-panel gx-selpanel">
      <section>
        <h4>
          Selection
          <span className="gx-panel__hint">
            {a.count ? `${a.count.toLocaleString()} of ${slice.nodes.length.toLocaleString()} nodes` : 'nothing selected'}
          </span>
        </h4>
        <div className="gx-selpanel__rows">
          <span className="gx-selpanel__label">Select</span>
          <div className="gx-selpanel__btns">
            <button className="btn btn--sm" onClick={a.selectAll} disabled={none} title="Every node in view">
              All
            </button>
            <button className="btn btn--sm" onClick={a.invert} disabled={none} title="Everything that is not selected, and nothing that is">
              Invert
            </button>
            <button className="btn btn--sm" onClick={a.clear} disabled={!a.count} title="Select nothing (Esc)">
              None
            </button>
          </div>
          <span className="gx-selpanel__label">Add</span>
          <div className="gx-selpanel__btns">
            <button className="btn btn--sm" onClick={() => a.neighbours(1)} disabled={!a.count} title={a.count ? 'Add every node one link away from the selection' : 'Select a node first'}>
              Neighbours
            </button>
            <button className="btn btn--sm" onClick={a.byType} disabled={!a.count} title={a.count ? 'Add every node in view of the selected types' : 'Select a node first'}>
              Same type
            </button>
            <button className="btn btn--sm" onClick={a.byTag} disabled={!a.count} title={a.count ? 'Add every node in view sharing a tag with the selection' : 'Select a node first'}>
              Same tag
            </button>
          </div>
        </div>
        {a.count > 0 ? (
          <ul className="gx-list gx-selpanel__list">
            {state.selectedIds
              .slice(-MAX_LIST)
              .reverse()
              .map((id) => {
                const e = store.get(id)
                return (
                  <li key={id} className={id === primary ? 'is-primary' : ''} onClick={() => dispatch({ type: 'select', ids: [id], mode: 'add' })} title={id === primary ? 'Shown in the details on the right' : 'Show this one in the details'}>
                    <span className="gx-dot" style={{ background: registry.colorOf(e?.type ?? '') }} />
                    <span className="gx-list__label">{e ? displayLabel(e) : id}</span>
                    <button className="gx-chip-x" onClick={(ev) => (ev.stopPropagation(), dispatch({ type: 'select', ids: [id], mode: 'remove' }))} aria-label="Deselect" title="Deselect">
                      <X size={11} />
                    </button>
                  </li>
                )
              })}
            {a.count > MAX_LIST && <li className="faint">… and {(a.count - MAX_LIST).toLocaleString()} more</li>}
          </ul>
        ) : (
          <ul className="gx-selpanel__how">
            <li>
              <span>Click a node</span>
              <span className="faint">to select it</span>
            </li>
            <li>
              <span>
                <kbd className="kbd">⇧</kbd> or <kbd className="kbd">⌘</kbd> click
              </span>
              <span className="faint">to add or drop one</span>
            </li>
            <li>
              <span>
                <kbd className="kbd">⇧</kbd> drag
              </span>
              <span className="faint">to box a group</span>
            </li>
            <li>
              <span>Drag a selected one</span>
              <span className="faint">to move them all</span>
            </li>
          </ul>
        )}
      </section>

      <section>
        <h4>
          Pointer
          <span className="gx-panel__hint">{state.tool === 'path' ? 'finds a path' : state.tool === 'box' ? 'draws a selection box' : 'moves the picture'}</span>
        </h4>
        <div className="gx-seg" role="radiogroup" aria-label="What the pointer does">
          <button role="radio" aria-checked={state.tool === 'pan'} className={state.tool === 'pan' ? 'is-active' : ''} onClick={() => dispatch({ type: 'setTool', tool: 'pan' })} title="Drag to move the picture; ⇧-drag draws a selection box">
            <Hand size={12} /> Hand
          </button>
          <button role="radio" aria-checked={state.tool === 'box'} className={state.tool === 'box' ? 'is-active' : ''} onClick={() => dispatch({ type: 'setTool', tool: 'box' })} title="Drag a box round nodes to select them (⇧ adds); hold Space to move the picture (V)">
            <MousePointer2 size={12} /> Select
          </button>
          <button role="radio" aria-checked={state.tool === 'path'} className={state.tool === 'path' ? 'is-active' : ''} onClick={() => dispatch({ type: 'setTool', tool: 'path' })}>
            <Route size={12} /> Shortest path
          </button>
        </div>
        {state.tool === 'path' && (
          <div className="gx-selpanel__path">
            <p className="gx-panel__note">Click two nodes: the fewest links between them light up.</p>
            <label className="gx-selpanel__opt">
              <Switch on={!!state.pathOptions.directed} onChange={(on) => dispatch({ type: 'setPathOptions', patch: { directed: on } })} />
              <span>Only along each link’s direction</span>
            </label>
            <label className="gx-selpanel__opt">
              <Switch on={!!state.pathOptions.weighted} onChange={(on) => dispatch({ type: 'setPathOptions', patch: { weighted: on } })} />
              <span>Shortest by weight, not by count</span>
            </label>
            {state.pathOptions.weighted && (
              <label className="gx-row">
                <span>Weight</span>
                <input className="input" style={{ flex: 1, height: 26 }} list="gx-edge-keys" placeholder="data.weight" value={state.pathOptions.weightField ?? ''} onChange={(e) => dispatch({ type: 'setPathOptions', patch: { weightField: e.target.value || undefined } })} />
                <datalist id="gx-edge-keys">
                  {edgeKeys.map((k) => (
                    <option key={k} value={k} />
                  ))}
                </datalist>
              </label>
            )}
            {state.path && (
              <p className="gx-panel__note">
                <strong>
                  {state.path.length} link{state.path.length === 1 ? '' : 's'}:
                </strong>{' '}
                {state.path.nodes.map((id) => labelOf(store, id)).join(' → ')}
              </p>
            )}
          </div>
        )}
      </section>

      <section>
        <h4>Highlight</h4>
        <div className="gx-selpanel__stepper-row">
          <div className="gx-stepper" role="group" aria-label="Links from the selection that stay lit">
            <button onClick={() => setHops(hops - 1)} disabled={hops <= 1} aria-label="Fewer">
              <Minus size={12} />
            </button>
            <span className="gx-stepper__value">{hops}</span>
            <button onClick={() => setHops(hops + 1)} disabled={hops >= 6} aria-label="More">
              <Plus size={12} />
            </button>
          </div>
          <span>{hops === 1 ? 'link out stays lit' : 'links out stay lit'}</span>
        </div>
        <p className="gx-panel__note">With something selected, the nodes this close stay bright and the rest of the picture dims.</p>
      </section>

      <section>
        <h4>
          Pinned
          <span className="gx-panel__hint">{state.pinned.length ? state.pinned.length.toLocaleString() : 'none'}</span>
          <button className={`btn btn--sm btn--ghost ${state.pinned.length ? '' : 'is-idle'}`} disabled={!state.pinned.length} aria-hidden={!state.pinned.length} tabIndex={state.pinned.length ? undefined : -1} onClick={() => dispatch({ type: 'setPinned', ids: [] })}>
            <PinOff size={12} /> Unpin all
          </button>
        </h4>
        {state.pinned.length ? (
          <ul className="gx-list">
            {state.pinned.slice(0, MAX_LIST).map((id) => (
              <li key={id} onClick={() => dispatch({ type: 'select', ids: [id], mode: 'replace' })} title="Select it">
                <span className="gx-list__label">{labelOf(store, id)}</span>
                <button className="gx-chip-x" onClick={(ev) => (ev.stopPropagation(), dispatch({ type: 'pin', ids: [id], on: false }))} aria-label="Unpin" title="Unpin">
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="gx-panel__note">
            Select nodes and press <kbd className="kbd">P</kbd>: they hold their place through layouts and live physics.
          </p>
        )}
      </section>

      <section>
        <h4>Camera</h4>
        <label className="gx-selpanel__opt" title="Fitting, zooming, picking a row, a tool moving the view">
          <Switch on={state.animateCamera} onChange={(on) => dispatch({ type: 'setAnimateCamera', on })} />
          <span>Glide to where it goes</span>
          <span className="faint">{!state.animateCamera ? 'off: jumps at once' : prefersReducedMotion() ? 'jumps: the system asks for less motion' : ''}</span>
        </label>
      </section>
    </div>
  )
}

/** A switch, as the Style panel draws one. */
function Switch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className={`gx-st__switch ${on ? 'is-on' : ''}`} role="switch" aria-checked={on} onClick={(e) => (e.preventDefault(), onChange(!on))}>
      <span />
    </button>
  )
}

const labelOf = (store: ReturnType<typeof useEntityStore>, id: string) => {
  const e = store.get(id)
  return e ? displayLabel(e) : id.slice(0, 8)
}
