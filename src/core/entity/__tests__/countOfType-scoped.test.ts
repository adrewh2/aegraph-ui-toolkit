import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../entity'
import { EntityStore } from '../store'
import { createProject } from '../../projects/project'

/** Under a project, a type's count is the scope's tally — the same number a walk of the scope gives, through writes. */
const walk = (s: EntityStore, type: string) => s.all().filter((e) => e.type === type).length

describe('countOfType in a project', () => {
  it('matches a walk of the scope through adds, moves between projects and removals', () => {
    const s = new EntityStore()
    s.upsertMany([createProject({ id: 'p', label: 'P' }), createProject({ id: 'q', label: 'Q' })])
    s.setScope('p')
    s.upsertMany(Array.from({ length: 50 }, (_, i) => createEntity({ id: `c${i}`, type: 'conversation', label: `c${i}` })))
    s.upsert(createRelationship({ id: 'r', type: 'links', source: 'c1', target: 'c2' }))
    expect(s.countOfType('conversation')).toBe(50)
    expect(s.countOfType('links')).toBe(1)
    s.remove(['c3', 'c4'])
    s.upsert({ ...s.get('c5')!, meta: { ...s.get('c5')!.meta, projects: ['q'] } })
    s.upsert({ ...s.get('c6')!, type: 'note' })
    for (const t of ['conversation', 'note', 'links']) expect(s.countOfType(t)).toBe(walk(s, t))
    s.setScope('q')
    expect(s.countOfType('conversation')).toBe(walk(s, 'conversation'))
  })
})
