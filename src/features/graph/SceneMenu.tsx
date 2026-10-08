import { Check, ChevronDown, Clapperboard, Link2, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { applyFilter, describeFilter, toFilterSpec } from '../../core/graph/filter'
import { layoutInfo, type LayoutAlgorithm } from '../../core/graph/layouts'
import { isProject, projectMembers, projectOverlay } from '../../core/graph/project'
import { describeRendering, toRenderingSpec, type RenderingData } from '../../core/graph/rendering'
import { GRAPH_SCENE_TYPES, sceneDimensions, type SceneData } from '../../core/graph/scene'
import type { AnalysisData, FilterData, LayoutData } from '../../core/graph/types'
import { makeValueContext } from '../../core/graph/values'
import { formatDate } from '../../lib/format'
import { useDismiss } from '../../components/ui/useDismiss'
import { useToast } from '../../components/ui/useToast'
import { demoIdOf, demoLink } from '../../app/demoLink'
import { isProjectEntity } from '../../core/projects/project'

/**
 * The scene's name in the toolbar is a menu: every graph scene — of either
 * page — searchable, the loaded one ticked, a click loads one. Hovering a
 * row shows a card with what the scene holds, so what will load is known
 * before it does: its picture, description, how many nodes and edges the
 * view had after the filter, the layout, the style, the filter, the
 * analysis, the renderer and when it was saved. A scene saved before the
 * counts were recorded has its filter run on hover, once.
 */
export function SceneMenu({ active, dirty, onLoad, onUnload }: { active?: AnyEntity; dirty: boolean; onLoad: (scene: AnyEntity) => void; onUnload: () => void }) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<EntityId | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const scenes = useMemo(() => store.query({ type: [...GRAPH_SCENE_TYPES] }).sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt)), [store, version])
  const q = query.trim().toLowerCase()
  const shown = q ? scenes.filter((e) => `${displayLabel(e)} ${e.description ?? ''}`.toLowerCase().includes(q)) : scenes

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHover(null)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])
  useDismiss(() => setOpen(false), { active: open, inside: () => [rootRef.current] })

  const hoverIn = (id: EntityId) => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHover(id), 150)
  }
  const hoverOut = () => {
    clearTimeout(hoverTimer.current)
  }
  /** Off the scenes onto something else in the menu (Unload): no scene is hovered, and its card goes. */
  const hoverNone = () => {
    clearTimeout(hoverTimer.current)
    setHover(null)
  }
  const pick = (e: AnyEntity) => {
    setOpen(false)
    onLoad(e)
  }
  const hovered = hover ? store.get(hover) : undefined
  const toast = useToast()
  // A scene of a demo project can be shared: a link that opens the demo on this scene (`app/demoLink.ts`).
  const scope = store.scope ? store.get(store.scope) : undefined
  const demo = active && isProjectEntity(scope) ? demoIdOf(scope) : undefined
  const copyLink = () => {
    if (!active || !demo) return
    const url = demoLink(location.origin, demo, active.id)
    setOpen(false)
    navigator.clipboard.writeText(url).then(
      () => toast(`Link copied: it opens the demo on “${displayLabel(active)}”`),
      () => toast(url),
    )
  }

  return (
    <div className="gx-scene__menu" ref={rootRef}>
      <button className={`btn btn--sm gx-scene__name ${dirty ? 'is-dirty' : ''}`} aria-haspopup="listbox" aria-expanded={open} title={active ? `${displayLabel(active)}${dirty ? ' — changed since it was saved' : ''} · click to load another scene` : 'Load a scene'} onClick={() => setOpen((v) => !v)}>
        {/* The same 16px as the Save and Save as… icons beside it — at 13 it read as the smaller thing of the three. */}
        <Clapperboard size={16} />
        <span className="gx-scene__label">{active ? displayLabel(active) : 'Load scene'}</span>
        {dirty && <span className="gx-scene__dot" aria-label="Changed since it was saved" />}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="gx-scenes" role="dialog" aria-label="Scenes">
          <div className="gx-scenes__search">
            <Search size={13} />
            <input ref={inputRef} className="input" placeholder="Search scenes…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && shown[0] && pick(shown[0])} />
          </div>
          <div className="gx-scenes__list" role="listbox" onPointerLeave={hoverOut}>
            {shown.length === 0 && <div className="gx-scenes__empty muted">{scenes.length ? 'No scene matches' : 'No scenes yet — Save as… makes one'}</div>}
            {shown.map((e) => {
              const d = e.data as SceneData
              return (
                <button key={e.id} role="option" aria-selected={e.id === active?.id} className={`gx-scenes__row ${e.id === active?.id ? 'is-active' : ''} ${e.id === hover ? 'is-hover' : ''}`} onPointerEnter={() => hoverIn(e.id)} onFocus={() => setHover(e.id)} onClick={() => pick(e)}>
                  <span className="gx-scenes__thumb">{scenePicture(d.preview) ? <img src={scenePicture(d.preview)} alt="" /> : <Clapperboard size={14} />}</span>
                  <span className="gx-scenes__text">
                    <span className="gx-scenes__title" title={displayLabel(e)}>
                      <span className="gx-scenes__name">{displayLabel(e)}</span>
                      {e.id === active?.id && <Check size={12} />}
                    </span>
                    <span className="gx-scenes__meta muted">
                      Unigraph · {(sceneDimensions(d.mode) ?? sceneDimensions(d.renderer) ?? '2d').toUpperCase()} · {formatDate(e.meta.updatedAt)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          {active && (
            <div className="gx-scenes__foot">
              {/* A row like the scenes above it: the same width and inset, never wider than the menu. */}
              <button className="gx-scenes__row gx-scenes__unload" onPointerEnter={hoverNone} onFocus={hoverNone} onClick={() => (setOpen(false), onUnload())} title={`Unload “${displayLabel(active)}”: forget which scene the view came from; the filter, layout and style stay as they are`}>
                <span className="gx-scenes__thumb gx-scenes__thumb--icon">
                  <X size={14} />
                </span>
                <span className="gx-scenes__name">Unload this scene</span>
              </button>
              {demo && (
                <button className="gx-scenes__row gx-scenes__unload" onPointerEnter={hoverNone} onFocus={hoverNone} onClick={copyLink} title={`Copy a link that opens the ${demo} demo on “${displayLabel(active)}” — on a first visit or any other`}>
                  <span className="gx-scenes__thumb gx-scenes__thumb--icon">
                    <Link2 size={14} />
                  </span>
                  <span className="gx-scenes__name">Copy link to this scene</span>
                </button>
              )}
            </div>
          )}
          {hovered && <SceneCard scene={hovered} onLoad={() => pick(hovered)} />}
        </div>
      )}
    </div>
  )
}

/** Counts computed on hover for scenes saved without them, kept per scene until the store changes. */
const countCache = new Map<string, { nodes: number; edges: number }>()

function SceneCard({ scene, onLoad }: { scene: AnyEntity; onLoad: () => void }) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const registry = useTypeRegistry()
  const d = scene.data as SceneData
  const filter = d.filterId ? store.get(d.filterId) : undefined
  const layout = d.layoutId ? store.get(d.layoutId) : undefined
  const style = d.renderingId ? store.get(d.renderingId) : undefined
  const analysis = d.analysisId ? store.get(d.analysisId) : undefined
  const project = d.projectId ? store.get(d.projectId) : undefined
  const counts = useMemo(() => {
    if (d.stats) return { ...d.stats, at: 'saved' as const }
    const key = `${scene.id}:${version}`
    const hit = countCache.get(key)
    if (hit) return { ...hit, at: 'now' as const }
    // The filter as the scene would run it, over the dataset the scene names — the count the view would show.
    const spec = toFilterSpec((filter?.data as FilterData | undefined) ?? {})
    const p = isProject(project) ? project : undefined
    const slice = applyFilter(store, registry, spec, { members: p ? projectMembers(p) : undefined, values: makeValueContext({ scope: 'dataset', store, overlay: p ? projectOverlay(p) : undefined }) })
    const c = { nodes: slice.nodes.length, edges: slice.edges.length }
    countCache.clear()
    countCache.set(key, c)
    return { ...c, at: 'now' as const }
  }, [scene.id, d.stats, filter, project, store, registry, version])
  const algorithm = (d.algorithm ?? (layout?.data as LayoutData | undefined)?.algorithm) as LayoutAlgorithm | undefined
  const positions = Object.keys((layout?.data as LayoutData | undefined)?.positions ?? {}).length
  const metrics = analysis ? Object.keys((analysis.data as AnalysisData).columns ?? {}) : []
  const parts = [d.filterId, d.layoutId, d.renderingId, d.analysisId].filter(Boolean).length
  const v = d.view
  return (
    <div className="gx-scenecard" role="region" aria-label={`About ${displayLabel(scene)}`}>
      {scenePicture(d.preview) ? <img className="gx-scenecard__img" src={scenePicture(d.preview)} alt="" /> : <div className="gx-scenecard__img gx-scenecard__img--none muted">No picture</div>}
      <div className="gx-scenecard__body">
        <div className="gx-scenecard__title">{displayLabel(scene)}</div>
        {scene.description && <p className="gx-scenecard__desc">{scene.description}</p>}
        <dl className="gx-scenecard__facts">
          <dt>In view</dt>
          <dd>
            {counts.nodes.toLocaleString()} nodes · {counts.edges.toLocaleString()} edges{counts.at === 'now' && <span className="muted"> (now)</span>}
          </dd>
          <dt>Page</dt>
          <dd>
            Unigraph · {(sceneDimensions(d.mode) ?? sceneDimensions(d.renderer) ?? '2d').toUpperCase()}
          </dd>
          <dt>Filter</dt>
          <dd>{filter ? describeFilter(toFilterSpec(filter.data as FilterData)) : d.filterId ? <span className="muted">missing</span> : 'everything'}</dd>
          <dt>Layout</dt>
          <dd>
            {algorithm && layoutInfo(algorithm) ? layoutInfo(algorithm).label : layout ? 'positions' : d.layoutId ? <span className="muted">missing</span> : 'recomputed on load'}
            {positions > 0 && ` · ${positions.toLocaleString()} positions held`}
          </dd>
          <dt>Style</dt>
          <dd>{style ? describeRendering(toRenderingSpec(style.data as RenderingData)) : d.renderingId ? <span className="muted">missing</span> : 'default'}</dd>
          {(analysis || d.analysisId) && (
            <>
              <dt>Analysis</dt>
              <dd>{analysis ? metrics.join(', ') || 'metrics' : <span className="muted">missing</span>}</dd>
            </>
          )}
          {project && (
            <>
              <dt>Dataset</dt>
              <dd>{displayLabel(project)}</dd>
            </>
          )}
          {v && (
            <>
              <dt>View</dt>
              <dd>
                {[v.camera ? 'camera' : '', v.labels ? `labels ${v.labels}` : '', v.showEdges === false ? 'edges hidden' : '', v.showLegend === false ? 'no legend' : '', v.selectedIds?.length ? `${v.selectedIds.length} selected` : '', v.panel ? `${v.panel} panel` : ''].filter(Boolean).join(' · ') || 'as saved'}
              </dd>
            </>
          )}
          <dt>Saved</dt>
          <dd>
            {formatDate(scene.meta.updatedAt)} · {parts} part{parts === 1 ? '' : 's'} · <span className="muted">{registry.get(scene.type).label}</span>
          </dd>
        </dl>
        <button className="btn btn--sm btn--primary" onClick={onLoad}>
          Load
        </button>
      </div>
    </div>
  )
}

/** A scene's saved picture is drawn only in the shapes the app writes it in — a `data:` JPEG or SVG — never an address (a bundle could name any host). */
const scenePicture = (v: unknown): string | undefined => (typeof v === 'string' && /^data:image\/(jpeg|png|svg\+xml)[;,]/.test(v) ? v : undefined)
