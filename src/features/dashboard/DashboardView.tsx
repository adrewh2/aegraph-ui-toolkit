import { Link } from 'react-router-dom'
import { entityHref, typeHref } from '../../app/routes'
import { CATEGORIES, type TypeCategory } from '../../core/entity/categories'
import { displayLabel } from '../../core/entity/entity'
import { usePersistStatus } from '../../app/providers'
import { greeting } from './greeting'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import { isRelationship, type AnyEntity } from '../../core/entity/types'
import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { formatDate, hashColor } from '../../lib/format'
import './DashboardView.css'

const SHOWN: TypeCategory[] = ['resource', 'knowledge', 'project']

// Top-8 by recency via a bounded insertion instead of sorting the whole store — and kept per store version, since every
// render of the page (each store event re-renders it) would otherwise walk a city's worth of entities again.
const recentCache = new WeakMap<EntityStore, { key: string; registry: TypeRegistry; recent: AnyEntity[] }>()
function recentEntities(store: EntityStore, registry: TypeRegistry): AnyEntity[] {
  const key = `${store.dataVersion}|${store.scope ?? ''}`
  const hit = recentCache.get(store)
  if (hit && hit.key === key && hit.registry === registry) return hit.recent
  const top: { e: AnyEntity; k: string }[] = []
  for (const e of store.all()) {
    if (isRelationship(e) || registry.categoryOf(e.type) === 'schema') continue
    const k = e.meta.accessedAt ?? e.meta.updatedAt
    if (top.length === 8 && k <= top[7].k) continue
    let i = top.length
    while (i > 0 && top[i - 1].k < k) i--
    top.splice(i, 0, { e, k })
    if (top.length > 8) top.pop()
  }
  const recent = top.map((t) => t.e)
  recentCache.set(store, { key, registry, recent })
  return recent
}

export function DashboardView() {
  const store = useEntityStore()
  useStoreVersion(store)
  const registry = useTypeRegistry()
  const persist = usePersistStatus()
  const recent = recentEntities(store, registry)

  return (
    <div className="dash">
      <h1 className="page-title">{greeting(new Date().getHours())}</h1>
      <div className="dash__stats">
        {SHOWN.map((c) => (
          <Stat key={c} label={CATEGORIES[c].pluralLabel} value={registry.countInCategory(c)} to={CATEGORIES[c].path} />
        ))}
        <Stat label="Relationships" value={store.relationshipCount()} to="/entities?category=relationships" />
        <Stat label="Tags" value={store.tags().length} to="/entities?category=tags" />
        {/* Where it all lives: the one figure the Projects dialog used to repeat, at home beside the counts it belongs to. */}
        <Link to="/datasets" className="dash__stat" title="Everything is in this browser's IndexedDB, written as you edit. Opening, importing, exporting and clearing are in the Projects dialog.">
          <span className="dash__stat-label">In this browser</span>
          <span className="dash__stat-value dash__stat-value--word">{persist.state === 'saving' ? `saving… (${persist.pending})` : persist.state === 'error' ? 'error' : 'synced'}</span>
        </Link>
      </div>
      {SHOWN.map((c) => {
        const types = registry.inCategory(c, { withInstancesOnly: c !== 'resource' }).slice(0, 12)
        if (types.length === 0) return null
        return (
          <div key={c}>
            <h2 className="dash__h2">
              <Link to={CATEGORIES[c].path} style={{ color: 'inherit', textDecoration: 'none' }}>
                {CATEGORIES[c].pluralLabel}
              </Link>
            </h2>
            <div className="dash__types">
              {types.map((t) => {
                const Icon = t.icon
                const color = t.color ?? hashColor(t.type)
                return (
                  <Link key={t.type} to={typeHref(t.type, c)} className="dash__type">
                    <span className="dash__type-icon" style={{ background: Icon ? `${color}22` : color, color }}>
                      {Icon && <Icon size={18} />}
                    </span>
                    <span className="dash__type-name">{t.pluralLabel}</span>
                    <span className="dash__type-count">{t.count}</span>
                  </Link>
                )
              })}
            </div>
          </div>
        )
      })}
      <h2 className="dash__h2">Recently active</h2>
      <div className="dash__recent">
        {recent.map((e) => (
          <Link key={e.id} to={entityHref(e, registry)} className="dash__recent-row">
            <span className="badge">{registry.get(e.type).label}</span>
            <span className="dash__recent-label">{displayLabel(e)}</span>
            <span className="faint">{formatDate(e.meta.accessedAt ?? e.meta.updatedAt)}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, to }: { label: string; value: number; to: string }) {
  return (
    <Link to={to} className="dash__stat">
      <span className="dash__stat-label">{label}</span>
      <span className="dash__stat-value">{value.toLocaleString()}</span>
    </Link>
  )
}
