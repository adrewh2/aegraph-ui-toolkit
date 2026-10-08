import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SCRIPT_API } from '../../features/scripts/api'
import { outputsOf } from '../outputs'
import { Sandbox } from '../sandbox'
import type { Snapshot } from '../types'

/**
 * The sandbox at its edges, on a snapshot of a dozen entities so the runs
 * stay light beside the memory-cap test: every global the API text names
 * exists in the sandbox and every global the prelude defines is in the API
 * text; scripts returning undefined, a promise, a function, a huge array,
 * a cyclic object, a Date, a Set, nested Maps; logs of every shape beside
 * the result; throws of a string, a number, an object, null; ids with
 * spaces, quotes, backslashes and emoji through every helper; a syntax
 * error and a top-level await; outputs of mixed and odd shapes.
 */
function snapshot(): Snapshot {
  const ids = ['plain', 'with space', 'quo"te', "apos'trophe", 'back\\slash', 'ünï', '🎉', 'a:::b', '<tag>', 'x\ny']
  const entities = ids.map((id, i) => ({ id, type: i % 2 ? 'odd' : 'even', label: `L ${id}`, tags: i % 3 ? [] : ['t'], data: { n: i, when: `2025-0${1 + (i % 9)}-15T00:00:00Z` }, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' }))
  const relationships = ids.slice(1).map((id, i) => ({ id: `r${i}`, type: 'to', source: ids[i], target: id, directed: true, data: {} }))
  return { scope: { label: 'edges' }, entities, relationships, metrics: { pagerank: { '🎉': 0.5, 'with space': 0.25 } } }
}

const sb = new Sandbox()
const load = () => sb.load('edges', JSON.stringify(snapshot()))

describe('prelude ↔ api pairing', () => {
  const preludeSource = readFileSync(fileURLToPath(new URL('../prelude.js', import.meta.url)), 'utf8')
  /** Globals the prelude defines at its top level (not the helpers hung on `ds`, tested below). */
  const defined = [...preludeSource.matchAll(/^(?:const|function|let) (\w+)/gm)].map((m) => m[1]).filter((n) => !n.startsWith('__') && n !== 'DAY' && n !== 'AGG' && n !== 'keyOf')
  const dsMethods = [...preludeSource.matchAll(/^\s*ds\.(\w+) = /gm)].map((m) => m[1])

  it('every global the prelude defines is named in the API text, and every name the text gives is a function in the sandbox', async () => {
    expect(defined.length).toBeGreaterThan(30)
    for (const name of defined) expect(SCRIPT_API, name).toMatch(new RegExp(`\\b${name}\\b`))
    for (const m of dsMethods) expect(SCRIPT_API, `ds.${m}`).toContain(`ds.${m}`)
    await load()
    const r = await sb.run(`return { globals: ${JSON.stringify(defined)}.map((n) => typeof globalThis[n] === 'undefined' ? typeof eval(n) : typeof globalThis[n]), ds: ${JSON.stringify(dsMethods)}.map((m) => typeof ds[m]) }`)
    expect(r.error).toBeUndefined()
    const v = r.value as { globals: string[]; ds: string[] }
    expect(v.globals.filter((t) => t === 'undefined')).toEqual([])
    // Every ds.<name> is a function, except the two collections the prelude hangs on it.
    expect(dsMethods.filter((_, i) => v.ds[i] !== 'function')).toEqual(['entities', 'relationships'])
    // The names the text spells as calls exist too.
    const named = [...new Set([...SCRIPT_API.matchAll(/(?<![\w.])([a-z][A-Za-z]+)\(/g)].map((m) => m[1]))].filter((n) => !['ds', 'e', 'r', 'fn', 'print', 'result', 'e', 'return'].includes(n))
    const t = await sb.run(`return ${JSON.stringify(named)}.map((n) => [n, typeof eval(n)])`)
    expect((t.value as [string, string][]).filter(([, type]) => type !== 'function')).toEqual([])
  })
})

describe('sandbox edges', () => {
  it('serialises what a script returns: nothing as null, a function as null, a Date as ISO, a Set as a list, nested Maps, a huge array whole; a cyclic object is an error the next run survives', async () => {
    await load()
    expect((await sb.run('')).value).toBeNull()
    expect((await sb.run('return')).value).toBeNull()
    expect((await sb.run('return () => 1')).value).toBeNull()
    expect((await sb.run('return [undefined, () => 1, Symbol("s")]')).value).toEqual([null, null, null])
    expect((await sb.run('return new Date(0)')).value).toBe('1970-01-01T00:00:00.000Z')
    expect((await sb.run('return { s: new Set([1, 1, 2]), m: new Map([["k", new Map([["d", NaN]])]]), inf: -Infinity, big: 2 ** 53 }')).value).toEqual({ s: [1, 2], m: { k: { d: null } }, inf: null, big: 9007199254740992 })
    const huge = await sb.run('return new Array(200000).fill(0).map((_, i) => i)')
    expect((huge.value as number[]).length).toBe(200000)
    expect((huge.value as number[])[199999]).toBe(199999)
    const cyc = await sb.run('const a = { name: "a" }; a.self = a; return a')
    expect(cyc.error?.message).toMatch(/circular/i)
    expect(cyc.value).toBeUndefined()
    expect((await sb.run('return ds.count()')).value).toBe(10)
  })

  it('a returned promise is an error saying scripts are synchronous, and a top-level await is a syntax error', async () => {
    await load()
    const p = await sb.run('return Promise.resolve(1)')
    expect(p.error?.message).toMatch(/synchronous/)
    const a = await sb.run('const x = await 1; return x')
    expect(a.error?.message).toMatch(/await|SyntaxError|unexpected|expecting/i)
    const s = await sb.run('return {')
    expect(s.error?.message).toMatch(/SyntaxError|unexpected|expecting/i)
    expect((await sb.run('return 1')).value).toBe(1)
  })

  it('logs keep their order beside the result, objects as JSON, undefined and NaN as null, and are empty for a script that only returns', async () => {
    await load()
    const r = await sb.run(`log('a'); log({ x: 1 }, 'b', [1, 'c']); log(undefined, NaN, null); log(); log(new Map([['m', 1]])); return 'done'`)
    expect(r.error).toBeUndefined()
    expect(r.logs).toEqual(['a', '{"x":1} b [1,"c"]', 'null null null', '', '{"m":1}'])
    expect(r.value).toBe('done')
    expect((await sb.run('return 2')).logs).toEqual([])
    // Logs written before an error come back with it.
    const e = await sb.run(`log('before'); throw new Error('after')`)
    expect(e.logs).toEqual(['before'])
    expect(e.error?.message).toBe('after')
  })

  it('a throw of a string, a number, an object, null or a nested error reads as that, with a stack only for errors', async () => {
    await load()
    expect((await sb.run(`throw 'oops'`)).error).toEqual({ message: 'oops', stack: undefined })
    expect((await sb.run(`throw 42`)).error?.message).toBe('42')
    expect((await sb.run(`throw null`)).error?.message).toBe('null')
    expect((await sb.run(`throw { code: 7, why: 'x' }`)).error?.message).toBe('{"code":7,"why":"x"}')
    const e = await sb.run(`function inner() { throw new TypeError('bad type') }\ninner()`)
    expect(e.error?.message).toBe('bad type')
    expect(e.error?.stack).toMatch(/inner/)
    // The wrapper is sloppy-mode JavaScript: a plain write into the frozen dataset is silently ignored (a sort or push
    // still throws), so the data is unchanged for the next run and no "read-only" message appears. Noted, not changed:
    // 'use strict' would report it but also break scripts that assign undeclared names.
    const silent = await sb.run(`ds.get('plain').data.n = 5; return ds.get('plain').data.n`)
    expect(silent.error).toBeUndefined()
    expect(silent.value).toBe(0)
    expect((await sb.run(`ds.entities.push({})`)).error?.message).toMatch(/read-only|not extensible/)
  })

  it('ids with spaces, quotes, backslashes, emoji, colons and newlines go through every helper and come back intact', async () => {
    await load()
    const r = await sb.run(`
      const ids = ds.entities.map((e) => e.id)
      return {
        ids,
        got: ids.map((id) => ds.get(id)?.id === id),
        outs: ids.map((id) => ds.out(id).length),
        neighbours: ds.neighbors('🎉').map((e) => e.id),
        degree: ds.degree('with space'),
        pr: [ds.metric('pagerank', '🎉'), ds.metric('pagerank', 'with space'), ds.metric('pagerank', 'plain'), ds.metric('nope', '🎉')],
        tagged: ds.tagged('t').map((e) => e.id),
        types: ds.types(),
        odd: ds.byType('odd', 'nope').length,
        grouped: [...groupBy(ds.entities, 'type').keys()],
        top: topK(ds.entities, (e) => e.data.n, 2).map((e) => e.id),
        table: table(ds.entities.slice(0, 2).map((e) => ({ id: e.id, n: e.data.n }))),
      }
    `)
    expect(r.error).toBeUndefined()
    const v = r.value as Record<string, unknown>
    expect(v.ids).toEqual(['plain', 'with space', 'quo"te', "apos'trophe", 'back\\slash', 'ünï', '🎉', 'a:::b', '<tag>', 'x\ny'])
    expect(v.got).toEqual(new Array(10).fill(true))
    expect(v.outs).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0])
    expect(v.neighbours).toEqual(['a:::b', 'ünï'])
    expect(v.degree).toBe(2)
    expect(v.pr).toEqual([0.5, 0.25, null, null])
    expect(v.tagged).toEqual(['plain', "apos'trophe", '🎉', 'x\ny'])
    expect(v.types).toEqual(['even', 'odd'])
    expect(v.odd).toBe(5)
    expect(v.grouped).toEqual(['even', 'odd'])
    expect(v.top).toEqual(['x\ny', '<tag>'])
    expect(outputsOf(v.table)[0]).toEqual({ kind: 'table', columns: ['id', 'n'], rows: [['plain', 0], ['with space', 1]] })
  })

  it('reads mixed outputs from one object, ignores shapes it does not know, caps table rows, and treats an empty object as a value', () => {
    const outs = outputsOf({ plot: { data: [{ x: [1] }, 'junk'], layout: 'not an object' }, table: { rows: [[1], 2, [3]] }, text: 'hi', image: { png: 'AAAA' }, scene: { positions: {}, groups: { g: { members: [1, 2], title: 3 } }, scale: 'big' }, extra: true })
    expect(outs.map((o) => o.kind)).toEqual(['figure', 'table', 'scene', 'text', 'image'])
    expect(outs[0]).toEqual({ kind: 'figure', data: [{ x: [1] }], layout: {} })
    expect(outs[1]).toEqual({ kind: 'table', columns: ['c1'], rows: [[1], [2], [3]] })
    expect(outs[2]).toEqual({ kind: 'scene', label: undefined, positions: {}, groups: { g: { title: undefined, members: ['1', '2'] } }, scale: undefined })
    expect(outputsOf({ table: { rows: Array.from({ length: 6000 }, (_, i) => [i]) } })[0]).toMatchObject({ rows: expect.any(Array) })
    expect((outputsOf({ table: { rows: Array.from({ length: 6000 }, (_, i) => [i]) } })[0] as { rows: unknown[] }).rows).toHaveLength(5000)
    expect(outputsOf({})).toEqual([{ kind: 'value', value: {} }])
    expect(outputsOf({ text: 42 })).toEqual([{ kind: 'value', value: { text: 42 } }])
    expect(outputsOf([1, 2])).toEqual([{ kind: 'value', value: [1, 2] }])
    expect(outputsOf(false)).toEqual([{ kind: 'value', value: false }])
    expect(outputsOf('')).toEqual([{ kind: 'text', text: '' }])
    expect(() => outputsOf({ scene: { label: 'no positions' } })).toThrow(/positions/)
    expect(() => outputsOf({ figure: { data: 'x' } })).toThrow(/traces/)
  })
})
