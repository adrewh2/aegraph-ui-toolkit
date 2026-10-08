import type { Finding } from '../../analysis/types'
import { schemaTypeId } from '../../core/entity/categories'
import { createEntity, createRelationship } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import { schemaTypeEntity } from '../../core/entity/typeRegistry'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import type { MetricsResult } from '../../core/graph/metrics/types'

/**
 * Findings become knowledge. A finding from the Insights run is a
 * sentence with numbers behind it; saved, it is a *claim* entity whose
 * evidence — the entities the finding is about — points at it through
 * `supports` relationships, so it sits in the graph next to everything
 * else and the ontology, the tables and the assistant see it. A Louvain
 * community, named, is a *community* entity its members belong to
 * through `member-of`.
 *
 * Both types are defined on first use (a `schema:type` entity, so a
 * project without them gets a proper definition, colour included);
 * saving the same finding or community twice updates rather than
 * duplicates.
 */
export const CLAIM_TYPE = 'claim'
export const COMMUNITY_TYPE = 'community'
export const SUPPORTS = 'supports'
export const MEMBER_OF = 'member-of'

const TYPE_DEFS: Record<string, { label: string; pluralLabel: string; description: string; color: string }> = {
  [CLAIM_TYPE]: { label: 'Claim', pluralLabel: 'Claims', description: 'A statement the workspace is trying to support or challenge with evidence.', color: '#fca5a5' },
  [COMMUNITY_TYPE]: { label: 'Community', pluralLabel: 'Communities', description: 'A group of entities that are more connected to each other than to the rest — found by community detection and named.', color: '#f9a8d4' },
}

/** Define a type in the store unless it already is (user or demo definitions are left alone). */
export function ensureType(store: EntityStore, name: string) {
  if (store.get(schemaTypeId(name))) return
  const def = TYPE_DEFS[name]
  if (!def) return
  store.upsert(schemaTypeEntity(name, { label: def.label, pluralLabel: def.pluralLabel, description: def.description, color: def.color, category: 'knowledge' }))
}

export interface ReportRef {
  key: string
  computedAt: string
}

/**
 * The claim already saved for this finding, if any. A finding's id names
 * what it is about (`centrality:hubs`), not a particular run, so saving
 * it again after a re-run refreshes the claim with the latest numbers
 * and evidence rather than making a second one.
 */
export function claimFor(store: EntityStore, finding: Finding): AnyEntity | undefined {
  return store.ofType(CLAIM_TYPE).find((e) => e.data.findingId === finding.id)
}

/**
 * Save a finding as a claim with its evidence. The claim carries the
 * finding's title as its label and its detail as the description, plus
 * the analysis, score and rows behind it in `data`; every entity the
 * finding names supports it. Returns the claim and how many entities
 * support it (none when the finding names no entities).
 */
export function saveFindingAsClaim(store: EntityStore, finding: Finding, report: ReportRef, analysisLabel: string): { claim: AnyEntity; evidence: number; created: boolean } {
  ensureType(store, CLAIM_TYPE)
  const existing = claimFor(store, finding)
  const claim: AnyEntity = existing
    ? { ...existing, label: finding.title, description: finding.detail, data: { ...existing.data, score: finding.score, reportKey: report.key, computedAt: report.computedAt, rows: finding.data ?? {} }, meta: { ...existing.meta, updatedAt: new Date().toISOString() } }
    : createEntity({
        type: CLAIM_TYPE,
        label: finding.title,
        description: finding.detail,
        tags: ['insight', `analysis:${finding.analysis}`],
        data: { analysis: finding.analysis, analysisLabel, score: finding.score, findingId: finding.id, reportKey: report.key, computedAt: report.computedAt, rows: finding.data ?? {} },
        meta: { source: 'insights' },
      })
  const evidence = (finding.entities ?? []).filter((id) => store.has(id))
  const already = new Set(store.relationshipsOf(claim.id, 'in').filter((r) => r.type === SUPPORTS).map((r) => r.source.id))
  // Ranked by the entity's place in the finding (most relevant first) — not by its place among the links added this time.
  const links = evidence.filter((id) => !already.has(id)).map((id) => createRelationship({ type: SUPPORTS, source: id, target: claim.id, tags: ['insight'], data: { rank: evidence.indexOf(id) + 1 }, meta: { source: 'insights' } }))
  store.upsertMany([claim, ...links])
  return { claim, evidence: evidence.length, created: !existing }
}

/** The node ids in a community of a metrics run, in the run's node order. */
export function communityMembers(metrics: MetricsResult, community: number): EntityId[] {
  const col = metrics.columns.community
  if (!col) return []
  const out: EntityId[] = []
  for (let i = 0; i < metrics.ids.length; i++) if (col[i] === community) out.push(metrics.ids[i])
  return out
}

/** The community of a node in a metrics run, or undefined when it has none. */
export function communityOf(metrics: MetricsResult, id: EntityId): number | undefined {
  const col = metrics.columns.community
  if (!col) return undefined
  const i = metrics.ids.indexOf(id)
  return i < 0 ? undefined : col[i]
}

/** The community entity already made for this community of this run, if any. */
export function communityEntityFor(store: EntityStore, metricsKey: string, community: number): AnyEntity | undefined {
  return store.ofType(COMMUNITY_TYPE).find((e) => e.data.metricsKey === metricsKey && e.data.community === community)
}

/**
 * Name a community: a community entity every member belongs to. Naming
 * it again renames it and adds any members that were missing.
 */
export function nameCommunity(store: EntityStore, opts: { label: string; description?: string; members: EntityId[]; community: number; metricsKey: string }): { entity: AnyEntity; members: number; created: boolean } {
  ensureType(store, COMMUNITY_TYPE)
  const existing = communityEntityFor(store, opts.metricsKey, opts.community)
  // Unique: a list with a repeat in it used to add the same member-of twice (two relationships between the same
  // pair) and count the member twice in `size`. The caller's order is kept.
  const members = [...new Set(opts.members)].filter((id) => store.has(id))
  const entity: AnyEntity = existing
    ? { ...existing, label: opts.label, description: opts.description ?? existing.description, data: { ...existing.data, size: members.length }, meta: { ...existing.meta, updatedAt: new Date().toISOString() } }
    : createEntity({
        type: COMMUNITY_TYPE,
        label: opts.label,
        description: opts.description,
        tags: ['community'],
        data: { community: opts.community, metricsKey: opts.metricsKey, size: members.length },
        meta: { source: 'insights' },
      })
  const already = new Set(store.relationshipsOf(entity.id, 'in').filter((r) => r.type === MEMBER_OF).map((r) => r.source.id))
  const links = members.filter((id) => !already.has(id)).map((id) => createRelationship({ type: MEMBER_OF, source: id, target: entity.id, tags: ['community'], meta: { source: 'insights' } }))
  store.upsertMany([entity, ...links])
  return { entity, members: members.length, created: !existing }
}
