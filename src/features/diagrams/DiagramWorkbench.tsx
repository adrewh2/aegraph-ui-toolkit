import { Code2, Copy, Download, Expand, FileCode2, Maximize2, PencilLine, PenTool, Save, Shrink, ZoomIn, ZoomOut } from 'lucide-react'
import { Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '../../components/ui/Dialog'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { detectDiagramFormat, parseDiagram, switchDiagramFormat, type DiagramFormat, type DiagramGeometry, type ParsedDiagram } from '../../core/diagrams'
import { useEntityStore } from '../../core/entity/hooks'
import { DiagramEditor, sceneSummary, sceneToPng, sceneToSvg, type DiagramEditorHandle } from '../../diagram-editor'
import { downloadText } from '../../lib/download'
import { formatDate } from '../../lib/format'
import { createDiagram, TEMPLATES, type DiagramEntity } from './diagrams'
import { KeysHint } from '../../components/KeysHint/KeysHint'
import { MAX_ZOOM, MIN_ZOOM, usePreviewKeys } from './usePreviewKeys'
import { DiagramPicture } from './DiagramPicture'
import { GRAPHVIZ_ENGINES, atIntrinsicSize, extractGeometry, layoutEngine, renderDiagram, svgToPng } from './render'
import './diagrams.css'
import { Select } from '../../components/ui/Select'

const FORMAT_LABEL: Record<DiagramFormat, string> = { dot: 'Graphviz', mermaid: 'Mermaid', excalidraw: 'Excalidraw' }
const FORMAT_TITLE: Record<DiagramFormat, string> = { dot: 'Graphviz DOT', mermaid: 'Mermaid', excalidraw: 'Excalidraw (JSON)' }

const safeKind = (source: string, format: DiagramFormat) => {
  try {
    return parseDiagram(source, format).kind
  } catch {
    return 'unknown'
  }
}

/** Source/format/engine state with debounced save to the entity and a debounced live render. */
export function useDiagramEditor(diagram: DiagramEntity) {
  const store = useEntityStore()
  const [source, setSource] = useState(diagram.data.source)
  const [format, setFormat] = useState<DiagramFormat>(diagram.data.format)
  const [engine, setEngine] = useState<(typeof GRAPHVIZ_ENGINES)[number]>(() => layoutEngine(diagram.data.source) ?? 'dot')
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const renderTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const seq = useRef(0)

  // Keep local state in sync if the entity changes elsewhere (assistant, inspector).
  const [seen, setSeen] = useState(diagram.data.source)
  if (diagram.data.source !== seen) {
    setSeen(diagram.data.source)
    if (diagram.data.source !== source) setSource(diagram.data.source)
  }

  const parsed = useMemo<ParsedDiagram>(() => {
    try {
      return parseDiagram(source, format)
    } catch (e) {
      return { format, kind: 'unknown' as const, attrs: {}, nodes: [], edges: [], groups: [], warnings: [String(e)] }
    }
  }, [source, format])

  const dirty = source !== diagram.data.source || format !== diagram.data.format
  /** The drawing canvas, when one is mounted: asked for its pending edit before anything that reads the source. */
  const canvasRef = useRef<DiagramEditorHandle>(null)
  const flush = () => canvasRef.current?.flush()
  // Leaving the page must not lose what a debounce still holds — the canvas's or the save's.
  const latest = useRef({ source, format, dirty, kind: parsed.kind })
  latest.current = { source, format, dirty, kind: parsed.kind }
  const unmounted = useRef(false)
  /** Write source and format onto the entity as it is *now* in the store — never onto a snapshot of its data, which would clobber `sources` set by a switch in between. */
  const writeNow = (text: string, fmt: DiagramFormat) => {
    clearTimeout(saveTimer.current)
    const e = store.get(diagram.id)
    if (!e) return
    if (text !== e.data.source || fmt !== e.data.format) store.update(diagram.id, { data: { ...(e.data as DiagramEntity['data']), source: text, format: fmt, kind: safeKind(text, fmt) } })
  }
  /** The canvas's edits: state while mounted; straight to the entity once the page is gone. */
  const onSourceChange = (text: string) => {
    latest.current = { ...latest.current, source: text, dirty: true }
    if (unmounted.current) writeNow(text, latest.current.format)
    else setSource(text)
  }
  useEffect(
    () => () => {
      unmounted.current = true
      const l = latest.current
      if (l.dirty) writeNow(l.source, l.format)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diagram.id],
  )
  /** Write what is in the editor to the entity now (the debounce does it on its own after a pause). */
  const saveNow = () => writeNow(flush() ?? source, format)
  useEffect(() => {
    if (!dirty) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => writeNow(source, format), 500)
    return () => clearTimeout(saveTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, format])

  useEffect(() => {
    clearTimeout(renderTimer.current)
    const my = ++seq.current
    setRendering(true)
    renderTimer.current = setTimeout(async () => {
      try {
        const out = await renderDiagram(source, format, engine)
        if (my !== seq.current) return
        setSvg(out)
        setError(null)
      } catch (e) {
        if (my !== seq.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (my === seq.current) setRendering(false)
      }
    }, 350)
    return () => clearTimeout(renderTimer.current)
  }, [source, format, engine])

  /**
   * Show the diagram in another format without losing anything: the text
   * it last had there when nothing changed, else that text brought up to
   * date (see core/diagrams/sync). Every format's text is kept on the
   * entity, so the switch is written at once, not after the save pause.
   */
  const convert = async (to?: DiagramFormat) => {
    const target: DiagramFormat = to ?? (format === 'dot' ? 'mermaid' : format === 'mermaid' ? 'excalidraw' : 'dot')
    // An edit the canvas had not yet handed over counts.
    const text = flush() ?? source
    let rendered: DiagramGeometry | undefined
    // Where the renderer put things, for nodes the drawing has never placed.
    if (target === 'excalidraw' && format !== 'excalidraw') {
      try {
        rendered = await extractGeometry(text, format, parsed, engine)
      } catch {
        /* the writer lays it out itself */
      }
    }
    const live = (store.get(diagram.id)?.data as DiagramEntity['data'] | undefined) ?? diagram.data
    const r = switchDiagramFormat({ format, source: text, sources: live.sources, rendered }, target)
    clearTimeout(saveTimer.current)
    store.update(diagram.id, { data: { ...live, source: r.source, format: r.format, kind: safeKind(r.source, r.format), sources: r.sources } })
    setSource(r.source)
    setFormat(r.format)
    const eng = r.format === 'dot' ? layoutEngine(r.source) : undefined
    if (eng) setEngine(eng)
    return r
  }

  /** A copy under a new name, with every format's text; the caller decides whether to open it. */
  const saveAs = (label: string) => {
    const text = flush() ?? source
    writeNow(text, format)
    const copy = createDiagram(store, { label: label.trim() || `${diagram.label ?? 'Diagram'} copy`, source: text, format, tags: diagram.tags })
    const live = store.get(diagram.id)?.data as DiagramEntity['data'] | undefined
    if (live?.sources) store.update(copy.id, { data: { ...copy.data, sources: live.sources } })
    return copy
  }

  const download = async (what: 'source' | 'svg' | 'png') => {
    const base = (diagram.label ?? 'diagram').replace(/[^\w.-]+/g, '_')
    const canvas = format === 'excalidraw'
    if (what === 'source') downloadText(`${base}.${format === 'dot' ? 'dot' : format === 'mermaid' ? 'mmd' : 'excalidraw'}`, source, canvas ? 'application/json' : 'text/plain')
    else if (what === 'svg') downloadText(`${base}.svg`, canvas ? await sceneToSvg(source) : svg, 'image/svg+xml')
    else {
      const a = document.createElement('a')
      a.href = canvas ? URL.createObjectURL(await sceneToPng(source)) : await svgToPng(svg)
      a.download = `${base}.png`
      a.click()
      if (canvas) setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    }
  }

  return { source, setSource, onSourceChange, canvasRef, format, setFormat, engine, setEngine, svg, error, rendering, parsed, convert, dirty, saveNow, saveAs, download }
}

export type DiagramEditor = ReturnType<typeof useDiagramEditor>

interface WorkbenchProps {
  diagram: DiagramEntity
  editor: DiagramEditor
  /** Stacked layout with an Edit/View switch — for the inspector. */
  compact?: boolean
}

/** The preview's keys, as the hint in its corner says them (`usePreviewKeys`). */
const PREVIEW_KEYS = [
  { keys: ['←', '↑', '→', '↓'], label: 'pan' },
  { keys: ['−', '+'], label: 'zoom' },
  { keys: ['Shift'], label: 'fast' },
]

/**
 * The diagram tools: format tabs, engine, convert, templates, zoom, copy and
 * downloads, over a source editor beside (or above) the live render. Shared
 * by the diagram page and the Library inspector.
 */
export function DiagramWorkbench({ diagram, editor, compact = false }: WorkbenchProps) {
  const toast = useToast()
  const { source, setSource, format, setFormat, engine, setEngine, svg, error, rendering, parsed, dirty, saveNow, download } = editor
  const [zoom, setZoom] = useState(1)
  const previewRef = useRef<HTMLDivElement>(null)
  // At its own size, so the zoom scales it (Mermaid's picture is otherwise as wide as the pane, whatever the zoom).
  const sizedSvg = useMemo(() => atIntrinsicSize(svg), [svg])
  /** Zoom so the whole render shows in the pane (never enlarging past 1:1). */
  const fit = () => {
    const host = previewRef.current
    const el = host?.querySelector<HTMLImageElement>('.dgp__svg img')
    if (!host || !el) return setZoom(1)
    // The picture is an image: measured once it has decoded.
    if (!el.complete) return void el.addEventListener('load', fit, { once: true })
    // The box as laid out (Graphviz sizes in pt, Mermaid in px), unscaled by the zoom in effect.
    const box = el.getBoundingClientRect()
    const current = Number((host.querySelector<HTMLElement>('.dgp__svg')?.style.zoom || '1') as string) || 1
    const w = box.width / current
    const h = box.height / current
    if (!w || !h) return setZoom(1)
    setZoom(Math.max(0.1, Math.min(1, (host.clientWidth - 24) / w, (host.clientHeight - 24) / h)))
  }
  // A new diagram or format fits itself once; the user's zooming is kept across re-renders of the same one.
  const fitFor = useRef<string | null>(null)
  useEffect(() => {
    const key = `${diagram.id}|${format}`
    if (!svg || fitFor.current === key) return
    fitFor.current = key
    requestAnimationFrame(fit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg, diagram.id, format])
  const [templates, setTemplates] = useState<{ x: number; y: number } | null>(null)
  const [split, setSplit] = useState(0.42)
  // A drawing opens on the canvas; text formats open on their source. The inspector's compact form starts on the render.
  const [mode, setMode] = useState<'view' | 'edit' | 'draw'>(compact ? 'view' : format === 'excalidraw' ? 'draw' : 'edit')
  const [saveAs, setSaveAs] = useState<string | null>(null)
  const canvas = format === 'excalidraw'

  /** Draw: on the canvas when the diagram is one, else converted into one first (the text formats survive as a format tab). */
  const draw = async () => {
    if (!canvas) {
      try {
        const r = await editor.convert('excalidraw')
        toast(r.how === 'exact' ? 'Back to the drawing as you left it' : r.how === 'reconciled' ? 'Drawing brought up to date' : 'Converted to a drawing — the text formats are one tab away')
      } catch (err) {
        toast(`Can't draw this yet: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
    setMode('draw')
  }
  /** The format tabs convert: a source pasted in the target's own syntax is just relabelled, anything else is translated. */
  const switchFormat = async (target: DiagramFormat) => {
    if (target === format) return
    // Text pasted in the target's own syntax, which the current format can't even read: just relabel it.
    if (parsed.nodes.length === 0 && parsed.edges.length === 0 && detectDiagramFormat(source) === target) {
      setFormat(target)
      return
    }
    try {
      const r = await editor.convert(target)
      toast(r.how === 'exact' ? `Back to ${FORMAT_LABEL[target]} as you left it` : r.how === 'reconciled' ? `${FORMAT_LABEL[target]} brought up to date` : `Converted to ${FORMAT_LABEL[target]}`)
    } catch (err) {
      // The current text doesn't parse: nothing to convert from; the source stays as it is.
      toast(`Can't convert: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // A drawing is for drawing; the text formats show their source.
    setMode(target === 'excalidraw' ? 'draw' : mode === 'draw' ? 'edit' : mode)
  }

  const onDrag = (e: ReactPointerEvent) => {
    const host = (e.currentTarget as HTMLElement).parentElement!
    const rect = host.getBoundingClientRect()
    const move = (ev: PointerEvent) => setSplit(Math.max(0.2, Math.min(0.8, (compact ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width))))
    const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up))
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const templateItems: MenuItem[] = TEMPLATES.map((t) => ({ kind: 'item', label: t.label, onSelect: () => (setFormat(t.format), setSource(t.source), setMode(t.format === 'excalidraw' ? 'draw' : compact ? 'edit' : 'edit')) }))
  // Maximised, the rendering has the whole split to itself: the source editor and the gutter step aside.
  const [maxed, setMaxed] = useState(false)
  const showEditor = mode === 'edit' && !maxed
  useEffect(() => {
    requestAnimationFrame(fit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxed])
  const showCanvas = mode === 'draw' && canvas
  // The arrow keys and − + over the picture — on the diagram's page, not the compact form in an inspector or a panel.
  usePreviewKeys(previewRef, zoom, setZoom, !showCanvas && !!svg && !compact)
  const summary = canvas ? sceneSummary(source) : undefined
  // Templates are a starting point, offered only while there is nothing to lose: an empty canvas, blank source, or a
  // graph with no nodes yet. A diagram with content (loaded, imported, drawn) never gets one written over it — the
  // editor saves on its own after a pause, so a template picked there would have replaced the saved diagram.
  const blank = !source.trim() || (canvas ? summary!.elements === 0 : parsed.warnings.length === 0 && parsed.nodes.length === 0 && parsed.edges.length === 0)
  const stats = canvas ? `${summary!.elements} elements · ${summary!.shapes} shapes · ${summary!.arrows} connectors · ${summary!.text} text` : `${parsed.kind} · ${parsed.nodes.length} nodes · ${parsed.edges.length} edges${parsed.groups.length ? ` · ${parsed.groups.length} groups` : ''}${parsed.warnings.length ? ` · ${parsed.warnings.length} warnings` : ''}`

  const sourceEditor = (
    <div className="dgp__editor" style={compact ? { flexBasis: `${split * 100}%` } : { flexBasis: `${split * 100}%` }}>
      <textarea
        className="dgp__source"
        value={source}
        spellCheck={false}
        onChange={(e) => setSource(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault()
            const el = e.currentTarget
            const { selectionStart: s, selectionEnd: en } = el
            setSource(source.slice(0, s) + '  ' + source.slice(en))
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
          }
        }}
      />
      {parsed.warnings.length > 0 && (
        <div className="dgp__warnings">
          {parsed.warnings.slice(0, 3).map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className={`dgw ${compact ? 'dgw--compact' : ''}`}>
      <div className={compact ? 'dgw__bar' : 'dp__toolbar'}>
        <div className="tb" role="toolbar" aria-label="Diagram">
          <div className="gx-tabs">
            {compact && (
              <button className={`gx-tab ${mode === 'view' ? 'is-active' : ''}`} onClick={() => setMode('view')}>
                View
              </button>
            )}
            <button className={`gx-tab ${mode === 'draw' ? 'is-active' : ''}`} onClick={draw} title={canvas ? 'Draw on the canvas' : 'Convert to a drawing and open the canvas'}>
              <PenTool size={12} /> Draw
            </button>
            <button className={`gx-tab ${mode === 'edit' ? 'is-active' : ''}`} onClick={() => setMode('edit')} title="Edit the source text">
              {compact ? <PencilLine size={12} /> : <Code2 size={12} />} Source
            </button>
          </div>
          <span className="tb__sep" />
          <div className="gx-tabs">
            {(['dot', 'mermaid', 'excalidraw'] as const).map((f) => (
              <button key={f} className={`gx-tab ${format === f ? 'is-active' : ''}`} onClick={() => switchFormat(f)} title={format === f ? FORMAT_TITLE[f] : `Convert to ${FORMAT_LABEL[f]} (structure, groups, colours and geometry are kept)`}>
                {FORMAT_LABEL[f]}
              </button>
            ))}
          </div>
          {format === 'dot' && (
            <Select className="gx-select" value={engine} onChange={(e) => setEngine(e.target.value as typeof engine)} title="Layout engine">
              {GRAPHVIZ_ENGINES.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          )}
          {blank && (
            <button className="btn btn--sm" title="Start this empty diagram from a template" onClick={(e) => setTemplates({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })}>
              <FileCode2 size={13} /> Templates
            </button>
          )}
          {!showCanvas && (
            <>
              <span className="tb__sep" />
              <button className="btn btn--sm btn--icon" title="Zoom out (−)" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.25))}>
                <ZoomOut size={13} />
              </button>
              <button className="btn btn--sm btn--icon" title="Zoom in (+)" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.25))}>
                <ZoomIn size={13} />
              </button>
              <button className="btn btn--sm btn--icon" title="Fit to the pane" onClick={fit}>
                <Maximize2 size={13} />
              </button>
              {mode === 'edit' && (
                <button className={`btn btn--sm btn--icon ${maxed ? 'is-on' : ''}`} title={maxed ? 'Show the source again' : 'Maximize the rendering — hide the source'} onClick={() => setMaxed((v) => !v)}>
                  {maxed ? <Shrink size={13} /> : <Expand size={13} />}
                </button>
              )}
            </>
          )}
          {compact && (
            <>
              <span className="tb__sep" />
              <button className="btn btn--sm" onClick={saveNow} disabled={!dirty} title={dirty ? 'Save now (changes save on their own after a pause)' : 'Everything is saved'}>
                <Save size={13} /> {dirty ? 'Save' : 'Saved'}
              </button>
              <button className="btn btn--sm" onClick={() => setSaveAs(`${diagram.label ?? 'Diagram'} copy`)} title="Keep this one as it is and continue in a copy">
                Save as…
              </button>
              <span className="tb__sep" />
              <button className="btn btn--sm" onClick={() => (navigator.clipboard.writeText(source), toast('Source copied'))}>
                <Copy size={13} /> Copy
              </button>
              <button className="btn btn--sm" onClick={() => download('source')}>
                <Download size={13} /> .{format === 'dot' ? 'dot' : format === 'mermaid' ? 'mmd' : 'excalidraw'}
              </button>
              <button className="btn btn--sm" onClick={() => download('svg')} disabled={!svg && !canvas}>
                <Download size={13} /> SVG
              </button>
              <button className="btn btn--sm" onClick={() => download('png')} disabled={!svg && !canvas}>
                <Download size={13} /> PNG
              </button>
            </>
          )}
        </div>
        {!compact && (
          <>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: 12 }}>
              {stats}
              {diagram.data.lastImport ? ` · exported ${formatDate(diagram.data.lastImport.at)}` : ''}
            </span>
            <span className="dp__edited muted" title={new Date(diagram.meta.updatedAt).toLocaleString()}>
              Edited {formatDate(diagram.meta.updatedAt)}
            </span>
          </>
        )}
      </div>

      {showCanvas ? (
        <div className="dgp__canvas">
          <Suspense fallback={<div className="vp__loading muted">Loading the canvas…</div>}>
            {/* In development the canvas API is reachable from the console (`__aegraph.canvas`) for scripted checks. */}
            <DiagramEditor ref={editor.canvasRef} source={source} onChange={editor.onSourceChange} onApi={import.meta.env.DEV ? (api) => ((window as unknown as { __aegraph?: Record<string, unknown> }).__aegraph ??= {}).canvas = api : undefined} />
          </Suspense>
        </div>
      ) : (
        <div className={`dgp__split ${compact ? 'dgp__split--stacked' : ''}`}>
          {showEditor && sourceEditor}
          {showEditor && <div className="dgp__gutter" onPointerDown={onDrag} />}
          <div className="dgp__stage">
            <div className="dgp__preview" ref={previewRef}>
              {error && <div className="dgp__error">{error}</div>}
              {rendering && !svg && <div className="vp__loading muted">Rendering…</div>}
              <div className={`dgp__svg ${rendering ? 'is-stale' : ''}`} style={{ zoom }}>
                <DiagramPicture svg={sizedSvg} />
              </div>
            </div>
            {svg && !compact && <KeysHint items={PREVIEW_KEYS} />}
          </div>
        </div>
      )}
      {compact && <div className="dgw__status muted">{stats}</div>}
      {templates && <Menu x={templates.x} y={templates.y} items={templateItems} onClose={() => setTemplates(null)} />}
      <SaveAsDialog editor={editor} diagram={diagram} name={saveAs} onName={setSaveAs} onClose={() => setSaveAs(null)} />
    </div>
  )
}

/** "Save as": a copy under a new name, opened in place of this one. */
export function SaveAsDialog({ editor, diagram, name, onName, onClose }: { editor: DiagramEditor; diagram: DiagramEntity; name: string | null; onName: (v: string) => void; onClose: () => void }) {
  const navigate = useNavigate()
  const toast = useToast()
  const submit = () => {
    if (!name?.trim()) return
    const copy = editor.saveAs(name)
    onClose()
    toast(`Saved as “${copy.label}”`)
    navigate(`/diagrams/${copy.id}`)
  }
  return (
    <Dialog
      open={name !== null}
      title="Save as"
      description={`A new diagram with this content, in every format it has been shown in; “${diagram.label ?? 'this one'}” keeps what was saved last.`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!name?.trim()}>
            Save copy
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input className="input" autoFocus value={name ?? ''} onChange={(e) => onName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
    </Dialog>
  )
}
