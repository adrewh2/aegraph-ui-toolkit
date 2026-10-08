import { createEntity, createRelationship } from '../entity/entity'
import type { EntityStore } from '../entity/store'
import { isRelationship, type Entity, type EntityId, type Relationship, type Selector } from '../entity/types'
import { RELATIONSHIP_TYPES, RESOURCE_TYPES, type AnnotationData } from './types'

/**
 * Annotations are entities linked to their target by an `annotates`
 * relationship whose target ref carries a selector — a text quote for
 * documents, a region for images. These helpers are shared by every view
 * that shows or creates them.
 */

export interface TargetAnnotation {
  annotation: Entity<AnnotationData>
  relationshipId: EntityId
  selector?: Selector
  /** The quoted passage, when the selector is a text quote. */
  exact?: string
  /** The box, when the selector is a region. */
  region?: Extract<Selector, { kind: 'region' }>
}

/** Annotations pointing at `targetId`, oldest first. */
export function annotationsOf(store: EntityStore, targetId: EntityId): TargetAnnotation[] {
  const out: TargetAnnotation[] = []
  for (const r of store.relationshipsOf(targetId, 'in')) {
    if (r.type !== RELATIONSHIP_TYPES.annotates || r.target.id !== targetId) continue
    const a = store.get(r.source.id)
    if (!a || isRelationship(a) || a.type !== RESOURCE_TYPES.annotation) continue
    const selector = r.target.selector
    out.push({
      annotation: a as Entity<AnnotationData>,
      relationshipId: r.id,
      selector,
      exact: selector?.kind === 'text' ? selector.exact : typeof a.data.selectedText === 'string' ? a.data.selectedText : undefined,
      region: selector?.kind === 'region' ? selector : undefined,
    })
  }
  return out.sort((a, b) => a.annotation.meta.createdAt.localeCompare(b.annotation.meta.createdAt))
}

/** Creates the annotation entity and its `annotates` relationship in one batch. */
export function createAnnotation(
  store: EntityStore,
  targetId: EntityId,
  selector: Selector | undefined,
  init: { comment: string; tags?: string[]; label?: string; annotationType: AnnotationData['annotationType']; data?: Partial<AnnotationData>; source?: string },
): Entity<AnnotationData> {
  const comment = init.comment.trim()
  const ann = createEntity<AnnotationData>({
    type: RESOURCE_TYPES.annotation,
    label: init.label?.trim() || comment.slice(0, 60) || 'Annotation',
    tags: init.tags,
    data: { ...init.data, annotationType: init.annotationType, comment },
    meta: { source: init.source ?? 'user' },
  })
  const rel = createRelationship({
    type: RELATIONSHIP_TYPES.annotates,
    source: ann.id,
    target: selector ? { id: targetId, selector } : { id: targetId },
    meta: { source: init.source ?? 'user' },
  })
  store.upsertMany([ann, rel])
  return ann
}

/** Replace the selector on an annotation's relationship (e.g. after moving a box). */
export function updateAnnotationSelector(store: EntityStore, relationshipId: EntityId, selector: Selector) {
  const r = store.get(relationshipId)
  if (!r || !isRelationship(r)) return
  store.update<Relationship>(r.id, { target: { id: r.target.id, selector } })
}
