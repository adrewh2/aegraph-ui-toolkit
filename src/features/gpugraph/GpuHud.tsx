import { useRef, useState } from 'react'
import { useDismiss } from '../../components/ui/useDismiss'
import { Activity, ChevronDown, FlaskConical, LayoutGrid, Pause, Play } from 'lucide-react'
import type { FrameStats, PhysicsState } from './engine/engine'
import type { BenchResult } from './bench'
import type { GpuSource } from './GpuGraph'
import { useUserSettings } from '../account/settings'

/**
 * The GPU view's own chrome, over the canvas: the backend and frame
 * statistics (read a few times a second, never per frame), and the
 * benchmark — presets to load, the suite to run, the numbers it produced,
 * with the engine's own layouts for a benchmark graph. Everything else
 * (filter, layout — Multilevel is in the Layout tab —, style, selection,
 * saving) is the explorer's, shared with the 2D and 3D views.
 */
export function GpuHud(props: {
  backend: string
  error: string
  stats: FrameStats | null
  source: GpuSource
  bench: { running: string; result?: BenchResult; loaded?: string }
  presets: string[]
  onLoad: (preset: string) => void
  onRun: (preset: string) => void
  onExplorer: () => void
  onLayout: (algorithm: 'coarse' | 'grid' | 'circle' | 'random') => void
  /** The live physics: where it stands, and the toggle (a benchmark graph's own; the explorer's picture has the toolbar's). */
  physics?: PhysicsState | null
  onPhysics?: (on: boolean) => void
}) {
  const { backend, error, stats, source, bench, presets } = props
  const [open, setOpen] = useState<'bench' | 'layout' | null>(null)
  const layoutMenu = useRef<HTMLDivElement>(null)
  const benchMenu = useRef<HTMLDivElement>(null)
  // The open one (its button with it) is inside; a press anywhere else, the picture included, closes it.
  useDismiss(() => setOpen(null), { active: open !== null, inside: () => [open === 'layout' ? layoutMenu.current : benchMenu.current] })
  // The benchmark is a developer's tool: it shows when Developer tools is on in the account menu, and stays while a
  // benchmark graph is loaded so the way back is never hidden.
  const developer = useUserSettings().developerTools || source === 'benchmark'
  const [showResult, setShowResult] = useState(true)
  const r = bench.result
  return (
    <>
      <div className="gg-toolbar">
        {source === 'benchmark' && (
        <div className="gg-menu" ref={layoutMenu}>
          <button className={`btn btn--sm ${open === 'layout' ? 'is-active' : ''}`} onClick={() => setOpen(open === 'layout' ? null : 'layout')} title="Layouts computed by the GPU graph's worker: O(V+E), a picture in milliseconds">
            <LayoutGrid size={13} /> Layout <ChevronDown size={12} />
          </button>
          {open === 'layout' && (
            <div className="gg-menu__list" onClick={() => setOpen(null)}>
              <button onClick={() => props.onLayout('coarse')}>Coarse (communities)</button>
              <button onClick={() => props.onLayout('grid')}>Grid</button>
              <button onClick={() => props.onLayout('circle')}>Circle</button>
              <button onClick={() => props.onLayout('random')}>Random</button>
            </div>
          )}
        </div>
        )}
        {source === 'benchmark' && props.onPhysics && (
          <button className={`btn btn--sm ${props.physics?.on ? 'btn--primary' : ''}`} onClick={() => props.onPhysics!(!props.physics?.on)} title="Live physics over the whole graph: a force simulation on the GPU (WebGPU compute), or in the worker without it">
            {props.physics?.on ? <Pause size={13} /> : <Play size={13} />} Physics
          </button>
        )}
        {developer && (
        <div className="gg-menu" ref={benchMenu}>
          <button className={`btn btn--sm ${open === 'bench' ? 'is-active' : ''}`} onClick={() => setOpen(open === 'bench' ? null : 'bench')} title="Load a generated graph of a given size, or run the benchmark suite on one">
            <FlaskConical size={13} /> Benchmark <ChevronDown size={12} />
          </button>
          {open === 'bench' && (
            <div className="gg-menu__list" onClick={() => setOpen(null)}>
              <div className="gg-menu__label">Load</div>
              {presets.map((p) => (
                <button key={`l${p}`} onClick={() => props.onLoad(p)}>
                  {p} nodes
                </button>
              ))}
              <div className="gg-menu__label">Run the suite</div>
              {presets.map((p) => (
                <button key={`r${p}`} onClick={() => props.onRun(p)}>
                  {p} nodes
                </button>
              ))}
            </div>
          )}
        </div>
        )}
        {source === 'benchmark' && (
          <button className="btn btn--sm" onClick={props.onExplorer} title="Back to the explorer's graph">
            ← Explorer graph
          </button>
        )}
      </div>
      <div className="gg-hud" title="Backend · nodes in view / regime · frame time (mean of the last 60) · labels drawn">
        <Activity size={12} />
        <span className={`gg-hud__backend is-${backend || 'none'}`}>{backend || (error ? 'no GPU' : '…')}</span>
        {stats && (
          <>
            <span>{stats.nodesInView.toLocaleString()} in view</span>
            <span>LOD {stats.regime}</span>
            <span>{stats.meanMs.toFixed(1)} ms</span>
            <span>{stats.drawCalls} draws</span>
            {stats.labels > 0 && <span>{stats.labels} labels</span>}
          </>
        )}
        {props.physics?.on && (
          <span className="gg-hud__physics" title="The simulation: where it runs · iterations per frame × GPU ms per iteration · alpha (the run cools to a stop)">
            physics {props.physics.mode}{props.physics.cooled ? ' · settled' : ` · ${props.physics.perFrame}×${Number.isFinite(props.physics.msPerIteration) ? props.physics.msPerIteration.toFixed(1) : '?'} ms · α ${props.physics.alpha.toFixed(3)}`}
          </span>
        )}
        {bench.loaded && <span className="gg-hud__bench">{bench.loaded}</span>}
        {bench.running && <span className="gg-hud__busy">{bench.running}</span>}
      </div>
      {error && <div className="gg-error">{error}</div>}
      {r && showResult && (
        <div className="gg-result">
          <div className="gg-result__head">
            <strong>
              {r.preset}: {r.nodes.toLocaleString()} nodes · {r.edges.toLocaleString()} edges · {r.backend}
            </strong>
            <button className="btn btn--sm btn--ghost" onClick={() => setShowResult(false)}>
              ×
            </button>
          </div>
          <table>
            <tbody>
              <Row k="Generate (worker)" v={`${r.generateMs} ms`} />
              <Row k="Load into engine" v={`${r.loadMs} ms`} />
              <Row k="First frame" v={`${r.firstFrameMs} ms`} />
              <Row k="Camera frame p50 / p95 / max" v={`${r.frame.p50} / ${r.frame.p95} / ${r.frame.max} ms`} />
              <Row k="Pick (mean / max)" v={`${(r.pick.mean * 1000).toFixed(0)} µs / ${r.pick.max} ms`} />
              <Row k="Select all / clear / one" v={`${r.selectAllMs} / ${r.clearSelectionMs} / ${r.selectOneMs} ms`} />
              <Row k={`Select neighbours (degree ${r.selectNeighbors.degree})`} v={`${r.selectNeighbors.ms} ms`} />
              <Row k="Drag one node, per frame p50 / p95" v={`${r.drag.p50} / ${r.drag.p95} ms`} />
              <Row k="Drag 1,000 nodes, per frame p50 / p95" v={`${r.dragMany.p50} / ${r.dragMany.p95} ms`} />
              <Row k={`Marquee (${r.marqueeHits.toLocaleString()} hits)`} v={`${r.marqueeMs} ms`} />
              <Row k="Filter to one type" v={`${r.filterMs} ms`} />
              <Row k="Grid rebuild after drop" v={`${r.gridMs} ms`} />
              <Row k="Coarse layout (worker)" v={`${r.layoutMs} ms`} />
              {r.physics && <Row k={`Physics (${r.physics.mode}), ${r.physics.iterations} iterations`} v={`${r.physics.msPerIteration} ms / iteration · ${r.physics.totalMs} ms`} />}
              <Row k="Whole suite" v={`${(r.totalMs / 1000).toFixed(1)} s`} />
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td>{k}</td>
      <td>{v}</td>
    </tr>
  )
}
