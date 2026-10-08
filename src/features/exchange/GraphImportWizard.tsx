import '../diagrams/diagrams.css'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { parseTags } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import type { GraphFormat } from '../../core/exchange/graph/graphFormats'
import { checkGraphBytes } from '../../core/exchange/graph/limits'
import { applyGraphPlan, inferGraphMapping, planGraphImport, type GraphImportPlan, type GraphMappingSpec } from '../../core/exchange/graph/mapping'
import type { ParsedGraph } from '../../core/exchange/graph/model'
import { loadParsed } from '../../core/exchange/import'
import { Select } from '../../components/ui/Select'

/**
 * Import a GEXF / GraphML / Cytoscape / nodes+edges CSV file set: what was
 * found → how attributes map to types, labels and tags → what will be
 * written (a dry-run plan), then commit.
 */
export function GraphImportWizard({ format, files, mode, onDone, onClose }: { format: GraphFormat; files: File[]; mode: 'merge' | 'replace'; onDone: (summary: string) => void; onClose: () => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const toast = useToast()
  const [parsed, setParsed] = useState<ParsedGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [mapping, setMapping] = useState<GraphMappingSpec | null>(null)
  const [tagsText, setTagsText] = useState('')

  useEffect(() => {
    let cancelled = false
    // The size first: a file past the bound is refused before any of it is read into the page.
    Promise.resolve()
      .then(() => files.forEach((f) => checkGraphBytes(f.name, f.size)))
      .then(() => Promise.all(files.map(async (f) => (format.binary ? { name: f.name, text: '', bytes: await f.arrayBuffer() } : { name: f.name, text: await f.text() }))))
      .then((texts) => format.parse(texts))
      .then((p) => {
        if (cancelled) return
        setParsed(p)
        setMapping(inferGraphMapping(p, files[0].name))
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [files, format])

  const patch = (p: Partial<GraphMappingSpec>) => setMapping((m) => (m ? { ...m, ...p } : m))
  const plan: GraphImportPlan | null = useMemo(() => (step === 2 && parsed && mapping ? planGraphImport(store, parsed, { ...mapping, tags: parseTags(tagsText.split(/[,\s]+/)) }, `import:${format.id}`) : null), [step, parsed, mapping, tagsText, store, format.id])
  const knownTypes = registry.inCategory('knowledge').map((t) => t.type)

  const commit = async () => {
    if (!plan) return
    if (mode === 'replace') await loadParsed({ entities: [...plan.entities, ...plan.relationships, ...(plan.layout ? [plan.layout] : [])], tags: [], skipped: 0 }, store, { mode: 'replace' })
    else applyGraphPlan(store, plan)
    const summary = `Imported ${plan.entities.length} nodes and ${plan.relationships.length} relationships from ${files.map((f) => f.name).join(' + ')}${plan.layout ? ' — layout saved; load it from the Layout picker' : ''}`
    toast('Import complete')
    onDone(summary)
  }

  const sample = (key: string, of: { attrs: Record<string, unknown> }[]) => of.find((x) => x.attrs[key] !== undefined)?.attrs[key]

  return (
    <Dialog
      open
      wide
      title={`Import ${format.label}`}
      description={files.map((f) => f.name).join(' + ')}
      onClose={onClose}
      footer={
        <>
          {step > 0 && (
            <button className="btn" onClick={() => setStep((s) => (s - 1) as 0 | 1 | 2)}>
              <ChevronLeft size={13} /> Back
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {step < 2 ? (
            <button className="btn btn--primary" disabled={!parsed || !mapping} onClick={() => setStep((s) => (s + 1) as 0 | 1 | 2)}>
              Next <ChevronRight size={13} />
            </button>
          ) : (
            <button className="btn btn--primary" disabled={!plan} onClick={commit}>
              Import {plan ? `${plan.entities.length} nodes` : ''}
            </button>
          )}
        </>
      }
    >
      {error && <p className="gx-panel__note gx-panel__warn">{error}</p>}
      {!parsed && !error && <p className="muted">Reading…</p>}
      {parsed && mapping && step === 0 && (
        <div className="iw">
          <p>
            <strong>{parsed.nodes.length.toLocaleString()}</strong> nodes, <strong>{parsed.edges.length.toLocaleString()}</strong> edges ({parsed.directedDefault ? 'directed' : 'undirected'} by default)
            {parsed.nodes.some((n) => n.viz?.x !== undefined) && ' · positions'}
            {parsed.nodes.some((n) => n.viz?.color) && ' · colours'}
          </p>
          <h4>Node attributes</h4>
          <ul className="iw__list">
            {parsed.attributeKeys.nodes.slice(0, 20).map((k) => (
              <li key={k}>
                <code>{k}</code> <span className="faint">{String(sample(k, parsed.nodes) ?? '')}</span>
              </li>
            ))}
            {parsed.attributeKeys.nodes.length === 0 && <li className="faint">none</li>}
          </ul>
          <h4>Edge attributes</h4>
          <ul className="iw__list">
            {parsed.attributeKeys.edges.slice(0, 20).map((k) => (
              <li key={k}>
                <code>{k}</code> <span className="faint">{String(sample(k, parsed.edges) ?? '')}</span>
              </li>
            ))}
            {parsed.attributeKeys.edges.length === 0 && <li className="faint">none</li>}
          </ul>
          {parsed.warnings.slice(0, 5).map((w) => (
            <p key={w} className="gx-panel__note gx-panel__warn">
              {w}
            </p>
          ))}
        </div>
      )}
      {parsed && mapping && step === 1 && (
        <div className="iw">
          <div className="field">
            <label>Node type</label>
            <div className="gx-row">
              <Select className="gx-select" value={mapping.typeBy} onChange={(e) => patch({ typeBy: e.target.value as 'attr' | 'fixed' })}>
                <option value="attr">from attribute</option>
                <option value="fixed">fixed</option>
              </Select>
              {mapping.typeBy === 'attr' ? (
                <Select className="gx-select" value={mapping.typeAttr ?? ''} onChange={(e) => patch({ typeAttr: e.target.value || undefined })}>
                  <option value="">—</option>
                  {parsed.attributeKeys.nodes.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              ) : (
                <input className="input" list="wiz-types" value={mapping.fixedType} onChange={(e) => patch({ fixedType: e.target.value })} />
              )}
              <datalist id="wiz-types">
                {knownTypes.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="field">
            <label>Label attribute</label>
            <Select className="gx-select" value={mapping.labelAttr ?? ''} onChange={(e) => patch({ labelAttr: e.target.value || undefined })}>
              <option value="">file label / id</option>
              {parsed.attributeKeys.nodes.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Description attribute</label>
            <Select className="gx-select" value={mapping.descriptionAttr ?? ''} onChange={(e) => patch({ descriptionAttr: e.target.value || undefined })}>
              <option value="">none</option>
              {parsed.attributeKeys.nodes.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Tags attribute</label>
            <Select className="gx-select" value={mapping.tagsAttr ?? ''} onChange={(e) => patch({ tagsAttr: e.target.value || undefined })}>
              <option value="">none</option>
              {parsed.attributeKeys.nodes.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Relationship type</label>
            <div className="gx-row">
              <Select className="gx-select" value={mapping.edgeTypeBy} onChange={(e) => patch({ edgeTypeBy: e.target.value as 'attr' | 'label' | 'fixed' })}>
                <option value="attr">from attribute</option>
                <option value="label">from edge label</option>
                <option value="fixed">fixed</option>
              </Select>
              {mapping.edgeTypeBy === 'attr' && (
                <Select className="gx-select" value={mapping.edgeTypeAttr ?? ''} onChange={(e) => patch({ edgeTypeAttr: e.target.value || undefined })}>
                  <option value="">—</option>
                  {parsed.attributeKeys.edges.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              )}
              {mapping.edgeTypeBy === 'fixed' && <input className="input" value={mapping.fixedEdgeType} onChange={(e) => patch({ fixedEdgeType: e.target.value })} />}
            </div>
          </div>
          <div className="field">
            <label>Direction</label>
            <Select className="gx-select" value={mapping.directed} onChange={(e) => patch({ directed: e.target.value as GraphMappingSpec['directed'] })}>
              <option value="file">as in the file</option>
              <option value="directed">all directed</option>
              <option value="undirected">all undirected</option>
            </Select>
          </div>
          <label className="gx-row">
            <input type="checkbox" checked={mapping.attrsToData} onChange={(e) => patch({ attrsToData: e.target.checked })} /> <span>Copy other attributes into data</span>
          </label>
          <label className="gx-row">
            <input type="checkbox" checked={mapping.importLayout} onChange={(e) => patch({ importLayout: e.target.checked })} /> <span>Save positions as a layout</span>
          </label>
          <label className="gx-row">
            <input type="checkbox" checked={mapping.importColors} onChange={(e) => patch({ importColors: e.target.checked })} /> <span>Keep node colours (data.color)</span>
          </label>
          <div className="field">
            <label>Entity ids</label>
            <Select className="gx-select" value={mapping.idMode ?? 'keyed'} onChange={(e) => patch({ idMode: e.target.value as 'keyed' | 'verbatim' })}>
              <option value="keyed">this file's own (gi-{mapping.importKey}-…)</option>
              <option value="verbatim">the node ids as they are (IRIs: the same thing in another file is the same entity)</option>
            </Select>
          </div>
          {mapping.idMode !== 'verbatim' && (
            <label className="gx-row">
              <input type="checkbox" checked={mapping.reuseExistingIds} onChange={(e) => patch({ reuseExistingIds: e.target.checked })} /> <span>Node ids that match existing entities update them</span>
            </label>
          )}
          <div className="field">
            <label>Extra tags</label>
            <input className="input" placeholder="imported, source-x" value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
          </div>
          <div className="field">
            <label>Import key</label>
            <input className="input" style={{ width: 120 }} value={mapping.importKey} onChange={(e) => patch({ importKey: e.target.value.replace(/[^a-z0-9]/gi, '').slice(0, 12) || mapping.importKey })} />
            <p className="muted">Re-importing with the same key updates what it created before.</p>
          </div>
        </div>
      )}
      {plan && step === 2 && (
        <div className="iw">
          <p>
            <strong>{plan.created}</strong> new, <strong>{plan.updated}</strong> updated (previous import), <strong>{plan.reused}</strong> existing entities matched by id · <strong>{plan.relationships.length}</strong> relationships
            {plan.skippedEdges > 0 && ` · ${plan.skippedEdges} edges skipped (unknown endpoints)`}
            {plan.layout && ' · 1 layout'}
          </p>
          {mode === 'replace' && <p className="gx-panel__note gx-panel__warn">Replace mode: the whole Library is cleared first.</p>}
          <ul className="iw__list">
            {plan.entities.slice(0, 12).map((e) => (
              <li key={e.id}>
                <span className="badge">{e.type}</span> {e.label} {e.tags.length > 0 && <span className="faint">#{e.tags.join(' #')}</span>}
              </li>
            ))}
            {plan.entities.length > 12 && <li className="faint">… {plan.entities.length - 12} more</li>}
          </ul>
          {plan.warnings.slice(0, 5).map((w) => (
            <p key={w} className="gx-panel__note gx-panel__warn">
              {w}
            </p>
          ))}
        </div>
      )}
    </Dialog>
  )
}
