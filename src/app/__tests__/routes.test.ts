import { describe, expect, it } from 'vitest'
import { createEntity } from '../../core/entity/entity'
import { EntityStore } from '../../core/entity/store'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import '../../core/graph/types'
import '../../core/resources/types'
import { entityHref, unloadsBehind } from '../routes'

describe('entityHref and the scene family', () => {
  const registry = new TypeRegistry(new EntityStore())
  const geometry = { kind: '2d', width: 10, height: 10, nodes: {}, edges: {}, groups: {} }
  it('a scene and a script scene open on the Scenes page; a graph scene opens in Unigraph', () => {
    expect(entityHref(createEntity({ id: 's', type: 'projection', label: 'S', data: geometry }), registry)).toBe('/scenes?id=s')
    expect(entityHref(createEntity({ id: 'ss', type: 'scene:script', label: 'S', data: { ...geometry, source: { scriptId: 'x', ranAt: '2026-09-19T00:00:00Z' } } }), registry)).toBe('/scenes?id=ss')
    expect(entityHref(createEntity({ id: 'g', type: 'scene', label: 'G', data: { renderer: '2d' } }), registry)).toBe('/unigraph/2d?scene=g')
  })
})

describe('views let go when behind', () => {
  it('is Unigraph (and the old graph routes) — not the pages kept for a quick return', () => {
    for (const p of ['/unigraph', '/unigraph/3d', '/unigraph/2d?scene=s1', '/graph/2d']) expect(unloadsBehind(p)).toBe(true)
    for (const p of ['/entities', '/chats/x', '/documents/d', '/maps/m', '/workstation', '/', '/unigraphs']) expect(unloadsBehind(p)).toBe(false)
  })
})
