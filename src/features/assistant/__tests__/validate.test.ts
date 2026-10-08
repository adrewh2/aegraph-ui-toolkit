import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/graph/types'
import '../../../core/resources/types'
import { createAppTools, type AppHost } from '../tools'
import { BULK_TOOLS, MAX_BULK_ITEMS, MAX_DEPTH, MAX_ITEMS, MAX_STRING, shapeProblem, toolInputProblems, withInputChecks } from '../validate'

/**
 * Tool arguments checked against the tool's own schema before they reach
 * `run` — the SDK's parse is the identity and the bridge forwards what
 * the model sent, so a layout once ran at spacing 0 against a schema
 * minimum of 0.1. Below the minimum, above the maximum, a word not in
 * the enum, the wrong type, a bad array item: refused with a message
 * naming the argument — and a missing required key or a key the tool does
 * not take. Valid input, null, optional keys left out and nested objects:
 * untouched.
 */
const h: AppHost = { store: new EntityStore(), navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => true }
const tools = createAppTools(h)
const t = (name: string) => tools.find((x) => x.name === name) as BetaRunnableTool
const parse = (name: string, input: unknown) => () => t(name).parse(input)

describe('tool input checks', () => {
  it('refuses a number below its minimum or above its maximum, naming the argument and the bound', () => {
    expect(parse('graph_layout', { algorithm: 'concentric-by-degree', spacing: 0 })).toThrow('graph_layout: spacing must be at least 0.1, got 0')
    expect(parse('graph_layout', { spacing: -1, gravity: -2 })).toThrow('spacing must be at least 0.1, got -1; gravity must be at least 0, got -2')
    expect(parse('search_entities', { query: 'x', limit: 0 })).toThrow(/limit must be at least 1/)
    expect(parse('graph_layout', { spacing: 0.1 })).not.toThrow()
  })

  it('refuses a word not in an enum, the wrong type, a non-integer where an integer is due, and a bad array item', () => {
    expect(parse('graph_export', { format: 'bmp' })).toThrow(/graph_export: format must be one of "png", "svg", .*got "bmp"/)
    expect(parse('graph_layout', { direction: 'RL' })).toThrow('direction must be one of "TB", "LR", got "RL"')
    expect(parse('search_entities', { query: 'x', limit: 'ten' })).toThrow('limit must be a number, got string "ten"')
    expect(parse('search_entities', { query: 'x', limit: 2.5 })).toThrow('limit must be an integer, got 2.5')
    expect(parse('graph_layout', { noverlap: 'yes' })).toThrow('noverlap must be true or false, got string "yes"')
    expect(parse('graph_filter', { types: 'person' })).toThrow('types must be an array, got string "person"')
    expect(parse('graph_filter', { types: ['person', 3] })).toThrow('types[1] must be a string, got number 3')
    expect(parse('graph_layout', { spacing: NaN })).toThrow('spacing must be a number, got number null')
  })

  it('leaves valid, absent and null arguments alone, and does not look inside nested objects', () => {
    expect(parse('graph_layout', { algorithm: 'grid', spacing: 2, direction: 'LR', pin: ['a'] })).not.toThrow()
    expect(parse('graph_layout', {})).not.toThrow()
    expect(parse('graph_layout', { spacing: null })).not.toThrow()
    expect(toolInputProblems({ type: 'object', properties: { a: { type: 'object' } } }, { a: { b: 'anything' } })).toEqual([])
    // Unknown keys pass when the schema allows them; nested objects are never inspected.
    expect(toolInputProblems({ type: 'object', properties: { a: { type: 'number' } } }, { a: 1, extra: true })).toEqual([])
    expect(toolInputProblems({ type: 'object', properties: { a: { type: ['string', 'number'] } } }, { a: true })).toEqual([]) // a type list is not checked
    expect(toolInputProblems(undefined, { a: 1 })).toEqual([])
    expect(toolInputProblems({ type: 'object' }, 'not an object')).toEqual([])
  })

  it('refuses a missing required key, and a key the tool does not take — naming the likely one', () => {
    expect(parse('create_diagram', { title: 'x', source: 'digraph g {}' })).toThrow('create_diagram: label is required; title is not a parameter of this tool (it takes label, source, format, tags, open)')
    expect(parse('graph_layout', { spacing: 1, unknown_key: -99 })).toThrow(/unknown_key is not a parameter of this tool \(it takes /)
    expect(parse('graph_layout', { Algorithm: 'grid' })).toThrow('did you mean algorithm?')
    expect(parse('create_diagram', { label: 'x', source: 'digraph g {}' })).not.toThrow()
    expect(toolInputProblems({ type: 'object', properties: { a: { type: 'number' } }, required: ['a'] }, { a: null })).toEqual(['a is required'])
  })

  it('wraps a tool without touching anything but parse, and every app tool is wrapped', () => {
    const raw = { name: 'x', input_schema: { type: 'object', properties: { n: { type: 'number', maximum: 5 } } }, parse: (i: unknown) => ({ seen: i }), run: async () => 'ok' }
    const w = withInputChecks(raw)
    expect(w.run).toBe(raw.run)
    expect(w.parse({ n: 5 })).toEqual({ seen: { n: 5 } })
    expect(() => w.parse({ n: 6 })).toThrow('x: n must be at most 5, got 6')
    // Every tool is wrapped: one with no required keys accepts {}, one with them says which are missing.
    for (const tool of tools) {
      const required = ((tool as unknown as { input_schema?: { required?: string[] } }).input_schema?.required ?? []).filter((k) => k)
      if (required.length) expect(() => tool.parse({}), tool.name).toThrow(`${required[0]} is required`)
      else expect(() => tool.parse({}), tool.name).not.toThrow()
    }
  })
})

/**
 * Limits of shape under every schema: the input is written by a model that
 * may have read something hostile, or by a driver nobody vetted, and it
 * reaches code that walks and assigns what it is given.
 */
describe('tool input limits', () => {
  it('refuses a prototype key at any depth, even inside a free-form object', () => {
    const bad = JSON.parse('{"action":"define","rule":{"params":{"__proto__":{"polluted":true}}}}')
    expect(shapeProblem(bad)).toMatch(/rule\.params\.__proto__ is not allowed/)
    expect(shapeProblem({ a: [{ constructor: 1 }] })).toMatch(/a\[0\]\.constructor is not allowed/)
    expect(shapeProblem({ a: { prototype: 1 } })).toMatch(/prototype is not allowed/)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses an array past the cap, and lets a bulk tool take a dataset', () => {
    const ids = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `e${i}`)
    expect(shapeProblem({ ids })).toMatch(new RegExp(`ids has ${MAX_ITEMS + 1} items; at most ${MAX_ITEMS}`))
    expect(shapeProblem({ ids }, MAX_BULK_ITEMS)).toBeUndefined()
    expect(BULK_TOOLS.has('delete_entities')).toBe(true)
    expect(() => t('delete_entities').parse({ ids })).not.toThrow(/items; at most/)
  })

  it('refuses a string past the cap and nesting past the depth', () => {
    expect(shapeProblem({ text: 'x'.repeat(MAX_STRING + 1) })).toMatch(/text is longer than/)
    let deep: unknown = 1
    for (let i = 0; i < MAX_DEPTH + 2; i++) deep = { d: deep }
    expect(shapeProblem({ deep })).toMatch(/nested deeper than/)
  })

  it('honours maxItems and maxLength a schema declares', () => {
    const schema = { type: 'object', properties: { pair: { type: 'array', maxItems: 2 }, name: { type: 'string', maxLength: 3 } } }
    expect(toolInputProblems(schema, { pair: [1, 2, 3] })).toEqual(['pair must have at most 2 items, got 3'])
    expect(toolInputProblems(schema, { name: 'abcd' })).toEqual(['name must be at most 3 characters, got 4'])
    expect(toolInputProblems(schema, { pair: [1, 2], name: 'abc' })).toEqual([])
  })

  it('reaches every tool through withInputChecks', () => {
    const tool = withInputChecks({ name: 'x', input_schema: { type: 'object', properties: {} }, parse: (i: unknown) => i })
    expect(() => tool.parse(JSON.parse('{"__proto__":{}}'))).toThrow(/x: __proto__ is not allowed/)
  })
})
