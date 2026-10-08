import { describe, expect, it } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { getEntityType } from '../../../core/entity/schema'
import { EntityStore } from '../../../core/entity/store'
import type { Output } from '../../../scripting/types'
import { idsOfOutputs, isLockedScript, isScript, isVerdictOutput, markScriptUse, saveScript, scriptKindOf, scriptsIn, SCRIPT_FAMILY, SCRIPT_TYPE, subtypeOfOutputs, updateScriptDetails } from '../script'

/**
 * Script subtypes: filter, constraint and scene scripts are child types of
 * `script` (`script:filter`…), taken when a script is saved with a kind or
 * first put to use; a draft or a plain save has none.
 */
describe('script subtypes', () => {
  it('are child types of script in the ontology', () => {
    expect(SCRIPT_FAMILY).toEqual(['script', 'script:filter', 'script:constraint', 'script:scene', 'script:layout', 'script:style'])
    for (const t of SCRIPT_FAMILY.slice(1)) expect(getEntityType(t)?.parent).toBe(SCRIPT_TYPE)
    expect(scriptKindOf('script:filter')).toBe('filter')
    expect(scriptKindOf('script')).toBeUndefined()
  })

  it('a save without a kind is a plain script; a kind retypes it; null makes it plain again', () => {
    const store = new EntityStore()
    const s = saveScript(store, 'return 1', 'one')
    expect(s.type).toBe('script')
    expect(saveScript(store, 'return 1', 'one', s.id, undefined, 'js', undefined, 'filter').type).toBe('script:filter')
    // A later save that says nothing about the kind keeps it.
    expect(saveScript(store, 'return 2', 'one', s.id, undefined, 'js').type).toBe('script:filter')
    expect(saveScript(store, 'return 2', 'one', s.id, undefined, 'js', undefined, null).type).toBe('script')
    expect(isScript(store.get(s.id))).toBe(true)
  })

  it('putting a script to use names its kind once; a kind it has stays', () => {
    const store = new EntityStore()
    const s = saveScript(store, 'return true', 'check')
    expect(markScriptUse(store, s.id, 'constraint')).toBe('constraint')
    expect(store.get(s.id)?.type).toBe('script:constraint')
    expect(markScriptUse(store, s.id, 'filter')).toBe('constraint')
    expect(store.get(s.id)?.type).toBe('script:constraint')
    expect(markScriptUse(store, 'nope', 'filter')).toBeUndefined()
  })

  it('scriptsIn lists every kind and isScript accepts them', () => {
    const store = new EntityStore()
    saveScript(store, 'a', 'a')
    saveScript(store, 'b', 'b', undefined, undefined, 'js', undefined, 'scene')
    store.upsert(createEntity({ id: 'x', type: 'script:filter', label: 'no code', data: {} }))
    expect(scriptsIn(store).map((e) => [e.label, e.type])).toEqual([
      ['a', 'script'],
      ['b', 'script:scene'],
    ])
  })

  it('reads the entities a result names, a verdict, and the kind a result suggests', () => {
    const store = new EntityStore()
    store.upsertMany([createEntity({ id: 'p1', type: 'person', label: 'Ada' }), createEntity({ id: 'p2', type: 'person', label: 'Bob' })])
    const table = (columns: string[], rows: unknown[][]): Output => ({ kind: 'table', columns, rows })
    const value = (v: unknown): Output => ({ kind: 'value', value: v })
    // A collection returned as is draws as a table whose first column is the id; unknown ids do not count.
    expect(idsOfOutputs([table(['id', 'type', 'label'], [['p1', 'person', 'Ada'], ['zz', 'person', 'Zed']])], store)).toEqual(['p1'])
    expect(idsOfOutputs([value(['p2', 'p1', 'p2'])], store)).toEqual(['p2', 'p1'])
    expect(idsOfOutputs([value({ ids: ['p1'] })], store)).toEqual(['p1'])
    expect(idsOfOutputs([value([{ id: 'p1' }])], store)).toEqual(['p1'])
    // A table of violations names entities too, but it is a verdict, not a filter.
    const violations = table(['id', 'message'], [['p1', 'no author']])
    expect(idsOfOutputs([violations], store)).toEqual([])
    expect(isVerdictOutput(violations)).toBe(true)
    expect(isVerdictOutput(value(true))).toBe(true)
    expect(isVerdictOutput(value([{ id: 'p1', message: 'x' }]))).toBe(true)
    expect(isVerdictOutput(value(['p1']))).toBe(false)
    expect(subtypeOfOutputs([{ kind: 'scene', positions: { p1: { x: 0, y: 0 } } }], store)).toBe('scene')
    expect(subtypeOfOutputs([value(false)], store)).toBe('constraint')
    expect(subtypeOfOutputs([value(['p1'])], store)).toBe('filter')
    expect(subtypeOfOutputs([{ kind: 'text', text: 'hi' }], store)).toBeUndefined()
  })

  it('a locked script cannot be saved over, retyped or renamed; the lock itself can go, and details follow', () => {
    const store = new EntityStore()
    const s = saveScript(store, 'return 1', 'shipped')
    updateScriptDetails(store, s.id, { locked: true })
    expect(isLockedScript(store.get(s.id))).toBe(true)
    expect(() => saveScript(store, 'return 2', 'shipped', s.id)).toThrow(/locked/)
    expect(() => updateScriptDetails(store, s.id, { label: 'renamed' })).toThrow(/locked/)
    expect(markScriptUse(store, s.id, 'filter')).toBeUndefined()
    expect(store.get(s.id)?.type).toBe('script')
    // Unlocking and changing details in one go: the unlock comes first.
    const e = updateScriptDetails(store, s.id, { locked: false, label: 'mine', description: 'what it shows', subtype: 'scene' })
    expect([e.label, e.description, e.type, e.data.locked]).toEqual(['mine', 'what it shows', 'script:scene', undefined])
    expect(saveScript(store, 'return 2', 'mine', s.id).data.code).toBe('return 2')
    expect(updateScriptDetails(store, s.id, { description: '', subtype: null }).description).toBeUndefined()
    expect(store.get(s.id)?.type).toBe('script')
  })
})
