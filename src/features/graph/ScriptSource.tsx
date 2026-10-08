import { Code2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { formatDate } from '../../lib/format'
import { applyLayoutScript } from '../scripts/layouts'
import { isScript } from '../scripts/script'
import { applyStyleScript } from '../scripts/styles'
import { useExplorer } from './explorerState'

/**
 * A loaded style or layout that a script made says so: which script, when
 * it ran, a button to run it again (the saved entity is updated and
 * reloaded) and one to open the script. Shown by the Style and Layout
 * panels when what they hold carries a script source.
 */
export function ScriptSource({ kind, source }: { kind: 'style' | 'layout'; source: { scriptId: string; label?: string; ranAt: string } }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const { state, dispatch } = useExplorer()
  const navigate = useNavigate()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const script = store.get(source.scriptId)
  const label = isScript(script) ? displayLabel(script) : (source.label ?? 'a script')
  const rerun = async () => {
    if (!isScript(script)) {
      toast('The script is no longer in the Library.')
      return
    }
    setBusy(true)
    try {
      if (kind === 'style') {
        const applied = await applyStyleScript(store, registry, script.id, { base: state.rendering })
        dispatch({ type: 'loadRendering', id: applied.rendering.id, rendering: applied.spec })
      } else {
        const applied = await applyLayoutScript(store, registry, script.id)
        dispatch({ type: 'loadLayout', id: applied.layout.id, positions: applied.positions, algorithm: 'custom' })
      }
      toast(`“${label}” ran again`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="gx-script-source" title={`This ${kind} was made by the script “${label}” ${formatDate(source.ranAt)}`}>
      <Code2 size={12} />
      <span className="gx-script-source__text">
        <button className="gx-link gx-script-source__name" onClick={() => navigate(`/scripts?script=${encodeURIComponent(source.scriptId)}`)} title={`Open the script “${label}” · ran ${formatDate(source.ranAt)}`}>
          {label}
        </button>
      </span>
      <button className="btn btn--sm btn--ghost" disabled={busy || !isScript(script)} onClick={() => void rerun()} title="Run the script again and reload what it returns">
        <RefreshCw size={11} /> {busy ? 'Running…' : 'Run again'}
      </button>
    </div>
  )
}
