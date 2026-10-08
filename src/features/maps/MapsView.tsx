import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { FeatureOff } from '../../components/FeatureOff/FeatureOff'
import { featureOn } from '../../app/features'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreDataVersion, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { MapNewDialog } from './MapNewDialog'
import { MapsHome } from './MapsHome'
import { readAllView } from './MapWorkbench'
import { MapsIndex } from './MapsIndex'
import { mapMenuItems, unnamed, type MapCounts } from './mapIndexParts'
import { allMaps, createMap, geoAnnotationsOf, geoOf, isMap, type MapEntity } from './maps'
import '../documents/DocumentsView.css'
import '../images/images.css'
import './maps.css'

/**
 * The Maps routes, as every resource has them: `/maps` the index of maps;
 * `/maps/new` makes one and opens it; `/maps/:id` the map itself;
 * `/maps/all` everything with a place on one map.
 */
export function MapsView() {
  const store = useEntityStore()
  useStoreVersion(store)
  const dataVersion = useStoreDataVersion(store)
  const navigate = useNavigate()
  const toast = useToast()
  const { id } = useParams()
  const [params] = useSearchParams()
  const [rename, setRename] = useState<MapEntity | null>(null)
  const [pendingDelete, setPendingDelete] = useState<MapEntity | null>(null)

  // `/maps/new` makes one and opens it, asking for its name — once, however many times the effect runs before the
  // address changes (React runs it twice in development).
  const madeOne = useRef(false)
  useEffect(() => {
    if (id !== 'new') {
      madeOne.current = false
      return
    }
    if (madeOne.current) return
    madeOne.current = true
    // Where the page last looked, with its layer: the new map starts there rather than on the whole world.
    const view = readAllView()
    const m = createMap(store, { center: view.center, zoom: view.zoom, layer: view.layer })
    unnamed.add(m.id)
    navigate(`/maps/${m.id}`, { replace: true })
  }, [id, store, navigate])

  // The maps and what is on each, once per data version: a walk over every geo entity per map.
  const maps = useMemo(() => allMaps(store), [store, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => new Map<EntityId, MapCounts>(maps.map((m) => [m.id, { n: geoOf(store, m).length, notes: geoAnnotationsOf(store, m.id).length }])), [store, maps, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  if (id === 'new') return null
  // The globe address on a deployment that turned the globe off: say so, and offer the same places flat.
  if (id && params.get('view') === 'globe' && !featureOn('globe')) return <FeatureOff feature="globe" to={`/maps/${encodeURIComponent(id)}`} />
  if (id === 'all') return <MapsHome map={null} />
  const active = id ? store.get(id) : undefined
  const map = isMap(active) ? active : null
  if (id && !map)
    return (
      <div className="di__empty">
        <div className="di__empty-inner">
          <h2>Map not found</h2>
          <p className="muted">It may have been deleted, or the link is from another Library.</p>
          <button className="btn" onClick={() => navigate('/maps')}>
            All maps
          </button>
        </div>
      </div>
    )
  if (map) return <MapsHome map={map} />
  return (
    <>
      <MapsIndex maps={maps} counts={counts} contextItems={(m) => mapMenuItems(m, { open: (mid, globe) => navigate(`/maps/${mid}${globe ? '?view=globe' : ''}`), rename: setRename, remove: setPendingDelete })} />
      {rename && (
        <MapNewDialog
          title="Rename map"
          initial={rename.label ?? ''}
          onClose={() => setRename(null)}
          onSubmit={(label) => {
            store.update(rename.id, { label })
            setRename(null)
          }}
        />
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete “${pendingDelete ? displayLabel(pendingDelete) : ''}”?`}
        message="The map is removed; what it showed stays in the workspace, on no map. Notes pinned to the map go with it."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (pendingDelete) {
            store.remove(pendingDelete.id)
            toast(`Deleted ${displayLabel(pendingDelete)}`)
          }
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}
