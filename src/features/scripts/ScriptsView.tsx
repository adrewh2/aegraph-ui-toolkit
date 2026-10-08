import { BookOpen, Check, Palette, ChevronDown, Code2, Columns2, Copy, Filter, Lock, MoreHorizontal, Play, RotateCcw, Rows2, Save, ScanSearch, ShieldCheck, SlidersHorizontal, Square, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import { PROJECTION_TYPE, projectionFromPositions, SCRIPT_SCENE_TYPE, scriptSceneFrom } from '../../core/graph/projection'
import { createConstraint } from '../../core/constraints/constraint'
import { graphHref } from '../../app/openIn'
import { datasetFromScript, datasetFromTable } from '../../core/datasets/dataset'
import { useResizableWidth } from '../../lib/useResizableWidth'
import { detectLanguage } from '../../scripting/detect'
import { describeOutputs, outputsOf } from '../../scripting/outputs'
import type { PythonStatus } from '../../scripting/python/engine'
import type { RunSummary } from '../../scripting/runner'
import type { Language, Output } from '../../scripting/types'
import { PlotlyChart } from '../plots/PlotlyChart'
import { getLatestAnalysis } from '../analysis/latest'
import { CodeEditor, type CodeEditorHandle } from './CodeEditor'
import { hoverFor, scriptCompletion } from './completion'
import { assistantAvailable, convertWithAssistant } from './convertWithAssistant'
import { pairOf, planSwitch, type Pair } from './languageSwitch'
import { useScriptSchema } from './useScriptSchema'
import { registerScriptHandle } from './scriptHandle'
import { applyStyleScript } from './styles'
import { applyLayoutScript } from './layouts'
import { getExplorerHandle } from '../graph/explorerHandle'
import { clearDraft, NEW, readDraft, readDrafts, readLastScript, readScriptState, writeDraft, writeLastScript, writeScriptState, type LangChoice } from './drafts'
import { readLastRun, runStateOf, writeLastRun } from './lastRun'
import { autorunRefusal, hasConsent, recordConsent, withRunningMarker } from './consent'
import { cancelScript, pythonEngine, runScript, viewEngine } from './runner'
import { idsOfOutputs, isScript, isVerdictOutput, markScriptUse, saveScript, scriptKindOf, scriptsIn, SCRIPT_SUBTYPES, subtypeOfOutputs, updateScriptDetails, type ScriptEntity } from './script'
import { SaveAsDialog, ScriptDetailsDialog, UnsavedDialog, type ScriptDetails } from './ScriptDialogs'
import { TEMPLATES } from './templates'
import './scripts.css'
import { Select } from '../../components/ui/Select'


/**
 * Scripts: write (or let the assistant write) code over the dataset, run it
 * in a sandbox, and see the figure, table, image or scene it returns.
 * `?script=<id>` opens a saved script. The editor has the whole page until a
 * run; the output then opens beside or under it (resizable, closable), and
 * the Reference opens in a browser tab of its own. The script's name
 * is edited in place at the top left; everything else it carries — the
 * description, the kind, the lock — is in the Details dialog. Every edit is
 * kept as a draft (per script, and one for the unsaved script) so a reload
 * or a tab switch loses nothing; an action that would replace the editor
 * (another script, a template) asks first.
 */

/**
 * The last run per script (or the unsaved draft, under `new`) outlives the
 * page: coming back shows the figure, table or scene again without a run,
 * and a visual frame is re-attached rather than re-run.
 */
type RunState = { run: RunSummary; outputs: Output[]; error?: string }
const lastRuns = new Map<string, { result: RunState; viewShown: boolean }>()
/** What this page last showed for a script: from memory while the page lives, else from the browser after a reload. */
const lastShown = (id: string): RunState | null => {
  const held = lastRuns.get(id)?.result
  if (held) return held
  const stored = readLastRun(id)
  return stored ? runStateOf(stored) : null
}

export function ScriptsView() {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const version = useStoreVersion(store)
  const navigate = useNavigate()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  // A bare /scripts reopens the script the page was last on (the unsaved draft counts as "none").
  const remembered = readLastScript()
  const wanted = params.get('script') ?? (remembered && isScript(store.get(remembered)) ? remembered : null)
  const [scriptId, setScriptId] = useState<string | undefined>(() => (wanted && isScript(store.get(wanted)) ? wanted : undefined))
  useEffect(() => writeLastScript(scriptId), [scriptId])
  useEffect(() => {
    if (!params.get('script') && scriptId) setParams({ script: scriptId }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // What the editor opens on: the script's draft when one exists, else its saved code; the unsaved draft, else a template.
  const initial = (id: string | undefined): { code: string; choice: LangChoice } => {
    const e = id ? store.get(id) : undefined
    if (isScript(e)) {
      const d = readDraft(e.id)
      return d ? { code: d.code, choice: d.language } : { code: e.data.code, choice: e.data.language ?? 'auto' }
    }
    const d = readDraft(NEW)
    return d ? { code: d.code, choice: d.language } : { code: TEMPLATES[0].code, choice: 'auto' }
  }
  const [code, setCode] = useState<string>(() => initial(scriptId).code)
  const [choice, setChoice] = useState<LangChoice>(() => initial(scriptId).choice)
  const [draftTick, setDraftTick] = useState(0)
  const language: Language = choice === 'auto' ? detectLanguage(code) : choice
  // Switching the language converts the code; the pair of the last conversion means switching back with the
  // converted side unedited restores the original rather than converting again.
  const pair = useRef<Pair | null>(null)
  const [converting, setConverting] = useState(false)
  const codeRef = useRef(code)
  codeRef.current = code
  const switchLanguage = async (next: LangChoice) => {
    const from = language
    if (converting) return
    setChoice(next)
    if (next === 'auto' || next === from) return
    const plan = planSwitch(pair.current, from, next, code)
    if (plan.kind === 'none') return void (plan.reason !== 'same language' && toast(plan.reason))
    if (plan.kind === 'cached') return setCode(plan.code)
    // The assistant converts, when the user has one; otherwise the code stays as it is.
    if (!(await assistantAvailable())) return toast(`Left as ${from === 'python' ? 'Python' : 'JavaScript'}: the assistant is not available to convert it.`)
    setConverting(true)
    toast(`Converting to ${next === 'python' ? 'Python' : 'JavaScript'} with the assistant…`)
    try {
      const converted = await convertWithAssistant(code, from, next)
      // Meanwhile the user may have changed the code or the script: the reply is for what was asked.
      if (converted && codeRef.current === code) {
        pair.current = pairOf(from, code, next, converted)
        setCode(converted)
        setResult(null)
        toast(`Converted to ${next === 'python' ? 'Python' : 'JavaScript'} by the assistant`)
      } else toast('The assistant returned no code; the script is unchanged.')
    } catch (err) {
      toast(`The assistant could not convert it: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setConverting(false)
    }
  }
  const [py, setPy] = useState<PythonStatus>(() => pythonEngine().getStatus())
  useEffect(() => pythonEngine().onStatus(setPy), [])
  const [running, setRunning] = useState(false)
  const viewHost = useRef<HTMLDivElement>(null)
  const [viewShown, setViewShown] = useState(() => lastRuns.get(scriptId ?? NEW)?.viewShown ?? false)
  // Leaving the page hides the visual frames; a new run or Stop ends them.
  useEffect(() => () => viewEngine().detachAll(), [])
  const [result, setResult] = useState<RunState | null>(() => lastShown(scriptId ?? NEW))
  // A frame from an earlier run is shown over the host again; one that was stopped since is gone (the outputs still show).
  useEffect(() => {
    const frame = (result?.run as { frame?: HTMLIFrameElement } | undefined)?.frame
    if (!viewShown || !frame || !viewHost.current) return
    if (viewEngine().isLive(frame)) viewEngine().attach(frame, viewHost.current)
    else setViewShown(false)
  }, [result, viewShown, scriptId])
  const [menu, setMenu] = useState<{ x: number; y: number; which: 'scripts' | 'more' } | null>(null)
  // The output pane opens with a run and closes with its ×; beside the editor (side) or under it (stack), its size dragged and remembered per shape.
  const [shape, setShapeState] = useState<Layout>(() => readShape())
  const setShape = (next: Layout) => {
    setShapeState(next)
    try {
      localStorage.setItem(SHAPE_KEY, next)
    } catch {
      /* ignore */
    }
  }
  const [outputOpen, setOutputOpen] = useState(() => !!lastShown(scriptId ?? NEW))
  const outputSide = useResizableWidth({ storageKey: 'aegraph:scripts:output-width', initial: 560, min: 280, max: 1600, edge: 'start' })
  const outputBelow = useResizableWidth({ storageKey: 'aegraph:scripts:output-height', initial: 360, min: 160, max: 1200, edge: 'start', axis: 'y' })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scripts = useMemo(() => scriptsIn(store).sort((a, b) => displayLabel(a).localeCompare(displayLabel(b))), [store, version])
  const current = scriptId ? (store.get(scriptId) as ScriptEntity | undefined) : undefined
  const locked = !!current?.data.locked
  // Edits worth keeping: a saved script's code or language changed; an unsaved script that is more than a bare template.
  const dirty = current ? current.data.code !== code || (current.data.language ?? 'js') !== language : code.trim() !== '' && !TEMPLATES.some((t) => t.code === code)
  // The name at the top left: the saved script's, edited in place; for an unsaved script, what Save will call it.
  const [name, setName] = useState(() => (current ? displayLabel(current) : ''))
  useEffect(() => setName(current ? displayLabel(current) : ''), [scriptId, current?.label]) // eslint-disable-line react-hooks/exhaustive-deps
  const commitName = () => {
    const next = name.trim()
    if (!current) return
    if (!next || next === displayLabel(current)) return setName(displayLabel(current))
    if (locked) return (setName(displayLabel(current)), toast(`“${displayLabel(current)}” is locked — unlock it in Details to rename it.`))
    updateScriptDetails(store, current.id, { label: next })
  }
  const [dialog, setDialog] = useState<{ kind: 'details' } | { kind: 'saveAs'; then?: () => void } | { kind: 'unsaved'; then: () => void } | null>(null)
  // Completion knows the data: the schema is built once per store data version.
  const schema = useScriptSchema()
  const editorHandle = useRef<CodeEditorHandle>(null)
  const metricNames = useMemo(() => Object.keys(getLatestAnalysis()?.metrics.columns ?? {}), [version]) // eslint-disable-line react-hooks/exhaustive-deps
  const live = useRef({ schema, language, metricNames })
  live.current = { schema, language, metricNames }
  const completion = useMemo(() => scriptCompletion({ schema: () => live.current.schema, language: () => live.current.language, metrics: () => live.current.metricNames }), [])
  const hover = useCallback((name: string, doc: string, pos: number) => hoverFor(live.current.schema, live.current.language, doc, pos, name), [])
  // The Reference is a page in a tab of its own, beside the editor rather than in it; rows copy, the editor pastes.
  const openReference = () => window.open(`/analytics/scripts/reference?language=${language === 'python' ? 'python' : 'js'}`, '_blank', 'noopener')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const drafts = useMemo(() => readDrafts(), [draftTick, scriptId, code, choice])

  // Follow ?script= (a deep link, the assistant, the picker).
  useEffect(() => {
    if (wanted === (scriptId ?? null)) return
    viewEngine().detachAll()
    if (!wanted) {
      // The param went away while mounted (the picker's New script, a bare /scripts link): back to the unsaved draft.
      const init = initial(undefined)
      setScriptId(undefined)
      setCode(init.code)
      setChoice(init.choice)
      setResult(lastShown(NEW))
      setOutputOpen(!!lastShown(NEW))
      setViewShown(lastRuns.get(NEW)?.viewShown ?? false)
      return
    }
    const e = store.get(wanted)
    if (isScript(e)) {
      const init = initial(e.id)
      setScriptId(e.id)
      setCode(init.code)
      setChoice(init.choice)
      setResult(lastShown(e.id))
      setOutputOpen(!!lastShown(e.id))
      setViewShown(lastRuns.get(e.id)?.viewShown ?? false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted])
  // Every edit is a draft: kept while it differs from what is saved (or, unsaved, from a template), dropped once it matches again.
  // One that this browser will not keep is said, once until drafts are kept again: a reload would not bring it back.
  const draftRefused = useRef(false)
  useEffect(() => {
    const id = scriptId ?? NEW
    if (!dirty) clearDraft(id)
    else if (writeDraft(id, code, choice)) draftRefused.current = false
    else if (!draftRefused.current) {
      draftRefused.current = true
      toast('This browser’s storage would not keep the draft (it may be full): save the script to keep your edits — a reload would lose them.')
    }
    setDraftTick((t) => t + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, choice, scriptId, dirty])

  const run = useCallback(
    async (src = code, lang: Language = language, forId: string | null | undefined = scriptId) => {
      setRunning(true)
      // The output pane opens for the run; a visual script draws into it, so it must be on screen before the run starts.
      setOutputOpen(true)
      if (lang === 'view') {
        viewEngine().stopAll()
        setViewShown(true)
        await new Promise((r) => setTimeout(r, 0))
      } else setViewShown(false)
      try {
        const stateKey = (forId === undefined ? scriptId : forId) ?? NEW
        // A saved script that reads only some types keeps doing so from here (see ScriptData.types).
        const saved = stateKey === NEW ? undefined : store.get(stateKey)
        const types = isScript(saved) ? saved.data.types : undefined
        // Run here, by the owner (or, on arrival, only code they ran here before — see consent.ts): this code may run again
        // by itself. The marker says a run is in flight, so a script that hangs the tab is not re-run by the reload.
        // Untrusted only when it is a saved script's own code that its owner never ran or saved here (an import's, a
        // template's): what they type in the editor is theirs, and is not made to pay for a fresh engine every run.
        const untrusted = isScript(saved) && src === saved.data.code && !hasConsent(stateKey, src)
        recordConsent(stateKey, src)
        const r = await withRunningMarker(stateKey, () => runScript(store, registry, src, { untrusted, language: lang, host: lang === 'view' ? (viewHost.current ?? undefined) : undefined, state: readScriptState(stateKey), onState: (st) => writeScriptState(stateKey, st), ...(types?.length ? { types } : {}) }))
        let outputs: Output[] = []
        let error = r.error?.message
        if (!error) {
          try {
            outputs = outputsOf(r.value)
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
          }
        }
        const state = { run: r, outputs, error }
        setResult(state)
        setOutputOpen(true)
        // One live visual frame at a time: a new visual run ended the others, so their cached entries fall back to outputs only.
        if (lang === 'view') for (const v of lastRuns.values()) v.viewShown = false
        lastRuns.set(stateKey, { result: state, viewShown: lang === 'view' && !error })
        // And in the browser, so a reload lands on this output instead of an empty pane (or a re-run).
        writeLastRun(stateKey, { at: new Date().toISOString(), outputs, error, logs: r.logs, ms: r.ms.run, view: lang === 'view' })
        if (forId && isScript(store.get(forId))) {
          const e = store.get(forId) as ScriptEntity
          // The language is recorded only for the saved code: a draft in another language (a conversion, say) is the draft's.
          store.update(e.id, { data: { ...e.data, ...(code === e.data.code ? { language: lang } : {}), lastRun: { at: new Date().toISOString(), summary: error ? 'error' : describeOutputs(outputs), ms: r.ms.run, ...(error ? { error } : {}) } } }, { volatile: true })
        }
        return { r, outputs, error }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setResult({ run: { value: undefined, logs: [], ms: { load: 0, run: 0, snapshot: 0 } }, outputs: [], error: e instanceof Error ? e.message : String(e) })
        return null
      } finally {
        setRunning(false)
      }
    },
    [code, language, store, registry, scriptId],
  )

  // A page load with nothing remembered — in memory or in the browser (lastRun.ts skips a result too big to keep)
  // — re-runs a script that has run before, so a reload still lands on its figure or scene; `?run=1` (a script just
  // exported from Charts) runs it once whatever its history. Either way only code its owner ran or saved here, never
  // a Visual script, and never one whose last run did not finish (consent.ts): a `lastRun` is data a bundle carries,
  // and a link with `?run=1` is something anyone can send.
  const autoRan = useRef(false)
  const runParam = params.get('run') === '1'
  useEffect(() => {
    if (autoRan.current || result || running) return
    if (!runParam && (!current?.data.lastRun || current.data.lastRun.error)) return
    autoRan.current = true
    if (runParam) {
      const next = new URLSearchParams(params)
      next.delete('run')
      setParams(next, { replace: true })
    }
    const refusal = scriptId ? autorunRefusal(scriptId, code, language) : 'Not run: open a saved script to run it on arrival.'
    if (refusal) {
      if (runParam) toast(refusal)
      return
    }
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptId])

  /**
   * Save over the open script. A script that is not saved yet, or is locked, cannot be saved over: Save as
   * makes one (⌘S opens the dialog then). `then` runs once the save is done — the action that asked for it.
   */
  const save = (then?: () => void) => {
    if (!current || locked) return setDialog({ kind: 'saveAs', then })
    if (!dirty) return then?.()
    // A script saved without a kind takes the one its last run suggests: a scene, the entities to keep, a verdict.
    const kind = scriptKindOf(current.type) ? undefined : result && !result.error ? subtypeOfOutputs(result.outputs, store) : undefined
    saveScript(store, code, displayLabel(current), current.id, undefined, language, undefined, kind)
    clearDraft(current.id)
    toast('Saved')
    then?.()
  }
  /** A new script from the editor's contents: the first save, or a copy of the open one (a locked script's only way). */
  const saveAs = (label: string, then?: () => void) => {
    const kind = result && !result.error ? subtypeOfOutputs(result.outputs, store) : undefined
    const e = saveScript(store, code, label, undefined, undefined, language, current?.description, kind)
    clearDraft(NEW)
    if (current) clearDraft(current.id)
    setDialog(null)
    setScriptId(e.id)
    setParams({ script: e.id }, { replace: true })
    toast(`Saved “${label}”`)
    then?.()
  }
  /** Back to the saved code, dropping the draft. */
  const discard = () => {
    const id = scriptId ?? NEW
    clearDraft(id)
    setDraftTick((t) => t + 1)
    if (!current) return
    setCode(current.data.code)
    setChoice(current.data.language ?? 'auto')
    setResult(null)
  }
  /**
   * Run `action` — something that replaces what is in the editor — once the edits are dealt with: as they are when
   * there are none, else after the Unsaved dialog's Save, Discard or not at all. A reload or a tab switch never
   * comes through here: the draft keeps the edits for those.
   */
  const guarded = (action: () => void) => {
    if (!dirty) return action()
    setDialog({ kind: 'unsaved', then: action })
  }
  const open = (id?: string) =>
    guarded(() => {
      if (id) setParams({ script: id })
      else {
        clearDraft(NEW)
        setDraftTick((t) => t + 1)
        setScriptId(undefined)
        setCode(TEMPLATES[0].code)
        setChoice('auto')
        setResult(null)
        setOutputOpen(false)
        setParams({})
      }
    })
  const remove = () => {
    if (!current) return
    if (locked) return toast(`“${displayLabel(current)}” is locked — unlock it in Details to delete it.`)
    if (!window.confirm(`Delete script “${displayLabel(current)}”?`)) return
    store.remove([current.id])
    clearDraft(current.id)
    setScriptId(undefined)
    setParams({})
    toast('Deleted')
  }
  const saveDetails = (d: ScriptDetails) => {
    if (!current) return
    try {
      // A script that stays locked takes nothing else; unlocking (or an unlocked one) takes every field.
      if (current.data.locked && d.locked) updateScriptDetails(store, current.id, { locked: true })
      else updateScriptDetails(store, current.id, { label: d.label, description: d.description, subtype: d.subtype, locked: d.locked, types: d.types.length ? d.types : null })
      setDialog(null)
      toast(d.locked && !current.data.locked ? 'Locked' : !d.locked && current.data.locked ? 'Unlocked' : 'Details saved')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }
  // The scene a script draws is a script scene: it remembers the script, and a rerun updates it rather than adding
  // another — and the script, opened as a scene, is a scene script if it had no kind yet. An unsaved script has no id
  // to remember, so its picture is a plain scene named after the output.
  const showScene = (o: Extract<Output, { kind: 'scene' }>) => {
    const label = o.label ?? (current ? displayLabel(current) : 'Script scene')
    if (!current) {
      const existing = store.ofType(PROJECTION_TYPE).find((e) => displayLabel(e) === label)
      const proj = projectionFromPositions(label, o.positions, { scale: o.scale })
      if (existing) store.update(existing.id, { data: proj.data })
      else store.upsert(proj)
      navigate(`/scenes?id=${encodeURIComponent(existing?.id ?? proj.id)}`)
      return
    }
    const existing = store.ofType(SCRIPT_SCENE_TYPE).find((e) => (e.data as { source?: { scriptId?: string } }).source?.scriptId === current.id && (!o.label || displayLabel(e) === o.label))
    const scene = scriptSceneFrom({ id: current.id, label: displayLabel(current) }, o.positions, { scale: o.scale, label: o.label, existing })
    store.upsert(scene)
    markScriptUse(store, current.id, 'scene')
    navigate(`/scenes?id=${encodeURIComponent(scene.id)}`)
  }
  // A style or a layout is put to use by running the saved script through its applier: one rendering / layout entity per
  // script, updated each time, loaded into the open explorer or opened with it. An unsaved script has nothing to remember.
  const applyOnExplorer = async (kind: 'style' | 'layout') => {
    if (!current) {
      toast(`Save the script first: the ${kind} it makes remembers which script made it.`)
      return
    }
    try {
      const h = getExplorerHandle()
      if (kind === 'style') {
        const applied = await applyStyleScript(store, registry, current.id, { base: h?.getState().rendering })
        if (h) h.loadRendering(applied.rendering.id, applied.spec)
        else navigate(`/unigraph/2d?style=${encodeURIComponent(applied.rendering.id)}`)
        toast(`Style “${displayLabel(applied.rendering)}” ${applied.updated ? 'updated' : 'saved'} and applied`)
      } else {
        const applied = await applyLayoutScript(store, registry, current.id, { dimensions: h?.dims })
        if (h) h.loadLayout(applied.layout.id, applied.positions, 'custom')
        else navigate(`/unigraph/${applied.dimensions === 3 ? '3d' : '2d'}?layout=${encodeURIComponent(applied.layout.id)}`)
        toast(`Layout “${displayLabel(applied.layout)}” ${applied.updated ? 'updated' : 'saved'} and applied`)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }
  // Putting a result to use connects the script to what it made — and names its kind, if it has none yet.
  const keepInExplorer = (ids: string[]) => {
    markScriptUse(store, current?.id, 'filter')
    navigate(graphHref(ids, current ? displayLabel(current) : 'script result', '2d', false, current?.id))
  }
  const saveAsConstraint = () => {
    if (!current) {
      toast('Save the script first: a constraint names a saved script.')
      return
    }
    const label = window.prompt('Name the constraint', displayLabel(current))
    if (!label) return
    store.upsert(createConstraint({ label, description: current.description, scope: 'graph', rule: { script: current.id }, severity: 'warn' }))
    markScriptUse(store, current.id, 'constraint')
    toast(`Constraint “${label}” judged by this script — the audit runs it`)
    navigate('/ontology?tab=constraints')
  }
  /** What the current result can be used as, beside a scene: the entities to keep, or a verdict. */
  const resultIds = useMemo(() => (result && !result.error ? idsOfOutputs(result.outputs, store) : []), [result, store])
  const resultVerdict = !!result && !result.error && result.outputs.some(isVerdictOutput)

  // The assistant drives this page through a handle: set code, run, read the result.
  useEffect(
    () =>
      registerScriptHandle({
        getState: () => ({ scriptId, code, language, running, result: result ? { outputs: result.outputs, error: result.error, logs: result.run.logs, ms: result.run.ms } : undefined }),
        setCode: (c, l) => {
          setCode(c)
          if (l) setChoice(l)
          setResult(null)
        },
        run: async (c, l, forId) => {
          if (c !== undefined) setCode(c)
          if (l) setChoice(l)
          // The assistant names the script it is running (it may have just navigated here); otherwise the page's own.
          const r = await run(c ?? code, l ?? (c !== undefined && choice === 'auto' ? detectLanguage(c) : language), forId === undefined ? scriptId : forId)
          return r ? { outputs: r.outputs, error: r.error, logs: r.r.logs, ms: r.r.ms } : undefined
        },
        load: (id) => setParams({ script: id }),
      }),
    [scriptId, code, language, choice, running, result, run, setParams],
  )

  const at = (e: React.MouseEvent<HTMLElement>) => ({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })
  const scriptItems: MenuItem[] = [
    ...(drafts[NEW] && scriptId ? [{ kind: 'item' as const, label: 'Unsaved draft', icon: Code2, onSelect: () => guarded(() => setParams({})) }] : []),
    { kind: 'item', label: 'New script', icon: Code2, onSelect: () => open() },
    { kind: 'sep' },
    ...(scripts.length ? scripts.map<MenuItem>((s) => ({ kind: 'item', label: `${displayLabel(s)}${s.data.locked ? ' 🔒' : ''}${drafts[s.id] ? ' · draft' : ''}`, icon: s.id === scriptId ? Check : undefined, onSelect: () => (s.id === scriptId ? undefined : open(s.id)) })) : [{ kind: 'label' as const, label: 'No saved scripts yet' }]),
  ]
  const templateItems: MenuItem[] = TEMPLATES.map((t) => ({
    kind: 'item',
    label: t.label,
    onSelect: () =>
      guarded(() => {
        setCode(t.code)
        setChoice(t.language ?? 'auto')
        setResult(null)
      }),
  }))
  // Everything that is not run / save / name lives behind ⋯, so the bar never wraps.
  const moreItems: MenuItem[] = [
    { kind: 'item', label: 'Save as…', icon: Copy, onSelect: () => setDialog({ kind: 'saveAs' }) },
    ...(dirty ? [{ kind: 'item' as const, label: current ? 'Discard changes' : 'Discard draft', icon: RotateCcw, onSelect: discard }] : []),
    ...(current ? [{ kind: 'item' as const, label: 'Details…', icon: SlidersHorizontal, onSelect: () => setDialog({ kind: 'details' }) }, { kind: 'item' as const, label: 'Delete script', icon: Trash2, disabled: locked, onSelect: remove }] : []),
    { kind: 'sep' },
    { kind: 'label', label: 'Layout' },
    { kind: 'item', label: 'Output beside the script', icon: shape === 'side' ? Check : Columns2, onSelect: () => setShape('side') },
    { kind: 'item', label: 'Output under the script', icon: shape === 'stack' ? Check : Rows2, onSelect: () => setShape('stack') },
    { kind: 'sep' },
    { kind: 'label', label: 'Templates' },
    ...templateItems,
    { kind: 'sep' },
    { kind: 'item', label: 'Docs: Scripts', icon: BookOpen, onSelect: () => navigate('/docs/scripts') },
  ]
  const pyLabel = py.stage === 'ready' ? `Python ${py.versions?.python ?? ''} · pandas ${py.versions?.pandas ?? ''} · plotly ${py.versions?.plotly ?? ''}` : py.stage === 'runtime' ? 'Python: loading runtime…' : py.stage === 'packages' ? 'Python: loading numpy, pandas, plotly…' : py.stage === 'failed' ? `Python failed: ${py.message ?? ''}` : ''

  const kind = current ? scriptKindOf(current.type) : undefined
  const outputNote = result && !result.error ? `${[viewShown ? 'live scene' : '', describeOutputs(result.outputs)].filter(Boolean).join(' + ')} · ${result.run.ms.run} ms` : result?.error ? 'error' : running ? 'running…' : ''
  const editorPane = (
    <div className="sc__editor">
      <CodeEditor value={code} language={language} onChange={setCode} onRun={() => void run()} onSave={() => save()} completion={completion} hover={hover} handle={editorHandle} placeholder={language === 'python' ? '# the last expression is displayed: a plotly figure, a DataFrame, a matplotlib figure, a str' : language === 'view' ? "// an ES module with a DOM: import * as THREE from 'three'; draw into #app" : '// return figure(...), table(...), scene(...) or { text }'} />
      <div className="sc__status">
        <span className="muted">⌘↵ runs · ⌘S saves · ^Space completes, Tab accepts{result?.run.ms.snapshot ? ` · snapshot ${result.run.ms.snapshot} ms` : ''}</span>
        {language === 'python' && pyLabel && <span className={`muted sc__py ${py.stage === 'failed' ? 'sc__err' : ''}`}> · {pyLabel}</span>}
      </div>
    </div>
  )
  const outputPane = (
    <div className="sc__outpane">
      <div className="sc__outhead">
        <span className="sc__outtitle">Output</span>
        <span className={`sc__pane-note ${result?.error ? 'sc__err' : ''}`}>{outputNote}</span>
        <span className="spacer" />
        <button className="btn btn--sm btn--icon btn--ghost" title="Close the output (the next run opens it again)" onClick={() => setOutputOpen(false)}>
          <X size={13} />
        </button>
      </div>
      <div className="sc__out">
        <div ref={viewHost} className="sc__viewhost" hidden={!viewShown} />
        {result?.error && (
          <pre className="sc__error">
            {result.error}
            {result.run.error?.stack ? `\n${result.run.error.stack}` : ''}
          </pre>
        )}
        {result?.outputs.map((o, i) => (
          <div key={i} className={`sc__output sc__output--${o.kind}`}>
            {o.kind === 'figure' && <PlotlyChart data={o.data as never} layout={o.layout} className="sc__chart" dragmode="zoom" />}
            {o.kind === 'table' && (
              <div className="sc__table">
                <table>
                  <thead>
                    <tr>
                      {o.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {o.rows.slice(0, 500).map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k} className={typeof c === 'number' ? 'num' : ''}>
                            {typeof c === 'number' ? c.toLocaleString('en-US', { maximumFractionDigits: 3 }) : typeof c === 'string' ? c : JSON.stringify(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {o.rows.length > 500 && <p className="muted">Showing 500 of {o.rows.length.toLocaleString('en-US')} rows.</p>}
                <p className="sc__table-keep">
                  {/* The table kept as a dataset: a saved script's rerun refreshes the same one; an unsaved script's takes the page's name. */}
                  <button
                    className="btn btn--sm"
                    title="Keep this table as a dataset — an entity the Datasets page edits and charts read. A saved script's dataset is refreshed when the script runs again."
                    onClick={() => {
                      const e = current ? datasetFromScript(store, { id: current.id, label: displayLabel(current) }, o) : datasetFromTable(o.columns, o.rows, { label: name.trim() || firstLine(code) || 'Script table' })
                      store.upsert(e)
                      toast(`Dataset “${displayLabel(e)}”: ${o.rows.length.toLocaleString('en-US')} rows`)
                      navigate(`/analytics/datasets?id=${encodeURIComponent(e.id)}`)
                    }}
                  >
                    <Save size={13} /> Keep as a dataset
                  </button>
                </p>
              </div>
            )}
            {o.kind === 'scene' && (
              <div className="sc__scene">
                <p>
                  A scene placing {Object.keys(o.positions).length.toLocaleString('en-US')} entities{o.groups ? ` in ${Object.keys(o.groups).length} groups` : ''}.
                </p>
                <button className="btn" onClick={() => showScene(o)}>
                  <ScanSearch size={14} /> Open on the Scenes page
                </button>
              </div>
            )}
            {o.kind === 'layout' && (
              <div className="sc__scene">
                <p>
                  A layout placing {Object.keys(o.positions).length.toLocaleString('en-US')} entities{o.dimensions === 3 ? ' in 3D' : ''}.
                </p>
                <button className="btn" onClick={() => void applyOnExplorer('layout')} title="Hold these positions on the Graph Explorer, saved as this script's layout">
                  <Palette size={14} /> Apply on the Graph Explorer
                </button>
              </div>
            )}
            {o.kind === 'style' && (
              <div className="sc__scene">
                <p>
                  A style for {[o.overlay.nodes ? `${Object.keys(o.overlay.nodes).length.toLocaleString('en-US')} nodes` : '', o.overlay.edges ? `${Object.keys(o.overlay.edges).length.toLocaleString('en-US')} edges` : ''].filter(Boolean).join(' and ')}
                  {o.overlay.legend ? ` with a legend (${o.overlay.legend.title})` : ''}.
                </p>
                <button className="btn" onClick={() => void applyOnExplorer('style')} title="Colour, size and shape the Graph Explorer's nodes as the script says, saved as this script's style">
                  <Palette size={14} /> Apply on the Graph Explorer
                </button>
              </div>
            )}
            {o.kind === 'text' && <div className="sc__text">{o.text}</div>}
            {o.kind === 'image' && <img className="sc__image" src={`data:image/png;base64,${o.png}`} alt="script output" />}
            {o.kind === 'value' && <pre className="sc__value">{JSON.stringify(o.value, null, 2)}</pre>}
          </div>
        ))}
        {(resultIds.length > 0 || resultVerdict) && (
          <div className="sc__use">
            {resultIds.length > 0 && (
              <button className="btn btn--sm" onClick={() => keepInExplorer(resultIds)} title="Open Unigraph on just these entities — the script is then a filter">
                <Filter size={13} /> Keep these {resultIds.length.toLocaleString('en-US')} in Unigraph
              </button>
            )}
            {resultVerdict && (
              <button className="btn btn--sm" onClick={saveAsConstraint} title="A constraint judged by this script: true passes; false, a message or a list of { id, message } fails. The audit runs it.">
                <ShieldCheck size={13} /> Save as a constraint
              </button>
            )}
          </div>
        )}
        {result && result.run.logs.length > 0 && <pre className="sc__logs">{result.run.logs.join('\n')}</pre>}
        {running && <div className="sc__empty">{language === 'python' && py.stage !== 'ready' ? (pyLabel || 'Starting Python…') : 'Running…'}</div>}
      </div>
    </div>
  )
  const showOutput = outputOpen && (!!result || running || viewShown)

  return (
    <div className="sc">
      <div className="sc__top">
        <div className="sc__name" title={current ? (locked ? 'Locked — unlock it in Details to rename it' : 'The script\'s name — edit it here') : 'Not saved yet — this is what Save will call it'}>
          <Code2 size={15} className="sc__name-icon" />
          <input
            className="sc__name-input"
            style={{ width: `${Math.max(10, Math.min(48, (name || (current ? displayLabel(current) : 'Untitled script')).length + 2))}ch` }}
            value={name}
            placeholder={current ? displayLabel(current) : 'Untitled script'}
            readOnly={locked}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setName(current ? displayLabel(current) : '')
                e.currentTarget.blur()
              }
            }}
          />
          {locked && <Lock size={12} className="sc__name-lock" aria-label="Locked" />}
          {kind && <span className="sc__pick-kind" title={SCRIPT_SUBTYPES.find((k) => k.id === kind)?.hint}>{kind}</span>}
          {dirty && <span className="sc__pick-draft" title={current ? 'Edited since it was saved — kept as a draft until you save or discard' : 'Kept as a draft as you type; Save makes it a script'}>{current ? 'edited' : 'unsaved'}</span>}
          <button className="btn btn--sm btn--icon btn--ghost sc__pick" onClick={(e) => setMenu({ ...at(e), which: 'scripts' })} title="Open another script, or a new one">
            <ChevronDown size={13} />
          </button>
        </div>
        <Select className="gx-select sc__lang" value={choice} disabled={converting} title="Language: detected from the code, or pinned. Switching converts the script; switching back restores it." onChange={(e) => void switchLanguage(e.target.value as LangChoice)}>
          <option value="auto">Auto · {language === 'python' ? 'Python' : language === 'view' ? 'Visual' : 'JavaScript'}</option>
          <option value="js">JavaScript</option>
          <option value="python">Python</option>
          <option value="view">Visual · three.js / d3 / DOM</option>
        </Select>
        {running ? (
          <button className="btn btn--sm btn--primary" onClick={() => cancelScript(language)}>
            <Square size={12} /> Stop
          </button>
        ) : (
          <button className="btn btn--sm btn--primary" title="Run (⌘↵)" onClick={() => void run()}>
            <Play size={12} /> Run
          </button>
        )}
        {current && !locked ? (
          <button className="btn btn--sm" title="Save (⌘S)" onClick={() => save()} disabled={!dirty}>
            <Save size={13} /> Save
          </button>
        ) : (
          <button className="btn btn--sm" title={locked ? 'Locked: Save as makes a copy (⌘S)' : 'Save as a script (⌘S)'} onClick={() => setDialog({ kind: 'saveAs' })}>
            <Save size={13} /> Save as…
          </button>
        )}
        <button className="btn btn--sm" title={current ? 'Details: description, kind, lock' : 'Save the script first — its details are kept on the saved script'} disabled={!current} onClick={() => setDialog({ kind: 'details' })}>
          <SlidersHorizontal size={13} /> Details
        </button>
        <button type="button" className="btn btn--sm" onClick={openReference} title="What a script can reach — the API, the types with their properties, relationships, tags, the project — in a new browser tab; rows copy to paste here">
          <BookOpen size={13} /> Reference
        </button>
        <button className="btn btn--sm btn--icon" title="More: save as, discard, details, delete, layout, templates, docs" onClick={(e) => setMenu({ ...at(e), which: 'more' })}>
          <MoreHorizontal size={14} />
        </button>
      </div>
      <div className="sc__body">
        <div className={`sc__work sc__work--${shape}`}>
          {shape === 'stack' ? (
            <>
              <div className="sc__editorwrap">{editorPane}</div>
              {showOutput && (
                <>
                  <div className="pane-gutter pane-gutter--row" onPointerDown={outputBelow.onPointerDown} onDoubleClick={outputBelow.reset} title="Drag to resize · double-click to reset" />
                  <div className="sc__outwrap" style={{ height: outputBelow.width }}>
                    {outputPane}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="sc__editorwrap">{editorPane}</div>
              {showOutput && (
                <>
                  <div className="pane-gutter" onPointerDown={outputSide.onPointerDown} onDoubleClick={outputSide.reset} title="Drag to resize · double-click to reset" />
                  <div className="sc__outwrap" style={{ width: outputSide.width }}>
                    {outputPane}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {menu && <Menu x={menu.x} y={menu.y} items={menu.which === 'scripts' ? scriptItems : moreItems} onClose={() => setMenu(null)} />}
      {dialog?.kind === 'details' && current && <ScriptDetailsDialog script={current} onClose={() => setDialog(null)} onSave={saveDetails} />}
      {dialog?.kind === 'saveAs' && <SaveAsDialog title={current ? (locked ? 'Save a copy' : 'Save as') : 'Save script'} initial={current ? (locked || dirty ? `${displayLabel(current)} copy` : displayLabel(current)) : name.trim() || firstLine(code)} onClose={() => setDialog(null)} onSubmit={(label) => saveAs(label, dialog.then)} />}
      {dialog?.kind === 'unsaved' && (
        <UnsavedDialog
          name={current ? displayLabel(current) : name.trim() || 'Untitled script'}
          canSave={!!current && !locked}
          onClose={() => setDialog(null)}
          onDiscard={() => {
            const then = dialog.then
            setDialog(null)
            discard()
            then()
          }}
          onSave={() => {
            const then = dialog.then
            if (current && !locked) {
              setDialog(null)
              save(then)
            } else setDialog({ kind: 'saveAs', then })
          }}
        />
      )}
    </div>
  )
}

type Layout = 'side' | 'stack'
const SHAPE_KEY = 'aegraph:scripts:shape'
const readShape = (): Layout => {
  try {
    return localStorage.getItem(SHAPE_KEY) === 'stack' ? 'stack' : 'side'
  } catch {
    return 'side'
  }
}
const firstLine = (code: string) => {
  const l = code.split('\n').find((x) => x.trim().startsWith('//'))
  return l ? l.replace(/^\s*\/\/\s*/, '').slice(0, 60) : 'Script'
}
