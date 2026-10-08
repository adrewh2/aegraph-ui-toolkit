import { describe, expect, it } from 'vitest'
import { outputsOf } from '../outputs'
import { Sandbox } from '../sandbox'
import type { Snapshot } from '../types'

function snapshot(): Snapshot {
  const entities = []
  for (let i = 0; i < 300; i++) entities.push({ id: `e${i}`, type: i % 4 ? 'incident' : 'service', label: `E ${i}`, tags: i % 5 ? [] : ['hot'], data: { severity: `S${1 + (i % 3)}`, duration_min: 10 + (i % 50), startedAt: new Date(Date.UTC(2025, i % 12, 1 + (i % 27))).toISOString() }, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' })
  const relationships = []
  for (let i = 1; i < 300; i++) relationships.push({ id: `r${i}`, type: 'affected', source: `e${i}`, target: `e${i % 4 === 0 ? i : i - (i % 4)}`, directed: true, data: {} })
  return {
    scope: { label: 'test', projectId: 'p' },
    project: { id: 'p', label: 'Ops', includes: [], createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
    entities,
    relationships,
    ontology: [{ type: 'incident', label: 'Incident', category: 'knowledge', kind: 'entity', count: 225, properties: [{ key: 'severity', kind: 'text', options: ['S1', 'S2', 'S3'] }, { key: 'owner', kind: 'text', description: 'Who runs it' }] }],
    tags: [{ tag: 'hot', count: 60, color: '#f00' }],
    metrics: { pagerank: { e0: 0.5, e4: 0.25 } },
  }
}

describe('script sandbox', () => {
  const sb = new Sandbox()
  const load = () => sb.load('k1', JSON.stringify(snapshot()))

  it('runs a script over the snapshot with the prelude helpers', async () => {
    await load()
    const r = await sb.run(`
      const inc = ds.byType('incident')
      const perMonth = rollup(inc, (e) => bin(e.data.startedAt, 'month'), (e) => e.data.duration_min, 'mean')
      log('months', perMonth.length)
      return figure(line(perMonth.map((r) => r.key), perMonth.map((r) => r.value), { name: 'mean duration' }), { title: 'Mean duration per month' })
    `)
    expect(r.error).toBeUndefined()
    expect(r.logs).toEqual(['months 9'])
    const outs = outputsOf(r.value)
    expect(outs[0].kind).toBe('figure')
    if (outs[0].kind === 'figure') {
      expect(outs[0].data[0].x).toHaveLength(9)
      expect(outs[0].layout.title).toBe('Mean duration per month')
    }
  })

  it('exposes graph access and metrics, and serialises Maps and NaN', async () => {
    await load()
    const r = await sb.run(`
      const s = ds.get('e0')
      return { neighbours: ds.neighbors('e0').length, degree: ds.degree('e4'), pr: ds.metric('pagerank', 'e4'), m: new Map([['a', 1]]), nan: NaN, tagged: ds.tagged('hot').length, types: ds.types() }
    `)
    expect(r.error).toBeUndefined()
    expect(r.value).toEqual({ neighbours: 3, degree: 5, pr: 0.25, m: { a: 1 }, nan: null, tagged: 60, types: ['service', 'incident'] })
  })

  it('exposes the project state: the project, the ontology, tags, and a summary to dig into', async () => {
    await load()
    const r = await sb.run(`
      const d = ds.describe()
      return { project: ds.project.label, type: ds.type('incident').properties.map((p) => p.key), props: ds.properties('incident').map((p) => [p.key, p.kind, Math.round(p.coverage * 100), !!p.declared]), tags: ds.tags(), metrics: ds.metricNames(), summary: { types: d.types.map((t) => t.type), rels: d.relationshipTypes, tags: d.tags, n: d.entities } }
    `)
    expect(r.error).toBeUndefined()
    expect(r.value).toEqual({
      project: 'Ops',
      type: ['severity', 'owner'],
      // Seen in the data first (with coverage), then declared-only ones; a declared kind wins over the seen one.
      props: [['duration_min', 'number', 100, false], ['severity', 'text', 100, true], ['startedAt', 'string', 100, false], ['owner', 'text', 0, true]],
      tags: [{ tag: 'hot', count: 60, color: '#f00' }],
      metrics: ['pagerank'],
      summary: { types: ['service', 'incident'], rels: [{ type: 'affected', count: 299, joins: ['incident → service', 'service → service'] }], tags: ['hot (60)'], n: 300 },
    })
  })

  it('the chained query API: entities.types.<type>, filter specs, graph steps, sort/top/table — collections all the way, arrays still', async () => {
    await load()
    const r = await sb.run(`
      const hot = entities.types.services.filter({ tags: 'hot' })
      return {
        kinds: [entities.constructor.name, ds.entities === entities, ds.byType('service').constructor.name, entities.map((e) => e.id).constructor.name],
        get: entities.types.incident.get('e1').label,
        namespace: [entities.types.list(), Object.keys(entities.types), 'incidents' in entities.types],
        spec: entities.filter({ types: new Set(['incident']), data: { severity: ['S1', 'S2'] }, minDegree: 1 }).count(),
        snake: entities.filter({ min_degree: 4, types: 'service' }).ids().slice(0, 3),
        text: entities.filter({ text: 'e 29' }).ids(),
        hasAndData: entities.filter({ has: 'duration_min', data: { duration_min: (v) => v > 55 } }).count(),
        chain: entities.types.service.take(2).neighbors('affected').types.list(),
        rels: relationships.filter({ source_type: 'incident', target: 'e4' }).sources().count(),
        from: relationships.from(entities.types.service.take(1)).count(),
        sort: entities.types.incident.sort('data.duration_min', true).top('data.duration_min', 2).pluck('data.duration_min'),
        group: Object.fromEntries(Object.entries(entities.group('type')).map(([k, v]) => [k, v.count()])),
        rollup: entities.types.incident.rollup('data.severity', 'data.duration_min', 'mean').map((r) => [r.key, Math.round(r.value), r.n, r.items.constructor.name]),
        table: entities.types.service.take(1).table(['label', 'data.severity']),
        exclude: entities.exclude({ types: 'incident' }).count(),
        describe: entities.types.service.describe().properties,
        hot: hot.count(),
        degrees: Object.values(entities.types.service.take(2).degrees()),
        forOf: (() => { let n = 0; for (const e of entities.types.service) n++; return n })(),
      }
    `)
    expect(r.error).toBeUndefined()
    expect(r.value).toEqual({
      kinds: ['Entities', true, 'Entities', 'Array'],
      get: 'E 1',
      namespace: [['service', 'incident'], ['service', 'incident'], true],
      spec: 150,
      snake: ['e4', 'e8', 'e12'],
      text: ['e29', 'e290', 'e291', 'e292', 'e293', 'e294', 'e295', 'e296', 'e297', 'e298', 'e299'],
      hasAndData: 24,
      chain: ['incident', 'service'],
      rels: 3,
      from: 0,
      sort: [59, 59],
      group: { service: 75, incident: 225 },
      rollup: [['S1', 35, 75, 'Entities'], ['S2', 35, 75, 'Entities'], ['S3', 35, 75, 'Entities']],
      table: { table: { columns: ['label', 'data.severity'], rows: [['E 0', 'S1']] } },
      exclude: 75,
      describe: ['duration_min:number', 'severity:string', 'startedAt:string'],
      hot: 15,
      degrees: [3, 5],
      forOf: 75,
    })
  })

  it('has no I/O: no fetch, timers, DOM, or storage', async () => {
    await load()
    const r = await sb.run(`return [typeof fetch, typeof XMLHttpRequest, typeof setTimeout, typeof document, typeof localStorage, typeof indexedDB, typeof importScripts, typeof WebSocket]`)
    expect(r.value).toEqual(new Array(8).fill('undefined'))
  })

  it('interrupts a runaway script and reports errors with a stack', async () => {
    await load()
    const r = await sb.run(`while (true) {}`, { timeoutMs: 200 })
    expect(r.error?.message).toMatch(/interrupted/)
    const e = await sb.run(`const x = null\nreturn x.y`)
    expect(e.error?.message).toMatch(/null/)
    // The runtime survives both; the snapshot is still there.
    const ok = await sb.run(`return ds.count()`)
    expect(ok.value).toBe(300)
  })

  // The interpreter has to run far enough to exhaust 64 MB, so this one costs whatever the machine is charging:
  // a quarter of a second idle, a quarter of a minute when a dozen sessions are busy. The harness is given room;
  // what has to hold is that the run comes back with an error rather than eating the heap.
  it('caps memory', async () => {
    await load()
    const r = await sb.run(`const a = []; while (true) a.push(new Array(1e6).fill(1))`, { timeoutMs: 4000, memoryMb: 64 })
    expect(r.error).toBeDefined()
  }, 90_000)

  it('reads tables, scenes and text out of results', () => {
    expect(outputsOf({ table: { rows: [{ a: 1, b: 'x' }], columns: ['a', 'b'] } })[0]).toEqual({ kind: 'table', columns: ['a', 'b'], rows: [[{ a: 1, b: 'x' }]] })
    expect(outputsOf({ scene: { positions: { e1: { x: 1, y: 2 }, bad: { x: 'no' } } } })[0]).toMatchObject({ kind: 'scene', positions: { e1: { x: 1, y: 2 } } })
    expect(outputsOf('hello')).toEqual([{ kind: 'text', text: 'hello' }])
    expect(outputsOf(42)).toEqual([{ kind: 'value', value: 42 }])
    expect(() => outputsOf({ plot: { data: [] } })).toThrow()
  })
})

describe('warm context', () => {
  it('parses once: the second run is quick, and a run cannot change the data or leave logs for the next', async () => {
    const sb = new Sandbox()
    await sb.load('warm', JSON.stringify(snapshot()))
    const a = await sb.run(`log('first'); try { ds.entities[0].label = 'mutated' } catch {} ; return ds.entities[0].id`)
    expect(a.error).toBeUndefined()
    expect(a.logs).toEqual(['first'])
    // A collection's sort returns a copy (the same in Python), so it neither throws nor changes the dataset.
    const sorted = await sb.run(`return ds.entities.sort((x, y) => (x.id < y.id ? 1 : -1))[0].id`)
    expect(sorted.error).toBeUndefined()
    expect(sorted.value).toBe('e99')
    expect((await sb.run(`ds.entities.push({})`)).error?.message).toMatch(/read-only/)
    const b = await sb.run(`return { first: ds.entities[0].id, label: ds.entities[0].label, logs: typeof __logs }`)
    expect(b.error).toBeUndefined()
    expect(b.logs).toEqual([])
    expect((b.value as { first: string; label: string }).first).toBe('e0') // the in-place sort did not stick
    expect((b.value as { label: string }).label).toBe('E 0')
    expect(b.ms.load).toBeLessThan(a.ms.load + 1)
    // A timed-out run poisons the context; the next run gets a fresh one and works.
    const c = await sb.run('while (true) {}', { timeoutMs: 200 })
    expect(c.error?.message).toMatch(/interrupt/i)
    const d = await sb.run('return ds.entities.length')
    expect(d.value).toBe(300)
  })
})
