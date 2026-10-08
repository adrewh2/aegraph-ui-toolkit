import { describe, expect, it } from 'vitest'
import type { Finding } from '../../../analysis/types'
import { schemaTypeId } from '../../../core/entity/categories'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import type { MetricsResult } from '../../../core/graph/metrics/types'
import { CLAIM_TYPE, COMMUNITY_TYPE, MEMBER_OF, SUPPORTS, claimFor, communityEntityFor, communityMembers, communityOf, nameCommunity, saveFindingAsClaim } from '../claims'

/**
 * Claims and communities at the edges: a finding with no entities, one
 * whose evidence is all unknown, evidence that later leaves the store, a
 * finding re-saved with different evidence (the links accumulate, each
 * ranked by its place in the finding that brought it), two findings and
 * their separate claims, unicode and empty titles, the ids a claim and a
 * community get; a community with no members, a member that left, the same
 * community named twice (renamed, description kept when not given), two
 * communities of one run and the same number in two runs, members from a
 * column with unassigned cells, and lookups that find nothing.
 */
const people = (n: number) => {
  const store = new EntityStore()
  for (let i = 0; i < n; i++) store.upsert(createEntity({ id: `p${i}`, type: 'person', label: `Person ${i}` }))
  return store
}
const finding = (over: Partial<Finding> = {}): Finding => ({ id: 'anomalies:isolated', analysis: 'anomalies', title: 'Nobody knows p9', detail: 'p9 has no relationships.', score: 0.3, ...over })
const report = { key: 'k1', computedAt: '2026-09-19T00:00:00.000Z' }
const supporters = (store: EntityStore, claimId: string) => store.relationshipsOf(claimId, 'in').filter((r) => r.type === SUPPORTS).map((r) => [r.source.id, r.data.rank] as const).sort((a, b) => String(a[0]).localeCompare(String(b[0])))

describe('claims edges', () => {
  it('a finding with no entities, or only unknown ones, is a claim nobody supports; evidence that leaves the store takes its link along', () => {
    const store = people(3)
    const none = saveFindingAsClaim(store, finding(), report, 'Anomalies')
    expect(none).toMatchObject({ evidence: 0, created: true })
    expect(supporters(store, none.claim.id)).toEqual([])
    expect(store.get(schemaTypeId(CLAIM_TYPE))).toBeDefined()
    const ghosts = saveFindingAsClaim(store, finding({ id: 'x:y', entities: ['nope', 'nada'] }), report, 'X')
    expect(ghosts.evidence).toBe(0)
    expect(supporters(store, ghosts.claim.id)).toEqual([])
    const some = saveFindingAsClaim(store, finding({ id: 'x:z', entities: ['p0', 'p1'] }), report, 'X')
    expect(supporters(store, some.claim.id)).toEqual([['p0', 1], ['p1', 2]])
    store.remove('p1')
    expect(supporters(store, some.claim.id)).toEqual([['p0', 1]])
    // Saved again after the loss: p1 cannot come back, nothing else changes.
    const again = saveFindingAsClaim(store, finding({ id: 'x:z', entities: ['p0', 'p1'] }), report, 'X')
    expect(again).toMatchObject({ evidence: 1, created: false })
    expect(supporters(store, some.claim.id)).toEqual([['p0', 1]])
  })

  it('re-saved with different evidence, the links accumulate and each new one is ranked by its place in the finding that brought it', () => {
    const store = people(5)
    const a = saveFindingAsClaim(store, finding({ entities: ['p0', 'p1'] }), report, 'A')
    const b = saveFindingAsClaim(store, finding({ entities: ['p1', 'p3', 'p2'], title: 'Now p3 too', score: 0.9 }), { key: 'k2', computedAt: '2026-09-20T00:00:00.000Z' }, 'A')
    expect(b.claim.id).toBe(a.claim.id)
    expect(b).toMatchObject({ evidence: 3, created: false })
    const claim = store.get(a.claim.id)!
    expect(claim.label).toBe('Now p3 too')
    expect(claim.data).toMatchObject({ score: 0.9, reportKey: 'k2', findingId: 'anomalies:isolated', analysis: 'anomalies', analysisLabel: 'A' })
    expect(claim.tags).toEqual(['insight', 'analysis:anomalies'])
    // p0 stays from the first save (rank 1 then); p1 keeps its first rank; p3 and p2 arrive ranked 2 and 3 as the new finding lists them.
    expect(supporters(store, claim.id)).toEqual([['p0', 1], ['p1', 2], ['p2', 3], ['p3', 2]])
    expect(store.relationships().filter((r) => r.type === SUPPORTS)).toHaveLength(4)
  })

  it('two findings are two claims with ids of their own; unicode and empty titles are kept as given; claimFor finds by finding id', () => {
    const store = people(2)
    const a = saveFindingAsClaim(store, finding({ id: 'a:1', title: 'Émile · 🎉', detail: '' }), report, 'A')
    const b = saveFindingAsClaim(store, finding({ id: 'b:2', title: '' }), report, 'B')
    expect(a.claim.id).not.toBe(b.claim.id)
    expect(a.claim.id).toMatch(/\S/)
    expect(store.ofType(CLAIM_TYPE)).toHaveLength(2)
    expect(store.get(a.claim.id)!.label).toBe('Émile · 🎉')
    expect(store.get(b.claim.id)!.label).toBe('')
    expect(claimFor(store, finding({ id: 'a:1' }))?.id).toBe(a.claim.id)
    expect(claimFor(store, finding({ id: 'c:3' }))).toBeUndefined()
    expect(claimFor(new EntityStore(), finding())).toBeUndefined()
  })

  it('reads members from a column with unassigned cells, none without a column, and nothing for an unknown node', () => {
    const metrics = { ids: ['p0', 'p1', 'p2', 'p3'], columns: { community: new Float64Array([0, NaN, 0, 2]) } } as unknown as MetricsResult
    expect(communityMembers(metrics, 0)).toEqual(['p0', 'p2'])
    expect(communityMembers(metrics, 2)).toEqual(['p3'])
    expect(communityMembers(metrics, 1)).toEqual([])
    expect(communityMembers(metrics, NaN)).toEqual([])
    expect(communityOf(metrics, 'p1')).toBeNaN()
    expect(communityOf(metrics, 'p3')).toBe(2)
    expect(communityOf(metrics, 'zz')).toBeUndefined()
    const bare = { ids: ['p0'], columns: {} } as unknown as MetricsResult
    expect(communityMembers(bare, 0)).toEqual([])
    expect(communityOf(bare, 'p0')).toBeUndefined()
  })

  it('a community with no members, a member that left, the same community named twice, two of one run and one number in two runs', () => {
    const store = people(4)
    const empty = nameCommunity(store, { label: 'Nobody', members: [], community: 7, metricsKey: 'k1' })
    expect(empty).toMatchObject({ members: 0, created: true })
    expect(store.get(empty.entity.id)!.data).toEqual({ community: 7, metricsKey: 'k1', size: 0 })
    expect(store.relationshipsOf(empty.entity.id, 'in')).toEqual([])
    expect(store.get(schemaTypeId(COMMUNITY_TYPE))).toBeDefined()
    const a = nameCommunity(store, { label: 'The A team', description: 'first', members: ['p0', 'p1', 'ghost'], community: 0, metricsKey: 'k1' })
    expect(a).toMatchObject({ members: 2, created: true })
    store.remove('p1')
    expect(store.relationshipsOf(a.entity.id, 'in').map((r) => r.source.id)).toEqual(['p0'])
    // Named again: renamed, the description kept when none is given, p2 added, p1 gone for good, one entity still.
    const b = nameCommunity(store, { label: 'Équipe A 🎉', members: ['p0', 'p1', 'p2'], community: 0, metricsKey: 'k1' })
    expect(b).toMatchObject({ members: 2, created: false })
    expect(b.entity.id).toBe(a.entity.id)
    expect(store.get(a.entity.id)).toMatchObject({ label: 'Équipe A 🎉', description: 'first', data: { size: 2 } })
    expect(store.relationshipsOf(a.entity.id, 'in').filter((r) => r.type === MEMBER_OF).map((r) => r.source.id).sort()).toEqual(['p0', 'p2'])
    expect(store.ofType(COMMUNITY_TYPE)).toHaveLength(2)
    // Another community of the same run, and the same number from another run, are their own entities.
    const c = nameCommunity(store, { label: 'B', members: ['p3'], community: 1, metricsKey: 'k1' })
    const d = nameCommunity(store, { label: 'A again', members: ['p3'], community: 0, metricsKey: 'k2' })
    expect(new Set([a.entity.id, c.entity.id, d.entity.id]).size).toBe(3)
    expect(communityEntityFor(store, 'k1', 0)?.id).toBe(a.entity.id)
    expect(communityEntityFor(store, 'k2', 0)?.id).toBe(d.entity.id)
    expect(communityEntityFor(store, 'k3', 0)).toBeUndefined()
    // A member of two communities belongs to both.
    expect(store.relationshipsOf('p3', 'out').filter((r) => r.type === MEMBER_OF)).toHaveLength(2)
  })
})
