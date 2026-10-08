import { LayoutTemplate, Plus, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDismiss } from '../../components/ui/useDismiss'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { CONSTRAINT_TYPE, createConstraint, describeApplies, describeRule, describeWatches, inForce, isConstraint, scopeOf, type ConstraintApplies, type ConstraintEntity, type ConstraintRule, type ConstraintScope, type Severity, type Violation } from '../../core/constraints/constraint'
import { ConstraintEngine } from '../../core/constraints/engine'
import { GRAPH_HELPERS, compileGraphRule, graphVerdict, loadRuleRealm } from '../../core/constraints/rules'
import { createTemplate, findTemplate, instantiate, listTemplates, type ConstraintTemplate, type ParamKind, type ParamSpec } from '../../core/constraints/templates'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity } from '../../core/entity/types'
import { projectLabel } from '../../core/projects/project'
import { entityHref } from '../../app/routes'
import { FIELD_OPS, type FieldOp, type FieldPredicate } from '../../core/graph/fields'
import { ExprEditor } from '../expr/ExprEditor'
import { auditScripted } from '../scripts/constraints'
import { markScriptUse, scriptsIn } from '../scripts/script'
import './constraints.css'
import { Select } from '../../components/ui/Select'

const GRAPH_VOCABULARY = { helpers: GRAPH_HELPERS, entity: '' }

/**
 * The Constraints tab of the Ontology: the rules the store enforces on
 * every write, what each watches and checks, whether it is in force, and
 * an audit of the data as it stands. A rule is written in a dialog —
 * declarative conditions with a small form, a JavaScript check over one
 * entity or over the whole graph, or a saved script — or made from a
 * template: a rule with holes, whose parameters draw as a form.
 */
export function ConstraintsPanel({ type }: { /** Only the constraints that watch this type (the type page). */ type?: string } = {}) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const toast = useToast()
  const engine = useMemo(() => new ConstraintEngine(store), [store])
  // JavaScript rules run in the QuickJS realm: load it with the panel, so "Try on" and the audit never wait on it.
  useEffect(() => void loadRuleRealm(), [])
  const [editing, setEditing] = useState<ConstraintEntity | 'new' | null>(null)
  const [templating, setTemplating] = useState<ConstraintEntity | 'new' | null>(null)
  const [audit, setAudit] = useState<{ checked: number; violations: Violation[]; at: number; running?: boolean } | null>(null)

  const constraints = useMemo(() => {
    const all = store.library.ofType(CONSTRAINT_TYPE).filter(isConstraint)
    const scope = store.scope
    return all
      .filter((c) => !type || scopeOf(c) === 'graph' || !c.data.applies?.types?.length || c.data.applies.types.includes(type))
      .map((c) => ({ c, inForce: inForce(c, scope) }))
      .sort((a, b) => Number(b.inForce) - Number(a.inForce) || (a.c.label ?? '').localeCompare(b.c.label ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version, type])

  const runAudit = async () => {
    const types = type ? [type] : undefined
    await engine.ready()
    const r = engine.audit({ types, limit: 500 })
    const scripted = engine.scripted().length
    setAudit({ ...r, at: Date.now(), running: scripted > 0 })
    let violations = r.violations
    if (scripted) {
      const s = await auditScripted(store, registry, engine)
      violations = [...violations, ...(types ? s.violations.filter((v) => !v.entityId || types.includes(store.get(v.entityId)?.type ?? '')) : s.violations)]
      setAudit({ checked: r.checked, violations, at: Date.now() })
    }
    toast(violations.length ? `${violations.length} violation${violations.length === 1 ? '' : 's'} in ${r.checked.toLocaleString()} entities` : `No violations in ${r.checked.toLocaleString()} entities`)
  }
  const edit = (c: ConstraintEntity) => (c.data.template && findTemplate(store, c.data.template) ? setTemplating(c) : setEditing(c))
  const toggle = (c: ConstraintEntity) => store.update(c.id, { data: { ...c.data, enabled: c.data.enabled === false } })
  const remove = (c: ConstraintEntity) => {
    if (!window.confirm(`Delete the constraint “${displayLabel(c)}”?`)) return
    store.remove([c.id])
  }
  const byConstraint = useMemo(() => {
    const m = new Map<string, Violation[]>()
    for (const v of audit?.violations ?? []) m.set(v.constraintId, [...(m.get(v.constraintId) ?? []), v])
    return m
  }, [audit])

  return (
    <div className={`cons ${type ? 'cons--inline' : ''}`}>
      <div className="cons__bar">
        <span className="muted">
          {constraints.length ? `${constraints.filter((x) => x.inForce).length} of ${constraints.length} in force` : type ? 'No constraint watches this type.' : 'No constraints yet. A constraint is a rule every new or changed entity must satisfy — required properties, conditions, uniqueness, what a relationship may join, or a JavaScript check.'}
          {store.scope ? ' · a constraint made now belongs to this project' : ' · a constraint made now applies everywhere'}
        </span>
        <span className="spacer" />
        <button className="btn btn--sm" onClick={runAudit} disabled={!constraints.some((x) => x.inForce)} title="Check the data as it stands against the constraints in force">
          <ShieldCheck size={13} /> Audit
        </button>
        <button className="btn btn--sm" onClick={() => setTemplating('new')} title="A rule with holes: pick one, fill in the form">
          <LayoutTemplate size={13} /> From template
        </button>
        <button className="btn btn--sm btn--primary" onClick={() => setEditing('new')}>
          <Plus size={13} /> New constraint
        </button>
      </div>
      {audit && (
        <div className={`cons__audit ${audit.violations.length ? 'is-bad' : 'is-ok'}`}>
          {audit.violations.length ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
          {audit.violations.length ? `${audit.violations.length}${audit.violations.length >= 500 ? '+' : ''} violation${audit.violations.length === 1 ? '' : 's'}` : 'No violations'} in {audit.checked.toLocaleString()} {audit.checked === 1 ? 'entity' : 'entities'}
          {audit.running && <span className="faint"> · running the script-backed constraints…</span>}
          <button className="btn btn--sm btn--ghost" onClick={() => setAudit(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="cons__list">
        {constraints.map(({ c, inForce }) => {
          const vs = byConstraint.get(c.id) ?? []
          return (
            <div key={c.id} className={`cons__item ${inForce ? '' : 'is-off'}`}>
              <div className="cons__head">
                <label className="cons__toggle" title={c.data.enabled === false ? 'Disabled — click to enable' : 'Enabled — click to disable'}>
                  <input type="checkbox" checked={c.data.enabled !== false} onChange={() => toggle(c)} />
                </label>
                <h3>{displayLabel(c)}</h3>
                <span className={`cons__sev cons__sev--${c.data.severity ?? 'reject'}`}>{c.data.severity === 'warn' ? 'warns' : 'rejects'}</span>
                {scopeOf(c) === 'graph' && <span className="cons__badge" title="Judges the whole dataset at once, as it would stand after a write">graph</span>}
                {c.data.rule?.script && <span className="cons__badge" title="A saved script judges it in the sandbox — by the audit, not at write time">script</span>}
                {c.data.template && <span className="faint" title={`Made from the template ${c.data.template}`}>· {findTemplate(store, c.data.template)?.label ?? 'a template'}</span>}
                {c.meta.projects?.length ? <span className="faint" title="The project this constraint belongs to">· {c.meta.projects.map((p) => projectLabel(store, p)).join(', ')}</span> : null}
                {!inForce && c.data.enabled !== false && <span className="muted">another project's</span>}
                <span className="spacer" />
                {audit && <span className={`cons__count ${vs.length ? 'is-bad' : 'is-ok'}`}>{vs.length ? `${vs.length} violation${vs.length === 1 ? '' : 's'}` : 'clean'}</span>}
                <button className="btn btn--sm btn--ghost" onClick={() => edit(c)}>
                  Edit
                </button>
                <button className="btn btn--sm btn--ghost btn--icon" title="Delete" onClick={() => remove(c)}>
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="cons__what">
                <span className="cons__applies">{describeWatches(c)}</span>
                <span className="faint">must satisfy</span>
                <span className="cons__rule">{describeRule(c.data.rule ?? {})}</span>
              </div>
              {c.description && <p className="cons__desc">{c.description}</p>}
              {vs.length > 0 && (
                <div className="cons__violations">
                  {vs.slice(0, 12).map((v, i) => (
                    <button key={i} className="cons__violation" onClick={() => { const e = store.get(v.entityId); if (e) navigate(entityHref(e, registry)) }} title={v.entityId ? 'Open the entity' : undefined}>
                      <span className="cons__vent">{v.entity}</span>
                      <span className="muted">{v.message}</span>
                    </button>
                  ))}
                  {vs.length > 12 && <span className="faint">… {vs.length - 12} more</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {editing && <ConstraintDialog key={editing === 'new' ? 'new' : editing.id} existing={editing === 'new' ? undefined : editing} defaultType={type} onClose={() => setEditing(null)} />}
      {templating && <TemplateDialog key={templating === 'new' ? 'new' : templating.id} existing={templating === 'new' ? undefined : templating} defaultType={type} onClose={() => setTemplating(null)} />}
    </div>
  )
}

// ── The editor ───────────────────────────────────────────────────────────

const EMPTY_PRED: FieldPredicate = { path: '', op: 'exists' }

/**
 * Two panes: on the left what the rule watches and how it fails; on the
 * right the rule — Conditions (the declarative parts, in aligned rows)
 * or Code (the expression editor with completion over the watched types).
 * Both halves of the rule are checked; the footer reads the whole rule
 * back in one line.
 */
function ConstraintDialog({ existing, defaultType, onClose }: { existing?: ConstraintEntity; defaultType?: string; onClose: () => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const toast = useToast()
  const d = existing?.data
  const [label, setLabel] = useState(existing?.label ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [severity, setSeverity] = useState<Severity>(d?.severity ?? 'reject')
  const [kind, setKind] = useState<'both' | 'entity' | 'relationship'>(d?.applies?.kinds?.length === 1 ? d.applies.kinds[0] : 'both')
  const [types, setTypes] = useState<string[]>(d?.applies?.types ?? (defaultType ? [defaultType] : []))
  const [tags, setTags] = useState<string>(d?.applies?.tags?.join(', ') ?? '')
  const [required, setRequired] = useState<string>(d?.rule?.required?.join(', ') ?? '')
  const [forbidden, setForbidden] = useState<string>(d?.rule?.forbidden?.join(', ') ?? '')
  const [unique, setUnique] = useState<string>(d?.rule?.unique?.join(', ') ?? '')
  const [labelPattern, setLabelPattern] = useState<string>(d?.rule?.labelPattern ?? '')
  const [fields, setFields] = useState<FieldPredicate[]>(d?.rule?.fields?.length ? d.rule.fields : [])
  const [endSource, setEndSource] = useState<string>(d?.rule?.ends?.source?.join(', ') ?? '')
  const [endTarget, setEndTarget] = useState<string>(d?.rule?.ends?.target?.join(', ') ?? '')
  const [noSelf, setNoSelf] = useState(!!d?.rule?.ends?.noSelf)
  const [endsExist, setEndsExist] = useState(!!d?.rule?.ends?.endsExist)
  const [maxPerSource, setMaxPerSource] = useState<string>(d?.rule?.ends?.maxPerSource?.toString() ?? '')
  const [maxPerTarget, setMaxPerTarget] = useState<string>(d?.rule?.ends?.maxPerTarget?.toString() ?? '')
  const [js, setJs] = useState<string>(d?.rule?.js ?? '')
  const [script, setScript] = useState<string>(d?.rule?.script ?? '')
  const [scope, setScope] = useState<ConstraintScope>(d?.scope ?? 'entity')
  const [message, setMessage] = useState<string>(d?.message ?? '')
  const [pane, setPane] = useState<'conditions' | 'code' | 'script'>(d?.rule?.script && !d.rule.js ? 'script' : scope === 'graph' || (d?.rule?.js && !hasDeclarative(d.rule)) ? 'code' : 'conditions')
  const scripts = useMemo(() => scriptsIn(store).sort((a, b) => (a.label ?? '').localeCompare(b.label ?? '')), [store])
  // A graph rule is evaluated over the store as it stands; the entity picked in “Try on” is beside the point.
  const graphEvaluate = (code: string, _e: AnyEntity) => {
    const vs = graphVerdict(compileGraphRule(code)({ store, others: new Map() }))
    return vs.length ? `${vs.length} violation${vs.length === 1 ? '' : 's'}: ${vs.slice(0, 3).map((v) => `${v.id ? `${store.get(v.id)?.label ?? v.id}: ` : ''}${v.message}`).join('; ')}${vs.length > 3 ? '…' : ''}` : undefined
  }
  const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
  const typeNames = useMemo(() => registry.all().filter((t) => t.type !== 'schema:type' && (t.count > 0 || t.origin !== 'inferred')).map((t) => ({ type: t.type, label: t.label, count: t.count, rel: t.kind === 'relationship' })).sort((a, b) => b.count - a.count), [registry])

  const build = (): { applies: ConstraintApplies; rule: ConstraintRule } => {
    const applies: ConstraintApplies = {}
    if (kind !== 'both') applies.kinds = [kind]
    if (types.length) applies.types = types
    if (list(tags).length) applies.tags = list(tags)
    const rule: ConstraintRule = {}
    if (list(required).length) rule.required = list(required)
    if (list(forbidden).length) rule.forbidden = list(forbidden)
    if (list(unique).length) rule.unique = list(unique)
    if (labelPattern.trim()) rule.labelPattern = labelPattern.trim()
    const preds = fields.filter((f) => f.path.trim())
    if (preds.length) rule.fields = preds.map((f) => ({ ...f, value: parseValue(f.op, f.value) }))
    const ends: NonNullable<ConstraintRule['ends']> = {}
    if (list(endSource).length) ends.source = list(endSource)
    if (list(endTarget).length) ends.target = list(endTarget)
    if (noSelf) ends.noSelf = true
    if (endsExist) ends.endsExist = true
    if (maxPerSource.trim()) ends.maxPerSource = Number(maxPerSource)
    if (maxPerTarget.trim()) ends.maxPerTarget = Number(maxPerTarget)
    if (Object.keys(ends).length) rule.ends = ends
    if (scope === 'graph') return { applies: {}, rule: { ...(js.trim() ? { js } : {}), ...(script ? { script } : {}) } }
    if (js.trim()) rule.js = js
    if (script) rule.script = script
    return { applies, rule }
  }
  const save = () => {
    const { applies, rule } = build()
    if (!label.trim()) return toast('Give the constraint a name.')
    if (!Object.keys(rule).length) return toast('The rule needs at least one condition.')
    if (existing) store.update(existing.id, { label: label.trim(), description: description.trim() || undefined, data: { ...existing.data, applies, rule, severity, message: message.trim() || undefined, ...(scope === 'graph' ? { scope } : { scope: undefined }) } })
    else store.upsert(createConstraint({ label: label.trim(), description: description.trim() || undefined, applies, rule, severity, message: message.trim() || undefined, scope }))
    // A script judging a constraint is a constraint script, if it was not already something else.
    if (rule.script) markScriptUse(store, rule.script, 'constraint')
    toast(existing ? 'Constraint updated' : 'Constraint added — it applies to writes from now on; Audit checks what is already there')
    onClose()
  }
  const preview = build()
  const declarativeCount = Object.keys(preview.rule).filter((k) => k !== 'js').length
  const toggleType = (t: string) => setTypes((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))
  const [typeQ, setTypeQ] = useState('')
  const typeBox = useRef<HTMLDivElement>(null)
  // The list of matching types shows while there is a query: a press elsewhere in the dialog, or Escape, lets it go
  // (and the query with it) without closing the dialog.
  useDismiss(() => setTypeQ(''), { active: !!typeQ, inside: () => [typeBox.current] })
  const typeChoices = typeNames.filter((t) => (kind === 'both' || (kind === 'relationship') === t.rel) && (!typeQ || t.type.includes(typeQ.toLowerCase()) || t.label.toLowerCase().includes(typeQ.toLowerCase())))

  return (
    <Dialog open wide className="cdlg" title={existing ? 'Edit constraint' : 'New constraint'} onClose={onClose} footer={
      <>
        <span className="muted cdlg__preview" title={describeRule(preview.rule)}>
          <strong>{scope === 'graph' ? 'the whole graph' : describeApplies(preview.applies)}</strong> must satisfy {describeRule(preview.rule)}
        </span>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={save}>
          {existing ? 'Save' : 'Add constraint'}
        </button>
      </>
    }>
      <div className="cdlg__body">
        <div className="cdlg__left">
          <div className="cdlg__grid">
            <label>Name</label>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="People have birth years" autoFocus />
            <label>Why</label>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="So the timeline can place them" />
            <label>On failure</label>
            <div className="cdlg__seg" role="radiogroup">
              <button type="button" className={severity === 'reject' ? 'is-active' : ''} onClick={() => setSeverity('reject')}>
                Reject
              </button>
              <button type="button" className={severity === 'warn' ? 'is-active' : ''} onClick={() => setSeverity('warn')}>
                Warn
              </button>
            </div>
            <label>Message</label>
            <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="A person needs a birth year" />
            <label>Judges</label>
            <div className="cdlg__seg" role="radiogroup">
              <button type="button" className={scope === 'entity' ? 'is-active' : ''} onClick={() => setScope('entity')} title="Each entity of a write, on its own">
                Each entity
              </button>
              <button type="button" className={scope === 'graph' ? 'is-active' : ''} onClick={() => { setScope('graph'); if (pane === 'conditions') setPane('code') }} title="The whole dataset at once, as it would stand after the write — for invariants over the graph or the ontology">
                The whole graph
              </button>
            </div>
          </div>
          {scope === 'graph' ? (
            <p className="muted cdlg__codehint">A graph rule runs once per write over the store with the write laid on top, and in every audit. What was already violated never blocks an unrelated write.</p>
          ) : (
          <>
          <div className="cdlg__section">Watches</div>
          <div className="cdlg__grid">
            <label>Kind</label>
            <div className="cdlg__seg" role="radiogroup">
              <button type="button" className={kind === 'both' ? 'is-active' : ''} onClick={() => setKind('both')}>
                Both
              </button>
              <button type="button" className={kind === 'entity' ? 'is-active' : ''} onClick={() => setKind('entity')}>
                Entities
              </button>
              <button type="button" className={kind === 'relationship' ? 'is-active' : ''} onClick={() => setKind('relationship')}>
                Relationships
              </button>
            </div>
            <label>Types</label>
            <div className="cdlg__types" ref={typeBox}>
              <div className="cdlg__chips">
                {types.map((t) => (
                  <button key={t} type="button" className="cdlg__chip is-on" onClick={() => toggleType(t)} title="Remove">
                    {t} <X size={10} />
                  </button>
                ))}
                {!types.length && <span className="faint">any type</span>}
              </div>
              <input className="input cdlg__typeq" value={typeQ} placeholder="Find a type to add…" onChange={(e) => setTypeQ(e.target.value)} />
              {typeQ && (
                <div className="cdlg__typelist">
                  {typeChoices.slice(0, 8).map((t) => (
                    <button key={t.type} type="button" className="cdlg__typeopt" onClick={() => (toggleType(t.type), setTypeQ(''))}>
                      <span className="mono">{t.type}</span>
                      <span className="faint">{t.count.toLocaleString()}</span>
                    </button>
                  ))}
                  {!typeChoices.length && <span className="faint">no such type</span>}
                </div>
              )}
            </div>
            <label>Tags</label>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="any of: reviewed, imported" />
          </div>
          </>
          )}
        </div>

        <div className="cdlg__right">
          <div className="cdlg__ruletabs">
            <div className="cdlg__seg" role="tablist">
              {scope === 'entity' && (
                <button type="button" role="tab" className={pane === 'conditions' ? 'is-active' : ''} onClick={() => setPane('conditions')}>
                  Conditions{declarativeCount ? <span className="cdlg__badge">{declarativeCount}</span> : null}
                </button>
              )}
              <button type="button" role="tab" className={pane === 'code' ? 'is-active' : ''} onClick={() => setPane('code')}>
                Code{js.trim() ? <span className="cdlg__badge">1</span> : null}
              </button>
              <button type="button" role="tab" className={pane === 'script' ? 'is-active' : ''} onClick={() => setPane('script')}>
                Script{script ? <span className="cdlg__badge">1</span> : null}
              </button>
            </div>
            <span className="faint">every part is checked</span>
          </div>
          {pane === 'script' ? (
            <div className="cdlg__code">
              <p className="muted cdlg__codehint">
                A saved script judges the dataset in the sandbox — JavaScript or Python over <span className="mono">ds</span>, written on the Scripts page — returning true, a message, a list of <span className="mono">{'{ id, message }'}</span>, or a table (a DataFrame) with those columns. It runs in the audit, not at write time.
              </p>
              <Select className="input" value={script} onChange={(e) => setScript(e.target.value)}>
                <option value="">no script</option>
                {scripts.map((sc) => (
                  <option key={sc.id} value={sc.id}>
                    {displayLabel(sc)} · {sc.data.language ?? 'js'}
                  </option>
                ))}
              </Select>
              {!scripts.length && <span className="faint">No saved scripts yet — write one on the Scripts page and save it.</span>}
            </div>
          ) : pane === 'conditions' && scope === 'entity' ? (
            <div className="cdlg__grid cdlg__grid--rule">
              <label>Required</label>
              <input className="input mono" value={required} onChange={(e) => setRequired(e.target.value)} placeholder="label, data.born" />
              <label>Forbidden</label>
              <input className="input mono" value={forbidden} onChange={(e) => setForbidden(e.target.value)} placeholder="data.legacyId" />
              <label>Unique</label>
              <input className="input mono" value={unique} onChange={(e) => setUnique(e.target.value)} placeholder="label, data.email" />
              <label>Label matches</label>
              <input className="input mono" value={labelPattern} onChange={(e) => setLabelPattern(e.target.value)} placeholder="^[A-Z]" />
              <label>
                Fields
                <button type="button" className="cdlg__add" onClick={() => setFields((f) => [...f, { ...EMPTY_PRED }])} title="Add a field condition">
                  <Plus size={11} />
                </button>
              </label>
              <div className="cdlg__preds">
                {!fields.length && <span className="faint">no field conditions — add one</span>}
                {fields.map((f, i) => (
                  <div key={i} className="cdlg__pred">
                    <input className="input mono" value={f.path} placeholder="data.year" onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
                    <Select className="input" value={f.op} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, op: e.target.value as FieldOp } : x)))}>
                      {FIELD_OPS.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                    {FIELD_OPS.find((o) => o.id === f.op)?.arity !== 0 ? <input className="input" value={valueText(f.value)} placeholder={f.op === 'between' ? 'lo, hi' : f.op === 'in' ? 'a, b, c' : 'value'} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} /> : <span />}
                    <button type="button" className="cdlg__x" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} aria-label="Remove">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              {kind !== 'entity' && (
                <>
                  <div className="cdlg__section cdlg__section--span">Relationship ends</div>
                  <label>Source types</label>
                  <input className="input mono" value={endSource} onChange={(e) => setEndSource(e.target.value)} placeholder="person" />
                  <label>Target types</label>
                  <input className="input mono" value={endTarget} onChange={(e) => setEndTarget(e.target.value)} placeholder="paper, book" />
                  <label>At most</label>
                  <div className="cdlg__inline">
                    <input className="input" type="number" min={0} value={maxPerSource} onChange={(e) => setMaxPerSource(e.target.value)} placeholder="∞" /> <span className="muted">per source</span>
                    <input className="input" type="number" min={0} value={maxPerTarget} onChange={(e) => setMaxPerTarget(e.target.value)} placeholder="∞" /> <span className="muted">per target</span>
                  </div>
                  <label>Also</label>
                  <div className="cdlg__inline">
                    <label className="cdlg__check">
                      <input type="checkbox" checked={noSelf} onChange={(e) => setNoSelf(e.target.checked)} /> no self-links
                    </label>
                    <label className="cdlg__check">
                      <input type="checkbox" checked={endsExist} onChange={(e) => setEndsExist(e.target.checked)} /> both ends must exist
                    </label>
                  </div>
                </>
              )}
            </div>
          ) : scope === 'graph' ? (
            <div className="cdlg__code">
              <p className="muted cdlg__codehint">
                Over the whole dataset: true passes; false or a string fails the write; a list of <span className="mono">violation(id, message)</span> names the entities at fault. <span className="mono">ofType</span>, <span className="mono">inn</span>, <span className="mono">out</span>, <span className="mono">neighbors</span>, <span className="mono">cycle</span>, <span className="mono">types</span>… complete as you type; Try on evaluates it over the data as it stands.
              </p>
              <ExprEditor value={js} onChange={setJs} vocabulary={GRAPH_VOCABULARY} evaluate={graphEvaluate} rows={6} placeholder={"ofType('paper').filter((p) => !inn(p, 'wrote').length).map((p) => violation(p, 'no author'))"} onSubmit={save} />
            </div>
          ) : (
            <div className="cdlg__code">
              <p className="muted cdlg__codehint">
                An expression over <span className="mono">e</span>, the entity being written: true passes; false or a string (the message) fails. <span className="mono">has</span>, <span className="mono">get</span>, <span className="mono">out</span>, <span className="mono">neighbors</span>, <span className="mono">unique</span>… complete as you type — open Reference for the whole vocabulary and the watched types' properties.
              </p>
              <ExprEditor value={js} onChange={setJs} types={types} rows={6} placeholder={"has('data.born') && get('data.born') > 1000 || 'a person needs a plausible birth year'"} onSubmit={save} />
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}

const hasDeclarative = (r: ConstraintRule) => Object.keys(r).some((k) => k !== 'js')

const valueText = (v: unknown) => (v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v))
/** The text a predicate's value was typed as → what the predicate wants: numbers where they parse, lists for between / in. */
function parseValue(op: FieldOp, v: unknown): unknown {
  if (typeof v !== 'string') return v
  const scalar = (s: string) => (s.trim() !== '' && !Number.isNaN(Number(s)) ? Number(s) : s === 'true' ? true : s === 'false' ? false : s.trim())
  if (op === 'between' || op === 'in') return v.split(',').map(scalar)
  if (op === 'exists') return undefined
  return scalar(v)
}

// ── From a template ──────────────────────────────────────────────────────

/**
 * A rule with holes: the templates on the left (built-in, then the user's
 * own), the chosen one's parameters as a form on the right — a type
 * picker, a relationship picker, a number… each from the template's
 * declaration — with the rendered rule read back live. Editing a
 * constraint made from a template reopens this form with its parameters.
 */
function TemplateDialog({ existing, defaultType, onClose }: { existing?: ConstraintEntity; defaultType?: string; onClose: () => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const version = useStoreVersion(store)
  const toast = useToast()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const templates = useMemo(() => listTemplates(store), [store, version])
  const [templateId, setTemplateId] = useState<string>(existing?.data.template ?? '')
  const [params, setParams] = useState<Record<string, unknown>>(existing?.data.params ?? (defaultType ? { type: defaultType } : {}))
  const [label, setLabel] = useState(existing?.label ?? '')
  const [severity, setSeverity] = useState<Severity>(existing?.data.severity ?? 'reject')
  const [message, setMessage] = useState(existing?.data.message ?? '')
  const [authoring, setAuthoring] = useState<ConstraintTemplate | 'new' | null>(null)
  const [q, setQ] = useState('')
  const template = templates.find((t) => t.id === templateId)
  const entityTypes = useMemo(() => registry.all().filter((t) => t.kind !== 'relationship' && t.type !== 'schema:type' && (t.count > 0 || t.origin !== 'inferred')).sort((a, b) => b.count - a.count), [registry])
  const relTypes = useMemo(() => registry.relationshipTypes().sort((a, b) => b.relationshipCount - a.relationshipCount), [registry])

  let rendered: ReturnType<typeof instantiate> | undefined
  let problem: string | undefined
  if (template) {
    try {
      rendered = instantiate(template, params)
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err)
    }
  }
  const pick = (t: ConstraintTemplate) => {
    setTemplateId(t.id)
    // Keep parameters that carry over (the type picked on a type page); drop the rest.
    setParams((p) => Object.fromEntries(t.params.filter((s) => p[s.name] !== undefined).map((s) => [s.name, p[s.name]])))
  }
  const save = () => {
    if (!template || !rendered) return toast(problem ?? 'Pick a template and fill in its form.')
    const name = label.trim() || rendered.label
    if (existing) store.update(existing.id, { label: name, data: { ...existing.data, applies: rendered.applies, rule: rendered.rule, scope: rendered.scope === 'graph' ? 'graph' : undefined, template: template.id, params: rendered.params, severity, message: message.trim() || rendered.message } })
    else store.upsert(createConstraint({ label: name, description: template.description, applies: rendered.applies, rule: rendered.rule, scope: rendered.scope, template: template.id, params: rendered.params, severity, message: message.trim() || rendered.message }))
    toast(existing ? 'Constraint updated' : 'Constraint added — it applies to writes from now on; Audit checks what is already there')
    onClose()
  }
  const set = (name: string, v: unknown) => setParams((p) => ({ ...p, [name]: v }))
  const field = (p: ParamSpec) => {
    const v = params[p.name]
    const text = v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v)
    switch (p.kind) {
      case 'type':
        return (
          <Select className="input" value={text} onChange={(e) => set(p.name, e.target.value)}>
            <option value="">choose a type…</option>
            {text && !entityTypes.some((t) => t.type === text) && <option value={text}>{text} (not in use here)</option>}
            {entityTypes.map((t) => (
              <option key={t.type} value={t.type}>
                {t.type} ({t.count.toLocaleString()})
              </option>
            ))}
          </Select>
        )
      case 'relationship':
        return (
          <Select className="input" value={text} onChange={(e) => set(p.name, e.target.value)}>
            <option value="">choose a relationship…</option>
            {text && !relTypes.some((t) => t.type === text) && <option value={text}>{text} (not in use here)</option>}
            {relTypes.map((t) => (
              <option key={t.type} value={t.type}>
                {t.type} ({t.relationshipCount.toLocaleString()})
              </option>
            ))}
          </Select>
        )
      case 'enum':
        return (
          <Select className="input" value={text || String(p.default ?? '')} onChange={(e) => set(p.name, e.target.value)}>
            {(p.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        )
      case 'number':
        return <input className="input" type="number" value={text} placeholder={p.default !== undefined ? String(p.default) : ''} onChange={(e) => set(p.name, e.target.value === '' ? undefined : Number(e.target.value))} />
      case 'boolean':
        return (
          <label className="cdlg__check">
            <input type="checkbox" checked={v === true} onChange={(e) => set(p.name, e.target.checked)} /> {p.doc ?? ''}
          </label>
        )
      case 'types':
        return <input className="input mono" list="cons-types" value={text} placeholder="person, paper" onChange={(e) => set(p.name, e.target.value)} />
      case 'path':
        return <input className="input mono" list="cons-paths" value={text} placeholder="data.born" onChange={(e) => set(p.name, e.target.value)} />
      case 'list':
        return <input className="input" value={text} placeholder="a, b, c" onChange={(e) => set(p.name, e.target.value)} />
      default:
        return <input className="input mono" value={text} placeholder={p.kind === 'regex' ? '^[A-Z]' : ''} onChange={(e) => set(p.name, e.target.value)} />
    }
  }
  const watched = String(params.type ?? '')
  const pathChoices = useMemo(() => (watched ? registry.propertiesOf(watched).map((x) => `data.${x.key}`) : []), [registry, watched])
  const shown = templates.filter((t) => !q || t.label.toLowerCase().includes(q.toLowerCase()) || t.description.toLowerCase().includes(q.toLowerCase()))

  return (
    <Dialog open wide className="cdlg" title={existing ? 'Edit constraint' : 'New constraint from a template'} onClose={onClose} footer={
      <>
        <span className={`muted cdlg__preview ${problem ? 'is-bad' : ''}`} title={rendered ? describeRule(rendered.rule) : problem}>
          {rendered ? (
            <>
              <strong>{rendered.scope === 'graph' ? 'the whole graph' : describeApplies(rendered.applies)}</strong> must satisfy {describeRule(rendered.rule)}
            </>
          ) : template ? problem : 'Pick a template'}
        </span>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={save} disabled={!rendered}>
          {existing ? 'Save' : 'Add constraint'}
        </button>
      </>
    }>
      <datalist id="cons-types">
        {entityTypes.map((t) => (
          <option key={t.type} value={t.type} />
        ))}
      </datalist>
      <datalist id="cons-paths">
        {['label', 'description', 'tags', ...pathChoices].map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <div className="cdlg__body">
        <div className="cdlg__left cdlg__tpls">
          <input className="input" value={q} placeholder="Find a template…" onChange={(e) => setQ(e.target.value)} autoFocus={!existing} />
          <div className="cdlg__tpllist">
            {(['entity', 'graph'] as const).map((sc) => {
              const group = shown.filter((t) => t.scope === sc)
              if (!group.length) return null
              return (
                <div key={sc}>
                  <div className="cdlg__section">{sc === 'entity' ? 'Each entity' : 'The whole graph'}</div>
                  {group.map((t) => (
                    <button key={t.id} type="button" className={`cdlg__tpl ${t.id === templateId ? 'is-on' : ''}`} onClick={() => pick(t)} title={t.description}>
                      <span>{t.label}</span>
                      {!t.builtin && <span className="faint">yours</span>}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
          <div className="cdlg__inline">
            <button type="button" className="btn btn--sm" onClick={() => setAuthoring('new')} title="A template of your own: code with parameters, drawn as a form like these">
              <Plus size={12} /> New template
            </button>
            {template && !template.builtin && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAuthoring(template)}>
                Edit template
              </button>
            )}
          </div>
        </div>
        <div className="cdlg__right">
          {template ? (
            <>
              <p className="muted cdlg__codehint">{template.description}</p>
              <div className="cdlg__grid cdlg__grid--rule">
                {template.params.map((p) => (
                  <div key={p.name} className="cdlg__param">
                    <label title={p.doc}>
                      {p.label ?? p.name}
                      {p.required === false && <span className="faint"> (optional)</span>}
                    </label>
                    {field(p)}
                  </div>
                ))}
                {!template.params.length && <span className="faint">This template has no parameters.</span>}
              </div>
              <div className="cdlg__section">Constraint</div>
              <div className="cdlg__grid">
                <label>Name</label>
                <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={rendered?.label ?? ''} />
                <label>On failure</label>
                <div className="cdlg__seg" role="radiogroup">
                  <button type="button" className={severity === 'reject' ? 'is-active' : ''} onClick={() => setSeverity('reject')}>
                    Reject
                  </button>
                  <button type="button" className={severity === 'warn' ? 'is-active' : ''} onClick={() => setSeverity('warn')}>
                    Warn
                  </button>
                </div>
                <label>Message</label>
                <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={rendered?.message ?? 'Shown when the rule fails'} />
              </div>
              {rendered?.rule.js && (
                <details className="cdlg__rendered">
                  <summary className="faint">The rule it renders to</summary>
                  <pre className="mono">{rendered.rule.js}</pre>
                </details>
              )}
            </>
          ) : (
            <p className="muted cdlg__codehint">Pick a template on the left. Each is a rule with holes — a type, a relationship, a number — that this form fills in; the constraint it makes keeps the template's name and its parameters, so it can be edited here again.</p>
          )}
        </div>
      </div>
      {authoring && <TemplateEditor existing={authoring === 'new' ? undefined : authoring} onClose={(id) => { setAuthoring(null); if (id) setTemplateId(id) }} />}
    </Dialog>
  )
}

const PARAM_KINDS: ParamKind[] = ['type', 'types', 'relationship', 'path', 'string', 'number', 'boolean', 'regex', 'list', 'enum']

/**
 * A template of the user's own: code in the rule vocabulary of its scope
 * reading `params.<name>`, and the parameters as rows — each becomes a
 * field of the form above. Constraints made from it follow its code.
 */
function TemplateEditor({ existing, onClose }: { existing?: ConstraintTemplate; onClose: (id?: string) => void }) {
  const store = useEntityStore()
  const toast = useToast()
  const e = existing?.entity
  const [label, setLabel] = useState(existing?.label ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [scope, setScope] = useState<ConstraintScope>(existing?.scope ?? 'entity')
  const [code, setCode] = useState(e?.data.code ?? '')
  const [types, setTypes] = useState(e?.data.applies?.types?.join(', ') ?? '')
  const [labelPattern, setLabelPattern] = useState(e?.data.labelPattern ?? '')
  const [params, setParams] = useState<ParamSpec[]>(existing?.params ?? [{ name: 'type', label: 'Type', kind: 'type' }])
  const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
  const setP = (i: number, patch: Partial<ParamSpec>) => setParams((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const save = () => {
    if (!label.trim()) return toast('Give the template a name.')
    if (!code.trim()) return toast('The template needs code.')
    if (params.some((p) => !p.name.trim())) return toast('Every parameter needs a name.')
    const data = { code, params: params.map((p) => ({ ...p, name: p.name.trim(), ...(p.kind === 'enum' ? { options: p.options ?? [] } : {}) })), ...(scope === 'graph' ? { scope } : {}), ...(list(types).length && scope === 'entity' ? { applies: { types: list(types) } } : {}), ...(labelPattern.trim() ? { labelPattern: labelPattern.trim() } : {}) }
    let id: string
    if (e) {
      store.update(e.id, { label: label.trim(), description: description.trim() || undefined, data: { ...e.data, ...data, scope: scope === 'graph' ? 'graph' : undefined, applies: data.applies } })
      id = e.id
    } else {
      const t = createTemplate({ label: label.trim(), description: description.trim() || undefined, scope, params: data.params, code, applies: data.applies, labelPattern: data.labelPattern })
      store.upsert(t)
      id = t.id
    }
    toast(e ? 'Template updated — constraints made from it follow' : 'Template added')
    onClose(id)
  }
  return (
    <Dialog open wide className="cdlg" title={e ? 'Edit template' : 'New template'} onClose={() => onClose()} footer={
      <>
        <span className="muted cdlg__preview">The code reads its parameters as <span className="mono">params.&lt;name&gt;</span>; <span className="mono">{'{{name}}'}</span> in the watched types and the name pattern is filled in too.</span>
        <button className="btn" onClick={() => onClose()}>
          Cancel
        </button>
        <button className="btn btn--primary" onClick={save}>
          {e ? 'Save' : 'Add template'}
        </button>
      </>
    }>
      <div className="cdlg__body">
        <div className="cdlg__left">
          <div className="cdlg__grid">
            <label>Name</label>
            <input className="input" value={label} onChange={(ev) => setLabel(ev.target.value)} placeholder="Born after a year" autoFocus />
            <label>Describes</label>
            <input className="input" value={description} onChange={(ev) => setDescription(ev.target.value)} placeholder="Every entity of a type was born after a year" />
            <label>Judges</label>
            <div className="cdlg__seg" role="radiogroup">
              <button type="button" className={scope === 'entity' ? 'is-active' : ''} onClick={() => setScope('entity')}>
                Each entity
              </button>
              <button type="button" className={scope === 'graph' ? 'is-active' : ''} onClick={() => setScope('graph')}>
                The whole graph
              </button>
            </div>
            {scope === 'entity' && (
              <>
                <label>Watches</label>
                <input className="input mono" value={types} onChange={(ev) => setTypes(ev.target.value)} placeholder="{{type}}" title="Types, or {{name}} for a type parameter" />
              </>
            )}
            <label>Name pattern</label>
            <input className="input" value={labelPattern} onChange={(ev) => setLabelPattern(ev.target.value)} placeholder="{{type}} born after {{year}}" />
          </div>
          <div className="cdlg__section">
            Parameters
            <button type="button" className="cdlg__add" onClick={() => setParams((ps) => [...ps, { name: '', kind: 'string' }])} title="Add a parameter">
              <Plus size={11} />
            </button>
          </div>
          <div className="cdlg__preds">
            {params.map((p, i) => (
              <div key={i} className="cdlg__pred cdlg__pred--param">
                <input className="input mono" value={p.name} placeholder="name" onChange={(ev) => setP(i, { name: ev.target.value })} />
                <Select className="input" value={p.kind} onChange={(ev) => setP(i, { kind: ev.target.value as ParamKind })}>
                  {PARAM_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
                {p.kind === 'enum' ? <input className="input" value={(p.options ?? []).join(', ')} placeholder="a, b, c" onChange={(ev) => setP(i, { options: list(ev.target.value) })} /> : <input className="input" value={p.label ?? ''} placeholder="label" onChange={(ev) => setP(i, { label: ev.target.value || undefined })} />}
                <button type="button" className="cdlg__x" onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))} aria-label="Remove">
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="cdlg__right">
          <div className="cdlg__code">
            <p className="muted cdlg__codehint">{scope === 'graph' ? 'Over the whole dataset: true passes; false or a string fails; a list of violation(id, message) names the entities at fault.' : 'Over e, the entity being written: true passes; false or a string (the message) fails.'} The parameters are in <span className="mono">params</span>.</p>
            {scope === 'graph' ? <ExprEditor value={code} onChange={setCode} vocabulary={GRAPH_VOCABULARY} evaluate={() => undefined} rows={10} placeholder={"ofType(params.type).filter((x) => !inn(x, params.rel).length).map((x) => violation(x, 'missing ' + params.rel))"} onSubmit={save} /> : <ExprEditor value={code} onChange={setCode} types={list(types).filter((t) => !t.includes('{{'))} rows={10} placeholder={"get('data.born') >= params.year || 'born too early'"} onSubmit={save} />}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
