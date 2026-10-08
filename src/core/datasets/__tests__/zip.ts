import { deflateRawSync } from 'node:zlib'

const enc = (s: string) => new TextEncoder().encode(s)

/** A zip of the given members — stored, or deflated — with no CRCs (the reader does not check them). */
export function zip(members: { name: string; text: string | Uint8Array; deflate?: boolean; flags?: number }[]): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const m of members) {
    const raw = typeof m.text === 'string' ? enc(m.text) : m.text
    const data = m.deflate ? new Uint8Array(deflateRawSync(raw)) : raw
    const name = enc(m.name)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(6, m.flags ?? 0, true)
    lv.setUint16(8, m.deflate ? 8 : 0, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const dir = new Uint8Array(46 + name.length)
    const dv = new DataView(dir.buffer)
    dv.setUint32(0, 0x02014b50, true)
    dv.setUint16(8, m.flags ?? 0, true)
    dv.setUint16(10, m.deflate ? 8 : 0, true)
    dv.setUint32(20, data.length, true)
    dv.setUint32(24, raw.length, true)
    dv.setUint16(28, name.length, true)
    dv.setUint32(42, offset, true)
    dir.set(name, 46)
    parts.push(local, data)
    central.push(dir)
    offset += local.length + data.length
  }
  const dirSize = central.reduce((s, d) => s + d.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, members.length, true)
  ev.setUint16(10, members.length, true)
  ev.setUint32(12, dirSize, true)
  ev.setUint32(16, offset, true)
  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0))
  let at = 0
  for (const p of all) {
    out.set(p, at)
    at += p.length
  }
  return out
}
