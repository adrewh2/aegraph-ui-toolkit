import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../entity'
import { EntityStore } from '../store'
import { createProject } from '../../projects/project'

/**
 * What a read costs after a write, as a shape rather than a stopwatch: the counts, the tag list and the
 * relationships array are kept as the indexes are written, so an edit to one entity does not set anything walking
 * the store again. At a million entities those walks were most of a second each, on every keystroke that saved.
 * The assertions here are identities and totals, so they hold on any machine.
 */
describe('the store keeps its tallies', () => {
  const build = () => {
    const s = new EntityStore()
    s.upsertMany([
      ...Array.from({ length: 50 }, (_, i) => createEntity({ id: `p${i}`, type: i % 2 ? 'person' : 'place', label: `Thing ${i}`, tags: i % 5 === 0 ? ['flagged'] : ['plain', `g:${i % 3}`] })),
      ...Array.from({ length: 20 }, (_, i) => createRelationship({ id: `r${i}`, type: 'knows', source: `p${i}`, target: `p${(i + 1) % 50}` })),
    ])
    return s
  }
  /** The counts, worked out the long way. */
  const walked = (s: EntityStore) => {
    const entities = new Map<string, number>()
    const relationships = new Map<string, number>()
    for (const e of s.all()) {
      const m = e.kind === 'relationship' ? relationships : entities
      m.set(e.type, (m.get(e.type) ?? 0) + 1)
    }
    return { entities, relationships }
  }
  const same = (a: Map<string, number>, b: Map<string, number>) => expect(Object.fromEntries([...a].sort())).toEqual(Object.fromEntries([...b].sort()))

  it('counts by type and kind follow every kind of write', () => {
    const s = build()
    const check = () => {
      const w = walked(s)
      same(s.countByTypeAndKind().entities, w.entities)
      same(s.countByTypeAndKind().relationships, w.relationships)
    }
    check()
    s.upsert(createEntity({ id: 'new', type: 'person' }))
    check()
    // A type changed, a kind changed, an entity removed, a relationship removed.
    s.upsert({ ...s.require('p1'), type: 'creature' })
    check()
    s.upsert(createRelationship({ id: 'p2', type: 'knows', source: 'p3', target: 'p4' }))
    check()
    s.remove(['p5'])
    check()
    s.remove(['r1'])
    check()
    s.clear()
    check()
  })

  it('an edit to anything but a relationship leaves the relationships array alone', () => {
    const s = build()
    const before = s.relationships()
    expect(before).toHaveLength(20)
    s.upsert({ ...s.require('p7'), label: 'Renamed' })
    // The very same array: nothing was collected again.
    expect(s.relationships()).toBe(before)
    s.upsert(createEntity({ id: 'another', type: 'person' }))
    expect(s.relationships()).toBe(before)
    // A relationship written, and it is built afresh — with the new one in it.
    s.upsert(createRelationship({ id: 'r-new', type: 'cites', source: 'p1', target: 'p2' }))
    const after = s.relationships()
    expect(after).not.toBe(before)
    expect(after).toHaveLength(21)
    s.remove(['r-new'])
    expect(s.relationships()).toHaveLength(20)
  })

  it('in a project, the tags and their usage come from the scope’s own tally', () => {
    const s = build()
    const project = createProject({ label: 'Scoped' })
    s.upsert(project)
    s.mark(['p0', 'p1', 'p2', 'r0'], project.id)
    s.setScope(project.id)
    const inScope = s.all()
    const byWalk = new Set(inScope.flatMap((e) => e.tags))
    expect(new Set(s.tags())).toEqual(byWalk)
    for (const tag of byWalk) expect(s.tagUsage(tag)).toBe(inScope.filter((e) => e.tags.includes(tag)).length)
    // A tag added inside the scope, and one taken away.
    s.upsert({ ...s.require('p1'), tags: ['brand-new'] })
    expect(s.tags()).toContain('brand-new')
    expect(s.tagUsage('brand-new')).toBe(1)
    const after = s.all()
    expect(new Set(s.tags())).toEqual(new Set(after.flatMap((e) => e.tags)))
    s.setScope(null)
  })
})
