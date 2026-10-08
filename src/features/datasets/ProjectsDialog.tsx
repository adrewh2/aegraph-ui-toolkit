import { Database, Download, FlaskConical, FolderClosed, GitFork, Sparkles, Trash2, Upload, type LucideIcon } from 'lucide-react'
import { useCallback, useRef, useState, type DragEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AnyEntity } from '../../core/entity/types'
import { usePersistStatus, usePersistence } from '../../app/providers'
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { ChatGptImportCard } from '../conversations/ChatGptImportCard'
import { SpotifyCard } from '../spotify/SpotifyCard'
import { YourProjectsPanel } from '../projects/ProjectsPanel'
import { DemosPanel } from '../projects/DemosPanel'
import { LocalDemosCard } from './LocalDemosCard'
import { DBPEDIA_DEMO_ID, LinkedDataCard } from './LinkedDataCard'
import { fetchDemoCatalog } from './demos'
import { openBundleUrl } from '../projects/projectActions'
import { isAtlas, parseAtlas } from '../../core/exchange/atlas'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import { exportToBlob, saveBlob } from '../../core/exchange/export'
import { FORMATS, supportsGzip, type FormatId } from '../../core/exchange/formats'
import { GRAPH_FORMATS, GRAPH_IMPORT_ACCEPT, isGraphFormatId, matchGraphImport, type GraphFormat, type GraphFormatId } from '../../core/exchange/graph/graphFormats'
import { exportWorkspaceGraph } from '../exchange/exportGraph'
import { GraphImportWizard } from '../exchange/GraphImportWizard'
import { downloadFiles } from '../graph/exportView'
import { GENERATOR_TAG_INFO } from '../../core/exchange/generate'
import { generateInWorker } from '../../core/exchange/generateInWorker'
import { importFile, loadParsed, parseFile, type ImportProgress } from '../../core/exchange/import'
import { openBundleFile } from '../projects/projectActions'
import { TemplateCard } from '../projects/TemplateCard'
import { formatNumber } from '../../lib/format'

/** A byte count as people read it. */
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`)
import { DIAGRAM_EXTENSIONS, detectDiagramFormat, diagramFromEntities, writeDiagram, type DiagramFormat } from '../../core/diagrams'
import { useTypeRegistry } from '../../core/entity/hooks'
import { createDiagram } from '../diagrams/diagrams'
import { displayLabel } from '../../core/entity/entity'
import { downloadText } from '../../lib/download'
import './DatasetsView.css'
import './ProjectsDialog.css'
import { Select } from '../../components/ui/Select'

/** A pack, or JSON that says it is an aegraph document with a project key (the bundle's own project) — peeking at the head only. */
async function looksLikeBundle(file: File): Promise<boolean> {
  if (/\.aeb$|\.ae\.json(\.gz)?$|\.ae(\.gz)?$|\.aegraph\.json(\.gz)?$/i.test(file.name)) return true
  if (!/\.json$/i.test(file.name)) return false
  const head = await file.slice(0, 4096).text()
  return /"\$schema"\s*:\s*"aegraph\/v1"/.test(head) && /"project"\s*:\s*"/.test(head)
}

type Job = { label: string; done: number; total: number; detail?: string } | null

const PRESETS: { label: string; target: number; hint: string }[] = [
  { label: '10k', target: 10_000, hint: 'instant' },
  { label: '100k', target: 100_000, hint: '~1s' },
  { label: '250k', target: 250_000, hint: '~2s' },
  { label: '500k', target: 500_000, hint: '~5s, ~400 MB RAM' },
  { label: '1M', target: 1_000_000, hint: 'stress test — expect ~1 GB RAM' },
]

export type ProjectsTab = 'projects' | 'demos' | 'import' | 'examples' | 'export' | 'library'
/** `hint` is said on the tabs that have no bar of their own; the first two say what they are in theirs. */
const TABS: { id: ProjectsTab; label: string; icon: LucideIcon; hint?: string }[] = [
  { id: 'projects', label: 'Your projects', icon: FolderClosed },
  { id: 'demos', label: 'Demos', icon: Sparkles },
  { id: 'import', label: 'Import', icon: Upload, hint: 'Bring data in: files, linked data, a ChatGPT export, your Spotify library.' },
  { id: 'examples', label: 'Examples', icon: FlaskConical, hint: 'Project templates and the synthetic graph generator. The demo projects are on Demos.' },
  { id: 'export', label: 'Export', icon: Download, hint: 'Take the Library or the open project out, as data or as a diagram.' },
  { id: 'library', label: 'Library', icon: Database, hint: 'What is in this browser, and how to empty it.' },
]

/**
 * Everything to do with getting data in and out, in one dialog: opening a
 * project, importing files and feeds, the examples and the generator,
 * exporting, and the Library itself. It was a page of its own — a long grid
 * of cards where a project bundle sat beside a CSV importer and a "when
 * loading" radio that applied to some of them — and a dataset is really a
 * project, so it belongs where projects are opened.
 */
export function ProjectsDialog({ tab: startTab = 'projects', onClose }: { tab?: ProjectsTab; onClose: () => void }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const persistence = usePersistence()
  const persist = usePersistStatus()
  const toast = useToast()
  const navigate = useNavigate()

  const [tab, setTab] = useState<ProjectsTab>(startTab)
  const [job, setJob] = useState<Job>(null)
  const [log, setLog] = useState<string[]>([])
  // Merge unless asked otherwise: replace empties the whole Library — every project, and with them their history — so
  // choosing it asks first (`confirmReplace`), naming what goes.
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [target, setTarget] = useState(100_000)
  const [seed, setSeed] = useState(42)
  const [exportFormat, setExportFormat] = useState<FormatId | GraphFormatId>('jsonl')
  const [graphImport, setGraphImport] = useState<{ format: GraphFormat; files: File[] } | null>(null)
  const [gzip, setGzip] = useState(false)
  const registry = useTypeRegistry()
  const [diagFormat, setDiagFormat] = useState<DiagramFormat>('dot')
  const [diagCategory, setDiagCategory] = useState<'knowledge' | 'resource'>('knowledge')
  const [confirmClear, setConfirmClear] = useState(false)
  const [dragging, setDragging] = useState(false)
  const scopeLabel = store.scope ? displayLabel(store.get(store.scope) ?? ({ id: store.scope } as AnyEntity)) : null
  const abort = useRef<AbortController | null>(null)
  const [cancellable, setCancellable] = useState(false)

  const say = useCallback((line: string) => setLog((l) => [line, ...l].slice(0, 12)), [])
  const busy = job !== null

  const commit = async (entities: Parameters<typeof store.upsertMany>[0], tags: { tag: string; color?: string; description?: string }[], label: string) => {
    setJob({ label: `Indexing ${label}`, done: 0, total: 1 })
    await new Promise((r) => setTimeout(r, 0))
    const t0 = performance.now()
    store.transaction(() => {
      if (mode === 'replace') store.clear()
      for (const t of tags) store.setTagInfo(t.tag, t)
      store.upsertMany(entities)
    })
    return performance.now() - t0
  }

  /** The Linked data card's sample: the DBpedia demo, opened as its own project from the demos catalog. */
  const openDbpediaDemo = async () => {
    setJob({ label: 'Opening the DBpedia demo', done: 0, total: 1 })
    try {
      const demo = (await fetchDemoCatalog())?.demos.find((d) => d.id === DBPEDIA_DEMO_ID)
      if (!demo) throw new Error('this build carries no DBpedia demo — the demos come from the aegraph-ui-demos repository when the app is built')
      const r = await openBundleUrl(store, demo.bundleUrl)
      toast(`Opened “${displayLabel(r.project)}” · ${formatNumber(r.created)} new, ${formatNumber(r.updated)} updated`)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      say(`DBpedia demo: ${msg}`)
      toast(msg)
    } finally {
      setJob(null)
    }
  }

  const generate = async () => {
    abort.current = new AbortController()
    setCancellable(true)
    setJob({ label: 'Generating', done: 0, total: target })
    try {
      const t0 = performance.now()
      const { entities, stats } = await generateInWorker(target, seed, (p, est) => setJob({ label: 'Generating', done: p, total: est }), abort.current.signal)
      const gen = performance.now() - t0
      const idx = await commit(entities, GENERATOR_TAG_INFO, `${formatNumber(stats.total)} entities`)
      say(
        `Generated ${formatNumber(stats.total)} (${formatNumber(stats.people)} people, ${formatNumber(stats.works)} works, ${formatNumber(stats.concepts)} concepts, ${formatNumber(stats.relationships)} relationships) · worker ${gen.toFixed(0)}ms · indexed ${idx.toFixed(0)}ms`,
      )
      toast(`Generated ${formatNumber(stats.total)} entities`)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') say(`Generation failed: ${(err as Error).message}`)
    } finally {
      setJob(null)
      abort.current = null
      setCancellable(false)
    }
  }

  /** Diagram sources become a diagram resource, then the mapping wizard takes over. */
  const importDiagramFile = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const text = await file.text()
    const format = DIAGRAM_EXTENSIONS[ext] ?? detectDiagramFormat(text)
    const e = createDiagram(store, { label: file.name.replace(/\.[^.]+$/, ''), source: text, format, source_: 'import:file' })
    say(`Added diagram ${displayLabel(e)} (${format}); opening the export wizard`)
    navigate(`/diagrams/${e.id}?export=1`)
  }

  const exportDiagram = (save: boolean) => {
    const types = registry.inCategory(diagCategory, { withInstancesOnly: true }).map((t) => t.type)
    const nodes = store.query({ kind: 'entity', type: types })
    const ids = new Set(nodes.map((n) => n.id))
    const edges = store.relationships().filter((r) => ids.has(r.source.id) && ids.has(r.target.id))
    const d = diagramFromEntities(nodes, edges, registry, { name: diagCategory })
    const src = writeDiagram(d, diagFormat)
    if (save) {
      const e = createDiagram(store, { label: `${diagCategory} (${formatNumber(nodes.length)} nodes)`, source: src, format: diagFormat, tags: ['from-dataset'], source_: 'export:dataset' })
      navigate(`/diagrams/${e.id}`)
    } else downloadText(`${diagCategory}.${diagFormat === 'dot' ? 'dot' : 'mmd'}`, src, 'text/plain')
    say(`Diagram of ${formatNumber(nodes.length)} nodes and ${formatNumber(edges.length)} edges (${diagFormat})`)
  }

  /** An old-aegraph scene graph / pipeline atlas (`{ data: { graph } }`): converted in one go. Returns false when the file is something else. */
  const importAtlasFile = async (file: File): Promise<boolean> => {
    const head = await file.slice(0, 4096).text()
    if (!/"data"\s*:\s*\{[\s\S]*"graph"/.test(head) && !/"graph"\s*:\s*\{\s*"nodes"/.test(head)) return false
    setJob({ label: `Reading ${file.name}`, done: 0, total: file.size })
    try {
      const json = JSON.parse(await file.text()) as unknown
      if (!isAtlas(json)) return false
      const atlas = parseAtlas(json, { tag: file.name.replace(/\.json$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') })
      const ms = await commit(atlas.entities, atlas.tags, atlas.label)
      say(`${atlas.label}: ${formatNumber(atlas.nodes)} nodes, ${formatNumber(atlas.edges)} relationships, ${atlas.types.length} types · indexed ${ms.toFixed(0)}ms`)
      toast(`${atlas.label} loaded`)
      return true
    } catch (err) {
      say(`Atlas import failed: ${err instanceof Error ? err.message : String(err)}`)
      toast('Import failed')
      return true
    } finally {
      setJob(null)
    }
  }

  const doImport = async (file: File, all: File[] = [file]) => {
    const gi = matchGraphImport(all)
    if (gi) return setGraphImport({ format: gi.format, files: gi.files as File[] })
    if (DIAGRAM_EXTENSIONS[file.name.split('.').pop()?.toLowerCase() ?? '']) return importDiagramFile(file)
    if (/\.json$/i.test(file.name) && (await importAtlasFile(file))) return
    // A project bundle opens as the project — on the screen it was saved from — rather than merging into whatever is open.
    if (mode === 'merge' && (await looksLikeBundle(file))) {
      setJob({ label: `Opening ${file.name}`, done: 0, total: file.size })
      try {
        const r = await openBundleFile(store, file)
        say(`Opened “${displayLabel(r.project)}”: ${formatNumber(r.created)} new, ${formatNumber(r.updated)} updated, ${formatNumber(r.upToDate)} up to date`)
        toast(`Opened ${displayLabel(r.project)}`)
      } catch (err) {
        say(`Import failed: ${(err as Error).message}`)
        toast('Import failed')
      } finally {
        setJob(null)
      }
      return
    }
    abort.current = new AbortController()
    setCancellable(true)
    const onProgress = (p: ImportProgress) =>
      setJob({ label: p.phase === 'reading' ? `Reading ${file.name}` : 'Indexing', done: p.done, total: p.total, detail: `${formatNumber(p.count)} entities` })
    setJob({ label: `Reading ${file.name}`, done: 0, total: file.size })
    try {
      if (mode === 'merge') {
        const r = await importFile(file, store, { mode, onProgress, signal: abort.current.signal })
        say(`Imported ${formatNumber(r.count)} entities (${r.format}${r.skipped ? `, ${r.skipped} skipped` : ''}) in ${r.ms.toFixed(0)}ms`)
      } else {
        const t0 = performance.now()
        const parsed = await parseFile(file, { onProgress, signal: abort.current.signal })
        await loadParsed(parsed, store, { mode: 'replace', onProgress })
        say(`Imported ${formatNumber(parsed.entities.length)} entities (${parsed.format}${parsed.skipped ? `, ${parsed.skipped} skipped` : ''}) in ${(performance.now() - t0).toFixed(0)}ms`)
      }
      toast('Import complete')
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        say(`Import failed: ${(err as Error).message}`)
        toast('Import failed')
      }
    } finally {
      setJob(null)
      abort.current = null
      setCancellable(false)
    }
  }

  const doExport = async () => {
    if (isGraphFormatId(exportFormat)) {
      setJob({ label: `Exporting ${GRAPH_FORMATS.find((f) => f.id === exportFormat)!.label}`, done: 0, total: 1 })
      try {
        const files = await exportWorkspaceGraph(store, registry, exportFormat)
        downloadFiles(files)
        say(`Exported ${files.map((f) => `${f.name} (${bytes(f.text.length)})`).join(', ')}`)
      } catch (err) {
        say(`Export failed: ${(err as Error).message}`)
      } finally {
        setJob(null)
      }
      return
    }
    setJob({ label: `Exporting ${FORMATS[exportFormat].label}`, done: 0, total: 1 })
    try {
      // What the open project contains, or the whole Library.
      const r = await exportToBlob({ entities: store.all(), tags: store.tagInfos() }, { format: exportFormat, gzip, onProgress: (d, t) => setJob({ label: 'Exporting', done: d, total: t }) }, scopeLabel ? scopeLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'library')
      saveBlob(r.blob, r.filename)
      say(`Exported ${formatNumber(r.count)} entities → ${r.filename} (${bytes(r.bytes)}) in ${r.ms.toFixed(0)}ms`)
    } catch (err) {
      say(`Export failed: ${(err as Error).message}`)
    } finally {
      setJob(null)
    }
  }

  const clearAll = async () => {
    setConfirmClear(false)
    store.clear()
    await persistence.wipe().catch(() => {})
    say('Library cleared')
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const files = [...(e.dataTransfer.files ?? [])]
    if (files[0]) doImport(files[0], files)
  }

  const pick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    // Single-dot extensions only: a `.ae.json` token makes the macOS picker grey out every file.
    input.accept = '.aeb,.ae,.json,.jsonl,.ndjson,.csv,.gz,.dot,.gv,.mmd,.mermaid,' + GRAPH_IMPORT_ACCEPT
    input.onchange = () => {
      const files = [...(input.files ?? [])]
      if (files[0]) doImport(files[0], files)
    }
    input.click()
  }

  const entityN = store.entityCount()
  const relN = store.relationshipCount()

  return (
    <Dialog open title="Projects" onClose={onClose} className="projdlg" wide>
      <div className="projdlg__tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`projdlg__tab ${tab === t.id ? 'is-on' : ''}`} onClick={() => setTab(t.id)}>
            <t.icon size={15} aria-hidden />
            {t.label}
          </button>
        ))}
      </div>
      {TABS.find((t) => t.id === tab)?.hint && <p className="projdlg__hint">{TABS.find((t) => t.id === tab)?.hint}</p>}

      {job && (
        <div className="ds__job">
          <div className="ds__job-head">
            <span>{job.label}</span>
            <span className="muted">{job.detail ?? (job.total > 1 ? `${formatNumber(job.done)} / ${formatNumber(job.total)}` : '')}</span>
            {cancellable && (
              <button className="btn btn--sm btn--ghost" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            )}
          </div>
          <div className="ds__bar">
            <div className="ds__bar-fill" style={{ width: `${Math.min(100, (job.done / Math.max(1, job.total)) * 100)}%` }} />
          </div>
        </div>
      )}

      {/* Keyed by the tab, so each tab opens at its top rather than where the last one was scrolled to. */}
      <div className="projdlg__panel" key={tab}>
        {tab === 'projects' && <YourProjectsPanel onOpened={onClose} onDemos={() => setTab('demos')} />}
        {tab === 'demos' && <DemosPanel onOpened={onClose} />}

        {tab === 'import' && (
          <>
          <div className="ds__mode">
            <span className="muted">When loading:</span>
            <label>
              <input type="radio" checked={mode === 'replace'} onChange={() => (store.library.size() ? setConfirmReplace(true) : setMode('replace'))} /> Replace the Library
            </label>
            <label>
              <input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} /> Merge{scopeLabel ? ` into ${scopeLabel}` : ''}
            </label>
          </div>
            <div className="ds__grid projdlg__grid">
        <section
          className={`ds__card ds__drop ${dragging ? 'is-dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <header>
            <span className="ds__icon" style={{ background: '#dcfce7', color: '#166534' }}>
              <Upload size={18} />
            </span>
            <div>
              <h2>Import</h2>
              <p>
                Drop a file here or pick one. Accepts <code>.ae.json</code> (an aegraph document — see <Link to="/docs/spec">the file format</Link>), <code>.json</code> (document or plain array), <code>.jsonl</code>, <code>.csv</code>, each optionally <code>.gz</code>. JSONL and CSV stream, so size isn't a concern. Foreign records need only an <code>id</code>. Diagram files (<code>.dot</code>, <code>.gv</code>, <code>.mmd</code>) open the mapping wizard, and so do graph files — GEXF, GraphML, <code>.cyjs</code>, RDF, and <code>.parquet</code> (a points table, or drop a points and a links file together).
              </p>
            </div>
          </header>
          <div className="ds__actions">
            <button className="btn btn--primary" disabled={busy} onClick={pick}>
              Choose file…
            </button>
          </div>
        </section>
        <LocalDemosCard busy={busy} mode={mode} say={say} onJob={setJob} />
        <LinkedDataCard busy={busy} say={say} onImport={(format, files) => setGraphImport({ format, files })} onSample={() => void openDbpediaDemo()} />
        <ChatGptImportCard busy={busy} mode={mode} say={say} commit={commit} />
        <SpotifyCard busy={busy} say={say} />
            </div>
          </>
        )}

        {tab === 'examples' && (
          <>
          <div className="ds__mode">
            <span className="muted">When loading:</span>
            <label>
              <input type="radio" checked={mode === 'replace'} onChange={() => (store.library.size() ? setConfirmReplace(true) : setMode('replace'))} /> Replace the Library
            </label>
            <label>
              <input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} /> Merge{scopeLabel ? ` into ${scopeLabel}` : ''}
            </label>
          </div>
            <div className="ds__grid projdlg__grid">
        <TemplateCard busy={busy} say={say} />
        <section className="ds__card">
          <header>
            <span className="ds__icon" style={{ background: '#fde68a', color: '#92400e' }}>
              <FlaskConical size={18} />
            </span>
            <div>
              <h2>Synthetic academic graph</h2>
              <p>Deterministic generator shaped like the AcademicsKG demo — people, works, fields, concepts, influence, annotations. Same seed and size always produce the same ids, so regenerating merges cleanly. Runs in a Web Worker.</p>
            </div>
          </header>
          <div className="ds__presets">
            {PRESETS.map((p) => (
              <button key={p.target} className={`btn btn--sm ${target === p.target ? 'btn--primary' : ''}`} title={p.hint} onClick={() => setTarget(p.target)}>
                {p.label}
              </button>
            ))}
            <label className="ds__inline">
              custom
              <input className="input" type="number" min={100} step={1000} value={target} onChange={(e) => setTarget(Math.max(100, Number(e.target.value) || 100))} style={{ width: 120, height: 28 }} />
            </label>
            <label className="ds__inline">
              seed
              <input className="input" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} style={{ width: 90, height: 28 }} />
            </label>
          </div>
          <div className="ds__actions">
            <button className="btn btn--primary" disabled={busy} onClick={generate}>
              Generate {formatNumber(target)}
            </button>
            <span className="faint">{PRESETS.find((p) => p.target === target)?.hint ?? ''}</span>
          </div>
        </section>
            </div>
          </>
        )}

        {tab === 'export' && (
          <div className="ds__grid projdlg__grid">
        <section className="ds__card">
          <header>
            <span className="ds__icon" style={{ background: '#ede9fe', color: '#5b21b6' }}>
              <Download size={18} />
            </span>
            <div>
              <h2>Export {scopeLabel ?? 'the Library'}</h2>
              <p>{isGraphFormatId(exportFormat) ? 'Every browsable entity and the relationships among them, with type colours and the newest saved layout, for Gephi / Cytoscape / yEd.' : FORMATS[exportFormat].description}</p>
            </div>
          </header>
          <div className="ds__presets">
            {(Object.keys(FORMATS) as FormatId[]).map((f) => (
              <button key={f} className={`btn btn--sm ${exportFormat === f ? 'btn--primary' : ''}`} onClick={() => setExportFormat(f)}>
                {FORMATS[f].label}
              </button>
            ))}
            {GRAPH_FORMATS.filter((f) => f.canExport).map((f) => (
              <button key={f.id} className={`btn btn--sm ${exportFormat === f.id ? 'btn--primary' : ''}`} onClick={() => setExportFormat(f.id)} title="Graph interchange format: nodes, relationships, colours and the newest layout's positions">
                {f.label}
              </button>
            ))}
            <label className="ds__inline" title={supportsGzip() ? '' : 'CompressionStream not available in this browser'}>
              <input type="checkbox" checked={gzip} disabled={!supportsGzip()} onChange={(e) => setGzip(e.target.checked)} /> gzip
            </label>
          </div>
          <div className="ds__actions">
            <button className="btn btn--primary" disabled={busy || store.size() === 0} onClick={doExport}>
              Export {formatNumber(store.size())} entities
            </button>
          </div>
        </section>
        <section className="ds__card">
          <header>
            <span className="ds__icon" style={{ background: '#cffafe', color: '#155e75' }}>
              <GitFork size={18} />
            </span>
            <div>
              <h2>Export as diagram</h2>
              <p>Turn a category of the dataset into a Graphviz or Mermaid diagram — types become clusters, relationships become labelled edges. Save it as a diagram resource to edit and re-export, or download the source.</p>
            </div>
          </header>
          <div className="ds__presets">
            <button className={`btn btn--sm ${diagFormat === 'dot' ? 'btn--primary' : ''}`} onClick={() => setDiagFormat('dot')}>
              Graphviz
            </button>
            <button className={`btn btn--sm ${diagFormat === 'mermaid' ? 'btn--primary' : ''}`} onClick={() => setDiagFormat('mermaid')}>
              Mermaid
            </button>
            <label className="ds__inline">
              scope
              <Select className="input" style={{ height: 28 }} value={diagCategory} onChange={(e) => setDiagCategory(e.target.value as 'knowledge' | 'resource')}>
                <option value="knowledge">Knowledge ({formatNumber(registry.countInCategory('knowledge'))})</option>
                <option value="resource">Resources ({formatNumber(registry.countInCategory('resource'))})</option>
              </Select>
            </label>
          </div>
          <div className="ds__actions">
            <button className="btn btn--primary" disabled={busy || registry.countInCategory(diagCategory) === 0} onClick={() => exportDiagram(true)}>
              Save as diagram
            </button>
            <button className="btn" disabled={busy || registry.countInCategory(diagCategory) === 0} onClick={() => exportDiagram(false)}>
              Download
            </button>
            {registry.countInCategory(diagCategory) > 3000 && <span className="faint">large — rendering will be slow</span>}
          </div>
        </section>
          </div>
        )}

        {tab === 'library' && (
          <>
          <p className="projdlg__summary">
            {formatNumber(entityN)} entities · {formatNumber(relN)} relationships · {formatNumber(registry.all().filter((t) => t.count + t.relationshipCount > 0).length)} types · {formatNumber(store.tags().length)} tags ·{' '}
            {persist.state === 'saving' ? `saving to this browser… (${persist.pending})` : persist.state === 'error' ? `storage error: ${persist.error ?? 'unknown'}` : 'synced to this browser'}
          </p>
            <div className="ds__grid projdlg__grid">
        <section className="ds__card">
          <header>
            <span className="ds__icon" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
              <Database size={18} />
            </span>
            <div>
              <h2>Library</h2>
              <p>Everything — every project included — lives in this browser's IndexedDB and is written incrementally as you edit. Clearing removes it all from memory and disk.</p>
            </div>
          </header>
          <div className="ds__actions">
            <button className="btn btn--danger" disabled={busy || store.size() === 0} onClick={() => setConfirmClear(true)}>
              <Trash2 size={14} /> Clear the Library
            </button>
          </div>
        </section>            </div>
            {log.length > 0 && (
              <section className="ds__log">
                <h3>Activity</h3>
                {log.map((l, i) => (
                  <div key={i} className="mono">
                    {l}
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmReplace}
        title="Replace the whole Library when loading?"
        message={`What you load next will take the place of everything here: ${formatNumber(store.library.size())} entities, in ${formatNumber(store.library.ofType('project').length)} project${store.library.ofType('project').length === 1 ? '' : 's'}, and their version history. Export first if you want to keep them (Save project…, or the Library as a bundle). Merge adds to what is here instead.`}
        confirmLabel="Replace when loading"
        danger
        onConfirm={() => {
          setConfirmReplace(false)
          setMode('replace')
        }}
        onCancel={() => setConfirmReplace(false)}
      />
      <ConfirmDialog
        open={confirmClear}
        title="Clear the whole Library?"
        message={`${formatNumber(store.size())} entities will be removed from memory and IndexedDB. Export first if you want to keep them.`}
        confirmLabel="Clear everything"
        danger
        onConfirm={clearAll}
        onCancel={() => setConfirmClear(false)}
      />
      {graphImport && (
        <GraphImportWizard
          format={graphImport.format}
          files={graphImport.files}
          mode={mode}
          onDone={(summary) => {
            say(summary)
            setGraphImport(null)
          }}
          onClose={() => setGraphImport(null)}
        />
      )}
    </Dialog>
  )
}
