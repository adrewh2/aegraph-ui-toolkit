import { useState } from 'react'
import type { Language } from '../../scripting/types'
import type { ExprSchema } from '../expr/schema'
import '../expr/expr.css'
import { access_, scaffoldRelationship, scaffoldState, scaffoldType, type ScaffoldContext } from './scaffold'
import { COLLECTION_API, GROUP_LABELS, helpersFor } from './vocabulary'

/**
 * The Reference drawer of the Scripts page: what a script can reach, from
 * the data as it stands — the API by group, the types with the properties
 * their entities carry (kind, coverage, a sample), the relationship types
 * and what they join, the tags, the project and the metrics. Every row
 * inserts at the cursor; a scaffold writes a whole script from the row —
 * a table of a type with its real properties, a relationship with both
 * ends, or a function over the whole project state.
 */
export function ScriptReference({ schema, language, project, metrics, onInsert, onScaffold }: { schema: ExprSchema; language: Language; project?: { id: string; label: string }; metrics?: string[]; onInsert: (text: string) => void; onScaffold: (code: string) => void }) {
  const [tab, setTab] = useState<'api' | 'types' | 'relationships' | 'tags' | 'project'>('api')
  const { bare, members } = helpersFor(language)
  const ctx: ScaffoldContext = { schema, project, metrics }
  const py = language === 'python'
  // The collection vocabulary is one list for both languages; the bare entries for entities/relationships defer to it.
  const listed = [...COLLECTION_API, ...members, ...bare.filter((h) => h.group !== 'collections' || !COLLECTION_API.some((c) => c.name === h.name))]
  const groups = [...new Set(listed.map((h) => h.group))]
  const entityTypes = schema.types.filter((t) => t.kind === 'entity')
  const insertCall = (h: { name: string; of?: string; signature: string }) => onInsert(`${h.of ? `${h.of}.` : ''}${h.name}${h.signature.includes('(') ? '(' : ''}`)

  return (
    <div className="xp__ref sc__ref">
      <div className="xp__ref-tabs">
        {(['api', 'types', 'relationships', 'tags', 'project'] as const).map((t) => (
          <button key={t} type="button" className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>
            {t === 'api' ? 'API' : t}
          </button>
        ))}
        <span className="spacer" />
        <span className="faint">click to insert · scaffold writes a script</span>
      </div>
      <div className="xp__ref-body">
        {tab === 'api' &&
          groups.map((g) => (
            <div key={g} className="xp__ref-group">
              <div className="xp__ref-head">{GROUP_LABELS[g] ?? g}</div>
              {listed
                .filter((h) => h.group === g)
                .map((h) => (
                  <button key={`${h.of ?? ''}${h.group}${h.name}`} type="button" className="xp__ref-row" onClick={() => insertCall(h)} title={h.doc}>
                    <span className="mono xp__ref-name">{h.signature}</span>
                    <span className="muted">{h.doc}</span>
                  </button>
                ))}
            </div>
          ))}
        {tab === 'types' && (
          <>
            <div className="xp__ref-note muted">
              {entityTypes.length} type{entityTypes.length === 1 ? '' : 's'} in the dataset. A property row inserts its access; <em>scaffold</em> writes a table of the type with every property as a column.
            </div>
            {entityTypes.map((t) => (
              <div key={t.type} className="xp__ref-group">
                <div className="xp__ref-head sc__ref-head">
                  <button type="button" className="mono sc__ref-type" onClick={() => onInsert(access_(t.type))} title={`${t.label} — insert the collection`}>
                    {t.type}
                  </button>
                  <span className="xp__ref-cov">{t.count.toLocaleString()}</span>
                  <span className="spacer" />
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => onScaffold(scaffoldType(ctx, t.type, language))} title={`A script: every ${t.type} as a table, one column per property`}>
                    scaffold
                  </button>
                </div>
                {(schema.properties.get(t.type) ?? []).map((p) => {
                  const about = p.values?.length ? `one of: ${p.values.slice(0, 6).join(', ')}${p.values.length > 6 ? `, … (${p.values.length})` : ''}` : p.sample !== undefined ? `e.g. ${p.sample}` : ''
                  return (
                    <button key={p.key} type="button" className="xp__ref-row" onClick={() => onInsert(py ? `['${p.key}']` : /^[A-Za-z_$][\w$]*$/.test(p.key) ? `e.data.${p.key}` : `e.data[${JSON.stringify(p.key)}]`)} title={[p.description, about].filter(Boolean).join(' · ')}>
                      <span className="mono xp__ref-name">{py ? p.key : `data.${p.key}`}</span>
                      <span className="xp__ref-kind">{p.kind}</span>
                      <span className="xp__ref-cov">{Math.round(p.coverage * 100)}%</span>
                      <span className="muted xp__ref-sample">{p.description ?? about}</span>
                    </button>
                  )
                })}
                {!(schema.properties.get(t.type) ?? []).length && <div className="faint">no properties seen</div>}
              </div>
            ))}
            {!entityTypes.length && <div className="faint">The dataset is empty.</div>}
          </>
        )}
        {tab === 'relationships' && (
          <>
            {schema.relationshipTypes.map((r) => (
              <div key={r.type} className="xp__ref-row sc__ref-rel">
                <button type="button" className="mono xp__ref-name sc__ref-type" onClick={() => onInsert(/^[A-Za-z_$][\w$]*$/.test(r.type) ? `relationships.types.${r.type}` : `relationships.types['${r.type}']`)} title="Insert the collection">
                  {r.type}
                </button>
                <span className="xp__ref-cov">{r.count.toLocaleString()}</span>
                <span className="muted xp__ref-sample">{r.pairs.join(' · ')}</span>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => onScaffold(scaffoldRelationship(ctx, r.type, language))} title="A script: every relationship of the type with both ends">
                  scaffold
                </button>
              </div>
            ))}
            {!schema.relationshipTypes.length && <div className="faint">No relationships in the dataset.</div>}
          </>
        )}
        {tab === 'tags' && (
          <>
            {schema.tags.map((t) => (
              <button key={t} type="button" className="xp__ref-row" onClick={() => onInsert(`entities.tagged('${t}')`)}>
                <span className="mono xp__ref-name">{t}</span>
              </button>
            ))}
            {!schema.tags.length && <div className="faint">No tags in the dataset.</div>}
          </>
        )}
        {tab === 'project' && (
          <>
            <div className="xp__ref-note muted">
              {project ? (
                <>
                  The project <strong>{project.label}</strong> is open: <span className="mono">{py ? 'project' : 'ds.project'}</span> holds it; <span className="mono">{py ? 'ontology' : 'ds.ontology'}</span> its types with their declared properties; <span className="mono">{py ? 'tags' : 'ds.tags()'}</span> the tags; <span className="mono">{py ? 'describe()' : 'ds.describe()'}</span> everything at once.
                </>
              ) : (
                <>
                  The Library is open (<span className="mono">{py ? 'project' : 'ds.project'}</span> is null). <span className="mono">{py ? 'ontology' : 'ds.ontology'}</span> holds the types with their declared properties, <span className="mono">{py ? 'tags' : 'ds.tags()'}</span> the tags, <span className="mono">{py ? 'describe()' : 'ds.describe()'}</span> everything at once.
                </>
              )}
            </div>
            <button type="button" className="btn btn--sm sc__ref-scaffold" onClick={() => onScaffold(scaffoldState(ctx, language))} title="A function whose arguments are the whole project state, described with the real counts">
              Scaffold: a function over the project state
            </button>
            <div className="xp__ref-group">
              <div className="xp__ref-head">Metrics</div>
              {metrics?.length ? (
                metrics.map((m) => (
                  <button key={m} type="button" className="xp__ref-row" onClick={() => onInsert(py ? `metric('${m}', id)` : `ds.metric('${m}', e.id)`)}>
                    <span className="mono xp__ref-name">{m}</span>
                  </button>
                ))
              ) : (
                <div className="faint">None yet — run Insights (or the analyze tool) and the columns appear here.</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
