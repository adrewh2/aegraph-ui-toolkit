import { ChevronRight } from 'lucide-react'
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useEntityStore, useStoreDataVersion, useTypeRegistry } from '../../core/entity/hooks'
import { typeProfile } from './profile'
import { TypeDetail } from './TypeDetail'
import '../resources/ResourcesView.css'
import './ontology.css'

/** `/ontology/type/:type` — an entity type's own page, with the whole width for its properties and relationships. */
export function TypePage() {
  const { type = '' } = useParams()
  const store = useEntityStore()
  const version = useStoreDataVersion(store)
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const profile = useMemo(() => (type ? typeProfile(store, registry, type) : undefined), [store, registry, type, version])
  const colorOf = (t: string) => registry.colorOf(t)
  const labelOf = (t: string) => registry.get(t).label
  if (!profile) return null
  const known = profile.def.origin !== 'inferred' || profile.instances > 0
  return (
    <div className="res onto onto--page">
      <nav className="onto__crumbs" aria-label="Breadcrumb">
        <button type="button" className="onto__crumb" onClick={() => navigate('/ontology')}>
          Ontology
        </button>
        <ChevronRight size={13} className="faint" />
        <span className="onto__crumb onto__crumb--current">{profile.def.label}</span>
      </nav>
      {known ? (
        <TypeDetail profile={profile} page onFocusType={(t) => navigate(`/ontology/type/${encodeURIComponent(t)}`)} onClose={() => navigate('/ontology')} colorOf={colorOf} labelOf={labelOf} />
      ) : (
        <div className="onto__none muted" style={{ padding: 24 }}>
          No type called <span className="mono">{type}</span> — nothing defines it and no entity has it.
        </div>
      )}
    </div>
  )
}

export const typePageHref = (type: string) => `/ontology/type/${encodeURIComponent(type)}`
