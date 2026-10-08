import { describe, expect, it } from 'vitest'
import { isNodeLink, parseNodeLink } from '../nodeLink'

describe('node-link JSON', () => {
  it('reads d3’s shape: nodes by name, links by index, the rest as attributes', async () => {
    const g = await parseNodeLink(JSON.stringify({ nodes: [{ name: 'Myriel', group: 1, index: 0 }, { name: 'Napoleon', group: 1 }], links: [{ source: 1, target: 0, value: 3 }] }))
    expect(g.nodes.map((n) => [n.id, n.label, n.attrs.group])).toEqual([['Myriel', 'Myriel', 1], ['Napoleon', 'Napoleon', 1]])
    expect(g.nodes[0].attrs).not.toHaveProperty('index')
    expect(g.edges).toEqual([expect.objectContaining({ source: 'Napoleon', target: 'Myriel', weight: 3 })])
    expect(g.directedDefault).toBe(false)
  })

  it('reads NetworkX’s: explicit ids (numbers too), `edges` for `links`, `directed`', async () => {
    const g = await parseNodeLink(JSON.stringify({ directed: true, multigraph: false, graph: {}, nodes: [{ id: 1, club: 'Mr. Hi' }, { id: 2 }], edges: [{ source: 1, target: 2, weight: 4 }] }))
    expect(g.nodes.map((n) => n.id)).toEqual(['1', '2'])
    expect(g.edges[0]).toMatchObject({ source: '1', target: '2', weight: 4 })
    expect(g.directedDefault).toBe(true)
  })

  it('reads links whose ends are the nodes themselves (d3 after its simulation) and says what it skipped', async () => {
    const a = { id: 'a', x: 10, y: 20 }
    const g = await parseNodeLink(JSON.stringify({ nodes: [a, { id: 'b' }], links: [{ source: a, target: { id: 'b' } }, { source: 'a', target: 'nowhere' }] }))
    expect(g.edges.map((e) => [e.source, e.target])).toEqual([['a', 'b']])
    expect(g.nodes[0].viz).toEqual({ x: 10, y: -20 })
    expect(g.warnings[0]).toMatch(/Skipped 1 link/)
  })

  it('keeps keys that reach into objects out, and tells a node-link graph from an aegraph document', async () => {
    const g = await parseNodeLink('{"nodes":[{"id":"a","__proto__":{"polluted":true},"constructor":1,"ok":2}],"links":[]}')
    expect(Object.keys(g.nodes[0].attrs)).toEqual(['ok'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(isNodeLink({ nodes: [], links: [] })).toBe(true)
    expect(isNodeLink({ $schema: 'aegraph/v1', entities: [], nodes: [], links: [] })).toBe(false)
    expect(isNodeLink([{ nodes: [] }])).toBe(false)
    await expect(parseNodeLink('{"entities":[]}')).rejects.toThrow(/Not node-link JSON/)
  })
})
