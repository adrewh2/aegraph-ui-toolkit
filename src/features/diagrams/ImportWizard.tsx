import { ArrowRight, Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { applyPlan, describeMapping, edgeKey, inferMapping, keyStats, nodeKey, planImport, type EdgeTypeBy, type MappingSpec, type NodeTypeBy, type ParsedDiagram } from '../../core/diagrams'
import { projectionFromPlan, projectionIdFor } from '../../core/graph/projection'
import { extractGeometry } from './render'
import { displayLabel, parseTags } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import type { DiagramEntity } from './diagrams'
import { Select } from '../../components/ui/Select'

/**
 * Three steps: what was found → how to map it → what will be written.
 * The mapping is saved on the diagram so the next export starts from it.
 */
export function ImportWizard({ diagram, parsed, onClose, engine = 'dot' }: { diagram: DiagramEntity; parsed: ParsedDiagram; onClose: () => void; engine?: string }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const toast = useToast()
  const navigate = useNavigate()
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [mapping, setMapping] = useState<MappingSpec>(() => ({ ...inferMapping(parsed, diagram.label), ...((diagram.data.mapping as Partial<MappingSpec> | undefined) ?? {}) }))
  const [tagsText, setTagsText] = useState(mapping.tags.join(', '))
  const [capture, setCapture] = useState(true)
  const [committing, setCommitting] = useState(false)
  const patch = (p: Partial<MappingSpec>) => setMapping((m) => ({ ...m, ...p }))

  const nodeKeys = useMemo(() => keyStats(parsed.nodes, (n) => nodeKey(n, mapping.nodeTypeBy), (n) => n.label), [parsed, mapping.nodeTypeBy])
  const edgeKeys = useMemo(() => keyStats(parsed.edges, (e) => edgeKey(e, mapping.edgeTypeBy), (e) => `${e.source} → ${e.target}`), [parsed, mapping.edgeTypeBy])
  const plan = useMemo(() => (step === 2 ? planImport(store, diagram, parsed, { ...mapping, tags: parseTags(tagsText) }) : null), [step, store, diagram, parsed, mapping, tagsText])
  const knownTypes = registry.inCategory('knowledge').map((t) => t.type)
  const relTypes = registry.relationshipTypes().map((t) => t.type)

  const switchNodeBy = (by: NodeTypeBy) => {
    const fresh = inferMapping(parsed)
    const inferred = { ...fresh, nodeTypeBy: by }
    // Recompute default keys for the new basis, keeping user edits for keys that still exist.
    const nodeTypes: Record<string, string> = {}
    for (const { key } of keyStats(parsed.nodes, (n) => nodeKey(n, by), () => '')) if (key) nodeTypes[key] = mapping.nodeTypes[key] ?? humanKey(parsed, key)
    setMapping((m) => ({ ...m, nodeTypeBy: by, nodeTypes, fixedNodeType: m.fixedNodeType || inferred.fixedNodeType }))
  }
  const switchEdgeBy = (by: EdgeTypeBy) => {
    const edgeTypes: Record<string, string> = {}
    for (const { key } of keyStats(parsed.edges, (e) => edgeKey(e, by), () => '')) if (key) edgeTypes[key] = mapping.edgeTypes[key] ?? key.toLowerCase()
    setMapping((m) => ({ ...m, edgeTypeBy: by, edgeTypes }))
  }

  const commit = async () => {
    if (!plan) return
    setCommitting(true)
    let projectionId: string | undefined
    try {
      applyPlan(store, plan)
      // Geometry rides along as a scene, so the Scenes page can show the import one-to-one.
      if (capture) {
        try {
          const geometry = await extractGeometry(diagram.data.source, diagram.data.format, parsed, engine)
          const proj = projectionFromPlan(diagram, parsed, geometry, plan, store.get(projectionIdFor(diagram.id)), diagram.data.format === 'dot' ? engine : undefined)
          store.upsert(proj)
          projectionId = proj.id
        } catch (err) {
          toast(`Geometry not captured: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const finalMapping = { ...mapping, tags: parseTags(tagsText) }
      store.update(diagram.id, { data: { ...diagram.data, mapping: finalMapping as unknown as Record<string, unknown>, lastImport: { at: new Date().toISOString(), entities: plan.entities.length, relationships: plan.relationships.length, projectionId } } })
      toast(`Exported ${plan.entities.length} entities and ${plan.relationships.length} relationships${projectionId ? ' with geometry' : ''}`)
      onClose()
      if (projectionId) navigate(`/scenes?id=${encodeURIComponent(projectionId)}`)
      else {
        const tag = finalMapping.tags[0]
        navigate(tag ? `/entities?tag=${encodeURIComponent(tag)}` : '/entities')
      }
    } finally {
      setCommitting(false)
    }
  }

  return (
    <Dialog
      open
      wide
      title="Export diagram into the dataset"
      description={['What the diagram contains', 'How nodes and edges become entities and relationships', 'What will be written'][step]}
      onClose={onClose}
      footer={
        <>
          <span className="muted" style={{ marginRight: 'auto', fontSize: 12 }}>
            Step {step + 1} of 3
          </span>
          {step > 0 && (
            <button className="btn" onClick={() => setStep((s) => (s - 1) as 0 | 1 | 2)}>
              <ChevronLeft size={14} /> Back
            </button>
          )}
          {step < 2 ? (
            <button className="btn btn--primary" onClick={() => setStep((s) => (s + 1) as 0 | 1 | 2)} disabled={parsed.nodes.length === 0}>
              Next <ChevronRight size={14} />
            </button>
          ) : (
            <button className="btn btn--primary" onClick={() => void commit()} disabled={!plan || plan.entities.length === 0 || committing}>
              <Check size={14} /> {committing ? 'Exporting…' : `Export ${plan?.entities.length ?? 0} entities`}
            </button>
          )}
        </>
      }
    >
      {step === 0 && (
        <div className="iw">
          <div className="iw__stats">
            <Stat label="Format" value={`${parsed.format} · ${parsed.kind}`} />
            <Stat label="Nodes" value={parsed.nodes.length} />
            <Stat label="Edges" value={parsed.edges.length} />
            <Stat label="Groups" value={parsed.groups.length} />
          </div>
          {parsed.nodes.length === 0 && <p className="error-text">No nodes were found. Check the diagram source.</p>}
          <div className="iw__cols">
            <div>
              <h4>Nodes {parsed.groups.length ? 'by group' : parsed.nodes.some((n) => n.classes.length) ? 'by class' : 'by shape'}</h4>
              <ul className="iw__list">
                {keyStats(parsed.nodes, (n) => nodeKey(n, parsed.groups.length ? 'group' : parsed.nodes.some((x) => x.classes.length) ? 'class' : 'shape'), (n) => n.label).map((k) => (
                  <li key={k.key}>
                    <span className="mono">{k.key || '(none)'}</span>
                    <span className="count">{k.count}</span>
                    <span className="faint">{k.samples.join(', ')}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4>Edges by label</h4>
              <ul className="iw__list">
                {keyStats(parsed.edges, (e) => e.label ?? '', (e) => `${e.source}→${e.target}`).map((k) => (
                  <li key={k.key}>
                    <span className="mono">{k.key || '(unlabelled)'}</span>
                    <span className="count">{k.count}</span>
                    <span className="faint">{k.samples.join(', ')}</span>
                  </li>
                ))}
                {parsed.edges.length === 0 && <li className="faint">No edges.</li>}
              </ul>
            </div>
          </div>
          {parsed.warnings.length > 0 && (
            <details className="iw__warn">
              <summary>{parsed.warnings.length} parser warning{parsed.warnings.length === 1 ? '' : 's'}</summary>
              <ul>
                {parsed.warnings.slice(0, 20).map((w, i) => (
                  <li key={i} className="mono">
                    {w}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="iw">
          <section>
            <h4>
              Entity type comes from
              <Select className="gx-select" value={mapping.nodeTypeBy} onChange={(e) => switchNodeBy(e.target.value as NodeTypeBy)}>
                <option value="group">the node's group (subgraph / cluster)</option>
                <option value="class">the node's class</option>
                <option value="shape">the node's shape</option>
                <option value="fixed">one type for all nodes</option>
              </Select>
            </h4>
            {mapping.nodeTypeBy !== 'fixed' && (
              <table className="iw__map">
                <thead>
                  <tr>
                    <th>{mapping.nodeTypeBy}</th>
                    <th />
                    <th>entity type</th>
                    <th>nodes</th>
                  </tr>
                </thead>
                <tbody>
                  {nodeKeys
                    .filter((k) => k.key)
                    .map((k) => (
                      <tr key={k.key}>
                        <td className="mono" title={k.samples.join(', ')}>
                          {k.key}
                        </td>
                        <td>
                          <ArrowRight size={12} className="faint" />
                        </td>
                        <td>
                          <input className="input" list="iw-types" value={mapping.nodeTypes[k.key] ?? ''} placeholder={mapping.fixedNodeType} onChange={(e) => patch({ nodeTypes: { ...mapping.nodeTypes, [k.key]: e.target.value } })} />
                        </td>
                        <td className="count">{k.count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
            <label className="iw__row">
              <span>{mapping.nodeTypeBy === 'fixed' ? 'Type for all nodes' : `Type for nodes without a ${mapping.nodeTypeBy}`}</span>
              <input className="input" list="iw-types" value={mapping.fixedNodeType} onChange={(e) => patch({ fixedNodeType: e.target.value })} />
              <span className="count">{nodeKeys.find((k) => !k.key)?.count ?? 0}</span>
            </label>
            <datalist id="iw-types">
              {knownTypes.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </section>

          <section>
            <h4>
              Relationship type comes from
              <Select className="gx-select" value={mapping.edgeTypeBy} onChange={(e) => switchEdgeBy(e.target.value as EdgeTypeBy)}>
                <option value="label">the edge's label</option>
                <option value="style">the edge's arrow style</option>
                <option value="fixed">one type for all edges</option>
              </Select>
            </h4>
            {mapping.edgeTypeBy !== 'fixed' && (
              <table className="iw__map">
                <thead>
                  <tr>
                    <th>{mapping.edgeTypeBy}</th>
                    <th />
                    <th>relationship type</th>
                    <th>edges</th>
                  </tr>
                </thead>
                <tbody>
                  {edgeKeys
                    .filter((k) => k.key)
                    .map((k) => (
                      <tr key={k.key}>
                        <td className="mono">{k.key}</td>
                        <td>
                          <ArrowRight size={12} className="faint" />
                        </td>
                        <td>
                          <input className="input" list="iw-rels" value={mapping.edgeTypes[k.key] ?? ''} placeholder={mapping.fixedEdgeType} onChange={(e) => patch({ edgeTypes: { ...mapping.edgeTypes, [k.key]: e.target.value } })} />
                        </td>
                        <td className="count">{k.count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
            <label className="iw__row">
              <span>{mapping.edgeTypeBy === 'fixed' ? 'Type for all edges' : `Type for edges without a ${mapping.edgeTypeBy}`}</span>
              <input className="input" list="iw-rels" value={mapping.fixedEdgeType} onChange={(e) => patch({ fixedEdgeType: e.target.value })} />
              <span className="count">{edgeKeys.find((k) => !k.key)?.count ?? 0}</span>
            </label>
            <datalist id="iw-rels">
              {relTypes.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </section>

          <section>
            <h4>Options</h4>
            <label className="iw__row">
              <span>Tags for everything imported</span>
              <input className="input" value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="comma separated" />
            </label>
            <label className="iw__check">
              <input type="checkbox" checked={mapping.mergeByLabel} onChange={(e) => patch({ mergeByLabel: e.target.checked })} />
              <span>
                <strong>Merge with existing entities that have the same label.</strong> Otherwise every node becomes a new entity.
              </span>
            </label>
            <label className="iw__check">
              <input type="checkbox" checked={mapping.linkToDiagram} onChange={(e) => patch({ linkToDiagram: e.target.checked })} />
              <span>
                <strong>Link imported entities to this diagram</strong> with a <code>derived-from</code> relationship.
              </span>
            </label>
            <label className="iw__check">
              <input type="checkbox" checked={mapping.attrsToData} onChange={(e) => patch({ attrsToData: e.target.checked })} />
              <span>
                <strong>Keep node and edge attributes</strong> (shape, class, colors, class members…) in <code>data</code>.
              </span>
            </label>
            <label className="iw__check">
              <input type="checkbox" checked={capture} onChange={(e) => setCapture(e.target.checked)} />
              <span>
                <strong>Capture geometry as a scene</strong> — positions, sizes, shapes, colours and edge routes as rendered, so the Scenes page can show the result one-to-one and you can adjust it.
              </span>
            </label>
          </section>
        </div>
      )}

      {step === 2 && plan && (
        <div className="iw">
          <p className="muted" style={{ margin: 0 }}>
            {describeMapping({ ...mapping, tags: parseTags(tagsText) })}. Importing this diagram again later updates these same entities rather than duplicating them.
          </p>
          <div className="iw__stats">
            <Stat label="New entities" value={plan.created} />
            <Stat label="Updated" value={plan.updated} />
            <Stat label="Merged into existing" value={plan.reused.length} />
            <Stat label="Relationships" value={plan.relationships.length} />
          </div>
          {plan.collapsed > 0 && <p className="gx-panel__warn" style={{ fontSize: 12 }}>{plan.collapsed} nodes share a label with another node and will map to the same entity.</p>}
          {plan.skippedEdges > 0 && <p className="gx-panel__warn" style={{ fontSize: 12 }}>{plan.skippedEdges} edges lead to or from a group rather than a node and will be left out.</p>}
          <div className="iw__cols">
            <div>
              <h4>Entities</h4>
              <ul className="iw__list iw__list--tall">
                {plan.entities.slice(0, 60).map((e) => {
                  const reused = plan.reused.find((r) => r.entity.id === e.id)
                  return (
                    <li key={e.id}>
                      <span className="badge">{e.type}</span>
                      <span>{displayLabel(e)}</span>
                      {reused && <span className="badge badge--info">merge</span>}
                    </li>
                  )
                })}
                {plan.entities.length > 60 && <li className="faint">…and {plan.entities.length - 60} more</li>}
              </ul>
            </div>
            <div>
              <h4>Relationships</h4>
              <ul className="iw__list iw__list--tall">
                {plan.relationships
                  .filter((r) => r.type !== 'derived-from')
                  .slice(0, 60)
                  .map((r) => {
                    const s = plan.entities.find((e) => e.id === r.source.id)
                    const t = plan.entities.find((e) => e.id === r.target.id)
                    return (
                      <li key={r.id}>
                        <span>{s ? displayLabel(s) : r.source.id}</span>
                        <span className="badge">{r.type}</span>
                        <span>{t ? displayLabel(t) : r.target.id}</span>
                      </li>
                    )
                  })}
                {mapping.linkToDiagram && <li className="faint">+ {plan.relationships.filter((r) => r.type === 'derived-from').length} derived-from links to the diagram</li>}
              </ul>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="iw__stat">
      <span className="iw__stat-label">{label}</span>
      <span className="iw__stat-value">{value}</span>
    </div>
  )
}

function humanKey(parsed: ParsedDiagram, key: string): string {
  const g = parsed.groups.find((x) => x.id === key)
  return (g?.label ?? key).replace(/^cluster_?/i, '').toLowerCase()
}
