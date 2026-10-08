import type { EntityId, EntityRef, Selector } from './types'

export function newEntityId(): EntityId {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export const ref = (id: EntityId, selector?: Selector): EntityRef =>
  selector ? { id, selector } : { id }

export const refEquals = (a: EntityRef, b: EntityRef) =>
  a.id === b.id && JSON.stringify(a.selector ?? null) === JSON.stringify(b.selector ?? null)

/**
 * URI form of a reference: `aegraph:<id>[#<selector>]`.
 * Selectors are encoded as URL-safe JSON so the ref survives copy/paste.
 */
export function refToUri(r: EntityRef): string {
  if (!r.selector) return `aegraph:${r.id}`
  return `aegraph:${r.id}#${encodeURIComponent(JSON.stringify(r.selector))}`
}

export function uriToRef(uri: string): EntityRef | undefined {
  const m = /^aegraph:([^#]+)(?:#(.*))?$/.exec(uri.trim())
  if (!m) return undefined
  const [, id, frag] = m
  if (!frag) return { id }
  try {
    return { id, selector: JSON.parse(decodeURIComponent(frag)) as Selector }
  } catch {
    return { id, selector: { kind: 'fragment', value: frag } }
  }
}

export function describeSelector(s: Selector | undefined): string {
  if (!s) return ''
  switch (s.kind) {
    case 'text':
      return `“${s.exact.length > 40 ? s.exact.slice(0, 40) + '…' : s.exact}”`
    case 'range':
      return `chars ${s.start}–${s.end}`
    case 'region':
      return `region ${s.width}×${s.height} @ ${s.x},${s.y}`
    case 'time': {
      const t = s.end != null ? `${clock(s.start)}–${clock(s.end)}` : `@ ${clock(s.start)}`
      return s.region ? `${t} · region ${Math.round(s.region.width * 100)}×${Math.round(s.region.height * 100)}%` : t
    }
    case 'fragment':
      return `#${s.value}`
    case 'geo': {
      const where = `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}${s.radius ? ` ±${s.radius >= 1000 ? `${(s.radius / 1000).toFixed(1)} km` : `${Math.round(s.radius)} m`}` : ''}`
      const when = s.at ? ` @ ${new Date(s.at).toLocaleString()}${s.until ? ` – ${new Date(s.until).toLocaleString()}` : ''}` : ''
      return where + when
    }
  }
}

/** Seconds → `m:ss` / `h:mm:ss`. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h ? h + ':' : ''}${h ? String(m).padStart(2, '0') : m}:${String(sec).padStart(2, '0')}`
}
