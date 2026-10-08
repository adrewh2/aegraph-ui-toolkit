import { ExternalLink, Map as MapIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import { MapCanvas, type MapCanvasHandle } from './MapCanvas'
import { formatArea, formatDistance, geoPreview, googleEarthUrl, googleMapsUrl, mapsShowing, pointsOf, type GeoEntity } from './maps'
import { readMoreUrl } from './placeCard'
import { wikiPreviewOf } from './wikipedia'
import './maps.css'

/** A location, path or area in the detail panel: where it is, on a small map, with links out and the map it belongs to. */
export default function PlaceEmbed({ place }: { place: GeoEntity }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const navigate = useNavigate()
  const canvas = useRef<MapCanvasHandle>(null)
  const p = { lat: place.data.lat, lng: place.data.lng }
  const maps = mapsShowing(store, place.id)
  const shape = place.data.geometry && place.data.geometry.type !== 'Point'
  useEffect(() => {
    if (shape) canvas.current?.fit(pointsOf(place))
    else canvas.current?.flyTo(p, 14)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place.id])
  return (
    <div className="geo-embed">
      <div className="geo-embed__bar">
        <span className="mono muted">
          {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
        </span>
        {place.data.address && <span className="muted">· {place.data.address}</span>}
        {typeof place.data.lengthM === 'number' && <span className="muted">· {formatDistance(place.data.lengthM)} long</span>}
        {typeof place.data.areaM2 === 'number' && <span className="muted">· {formatArea(place.data.areaM2)}</span>}
        <span className="spacer" />
        <a className="btn btn--sm" href={googleMapsUrl(p)} target="_blank" rel="noreferrer noopener" title="Open in Google Maps">
          <ExternalLink size={12} /> Maps
        </a>
        <a className="btn btn--sm" href={googleEarthUrl(p)} target="_blank" rel="noreferrer noopener" title="Open in Google Earth">
          <ExternalLink size={12} /> Earth
        </a>
      </div>
      <div className="geo-embed__map">
        <MapCanvas ref={canvas} center={p} zoom={14} layer="streets" pins="bubbles" features={[place]} notes={[]} selectedId={place.id} tool="browse" onSelect={() => {}} onClick={() => {}} onDraw={() => {}} onMovePlace={(id, to) => store.update(id, { data: { ...place.data, lat: to.lat, lng: to.lng } })} onMoveNote={() => {}} onView={() => {}} previewOf={(e) => geoPreview(store, e)} readMoreOf={(e) => readMoreUrl(e, wikiPreviewOf(e))} />
      </div>
      <div className="geo-embed__bar" style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}>
        <MapIcon size={13} className="faint" />
        {maps.length ? (
          <span>
            On {maps.map((m, i) => (
              <span key={m.id}>
                {i > 0 && ', '}
                <a href={`/maps/${m.id}`} onClick={(e) => (e.preventDefault(), navigate(`/maps/${m.id}`))}>
                  {m.label}
                </a>
              </span>
            ))}
          </span>
        ) : (
          <span className="muted">On no map in particular — the Maps home shows it; open a map and add it there to keep it with others.</span>
        )}
      </div>
    </div>
  )
}
