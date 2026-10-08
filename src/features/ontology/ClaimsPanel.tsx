import { Bookmark, Table2, Users, Waypoints } from 'lucide-react'
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { browserHref, graphHref } from '../../app/openIn'
import { entityHref } from '../../app/routes'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity } from '../../core/entity/types'
import { CLAIM_TYPE, COMMUNITY_TYPE, MEMBER_OF, SUPPORTS } from '../knowledge/claims'
import { useOpenInTab } from '../workstation/paneContext'
import './claims.css'

/**
 * The Claims tab of the Ontology: what the workspace asserts. Every claim
 * with the entities that support it, and every named community with its
 * size — findings that were kept, plus claims written by hand or brought
 * in by a dataset. Each opens in the Entities table or as a graph of
 * itself and its evidence.
 */
export function ClaimsPanel() {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const openTab = useOpenInTab()

  const { claims, communities } = useMemo(() => {
    const byUpdated = (a: AnyEntity, b: AnyEntity) => (b.meta.updatedAt ?? '').localeCompare(a.meta.updatedAt ?? '')
    const claims = store
      .ofType(CLAIM_TYPE)
      .sort(byUpdated)
      .map((c) => ({ entity: c, evidence: store.relationshipsOf(c.id, 'in').filter((r) => r.type === SUPPORTS).map((r) => store.get(r.source.id)).filter((e): e is AnyEntity => !!e) }))
    const communities = store
      .ofType(COMMUNITY_TYPE)
      .sort(byUpdated)
      .map((c) => ({ entity: c, members: store.relationshipsOf(c.id, 'in').filter((r) => r.type === MEMBER_OF).map((r) => r.source.id) }))
    return { claims, communities }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version])

  if (!claims.length && !communities.length) {
    return (
      <div className="res__body claims">
        <div className="claims__empty">
          <Bookmark size={18} />
          <p>
            <strong>No claims yet.</strong> A claim is a statement the workspace supports with evidence. Run the <a href="/insights" onClick={(e) => (e.preventDefault(), navigate('/insights'))}>Insights</a> analyses and <em>Save as claim</em> on a finding, or <em>Name a community</em> there (or from a node's menu in the Graph Explorer) to turn a detected group into an entity its members belong to.
          </p>
        </div>
      </div>
    )
  }

  const typeLabel = (t: string) => registry.get(t).label
  return (
    <div className="res__body claims">
      <section className="claims__section">
        <h2>
          <Bookmark size={14} /> Claims <span className="muted">{claims.length}</span>
        </h2>
        {claims.length ? (
          <div className="claims__list">
            {claims.map(({ entity: c, evidence }) => (
              <article key={c.id} className="claims__item">
                <div className="claims__head">
                  <h3>{displayLabel(c)}</h3>
                  {typeof c.data.analysisLabel === 'string' && <span className="badge">{c.data.analysisLabel}</span>}
                  {typeof c.data.score === 'number' && (
                    <span className="claims__score" title={`Interestingness ${(c.data.score * 100).toFixed(0)}%`}>
                      <span style={{ width: `${Math.round(c.data.score * 100)}%` }} />
                    </span>
                  )}
                </div>
                {c.description && <p className="claims__detail">{c.description}</p>}
                <div className="claims__evidence">
                  <span className="muted">{evidence.length ? `Supported by ${evidence.length}:` : 'No supporting entities yet — link some with Link to…'}</span>
                  {evidence.slice(0, 8).map((e) => (
                    <a key={e.id} className="chip" href={entityHref(e, registry)} onClick={(ev) => (ev.preventDefault(), navigate(entityHref(e, registry)))} title={typeLabel(e.type)}>
                      {displayLabel(e)}
                    </a>
                  ))}
                  {evidence.length > 8 && <span className="muted">+{evidence.length - 8} more</span>}
                </div>
                <div className="claims__actions">
                  <button className="btn btn--sm" onClick={() => navigate(browserHref(c, registry))} title="Open in the Entities table">
                    <Table2 size={12} /> Open
                  </button>
                  <button className="btn btn--sm" disabled={!evidence.length} onClick={() => openTab(graphHref([c.id, ...evidence.map((e) => e.id)], displayLabel(c), '2d', true), displayLabel(c))} title="The claim and its evidence as a graph">
                    <Waypoints size={12} /> Show in graph
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">None yet — Save as claim on an Insights finding.</p>
        )}
      </section>
      <section className="claims__section">
        <h2>
          <Users size={14} /> Named communities <span className="muted">{communities.length}</span>
        </h2>
        {communities.length ? (
          <div className="claims__list">
            {communities.map(({ entity: c, members }) => (
              <article key={c.id} className="claims__item claims__item--community">
                <div className="claims__head">
                  <h3>{displayLabel(c)}</h3>
                  <span className="muted">{members.length.toLocaleString()} member{members.length === 1 ? '' : 's'}</span>
                </div>
                {c.description && <p className="claims__detail">{c.description}</p>}
                <div className="claims__actions">
                  <button className="btn btn--sm" onClick={() => navigate(browserHref(c, registry))} title="Open in the Entities table">
                    <Table2 size={12} /> Open
                  </button>
                  <button className="btn btn--sm" disabled={!members.length} onClick={() => openTab(graphHref([c.id, ...members], displayLabel(c), '2d', true), displayLabel(c))} title="The community and its members as a graph">
                    <Waypoints size={12} /> Show in graph
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">None yet — Name a community on an Insights finding, or from a node's menu in Unigraph once communities are computed.</p>
        )}
      </section>
    </div>
  )
}
