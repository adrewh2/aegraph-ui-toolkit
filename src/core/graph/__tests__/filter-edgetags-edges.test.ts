import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { applyFilter, describeFilter, emptyFilter } from '../filter'
import '../types'

/**
 * `tags` keeps nodes; `edgeTags` keeps the links between them — the one a
 * picture of a spanning tree needs, where the tree is a tag on the
 * citations rather than on the theorems. Both paths of the edge collection
 * are exercised: the small node set that walks each node's relationships,
 * and the large one that scans them all.
 */
function fixture(n: number) {
  const s = new EntityStore()
  s.upsertMany(Array.from({ length: n }, (_, i) => createEntity({ id: `t${i}`, type: 'theorem', label: `T${i}` })))
  // A chain tagged `tree`, plus cross links that are not.
  s.upsertMany(Array.from({ length: n - 1 }, (_, i) => createRelationship({ id: `tree${i}`, type: 'cites', source: `t${i}`, target: `t${i + 1}`, tags: ['tree'] })))
  s.upsertMany(Array.from({ length: n - 2 }, (_, i) => createRelationship({ id: `x${i}`, type: 'cites', source: `t${i}`, target: `t${i + 2}` })))
  s.upsert(createRelationship({ id: 'other', type: 'mentions', source: 't0', target: 't1', tags: ['tree'] }))
  return { s, r: new TypeRegistry(s) }
}

describe('filtering the links, not the nodes', () => {
  it('keeps only the links carrying the tag, over both edge-collection paths, and leaves the nodes alone', () => {
    for (const n of [6, 400]) {
      const { s, r } = fixture(n)
      const all = applyFilter(s, r, { ...emptyFilter(), types: ['theorem'] })
      expect(all.nodes.length, `${n} nodes`).toBe(n)
      expect(all.edges.length).toBe(n - 1 + n - 2 + 1)
      const tree = applyFilter(s, r, { ...emptyFilter(), types: ['theorem'], edgeTags: ['tree'] })
      expect(tree.nodes.length, `${n} tree nodes`).toBe(n) // the nodes are the same; only the links thinned
      expect(tree.edges.map((e) => e.id).every((id) => id.startsWith('tree') || id === 'other')).toBe(true)
      expect(tree.edges.length).toBe(n - 1 + 1)
      // With a relationship type as well, both must hold.
      const both = applyFilter(s, r, { ...emptyFilter(), types: ['theorem'], relationshipTypes: ['cites'], edgeTags: ['tree'] })
      expect(both.edges.length).toBe(n - 1)
      expect(both.edges.every((e) => e.type === 'cites' && e.tags.includes('tree'))).toBe(true)
      // A tag nothing carries leaves the nodes and takes every link.
      const none = applyFilter(s, r, { ...emptyFilter(), types: ['theorem'], edgeTags: ['nope'] })
      expect(none.edges).toEqual([])
      expect(none.nodes.length).toBe(n)
      // Any of several tags.
      expect(applyFilter(s, r, { ...emptyFilter(), types: ['theorem'], edgeTags: ['nope', 'tree'] }).edges.length).toBe(n)
    }
  })

  it('is off when empty, says itself in the summary, and does not confuse the node tags', () => {
    const { s, r } = fixture(5)
    expect(applyFilter(s, r, { ...emptyFilter(), edgeTags: [] }).edges.length).toBe(applyFilter(s, r, emptyFilter()).edges.length)
    // `tags` still means nodes: the theorems carry no `tree` tag, so that filter empties the view.
    expect(applyFilter(s, r, { ...emptyFilter(), types: ['theorem'], tags: ['tree'] }).nodes).toEqual([])
    expect(describeFilter({ ...emptyFilter(), edgeTags: ['tree'] })).toContain('links tagged tree')
    expect(describeFilter(emptyFilter())).not.toContain('links tagged')
  })
})
