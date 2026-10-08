import { describe, expect, it } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import type { FieldDef } from '../../../core/entity/schema'
import { EntityStore, type StoreEvent } from '../../../core/entity/store'
import type { AnyEntity } from '../../../core/entity/types'
import '../../../core/resources/types'
import { patchSortedRows, sortRows } from '../EntityTable'
import { patchOf, patchRows } from '../liveRows'

/**
 * An edit in a big project costs the edit: the rows a table shows are kept by the store's events, a rename patches
 * the row in place (`patchRows`), and the table moves only that row in its order (`patchSortedRows`) — the same
 * rows, in the same order, as querying and sorting again.
 */
const ids = (rows: readonly AnyEntity[]) => rows.map((r) => r.id)
const label: FieldDef = { key: 'label', label: 'Label', kind: 'text' }

function project(n: number) {
  const s = new EntityStore()
  s.upsertMany(Array.from({ length: n }, (_, i) => createEntity({ id: `e${i}`, type: 'note', label: `Note ${String((i * 7919) % n).padStart(5, '0')}` })))
  s.upsert(createEntity({ id: 'other', type: 'person', label: 'Someone' }))
  return s
}
/** The events a write sends, caught. */
function events(s: EntityStore, write: () => void): StoreEvent[] {
  const out: StoreEvent[] = []
  const off = s.subscribe((e) => void out.push(e))
  write()
  off()
  return out
}

describe('rows kept by the store’s events', () => {
  it('a rename replaces the row where it is, in a copy that says how it was made; a write elsewhere changes nothing', () => {
    const s = project(50)
    const rows = s.query({ type: 'note' })
    const belongs = (e: AnyEntity) => s.matches(e, { type: 'note' })
    const [ev] = events(s, () => s.update('e3', { label: 'Renamed' }))
    const next = patchRows(rows, ev, belongs)
    expect(next).not.toBe(rows)
    expect(ids(next as AnyEntity[])).toEqual(ids(rows))
    expect((next as AnyEntity[])[3].label).toBe('Renamed')
    expect(patchOf(next as AnyEntity[])).toMatchObject({ prev: rows, changed: [{ index: 3, before: rows[3] }] })
    const [other] = events(s, () => s.update('other', { label: 'Someone else' }))
    expect(patchRows(next as AnyEntity[], other, belongs)).toBe(next)
  })

  it('queries again when a write may change who belongs: a new member, a removal, a row leaving the query', () => {
    const s = project(20)
    const rows = s.query({ type: 'note' })
    const belongs = (e: AnyEntity) => s.matches(e, { type: 'note', predicate: (x) => (x.label ?? '').startsWith('Note') })
    expect(patchRows(rows, events(s, () => s.upsert(createEntity({ id: 'new', type: 'note', label: 'Note new' })))[0], belongs)).toBe('query')
    expect(patchRows(rows, events(s, () => s.remove(['e1']))[0], belongs)).toBe('query')
    // Renamed out of the query: it no longer belongs.
    expect(patchRows(rows, events(s, () => s.update('e2', { label: 'Elsewhere' }))[0], belongs)).toBe('query')
  })
})

describe('a table’s sorted rows after a rename', () => {
  for (const dir of ['asc', 'desc'] as const)
    for (const [mode, n] of [
      ['the collator', 400],
      ['code units, past the collator’s limit', 60_000],
    ] as const)
      it(`moves only the renamed rows and lands them where a full sort would — ${dir}, ${mode}`, () => {
        const s = project(n)
        let entities = s.query({ type: 'note' })
        let rows = sortRows(entities, 'label', label, dir, s)
        for (let k = 0; k < 25; k++) {
          const id = `e${(k * 104729) % n}`
          const [ev] = events(s, () => s.update(id, { label: `Note ${k % 2 ? 'zz' : 'aa'} renamed ${k}` }))
          const next = patchRows(entities, ev, (e) => s.matches(e, { type: 'note' }))
          if (next === 'query') throw new Error('a rename should patch')
          const made = patchSortedRows(rows, patchOf(next)!.changed, null, { key: 'label', f: label }, s)
          expect(made).not.toBeNull()
          entities = next as AnyEntity[]
          rows = made!.rows
        }
        expect(ids(rows)).toEqual(ids(sortRows(s.query({ type: 'note' }), 'label', label, dir, s)))
      })

  it('takes a row out when it stops passing the filters, and puts one in when it starts', () => {
    const s = project(100)
    const passes = (e: AnyEntity) => (e.label ?? '').includes('keep')
    s.update('e1', { label: 'Note keep 1' })
    s.update('e2', { label: 'Note keep 2' })
    let entities = s.query({ type: 'note' })
    let rows = sortRows(entities.filter(passes), 'label', label, 'asc', s)
    expect(ids(rows)).toEqual(['e1', 'e2'])
    for (const [id, to] of [
      ['e1', 'Note gone'],
      ['e9', 'Note keep 0'],
    ] as const) {
      const [ev] = events(s, () => s.update(id, { label: to }))
      const next = patchRows(entities, ev, (e) => s.matches(e, { type: 'note' })) as AnyEntity[]
      rows = patchSortedRows(rows, patchOf(next)!.changed, passes, { key: 'label', f: label }, s)!.rows
      entities = next
    }
    expect(ids(rows)).toEqual(['e9', 'e2'])
  })
})
