import { KeysHint } from '../../components/KeysHint/KeysHint'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Hand, Maximize2, Minimize2, MousePointer2, Route, Scan, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { RefObject } from 'react'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import { useExplorer } from './explorerState'
import type { GraphViewHandle } from './view'
import { useSelectionActions } from './useSelectionActions'
import { setCameraControls, useCameraControls, type CameraControls } from './cameraControls'
import './GraphNav.css'

/**
 * The stage's own controls, bottom right of the picture like a map's: the
 * pointer tool (select, or the path tool), zoom in and out, fit, and full
 * view (the side panel folded away). They sit in the view rather than in
 * the toolbar above it because they are about the picture the eye is on.
 * The same in every renderer — sigma, three.js, the GPU view — through the
 * view handle.
 */
export function GraphNav({ viewRef, fullView, onFullView }: { viewRef: RefObject<GraphViewHandle | null>; fullView: boolean; onFullView: (on: boolean) => void }) {
  const { state, dispatch } = useExplorer()
  // The pointer tools, one at a time: the hand moves the picture, Select draws a box round what it selects, Path finds
  // the shortest path between two clicked nodes. Dragging a node moves it with either of the first two.
  const tools = [
    { id: 'pan', icon: <Hand size={14} />, title: 'Hand: drag to move the picture (⇧-drag still draws a selection box)' },
    { id: 'box', icon: <MousePointer2 size={14} />, title: 'Select: drag a box round nodes to select them — ⇧ adds to the selection; hold Space (or use the right button) to move the picture (V)' },
    { id: 'path', icon: <Route size={14} />, title: 'Path: click two nodes to find the shortest path between them' },
  ] as const
  return (
    <div className="gx-nav" role="toolbar" aria-label="View">
      {tools.map((t) => (
        <button key={t.id} className={`gx-nav__btn ${state.tool === t.id ? 'is-on' : ''}`} title={t.title} aria-label={t.title.split(':')[0]} aria-pressed={state.tool === t.id} onClick={() => dispatch({ type: 'setTool', tool: t.id })}>
          {t.icon}
        </button>
      ))}
      <span className="gx-nav__sep" />
      <button className="gx-nav__btn" title="Zoom in" onClick={() => viewRef.current?.zoomIn()}>
        <ZoomIn size={14} />
      </button>
      <button className="gx-nav__btn" title="Zoom out" onClick={() => viewRef.current?.zoomOut()}>
        <ZoomOut size={14} />
      </button>
      <button className="gx-nav__btn" title="Fit the whole picture (F)" onClick={() => viewRef.current?.fit()}>
        <Scan size={14} />
      </button>
      <span className="gx-nav__sep" />
      <button className={`gx-nav__btn ${fullView ? 'is-on' : ''}`} title={fullView ? 'Show the side panel' : 'Full view: fold the side panel away'} aria-pressed={fullView} onClick={() => onFullView(!fullView)}>
        {/* Drawn a size down: its arrows run into the corners, where the magnifiers above are round, so at the same size
            it read as the biggest button of the column. The stroke is kept to the others' weight (2 at 14 px). */}
        {fullView ? <Minimize2 size={12} strokeWidth={2.33} /> : <Maximize2 size={12} strokeWidth={2.33} />}
      </button>
    </div>
  )
}

/**
 * The camera keys, as a quiet line beside the view's controls: arrows slide,
 * Q/E zoom, and in 3D W A S D orbit (`useCameraKeys`). Small and faint, and
 * it never takes a click — a reminder, not a control.
 */
export function CameraKeysHint({ dims }: { dims: 2 | 3 }) {
  const controls = useCameraControls()
  const arrows = [ArrowLeft, ArrowUp, ArrowDown, ArrowRight].map((Icon, i) => <Icon key={i} size={10} strokeWidth={2.5} />)
  // 2D has one way to move; 3D offers the switch, and the line says what the keys do in the mode it is in. The other
  // mode's keys hold their room, so the switch stays put when it is flipped.
  const orbitKeys = [
    { keys: arrows, label: 'pan' },
    { keys: ['Q', 'E'], label: 'zoom' },
    ...(dims === 3 ? [{ keys: ['W', 'A', 'S', 'D'], label: 'orbit' }] : []),
    { keys: ['Shift'], label: 'fast' },
  ]
  const flyKeys = [
    { keys: ['W', 'A', 'S', 'D'], label: 'move' },
    { keys: ['Q', 'E'], label: 'down · up' },
    { keys: arrows, label: 'look' },
    { keys: ['Shift'], label: 'fast' },
  ]
  const fly = dims === 3 && controls === 'fly'
  return <KeysHint className="gx-keys" lead={dims === 3 ? <ControlsSwitch value={controls} /> : undefined} items={fly ? flyKeys : orbitKeys} reserve={dims === 3 ? [fly ? orbitKeys : flyKeys] : []} />
}

const CONTROLS: { id: CameraControls; label: string; title: string }[] = [
  { id: 'orbit', label: 'Orbit', title: 'Orbit: turn around the point you look at — W A S D orbit, Q/E zoom, a drag orbits' },
  { id: 'fly', label: 'Fly', title: 'Fly: move the camera itself — W A S D move, Q/E down and up, arrows and a drag look around — through the graph and past it' },
]

/** Orbit or fly: two small segments at the start of the key hint, the one in use filled. */
function ControlsSwitch({ value }: { value: CameraControls }) {
  return (
    <span className="gx-controls" role="radiogroup" aria-label="Camera controls">
      {CONTROLS.map((c) => (
        <button key={c.id} type="button" role="radio" aria-checked={value === c.id} className={`gx-controls__opt${value === c.id ? ' is-on' : ''}`} title={c.title} onClick={() => setCameraControls(c.id)}>
          {c.label}
        </button>
      ))}
    </span>
  )
}

/**
 * What the path tool is doing, while it is doing something: the node it
 * starts from and what to click next, or the path found and how to keep it.
 * A mode needs a word on screen; a selection does not — its actions are on
 * the right-click menu and in the details pane.
 */
export function PathStatus() {
  const store = useEntityStore()
  const { state, dispatch } = useExplorer()
  const a = useSelectionActions()
  const labelOf = (id: string) => {
    const e = store.get(id)
    return e ? displayLabel(e) : id.slice(0, 8)
  }
  if (state.path) {
    const p = state.path
    return (
      <div className="gx-path-status">
        <Route size={13} />
        <strong>
          {p.length} hop{p.length === 1 ? '' : 's'}
          {p.weight != null && ` · weight ${Number.isInteger(p.weight) ? p.weight : p.weight.toFixed(2)}`}
        </strong>
        <span className="faint">
          {labelOf(p.from)} → {labelOf(p.to)}
        </span>
        <button className="btn btn--sm" onClick={a.addPathToSelection}>
          Select path
        </button>
        <button className="btn btn--sm btn--ghost btn--icon" title="Clear the path (Esc)" onClick={() => dispatch({ type: 'setPath', path: undefined })}>
          <X size={12} />
        </button>
      </div>
    )
  }
  if (state.pathFrom) {
    return (
      <div className="gx-path-status">
        <Route size={13} />
        <strong>From {labelOf(state.pathFrom)}</strong>
        <span className="faint">click the destination node</span>
        <button className="btn btn--sm btn--ghost btn--icon" title="Cancel (Esc)" onClick={() => dispatch({ type: 'setPathFrom', id: undefined })}>
          <X size={12} />
        </button>
      </div>
    )
  }
  if (state.tool === 'path') {
    return (
      <div className="gx-path-status">
        <Route size={13} />
        <span className="faint">Path tool: click the first node</span>
      </div>
    )
  }
  return null
}
