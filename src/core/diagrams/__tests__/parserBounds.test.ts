import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { parseDot, writeDot } from '../dot'
import { applyPlan, inferMapping, planImport } from '../mapping'
import { classRelation, MAX_LINE, parseMermaid, writeMermaid } from '../mermaid'
import { emptyDiagram, MAX_DIAGRAM_EDGES, upsertNode } from '../model'

/**
 * Diagram text comes from anywhere and is parsed whenever the Diagrams page draws it: no line may stall a parser,
 * no product of nodes may become millions of edges, and no name in it may reach an object's machinery. The time
 * budgets are generous (seconds where a run takes milliseconds); before, the first case took minutes.
 */
const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now()
  const out = f()
  return [out, performance.now() - t]
}

describe('Mermaid parsers in bounded time', () => {
  it('reads a class relationship by splitting, so a run of dashes is linear (it was ~n⁴: 1,000 dashes took 396 s)', () => {
    const [d, ms] = timed(() => parseMermaid('classDiagram\n  A' + '-'.repeat(1_000) + '!\n  A ' + '-'.repeat(1_900) + ' B x'))
    expect(ms).toBeLessThan(2_000)
    expect(d.edges).toHaveLength(0)
    expect(classRelation('A "1" <|-- "many" B : owns')).toEqual({ a: 'A', cardA: '1', arrow: '<|--', cardB: 'many', b: 'B', label: 'owns' })
    expect(classRelation('Animal<|--Duck')).toMatchObject({ a: 'Animal', arrow: '<|--', b: 'Duck' })
    expect(classRelation('A..|>B')).toMatchObject({ a: 'A', arrow: '..|>', b: 'B' })
    expect(classRelation('my-class *-- other')).toMatchObject({ a: 'my-class', arrow: '*--', b: 'other' })
    expect(classRelation('direction LR')).toBeUndefined()
    expect(classRelation('click A href "x"')).toBeUndefined()
    const parsed = parseMermaid('classDiagram\n  Animal <|-- Duck\n  Zoo "1" o-- "*" Animal : keeps\n  A<|--B')
    expect(parsed.edges.map((e) => [e.source, e.target, e.style])).toEqual([['Duck', 'Animal', 'inheritance'], ['Zoo', 'Animal', 'aggregation'], ['B', 'A', 'inheritance']])
    expect(parsed.edges[1].attrs).toEqual({ sourceCardinality: '1', targetCardinality: '*' })
  })

  it('leaves out a line longer than MAX_LINE with a warning, before any pattern sees it, and every kind stays fast on lines just under it', () => {
    const d = parseMermaid(`flowchart TD\nA --> B\nC${'-'.repeat(MAX_LINE)}D`)
    expect(d.nodes.map((n) => n.id)).toEqual(['A', 'B'])
    expect(d.warnings.join(' ')).toMatch(/1 line longer than 2,000 characters left out/)
    const n = MAX_LINE - 20
    const lines = [
      'flowchart TD\nA -- ' + 'a '.repeat(n / 2) + '!',
      'flowchart TD\nA --' + ' '.repeat(n) + 'x',
      'flowchart TD\n' + 'A -- '.repeat(n / 5),
      'flowchart TD\nA@{' + 'a: b '.repeat(n / 5) + '}',
      'flowchart TD\nclass ' + 'a '.repeat(n / 2) + '!',
      'flowchart TD\n' + 'A & '.repeat(n / 4),
      'erDiagram\n' + 'A'.repeat(n) + ' ||--o{ B',
      'stateDiagram-v2\nA --> ' + 'B-'.repeat(n / 2) + ' x',
      'mindmap\n' + 'a(' + ')'.repeat(n),
      'sequenceDiagram\n' + 'A' + '-'.repeat(n) + 'x',
      'classDiagram\nclass A [' + ' '.repeat(n),
      'classDiagram\n' + '<'.repeat(n) + '!',
    ]
    const [, ms] = timed(() => lines.forEach((l) => parseMermaid(l)))
    expect(ms).toBeLessThan(3_000)
  })

  it('finds nodes by id in a map, so a large diagram is not quadratic', () => {
    const mind = 'mindmap\nroot\n' + Array.from({ length: 20_000 }, (_, i) => `  n${i}`).join('\n')
    const [m, ms1] = timed(() => parseMermaid(mind))
    expect(m.nodes).toHaveLength(20_001)
    const dot = `digraph {${Array.from({ length: 30_000 }, (_, i) => `n${i} -> n${i + 1};`).join('')}}`
    const [g, ms2] = timed(() => parseDot(dot))
    expect(g.nodes).toHaveLength(30_001)
    expect(ms1 + ms2).toBeLessThan(5_000)
    // The index follows nodes appended outside upsertNode and a replaced array.
    const d = emptyDiagram('dot')
    upsertNode(d, 'a')
    d.nodes.push({ id: 'b', label: 'b', classes: [], attrs: {} })
    expect(upsertNode(d, 'b')).toBe(d.nodes[1])
    d.nodes = [d.nodes[1]]
    expect(upsertNode(d, 'b')).toBe(d.nodes[0])
    expect(d.nodes).toHaveLength(1)
  })

  it('stops a product of node sets at MAX_DIAGRAM_EDGES, with a warning', () => {
    const set = (p: string, k: number) => `{${Array.from({ length: k }, (_, i) => `${p}${i}`).join(' ')}}`
    const [d, ms] = timed(() => parseDot(`digraph { ${set('a', 3_000)} -> ${set('b', 3_000)} }`))
    expect(d.edges).toHaveLength(MAX_DIAGRAM_EDGES)
    expect(d.warnings.filter((w) => /More than 200,000 edges/.test(w))).toHaveLength(1)
    expect(ms).toBeLessThan(5_000)
    const amp = (p: string, k: number) => Array.from({ length: k }, (_, i) => `${p}${i}`).join(' & ')
    const m = parseMermaid(`flowchart TD\n${amp('a', 120)} --> ${amp('b', 120)}`)
    expect(m.edges).toHaveLength(14_400)
  })
})

describe('names from a diagram are only names', () => {
  it('maps a class or label called __proto__ or constructor to a type that is a string, and the registry still builds', () => {
    const store = new EntityStore()
    const diagram = createEntity({ id: 'diag-00000001', type: 'diagram', label: 'd' })
    store.upsert(diagram)
    const d = parseMermaid('flowchart LR\nA:::__proto__ -->|__proto__| B:::constructor\nB -->|constructor| C:::toString')
    const m = inferMapping(d, 'd')
    expect(m.nodeTypeBy).toBe('class')
    const plan = planImport(store, diagram, d, m)
    for (const e of [...plan.entities, ...plan.relationships]) expect(typeof e.type).toBe('string')
    expect(plan.entities.find((e) => e.label === 'A')?.type).toBe('proto')
    applyPlan(store, plan)
    expect(() => new TypeRegistry(store)).not.toThrow()
    // A mapping from data (a diagram's data.mapping, a tool call) with nothing of its own for the key: the fixed type.
    const plain = planImport(store, diagram, d, { ...m, nodeTypes: {}, edgeTypes: { constructor: 7 } as unknown as Record<string, string>, fixedNodeType: '' })
    expect(plain.entities.every((e) => e.type === 'concept')).toBe(true)
    expect(plain.relationships.every((r) => typeof r.type === 'string')).toBe(true)
    expect(Object.prototype).not.toHaveProperty('proto')
  })

  it('a registry skips an entity whose type is not a name, instead of failing on every rebuild', () => {
    const store = new EntityStore()
    store.upsert(createEntity({ id: 'ok', type: 'person', label: 'ok' }))
    store.upsert({ ...createEntity({ id: 'bad', type: 'x', label: 'bad' }), type: {} as unknown as string })
    const reg = new TypeRegistry(store)
    expect(reg.get('person').count).toBe(1)
    expect(reg.all().every((t) => typeof t.type === 'string')).toBe(true)
  })

  it('writes a node whose shape names an object method without throwing', () => {
    const d = emptyDiagram('mermaid', 'flowchart')
    upsertNode(d, 'a', { shape: 'constructor' })
    upsertNode(d, 'b', { shape: 'toString' })
    expect(writeMermaid(d)).toContain('a["a"]')
    expect(writeDot(d)).toContain('shape=constructor')
  })
})
