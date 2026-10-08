import { BarChart3, ExternalLink, Loader2, Play, Square, Table2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { entityHref } from '../../app/routes'
import { cellText, columnLabel, describeDataset, isDataset, type DatasetEntity } from '../../core/datasets/dataset'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity } from '../../core/entity/types'
import { buildPlot, describePlot, isPlot } from '../../core/graph/plot'
import { formatDate } from '../../lib/format'
import { PlotlyChart } from '../plots/PlotlyChart'
import { usePlotContext } from '../plots/plotContext'
import { isScript, type ScriptEntity } from '../scripts/script'
import { cancelScript, runScript } from '../scripts/runner'
import { autorunRefusal, hasConsent, recordConsent, withRunningMarker } from '../scripts/consent'
import { describeOutputs, outputsOf } from '../../scripting/outputs'
import type { Output } from '../../scripting/types'
import { useViewActive } from '../workstation/paneContext'
import '../scripts/scripts.css'
import '../graph/GraphPartEmbed.css'
import './analytics.css'

/**
 * The inspector's first tab for a saved chart, script or dataset: the chart
 * itself, drawn live from the dataset; a script's code and last run; a
 * dataset's first rows — and the button that opens any of them in its
 * Analytics tab.
 */
export default function AnalyticsEmbed({ entity }: { entity: AnyEntity }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const open = () => navigate(entityHref(entity, registry))
  if (isPlot(entity)) return <ChartEmbed entity={entity} onOpen={open} />
  if (isScript(entity)) return <ScriptEmbed entity={entity} onOpen={open} />
  if (isDataset(entity)) return <DatasetEmbed entity={entity} onOpen={open} />
  return null
}

/** The first rows of a dataset, read-only; the Datasets tab is where it is edited. */
const EMBED_ROWS = 50
function DatasetEmbed({ entity, onOpen }: { entity: DatasetEntity; onOpen: () => void }) {
  const store = useEntityStore()
  const s = entity.data.source
  const script = s?.kind === 'script' ? store.get(s.scriptId) : undefined
  return (
    <div className="gp an__chart-embed">
      <div className="gp__actions">
        <button className="btn btn--sm btn--primary" onClick={onOpen} title="Open this dataset in a Datasets tab, to edit it">
          <Table2 size={14} /> Open in Analytics
        </button>
        <span className="muted an__chart-desc">{describeDataset(entity.data, script ? displayLabel(script) : undefined)}</span>
      </div>
      <div className="sc__table">
        <table>
          <thead>
            <tr>
              {entity.data.columns.map((c) => (
                <th key={c.key}>{columnLabel(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entity.data.rows.slice(0, EMBED_ROWS).map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={typeof v === 'number' ? 'num' : ''}>
                    {cellText(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {entity.data.rows.length > EMBED_ROWS && <p className="muted">Showing {EMBED_ROWS} of {entity.data.rows.length.toLocaleString('en-US')} rows.</p>}
      </div>
    </div>
  )
}

function ChartEmbed({ entity, onOpen }: { entity: AnyEntity & { data: { spec: Parameters<typeof buildPlot>[0] } }; onOpen: () => void }) {
  const ctx = usePlotContext()
  const built = useMemo(() => {
    try {
      return { plot: buildPlot(entity.data.spec, ctx) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [entity.data.spec, ctx])
  return (
    <div className="gp an__chart-embed">
      <div className="gp__actions">
        <button className="btn btn--sm btn--primary" onClick={onOpen} title="Open this chart in a Charts tab, to change it">
          <BarChart3 size={14} /> Open in Analytics
        </button>
        <span className="muted an__chart-desc">{describePlot(entity.data.spec)}</span>
      </div>
      <div className="an__chart-frame">{built.plot ? <PlotlyChart data={built.plot.data} layout={built.plot.layout} dragmode="zoom" /> : <div className="muted">{built.error}</div>}</div>
    </div>
  )
}

/** Whether a script runs the moment it is shown here; off, a Run button waits. Remembered in this browser. */
const AUTORUN_KEY = 'aegraph:scripts:run-in-inspector'
const readAutorun = () => localStorage.getItem(AUTORUN_KEY) !== '0'

/**
 * A script in the inspector: its result, run on arrival (or on Run, when running on arrival is turned off
 * — a heavy script need not run every time its row is clicked). The run happens in the sandbox's worker
 * (JavaScript) or its iframe (Python), so the page stays responsive; it is cancelled if the tab is closed
 * mid-run. Visual scripts need a page of their own and are only linked.
 */
function ScriptEmbed({ entity, onOpen }: { entity: ScriptEntity; onOpen: () => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const active = useViewActive()
  const [autorun, setAutorun] = useState(readAutorun)
  const [state, setState] = useState<{ id: string; running: boolean; outputs: Output[]; error?: string; ms?: number; logs: string[] } | null>(null)
  const runId = useRef(0)
  const language = entity.data.language === 'python' ? 'python' : entity.data.language === 'view' ? 'view' : 'js'
  const visual = language === 'view'

  const run = async () => {
    const id = ++runId.current
    setState({ id: entity.id, running: true, outputs: [], logs: [] })
    try {
      // Run by the owner (or on arrival, code they ran here before): consented from now on (consent.ts).
      const untrusted = !hasConsent(entity.id, entity.data.code)
      recordConsent(entity.id, entity.data.code)
      const r = await withRunningMarker(entity.id, () => runScript(store, registry, entity.data.code, { language, untrusted }))
      if (id !== runId.current) return
      let outputs: Output[] = []
      let error = r.error?.message
      if (!error) {
        try {
          outputs = outputsOf(r.value)
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
        }
      }
      setState({ id: entity.id, running: false, outputs, error, ms: r.ms.run, logs: r.logs })
      store.update(entity.id, { data: { ...entity.data, lastRun: { at: new Date().toISOString(), summary: error ? 'error' : describeOutputs(outputs), ms: r.ms.run, ...(error ? { error } : {}) } } }, { volatile: true })
    } catch (e) {
      if (id !== runId.current) return
      setState({ id: entity.id, running: false, outputs: [], error: e instanceof Error ? e.message : String(e), logs: [] })
    }
  }
  const stop = () => {
    runId.current++
    cancelScript(language)
    setState((s) => (s ? { ...s, running: false, error: 'stopped' } : s))
  }
  // Run on arrival — once per script, only while this view is on screen, never a visual script, and only code its owner
  // ran or saved in this browser (consent.ts): a script selected from an import waits for Run.
  // A beat after the inspector has painted, so the click lands before the snapshot (built once per dataset version) is cut.
  const refusal = autorunRefusal(entity.id, entity.data.code, language)
  useEffect(() => {
    if (!autorun || refusal || !active || state?.id === entity.id) return
    const t = setTimeout(() => void run(), 60)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.id, autorun, active])
  // Leaving mid-run: the run is cancelled so a stale result never lands, and the worker is freed.
  useEffect(
    () => () => {
      if (state?.running) cancelScript(language)
      runId.current++
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entity.id],
  )
  const toggleAutorun = (on: boolean) => {
    setAutorun(on)
    localStorage.setItem(AUTORUN_KEY, on ? '1' : '0')
  }
  const shown = state?.id === entity.id ? state : null
  const last = entity.data.lastRun

  return (
    <div className="gp an__script-embed">
      <div className="gp__actions">
        {shown?.running ? (
          <button className="btn btn--sm" onClick={stop} title="Stop this run">
            <Square size={13} /> Stop
          </button>
        ) : (
          <button className="btn btn--sm btn--primary" onClick={() => void run()} disabled={visual} title={visual ? 'A visual script draws into a page of its own: open it in Analytics' : 'Run the script here (in its sandbox; the app stays responsive)'}>
            <Play size={13} /> Run
          </button>
        )}
        <button className="btn btn--sm" onClick={onOpen} title="Open this script in a Scripts tab, to edit">
          <ExternalLink size={13} /> Open in Analytics
        </button>
        <span className="spacer" />
        <label className="an__autorun" title="Run a script the moment its row is selected. Turn off when scripts are heavy; Run stays here.">
          <input type="checkbox" checked={autorun} onChange={(e) => toggleAutorun(e.target.checked)} /> run on open
        </label>
      </div>
      <div className="an__script-status muted">
        {shown?.running ? (
          <>
            <Loader2 size={12} className="an__spin" /> running…
          </>
        ) : shown ? (
          shown.error ? <span className="sc__err">{shown.error}</span> : `${describeOutputs(shown.outputs)} · ${shown.ms} ms`
        ) : visual ? (
          'A visual script — open it in Analytics to see it.'
        ) : autorun && refusal ? (
          refusal
        ) : last ? (
          `Last run ${formatDate(last.at)}: ${last.error ? `error — ${last.error}` : last.summary}. ${autorun ? '' : 'Press Run to see it.'}`
        ) : autorun ? (
          ''
        ) : (
          'Not run yet — press Run.'
        )}
      </div>
      {shown && !shown.running && shown.outputs.length > 0 && (
        <div className="sc__out an__script-out">
          {shown.outputs.map((o, i) => (
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
                      {o.rows.slice(0, 200).map((r, ri) => (
                        <tr key={ri}>
                          {r.map((v, ci) => (
                            <td key={ci}>{typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {o.kind === 'text' && <div className="sc__text">{o.text}</div>}
              {o.kind === 'image' && <img className="sc__image" src={`data:image/png;base64,${o.png}`} alt="script output" />}
              {o.kind === 'scene' && <div className="muted">A scene placing {Object.keys(o.positions).length.toLocaleString('en-US')} entities — open in Analytics to send it to the Scenes page.</div>}
              {o.kind === 'value' && <pre className="sc__value">{JSON.stringify(o.value, null, 2)}</pre>}
            </div>
          ))}
          {shown.logs.length > 0 && <pre className="sc__logs">{shown.logs.join('\n')}</pre>}
        </div>
      )}
      <details className="an__code-fold">
        <summary className="muted">Code</summary>
        <pre className="an__code">{entity.data.code}</pre>
      </details>
    </div>
  )
}
