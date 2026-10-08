import { BookOpen } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useToast } from '../../components/ui/useToast'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import { projectLabel } from '../../core/projects/project'
import type { Language } from '../../scripting/types'
import { getLatestAnalysis } from '../analysis/latest'
import { ScriptReference } from './ScriptReference'
import { useScriptSchema } from './useScriptSchema'
import './scripts.css'
import { Select } from '../../components/ui/Select'

/**
 * The Reference as a page of its own (`/analytics/scripts/reference`), the
 * Scripts page opens in a new browser tab so it can sit beside the editor:
 * what a script can reach, from the data as it stands — the API by group,
 * the types with their properties, the relationships, the tags, the project
 * and the metrics. Across tabs there is no cursor to insert at, so a row
 * copies its call and a scaffold copies a whole script, to paste into the
 * editor. `?language=python` opens on the Python side.
 */
export function ScriptReferencePage() {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const language: Language = params.get('language') === 'python' ? 'python' : 'js'
  const setLanguage = (l: Language) => setParams({ language: l }, { replace: true })
  const schema = useScriptSchema()
  const metrics = useMemo(() => Object.keys(getLatestAnalysis()?.metrics.columns ?? {}), [version]) // eslint-disable-line react-hooks/exhaustive-deps
  const [last, setLast] = useState('')
  const copy = (text: string, what: string) => {
    setLast(text)
    navigator.clipboard?.writeText(text).then(
      () => toast(`${what} copied — paste it into the script`),
      () => toast('Could not copy: select it below and copy by hand'),
    )
  }
  return (
    <div className="sc sc--reference">
      <div className="sc__top">
        <span className="sc__name">
          <BookOpen size={15} className="sc__name-icon" />
          <span className="sc__reftitle">Script reference</span>
          <span className="muted sc__refnote">{schema.types.length} types · {schema.relationshipTypes.length} relationship types · {schema.tags.length} tags{store.scope ? ` · ${projectLabel(store, store.scope)}` : ''} — a row copies its call, a scaffold copies a whole script</span>
        </span>
        <Select className="gx-select sc__lang" value={language} onChange={(e) => setLanguage(e.target.value as Language)} title="Which language's reference">
          <option value="js">JavaScript</option>
          <option value="python">Python</option>
        </Select>
      </div>
      <div className="sc__body">
        <div className="sc__refpage">
          <ScriptReference schema={schema} language={language} project={store.scope ? { id: store.scope, label: projectLabel(store, store.scope) } : undefined} metrics={metrics} onInsert={(t) => copy(t, 'Call')} onScaffold={(code) => copy(code, 'Scaffold')} />
        </div>
        {last && (
          <div className="sc__refcopied">
            <div className="sc__outhead">
              <span className="sc__outtitle">Copied</span>
              <span className="sc__pane-note">on the clipboard — or select it here</span>
            </div>
            <pre className="sc__value">{last}</pre>
          </div>
        )}
      </div>
    </div>
  )
}
