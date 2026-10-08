import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import type { Selector } from '../../entity/types'
import { annotationsOf, createAnnotation, updateAnnotationSelector } from '../annotations'

/**
 * Annotations at their edges: what createAnnotation writes for every
 * selector kind and for none, where the selector lives, how the label is
 * chosen, what the listing puts in `exact` and `region` for each kind,
 * its ordering, two annotations on one passage, a target that is not in
 * the store, deleting the annotation and deleting the target, a
 * relationship that merely looks like an annotation, selector replacement
 * on a relationship that is not there, and what a project scope hides.
 */
function make() {
  const s = new EntityStore()
  s.upsertMany([createEntity({ id: 'doc', type: 'document', label: 'Doc' }), createEntity({ id: 'img', type: 'image', label: 'Img' })])
  return s
}

describe('annotations edges', () => {
  it('writes the entity and one annotates relationship, the selector on the target end, the source on both, tags deduplicated', () => {
    const s = make()
    const sel: Selector = { kind: 'text', exact: 'fox', prefix: 'quick ', suffix: ' jumps' }
    const a = createAnnotation(s, 'doc', sel, { comment: '  nice  ', tags: ['x', 'x', 'y'], annotationType: 'text', source: 'assistant' })
    expect(a.type).toBe('annotation')
    expect(a.data).toEqual({ annotationType: 'text', comment: 'nice' })
    expect(a.label).toBe('nice')
    expect(a.tags).toEqual(['x', 'y'])
    expect(a.meta.source).toBe('assistant')
    expect(s.size()).toBe(4)
    const rels = s.relationshipsOf(a.id, 'out')
    expect(rels).toHaveLength(1)
    expect(rels[0].type).toBe('annotates')
    expect(rels[0].source).toEqual({ id: a.id })
    expect(rels[0].target).toEqual({ id: 'doc', selector: sel })
    expect(rels[0].meta.source).toBe('assistant')
    // Without a selector the target ref carries none at all.
    const b = createAnnotation(s, 'doc', undefined, { comment: 'whole', annotationType: 'note' })
    expect(s.relationshipsOf(b.id, 'out')[0].target).toEqual({ id: 'doc' })
    expect(s.relationshipsOf(b.id, 'out')[0].meta.source).toBe('user')
  })

  it('labels from the label, else the comment cut at 60, else "Annotation"; the comment is trimmed and extra data comes along', () => {
    const s = make()
    const long = 'a'.repeat(80)
    expect(createAnnotation(s, 'doc', undefined, { comment: long, annotationType: 'note' }).label).toBe('a'.repeat(60))
    expect(createAnnotation(s, 'doc', undefined, { comment: 'c', label: '  Named  ', annotationType: 'note' }).label).toBe('Named')
    expect(createAnnotation(s, 'doc', undefined, { comment: 'c', label: '   ', annotationType: 'note' }).label).toBe('c')
    expect(createAnnotation(s, 'doc', undefined, { comment: '   ', annotationType: 'note' }).label).toBe('Annotation')
    const a = createAnnotation(s, 'img', { kind: 'region', x: 1, y: 2, width: 3, height: 4 }, { comment: 'box', annotationType: 'image', data: { imageUrl: 'data:,x', pageUrl: 'https://e.g/', imageWidth: 10 } })
    expect(a.data).toEqual({ annotationType: 'image', comment: 'box', imageUrl: 'data:,x', pageUrl: 'https://e.g/', imageWidth: 10 })
    // The named arguments win over the same keys given through `data`.
    const b = createAnnotation(s, 'doc', undefined, { comment: 'said', annotationType: 'note', data: { comment: 'other', annotationType: 'text' } })
    expect(b.data.comment).toBe('said')
    expect(b.data.annotationType).toBe('note')
  })

  it('lists every selector kind, fills exact for text quotes or from selectedText, and region for boxes only', () => {
    const s = make()
    const kinds: Selector[] = [
      { kind: 'text', exact: 'quote' },
      { kind: 'range', start: 1, end: 5 },
      { kind: 'region', x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      { kind: 'time', start: 12, end: 20, region: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      { kind: 'geo', lat: 51.5, lng: -0.1, radius: 250, at: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z' },
      { kind: 'fragment', value: 'p3' },
    ]
    const made = kinds.map((sel, i) => createAnnotation(s, 'doc', sel, { comment: `c${i}`, annotationType: 'note' }))
    const stamp = (id: string, t: string) => s.upsert({ ...s.get(id)!, meta: { ...s.get(id)!.meta, createdAt: t } })
    made.forEach((a, i) => stamp(a.id, `2026-01-01T00:00:0${i}Z`))
    const list = annotationsOf(s, 'doc')
    expect(list.map((x) => x.selector)).toEqual(kinds)
    expect(list.map((x) => x.annotation.id)).toEqual(made.map((a) => a.id))
    expect(list.map((x) => x.exact)).toEqual(['quote', undefined, undefined, undefined, undefined, undefined])
    expect(list.map((x) => x.region)).toEqual([undefined, undefined, kinds[2], undefined, undefined, undefined])
    expect(list.map((x) => s.get(x.relationshipId)?.kind)).toEqual(Array(6).fill('relationship'))
    // A still with a time selector and a stored `selectedText`: the text comes from the data.
    const still = createAnnotation(s, 'doc', { kind: 'time', start: 3 }, { comment: 'caption', annotationType: 'image', data: { selectedText: 'spoken words' } })
    const rows = annotationsOf(s, 'doc')
    expect(rows.find((x) => x.annotation.id === still.id)?.exact).toBe('spoken words')
    expect(rows.find((x) => x.annotation.id === still.id)?.region).toBeUndefined()
    const none = createAnnotation(s, 'doc', undefined, { comment: 'bare', annotationType: 'note' })
    const bare = annotationsOf(s, 'doc').find((x) => x.annotation.id === none.id)!
    expect(bare.selector).toBeUndefined()
    expect(bare.exact).toBeUndefined()
    expect(bare.region).toBeUndefined()
  })

  it('orders oldest first by creation time, not by insertion, and keeps two annotations on the same passage apart', () => {
    const s = make()
    const sel: Selector = { kind: 'text', exact: 'same words' }
    const first = createAnnotation(s, 'doc', sel, { comment: 'one', annotationType: 'text' })
    const second = createAnnotation(s, 'doc', sel, { comment: 'two', annotationType: 'text' })
    s.upsert({ ...s.get(first.id)!, meta: { ...s.get(first.id)!.meta, createdAt: '2030-01-01T00:00:00Z' } })
    s.upsert({ ...s.get(second.id)!, meta: { ...s.get(second.id)!.meta, createdAt: '2020-01-01T00:00:00Z' } })
    const list = annotationsOf(s, 'doc')
    expect(list.map((x) => x.annotation.data.comment)).toEqual(['two', 'one'])
    expect(new Set(list.map((x) => x.relationshipId)).size).toBe(2)
    expect(list.map((x) => x.selector)).toEqual([sel, sel])
    expect(s.relationshipsOf('doc', 'in')).toHaveLength(2)
  })

  it('annotates a target that is not in the store, leaving a dangling link the listing still resolves, and lists nothing for the unknown', () => {
    const s = make()
    const a = createAnnotation(s, 'ghost', { kind: 'text', exact: 'x' }, { comment: 'on nothing', annotationType: 'text' })
    expect(s.has('ghost')).toBe(false)
    expect(s.danglingRelationships()).toHaveLength(1)
    expect(annotationsOf(s, 'ghost').map((x) => x.annotation.id)).toEqual([a.id]) // the index is by id, whether or not the target exists
    expect(annotationsOf(s, 'nope')).toEqual([])
    expect(annotationsOf(s, a.id)).toEqual([]) // the annotation has no incoming links of its own
  })

  it('deleting the annotation removes its link and nothing else; deleting the target removes the link and leaves the annotation orphaned', () => {
    const s = make()
    const a = createAnnotation(s, 'doc', { kind: 'text', exact: 'x' }, { comment: 'a', annotationType: 'text' })
    const b = createAnnotation(s, 'doc', { kind: 'text', exact: 'y' }, { comment: 'b', annotationType: 'text' })
    const relB = annotationsOf(s, 'doc').find((x) => x.annotation.id === b.id)!.relationshipId
    s.remove(a.id)
    expect(annotationsOf(s, 'doc').map((x) => x.annotation.id)).toEqual([b.id])
    expect(s.has('doc')).toBe(true)
    expect(s.relationshipCount()).toBe(1)
    s.remove('doc')
    expect(s.has(relB)).toBe(false)
    expect(s.has(b.id)).toBe(true) // the note survives its target
    expect(s.relationshipsOf(b.id)).toEqual([])
    expect(annotationsOf(s, 'doc')).toEqual([])
    // Removing just the link (no cascade) also drops the listing while both ends stay.
    const c = createAnnotation(s, 'img', undefined, { comment: 'c', annotationType: 'note' })
    const relC = annotationsOf(s, 'img')[0].relationshipId
    s.remove(relC, { cascade: false })
    expect(annotationsOf(s, 'img')).toEqual([])
    expect(s.has(c.id) && s.has('img')).toBe(true)
  })

  it('ignores a link that is not an annotates from an annotation: another type from an annotation, annotates from another entity, a missing source, or the reverse direction', () => {
    const s = make()
    const a = createAnnotation(s, 'doc', undefined, { comment: 'real', annotationType: 'note' })
    s.upsertMany([
      createRelationship({ id: 'r1', type: 'related', source: a.id, target: 'doc' }),
      createRelationship({ id: 'r2', type: 'annotates', source: 'img', target: 'doc' }),
      createRelationship({ id: 'r3', type: 'annotates', source: 'missing', target: 'doc' }),
      createRelationship({ id: 'r4', type: 'annotates', source: 'doc', target: a.id }),
    ])
    expect(annotationsOf(s, 'doc').map((x) => x.annotation.id)).toEqual([a.id])
    expect(annotationsOf(s, a.id)).toEqual([]) // doc "annotating" the annotation is not an annotation
    expect(annotationsOf(s, 'img')).toEqual([])
  })

  it('replaces the selector on the link, keeping the target and the rest; does nothing for an entity id or an unknown one', () => {
    const s = make()
    const a = createAnnotation(s, 'img', { kind: 'region', x: 0, y: 0, width: 1, height: 1 }, { comment: 'box', annotationType: 'image', tags: ['t'] })
    const relId = annotationsOf(s, 'img')[0].relationshipId
    const v = s.version
    const moved: Selector = { kind: 'region', x: 0.5, y: 0.5, width: 0.2, height: 0.2 }
    updateAnnotationSelector(s, relId, moved)
    const rel = s.get(relId)!
    expect(rel.kind).toBe('relationship')
    expect((rel as { target: unknown }).target).toEqual({ id: 'img', selector: moved })
    expect((rel as { source: unknown }).source).toEqual({ id: a.id })
    expect(rel.type).toBe('annotates')
    expect(annotationsOf(s, 'img')[0].region).toEqual(moved)
    expect(s.version).toBe(v + 1)
    // Changing the kind is allowed too: the listing follows the selector, not the annotation type.
    updateAnnotationSelector(s, relId, { kind: 'text', exact: 'alt' })
    expect(annotationsOf(s, 'img')[0]).toMatchObject({ exact: 'alt', region: undefined })
    updateAnnotationSelector(s, a.id, moved)
    updateAnnotationSelector(s, 'nope', moved)
    expect(s.version).toBe(v + 2)
    expect(s.get(a.id)!.tags).toEqual(['t'])
  })

  it('under a project scope lists only annotations the project holds; one made while the project is open is in it', () => {
    const s = make()
    s.upsert(createEntity({ id: 'p', type: 'project', label: 'P', data: { members: [] } }))
    const before = createAnnotation(s, 'doc', undefined, { comment: 'before', annotationType: 'note' })
    s.mark(['doc'], 'p')
    s.setScope('p')
    expect(annotationsOf(s, 'doc')).toEqual([])
    const during = createAnnotation(s, 'doc', undefined, { comment: 'during', annotationType: 'note' })
    expect(annotationsOf(s, 'doc').map((x) => x.annotation.id)).toEqual([during.id])
    expect(s.projectsOf(during.id)).toEqual(['p'])
    s.setScope(null)
    expect(annotationsOf(s, 'doc').map((x) => x.annotation.data.comment).sort()).toEqual(['before', 'during'])
    expect(s.projectsOf(before.id)).toEqual([])
  })
})
