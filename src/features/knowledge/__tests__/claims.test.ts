import { describe, expect, it } from 'vitest'
import type { Finding } from '../../../analysis/types'
import { schemaTypeId } from '../../../core/entity/categories'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import type { MetricsResult } from '../../../core/graph/metrics/types'
import { CLAIM_TYPE, COMMUNITY_TYPE, MEMBER_OF, SUPPORTS, claimFor, communityEntityFor, communityMembers, communityOf, nameCommunity, saveFindingAsClaim } from '../claims'

function fixture() {
  const store = new EntityStore()
  for (let i = 0; i < 6; i++) store.upsert(createEntity({ id: `p${i}`, type: 'person', label: `Person ${i}` }))
  store.upsert(createRelationship({ id: 'k1', type: 'knows', source: { id: 'p0' }, target: { id: 'p1' } }))
  return store
}

const finding: Finding = { id: 'centrality:hubs', analysis: 'centrality', title: 'Three people hold the graph together', detail: 'p0, p1 and p2 carry 80% of the paths.', score: 0.8, entities: ['p0', 'p1', 'p2', 'ghost'], data: { rows: [1, 2, 3] } }
const report = { key: 'k1', computedAt: '2026-09-15T00:00:00.000Z' }

describe('findings become claims', () => {
  it('saves a finding as a claim with its evidence, defining the type on first use', () => {
    const store = fixture()
    const r = saveFindingAsClaim(store, finding, report, 'Centrality')
    expect(r.created).toBe(true)
    expect(r.evidence).toBe(3) // the unknown id is skipped
    const claim = store.get(r.claim.id)!
    expect(claim.type).toBe(CLAIM_TYPE)
    expect(claim.label).toBe(finding.title)
    expect(claim.description).toBe(finding.detail)
    expect(claim.data).toMatchObject({ analysis: 'centrality', analysisLabel: 'Centrality', findingId: 'centrality:hubs', reportKey: 'k1', score: 0.8, rows: { rows: [1, 2, 3] } })
    const supports = store.relationshipsOf(claim.id, 'in').filter((x) => x.type === SUPPORTS)
    expect(supports.map((x) => x.source.id).sort()).toEqual(['p0', 'p1', 'p2'])
    expect(store.get(schemaTypeId(CLAIM_TYPE))).toBeDefined()
    expect(new TypeRegistry(store).get(CLAIM_TYPE).label).toBe('Claim')
    expect(claimFor(store, finding)?.id).toBe(claim.id)
  })

  it('saving again updates the claim instead of duplicating it or its evidence', () => {
    const store = fixture()
    const a = saveFindingAsClaim(store, finding, report, 'Centrality')
    const b = saveFindingAsClaim(store, { ...finding, title: 'Revised', score: 0.9 }, report, 'Centrality')
    expect(b.created).toBe(false)
    expect(b.claim.id).toBe(a.claim.id)
    expect(store.ofType(CLAIM_TYPE)).toHaveLength(1)
    expect(store.get(a.claim.id)!.label).toBe('Revised')
    expect(store.relationshipsOf(a.claim.id, 'in').filter((x) => x.type === SUPPORTS)).toHaveLength(3)
    // A later run of the same finding refreshes the claim rather than making a second one.
    const c = saveFindingAsClaim(store, { ...finding, entities: ['p0', 'p3'] }, { key: 'k2', computedAt: '2026-09-16T00:00:00.000Z' }, 'Centrality')
    expect(c.created).toBe(false)
    expect(store.ofType(CLAIM_TYPE)).toHaveLength(1)
    expect(store.get(a.claim.id)!.data.reportKey).toBe('k2')
    expect(store.relationshipsOf(a.claim.id, 'in').filter((x) => x.type === SUPPORTS)).toHaveLength(4)
  })

  it('leaves a user-defined claim type alone', () => {
    const store = fixture()
    store.upsert(createEntity({ id: schemaTypeId(CLAIM_TYPE), type: 'schema:type', label: 'Assertion', data: { name: CLAIM_TYPE, category: 'knowledge', color: '#000' } }))
    saveFindingAsClaim(store, finding, report, 'Centrality')
    expect(store.get(schemaTypeId(CLAIM_TYPE))!.label).toBe('Assertion')
  })
})

describe('naming communities', () => {
  const metrics: MetricsResult = { computedAt: '', sliceKey: 's1', options: { metrics: ['community'] }, ids: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], columns: { community: new Float64Array([0, 0, 1, 1, 1, 2]) }, summary: {} as MetricsResult['summary'] }

  it('reads members and the community of a node from a metrics run', () => {
    expect(communityMembers(metrics, 1)).toEqual(['p2', 'p3', 'p4'])
    expect(communityOf(metrics, 'p5')).toBe(2)
    expect(communityOf(metrics, 'nope')).toBeUndefined()
    expect(communityMembers({ ...metrics, columns: {} }, 1)).toEqual([])
  })

  it('makes a community entity its members belong to, and renames rather than duplicates', () => {
    const store = fixture()
    const r = nameCommunity(store, { label: 'The trio', description: 'Middle of the graph', members: communityMembers(metrics, 1), community: 1, metricsKey: 's1' })
    expect(r.created).toBe(true)
    expect(r.members).toBe(3)
    const c = store.get(r.entity.id)!
    expect(c.type).toBe(COMMUNITY_TYPE)
    expect(c.data).toMatchObject({ community: 1, metricsKey: 's1', size: 3 })
    expect(store.relationshipsOf(c.id, 'in').filter((x) => x.type === MEMBER_OF).map((x) => x.source.id).sort()).toEqual(['p2', 'p3', 'p4'])
    expect(new TypeRegistry(store).get(COMMUNITY_TYPE).label).toBe('Community')
    expect(communityEntityFor(store, 's1', 1)?.id).toBe(c.id)

    const again = nameCommunity(store, { label: 'The middle three', members: ['p2', 'p3', 'p4', 'p5'], community: 1, metricsKey: 's1' })
    expect(again.created).toBe(false)
    expect(again.entity.id).toBe(c.id)
    expect(store.get(c.id)!.label).toBe('The middle three')
    expect(store.get(c.id)!.description).toBe('Middle of the graph')
    expect(store.relationshipsOf(c.id, 'in').filter((x) => x.type === MEMBER_OF)).toHaveLength(4)
    expect(store.ofType(COMMUNITY_TYPE)).toHaveLength(1)
  })
})
