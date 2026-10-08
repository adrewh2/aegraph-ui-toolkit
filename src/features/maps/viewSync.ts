/**
 * The flat map's view and the globe's camera, read as each other: switching
 * stages keeps what is in view. The flat map shows Web Mercator at a zoom;
 * the globe (globe.gl) looks straight down from an altitude in radii with a
 * 50° field of view, so the surface it shows is about 0.93 × altitude radii
 * tall. Equating the two heights, in metres, at the latitude in view gives
 * the altitude for a zoom and the zoom for an altitude.
 */

/** Metres per pixel of Web Mercator at a zoom and latitude (256 px tiles). */
export const metresPerPx = (zoom: number, lat: number) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
/** The surface the globe's camera sees, in radii, per radius of altitude: 2 × tan(25°). */
const VIEW_PER_ALTITUDE = 2 * Math.tan((25 * Math.PI) / 180)
const EARTH_M = 6371000
export const MIN_ALTITUDE = 2.5e-5
export const MAX_ALTITUDE = 2.5

/** The globe altitude (radii) whose view is as tall as the flat map's at this zoom, latitude and stage height (px) — unclamped. */
export const altitudeOfZoom = (zoom: number, lat: number, heightPx: number) => (Math.max(1, heightPx) * metresPerPx(zoom, lat)) / (VIEW_PER_ALTITUDE * EARTH_M)

/** The same, within where the globe's camera goes: its floor at a street, its ceiling in orbit. */
export function altitudeForView(zoom: number, lat: number, heightPx: number): number {
  return Math.max(MIN_ALTITUDE, Math.min(MAX_ALTITUDE, altitudeOfZoom(zoom, lat, heightPx)))
}

/** The flat map zoom whose view is as tall as the globe's at this altitude (radii), latitude and stage height (px). */
export function zoomForAltitude(altitude: number, lat: number, heightPx: number, maxZoom = 19): number {
  const viewM = Math.max(MIN_ALTITUDE, altitude) * VIEW_PER_ALTITUDE * EARTH_M
  const mpp = viewM / Math.max(1, heightPx)
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / mpp)
  return Math.max(1, Math.min(maxZoom, z))
}
