import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../entity'
import { EntityStore } from '../store'
import '../../graph/types'

/**
 * The store's edges: what a removal does with and without the cascade,
 * what require and resolve say about the unknown, queries that combine
 * kinds, types, several tags and text under a scope, relationships by
 * direction with an undirected edge and a dangling one, the scope of a
 * project with includes and a cycle, marks bringing the joining
 * relationships and nothing else, marks kept through a plain write and
 * dropped by unmark, the Library view beside the scoped one, one
 * notification per transaction and the two version counters, and tags
 * renamed, merged, deleted and counted within a scope.
 */
function make() {
  const s = new EntityStore()
  s.upsertMany([
    createEntity({ id: 'a', type: 'note', label: 'Alpha', tags: ['x', 'y'] }),
    createEntity({ id: 'b', type: 'note', label: 'Beta', tags: ['y'], description: 'about graphs' }),
    createEntity({ id: 'c', type: 'paper', label: 'Gamma', tags: ['x'] }),
    createEntity({ id: 'd', type: 'paper', label: 'Delta' }),
    createRelationship({ id: 'ab', type: 'cites', source: 'a', target: 'b' }),
    createRelationship({ id: 'bc', type: 'knows', source: 'b', target: 'c', directed: false }),
    createRelationship({ id: 'cd', type: 'cites', source: 'c', target: 'd' }),
  ])
  return s
}
const ids = (list: { id: string }[]) => list.map((e) => e.id).sort()

describe('store edges', () => {
  it('removes with or without the cascade, ignores what is not there, and answers require and resolve for the unknown', () => {
    const s = make()
    s.remove(['zz'])
    expect(s.size()).toBe(7)
    s.remove('c', { cascade: false })
    expect(s.has('c')).toBe(false)
    expect(ids(s.danglingRelationships())).toEqual(['bc', 'cd'])
    expect(s.neighbors('b').map((n) => n.entity.id)).toEqual(['a']) // the dangling edge to c yields no neighbour
    expect(s.relationshipsOf('d', 'in').map((r) => r.id)).toEqual(['cd']) // but the edge itself is still there
    s.remove(['bc', 'cd'])
    expect(s.danglingRelationships()).toEqual([])
    expect(() => s.require('c')).toThrow(/not found/i)
    expect(s.resolve({ id: 'a' })?.id).toBe('a')
    expect(s.resolve({ id: 'c' })).toBeUndefined()
    // Removing a relationship on its own leaves its ends.
    s.remove('ab')
    expect(s.has('a')).toBe(true)
    expect(s.relationshipsOf('a')).toEqual([])
  })

  it('queries by kind, one or several types, every tag named, and text over labels and descriptions', () => {
    const s = make()
    expect(ids(s.query({ type: ['note', 'paper'] }))).toEqual(['a', 'b', 'c', 'd'])
    expect(ids(s.query({ tags: ['x', 'y'] }))).toEqual(['a']) // every tag, not any
    expect(ids(s.query({ tags: ['x'], kind: 'entity' }))).toEqual(['a', 'c'])
    expect(ids(s.query({ type: 'paper', tags: ['x'] }))).toEqual(['c'])
    expect(ids(s.query({ text: 'GRAPHS' }))).toEqual(['b'])
    expect(ids(s.query({ text: 'cites', kind: 'relationship' }))).toEqual(['ab', 'cd'])
    expect(ids(s.query({ predicate: (e) => e.label === 'Delta' }))).toEqual(['d'])
    expect(s.query({ type: 'nope' })).toEqual([])
    expect(ids(s.query())).toEqual(['a', 'ab', 'b', 'bc', 'c', 'cd', 'd'])
  })

  it('walks relationships by direction, an undirected one from either end, and lists neighbours with the edge that joins them', () => {
    const s = make()
    expect(ids(s.relationshipsOf('b'))).toEqual(['ab', 'bc'])
    expect(ids(s.relationshipsOf('b', 'in'))).toEqual(['ab'])
    expect(ids(s.relationshipsOf('b', 'out'))).toEqual(['bc']) // by source and target, whatever `directed` says
    expect(ids(s.relationshipsOf('c', 'in'))).toEqual(['bc'])
    expect(s.relationshipsOf('nope')).toEqual([])
    const n = s.neighbors('c')
    expect(n.map((x) => `${x.entity.id}:${x.via.id}`).sort()).toEqual(['b:bc', 'd:cd'])
    expect(s.neighbors('c', 'out').map((x) => x.entity.id)).toEqual(['d'])
  })

  it('scopes a project to its marks plus what it includes, through a cycle, and counts within the scope', () => {
    const s = make()
    const p = createEntity({ id: 'p', type: 'project', label: 'P', data: { members: [], includes: ['q'] } })
    const q = createEntity({ id: 'q', type: 'project', label: 'Q', data: { members: [], includes: ['p'] } })
    s.upsertMany([p, q])
    expect(s.mark(['a'], 'p')).toBe(1)
    expect(s.mark(['d'], 'q')).toBe(1)
    expect([...s.scopeOf('p')].sort()).toEqual(['a', 'd'])
    expect([...s.scopeOf('q')].sort()).toEqual(['a', 'd'])
    expect([...s.markedWith('p')]).toEqual(['a'])
    expect(s.projectsOf('a')).toEqual(['p'])
    expect(s.projectsOf('b')).toEqual([])
    expect(s.scopeOf('nope').size).toBe(0)
    s.setScope('p')
    expect(ids(s.all())).toEqual(['a', 'd'])
    expect(s.entityCount()).toBe(2)
    expect(s.relationshipCount()).toBe(0)
    expect(ids(s.library.all()).length).toBe(9) // the Library view sees everything, projects included
    expect(s.library.entityCount()).toBe(6)
    expect(ids(s.query({ type: 'note' }))).toEqual(['a'])
    expect(ids(s.query({ kind: 'relationship' }))).toEqual([])
    expect(ids(s.withTag('y'))).toEqual(['a'])
    expect(s.tagUsage('y')).toBe(1)
    expect(s.library.withTag('y').length).toBe(2)
    s.setScope(null)
    expect(s.entityCount()).toBe(6)
  })

  it('marks bring the relationships that join the project, keep through plain writes, and leave with unmark', () => {
    const s = make()
    s.upsert(createEntity({ id: 'p', type: 'project', label: 'P', data: { members: [] } }))
    expect(s.mark(['a'], 'p')).toBe(1) // a alone: no relationship has both ends in
    expect(s.mark(['b'], 'p')).toBe(2) // b, and a→b
    expect([...s.markedWith('p')].sort()).toEqual(['a', 'ab', 'b'])
    expect(s.mark(['a', 'nope'], 'p')).toBe(0) // already in, or not an entity
    // Marking a relationship whose ends are not in: it comes alone.
    expect(s.mark(['cd'], 'p')).toBe(1)
    // A write that does not mention projects keeps the marks; an explicit empty list does not.
    s.update('a', { label: 'Alpha 2' })
    expect(s.projectsOf('a')).toEqual(['p'])
    expect(s.unmark(['a', 'nope'], 'p')).toBe(1)
    expect(s.projectsOf('a')).toEqual([])
    expect(s.has('a')).toBe(true)
    expect(s.get('a')!.meta.projects).toBeUndefined()
    // Created while a project is open: marked with it; a project entity never is.
    s.setScope('p')
    s.upsert(createEntity({ id: 'e', type: 'note', label: 'E' }))
    s.upsert(createEntity({ id: 'p2', type: 'project', label: 'P2', data: { members: [] } }))
    expect(s.projectsOf('e')).toEqual(['p'])
    expect(s.projectsOf('p2')).toEqual([])
    s.setScope(null)
    // A deletion reaches into every project.
    s.remove('b')
    expect(s.has('ab')).toBe(false)
    expect([...s.markedWith('p')].sort()).toEqual(['cd', 'e'])
  })

  it('notifies once per transaction, bumps the version for every write and the data version only for material ones', () => {
    const s = make()
    const events: string[] = []
    s.subscribe((e) => events.push(e.type))
    const v0 = s.version
    const d0 = s.dataVersion
    s.transaction(() => {
      s.upsert(createEntity({ id: 'e', type: 'note', label: 'E' }))
      s.transaction(() => s.remove('d'))
      s.setTagInfo('x', { color: '#ff0000' })
    })
    expect(events).toEqual(['batch'])
    expect(s.version).toBe(v0 + 1)
    expect(s.dataVersion).toBe(d0 + 1)
    s.touch('a')
    expect(events).toEqual(['batch', 'upsert'])
    expect(s.version).toBe(v0 + 2)
    expect(s.dataVersion).toBe(d0 + 1) // a touch is bookkeeping
    s.setScope(null) // already null: no event
    expect(events).toHaveLength(2)
    s.upsertMany([])
    expect(events).toHaveLength(2)
    const same = s.get('a')!
    s.upsert(same) // the very same object: nothing to do, but the write still notifies
    expect(s.version).toBe(v0 + 3)
    expect(s.transaction(() => 42)).toBe(42)
  })

  it('renames a tag into another (merging), deletes one everywhere, keeps its colour under the new name, and counts usage in scope', () => {
    const s = make()
    s.setTagInfo('x', { color: '#abc', description: 'ex' })
    s.renameTag('x', 'y')
    expect(ids(s.withTag('y'))).toEqual(['a', 'b', 'c'])
    expect(s.withTag('x')).toEqual([])
    expect(s.get('a')!.tags).toEqual(['y']) // no duplicate y
    expect(s.getTagInfo('y')).toMatchObject({ tag: 'y', color: '#abc', description: 'ex' })
    expect(s.getTagInfo('x')).toEqual({ tag: 'x' })
    s.renameTag('y', '  ')
    expect(ids(s.withTag('y'))).toEqual(['a', 'b', 'c']) // a blank name is refused
    s.deleteTag('y')
    expect(s.withTag('y')).toEqual([])
    expect(s.tags()).toEqual([])
    expect(s.tagUsage('y')).toBe(0)
    s.setTagInfo('zed', { color: '#000' })
    expect(s.tags()).toEqual(['zed']) // an info without a carrier still lists
  })
})


describe('counting without materialising', () => {
  it('countOfType, countByType and countByTypeAndKind agree with the lists they replace — scoped, unscoped, and after a write', () => {
    const s = make()
    const kinds = ['note', 'paper', 'cites', 'knows', 'nothing']
    for (const t of kinds) expect(s.countOfType(t), t).toBe(s.ofType(t).length)
    const both = s.countByTypeAndKind()
    expect(both.entities.get('note')).toBe(2)
    expect(both.relationships.get('cites')).toBe(2)
    expect(both.entities.get('cites')).toBeUndefined()
    expect(s.countByType().get('cites')).toBe(2) // by type alone, both kinds together
    // A project scope narrows every one of them the same way.
    s.upsert(createEntity({ id: 'project:p', type: 'project', label: 'P' }))
    s.upsert({ ...s.get('a')!, meta: { ...s.get('a')!.meta, projects: ['project:p'] } })
    s.setScope('project:p')
    for (const t of kinds) expect(s.countOfType(t), `scoped ${t}`).toBe(s.ofType(t).length)
    expect(s.countByType().get('note')).toBe(1)
    expect(s.countByTypeAndKind().entities.get('note')).toBe(1)
    expect(s.library.countOfType('note')).toBe(2)
    s.setScope(null)
    // And they follow a write.
    s.upsert(createEntity({ id: 'e9', type: 'note' }))
    expect(s.countOfType('note')).toBe(3)
    expect(s.countByType().get('note')).toBe(3)
    s.remove('e9')
    expect(s.countOfType('note')).toBe(2)
  })
})

describe('the scope kept level with the writes', () => {
  /** What a fresh walk says, for comparison: leaving and re-entering the scope rebuilds it. */
  const rebuilt = (s: EntityStore, id: string) => {
    s.setScope(null)
    s.setScope(id)
    return { all: ids(s.all()), size: s.size(), counts: [...s.countByType()].sort(), byKind: { e: [...s.countByTypeAndKind().entities].sort(), r: [...s.countByTypeAndKind().relationships].sort() }, types: s.types() }
  }
  const live = (s: EntityStore) => ({ all: ids(s.all()), size: s.size(), counts: [...s.countByType()].sort(), byKind: { e: [...s.countByTypeAndKind().entities].sort(), r: [...s.countByTypeAndKind().relationships].sort() }, types: s.types() })

  it('follows writes, marks, removals, an entity changing type, and an include, without a walk — and agrees with one', () => {
    const s = make()
    s.upsertMany([createEntity({ id: 'project:p', type: 'project', label: 'P' }), createEntity({ id: 'project:q', type: 'project', label: 'Q' })])
    s.mark(['a', 'b'], 'project:p')
    s.mark(['d'], 'project:q')
    s.setScope('project:p')
    expect(live(s)).toEqual(rebuilt(s, 'project:p'))
    // A new entity under the scope is marked and counted; a Library-only one is not.
    s.upsert(createEntity({ id: 'n1', type: 'note', label: 'N1' }))
    s.upsert(createEntity({ id: 'project:commit1', type: 'project:commit', label: 'c' }))
    expect(live(s).counts).toEqual([
      ['cites', 1],
      ['note', 3],
    ])
    expect(live(s)).toEqual(rebuilt(s, 'project:p'))
    // Out by unmark, in by mark; a plain write keeps the mark.
    s.unmark(['b'], 'project:p')
    expect(live(s).all).toEqual(['a', 'ab', 'n1']) // the relationship keeps its own mark
    expect(live(s)).toEqual(rebuilt(s, 'project:p'))
    s.mark(['c'], 'project:p')
    s.update('c', { label: 'Gamma 2' })
    expect(live(s)).toEqual(rebuilt(s, 'project:p'))
    // A removal with its cascade; a type change moves the tally.
    s.remove('a')
    expect(live(s)).toEqual(rebuilt(s, 'project:p'))
    s.update('c', { type: 'note' })
    expect(live(s).byKind.e).toEqual([['note', 2]])
    expect(live(s)).toEqual(rebuilt(s, 'project:p'))
    // An include written on the project: the scope rebuilds and takes q's entities in.
    s.update('project:p', { data: { includes: ['project:q'] } })
    expect(live(s).all).toContain('d')
    expect(live(s)).toEqual(rebuilt(s, 'project:p'))
    // Vocabulary: a type's definition comes in with its first member here and leaves with the last, unless it is shared.
    s.setScope(null)
    s.upsertMany([
      { ...createEntity({ id: 'def:report', type: 'schema:type', label: 'report', data: { name: 'report' } }), meta: { ...createEntity({ id: 'x', type: 'y' }).meta, projects: ['project:z'] } },
      createEntity({ id: 'def:note', type: 'schema:type', label: 'note', data: { name: 'note' } }), // in no project: always shared
    ])
    s.setScope('project:p')
    expect(live(s).all).not.toContain('def:report')
    expect(live(s).all).toContain('def:note')
    s.upsert(createEntity({ id: 'r1', type: 'report', label: 'R1' }))
    expect(live(s).all).toContain('def:report')
    expect(live(s)).toEqual(rebuilt(s, 'project:p'))
    s.remove('r1')
    expect(live(s).all).not.toContain('def:report')
    expect(live(s).all).toContain('def:note')
    expect(live(s)).toEqual(rebuilt(s, 'project:p'))
  })
})
