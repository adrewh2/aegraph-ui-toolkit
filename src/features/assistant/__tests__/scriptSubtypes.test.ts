import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { emptyFilter } from '../../../core/graph/filter'
import { setExplorerHandle, type ExplorerHandle } from '../../graph/explorerHandle'
import { createConstraintTools } from '../constraintTools'
import { createGraphTools } from '../graphTools'
import { createScriptTools } from '../scriptTools'
import type { AppHost } from '../tools'

/**
 * Script kinds over the tools: `script` saves with a kind (or reads one off
 * what the code returns), lists and applies by kind; `graph_filter {script}`
 * runs a filter script; `constraint {rule: {script}}` makes it a constraint
 * script. The sandbox is stood in for: what a script returns is spelled in
 * its code.
 */
vi.mock('../../scripts/runner', () => ({
  runScript: async (_store: unknown, _registry: unknown, code: string) => {
    const ms = { load: 0, run: 1, snapshot: 0 }
    if (code.includes('IDS')) return { value: ['p1', 'p2', 'nope'], logs: [], ms }
    if (code.includes('SCENE')) return { value: { scene: { positions: { p1: { x: 10, y: 20 }, p2: { x: 30, y: 40 } } } }, logs: [], ms }
    if (code.includes('VERDICT')) return { value: [{ id: 'p1', message: 'flagged' }], logs: [], ms }
    if (code.includes('STYLE')) return { value: { style: { nodes: { p1: { color: '#ff0000', size: 20 }, p2: { shape: 'square' } }, edges: {}, legend: { title: 'Kind', items: [{ label: 'Hot', color: '#ff0000' }] } } }, logs: [], ms }
    if (code.includes('LAYOUT')) return { value: { layout: { positions: { p1: { x: 1, y: 2 }, p2: { x: 3, y: 4 } }, label: 'row' } }, logs: [], ms }
    if (code.includes('THROW')) return { value: undefined, logs: [], error: { message: 'boom' }, ms }
    return { value: 'text', logs: [], ms }
  },
}))

function setup() {
  const store = new EntityStore()
  store.upsertMany([createEntity({ id: 'p1', type: 'person', label: 'Ada' }), createEntity({ id: 'p2', type: 'person', label: 'Bob' }), createEntity({ id: 'p3', type: 'person', label: 'Cy' })])
  const navigated: string[] = []
  const host: AppHost = { store, navigate: (to) => navigated.push(to), getContext: () => ({ route: '/' }), confirm: async () => true }
  const tools = [...createScriptTools(host), ...createGraphTools(host), ...createConstraintTools(host)]
  const call = (name: string) => {
    const t = tools.find((x) => x.name === name) as BetaRunnableTool
    return async (input: unknown) => JSON.parse(String(await t.run(t.parse(input))))
  }
  return { store, navigated, script: call('script'), graphFilter: call('graph_filter'), constraint: call('constraint') }
}

/** Enough of a mounted explorer for graph_filter: the filter it holds and what it is told to show. */
function fakeExplorer() {
  const st = { filter: emptyFilter(), viewBudget: { nodes: 3000, edges: 15000 } } as ReturnType<ExplorerHandle['getState']>
  const h = {
    dims: 2 as const,
    renderer: '2d' as const,
    getState: () => st,
    setFilter: (f: typeof st.filter) => {
      st.filter = f
    },
    clearFilter: () => {
      st.filter = emptyFilter()
    },
    switchMode: () => {},
    setViewBudget: () => {},
    acceptLoad: () => {},
  } as unknown as ExplorerHandle
  return { h, st }
}

describe('script kinds over the tools', () => {
  afterEach(() => setExplorerHandle(null))

  it('save takes a kind, or reads one off what the code returns; list and get say the kind', async () => {
    const { store, script } = setup()
    const plain = await script({ action: 'save', open: false, code: 'return "text"', name: 'plain' })
    expect([plain.type, plain.kind]).toEqual(['script', undefined])
    const filter = await script({ action: 'save', open: false, code: '// IDS', name: 'people' })
    expect([filter.type, filter.kind]).toEqual(['script:filter', 'filter'])
    const chosen = await script({ action: 'save', open: false, code: '// IDS', name: 'chosen', kind: 'scene' })
    expect(chosen.type).toBe('script:scene')
    // A kind chosen stays through a save that says nothing; "none" takes it away.
    expect((await script({ action: 'save', id: chosen.id, code: '// IDS again' })).type).toBe('script:scene')
    expect((await script({ action: 'save', id: chosen.id, kind: 'none' })).type).toBe('script')
    const list = await script({ action: 'list' })
    expect(list.kinds.map((k: { kind: string; type: string }) => [k.kind, k.type])).toEqual([
      ['filter', 'script:filter'],
      ['constraint', 'script:constraint'],
      ['scene', 'script:scene'],
      ['layout', 'script:layout'],
      ['style', 'script:style'],
    ])
    expect(list.scripts.map((s: { label: string; kind?: string }) => [s.label, s.kind])).toEqual([
      ['plain', undefined],
      ['chosen', undefined],
      ['people', 'filter'],
    ])
    expect((await script({ action: 'get', id: filter.id })).kind).toBe('filter')
    expect(store.get(filter.id)?.type).toBe('script:filter')
  })

  it('save opens a new script on the Scripts page, not an update to one, and not with open: false', async () => {
    const { navigated, script } = setup()
    const s = await script({ action: 'save', code: 'return "text"', name: 'shown' })
    expect(navigated).toEqual([`/scripts?script=${s.id}`])
    await script({ action: 'save', id: s.id, name: 'renamed' })
    await script({ action: 'save', open: false, code: 'return 1', name: 'quiet' })
    expect(navigated).toHaveLength(1)
  })

  it('apply as a filter runs the script and opens the explorer on what it returned', async () => {
    const { navigated, script } = setup()
    const s = await script({ action: 'save', open: false, code: '// IDS', name: 'people', kind: 'none' })
    expect(s.type).toBe('script')
    const r = await script({ action: 'apply', id: s.id, kind: 'filter' })
    expect(r).toMatchObject({ applied: 'filter', kept: 2, ids: ['p1', 'p2'], script: { kind: 'filter', type: 'script:filter' } })
    expect(navigated[0]).toMatch(/^\/graph\/2d\?only=/)
    // A script that has a kind needs none passed; one without cannot be applied blind.
    expect((await script({ action: 'apply', id: s.id })).applied).toBe('filter')
    const plain = await script({ action: 'save', open: false, code: 'return "text"', name: 'plain' })
    await expect(script({ action: 'apply', id: plain.id })).rejects.toThrow(/no kind yet/)
    const broken = await script({ action: 'save', open: false, code: '// THROW', name: 'broken', kind: 'filter' })
    expect(await script({ action: 'apply', id: broken.id })).toMatchObject({ applied: false, error: 'boom' })
    const empty = await script({ action: 'save', open: false, code: 'return "text"', name: 'empty', kind: 'filter' })
    expect((await script({ action: 'apply', id: empty.id })).error).toMatch(/names entities/)
  })

  it('graph_filter {script} keeps just what the script returned and remembers it; only: [] lifts it', async () => {
    const { store, script, graphFilter } = setup()
    const { h, st } = fakeExplorer()
    setExplorerHandle(h)
    const s = await script({ action: 'save', open: false, code: '// IDS', name: 'people', kind: 'none' })
    const r = await graphFilter({ script: s.id })
    expect(r).toMatchObject({ filter: 'just 2 by script', nodes: 2, script: { id: s.id, returned: 2 } })
    expect(st.filter.only).toEqual(['p1', 'p2'])
    expect(st.filter.script).toBe(s.id)
    // Applied as a filter, the script is a filter script.
    expect(store.get(s.id)?.type).toBe('script:filter')
    const lifted = await graphFilter({ only: [] })
    expect(lifted).toMatchObject({ filter: 'Everything', nodes: 3 })
    expect(st.filter.script).toBeUndefined()
    const broken = await script({ action: 'save', open: false, code: '// THROW', name: 'broken' })
    await expect(graphFilter({ script: broken.id })).rejects.toThrow(/filter script failed: boom/)
    await expect(graphFilter({ script: 'nope' })).rejects.toThrow(/No script/)
  })

  it('apply as a constraint defines one judged by the script; constraint {rule: {script}} marks it too', async () => {
    const { store, script, constraint } = setup()
    const s = await script({ action: 'save', open: false, code: '// VERDICT', name: 'authors' })
    expect(s.kind).toBe('constraint')
    const r = await script({ action: 'apply', id: s.id, name: 'every paper has an author' })
    expect(r).toMatchObject({ applied: 'constraint', constraint: { label: 'every paper has an author' } })
    expect(store.get(r.constraint.id)?.data.rule).toEqual({ script: s.id })
    const other = await script({ action: 'save', open: false, code: 'return "text"', name: 'other' })
    expect(other.type).toBe('script')
    await constraint({ action: 'define', label: 'by other', scope: 'graph', rule: { script: other.id } })
    expect(store.get(other.id)?.type).toBe('script:constraint')
  })

  it('apply as a scene saves the scene the script returned and opens it', async () => {
    const { store, navigated, script } = setup()
    const s = await script({ action: 'save', open: false, code: '// SCENE', name: 'ring' })
    expect(s.kind).toBe('scene')
    const r = await script({ action: 'apply', id: s.id })
    expect(r).toMatchObject({ applied: 'scene', scene: { label: 'ring', placed: 2, updated: false } })
    expect(navigated).toEqual([`/scenes?id=${encodeURIComponent(r.scene.id)}`])
    // A scene a script made is a scene:script that remembers it.
    expect(store.get(r.scene.id)?.type).toBe('scene:script')
    expect((store.get(r.scene.id)?.data as { source?: { scriptId?: string } }).source?.scriptId).toBe(s.id)
    expect((await script({ action: 'apply', id: s.id })).scene).toMatchObject({ id: r.scene.id, updated: true })
    const text = await script({ action: 'save', open: false, code: 'return "text"', name: 'text', kind: 'scene' })
    await expect(script({ action: 'apply', id: text.id })).rejects.toThrow(/returned no scene/)
  })

  it('apply as a style saves the script\'s rendering — overlay, legend, source — and opens the explorer with it', async () => {
    const { store, navigated, script } = setup()
    const s = await script({ action: 'save', open: false, code: '// STYLE', name: 'hot ones' })
    expect(s.kind).toBe('style')
    const r = await script({ action: 'apply', id: s.id })
    expect(r).toMatchObject({ applied: 'style', rendering: { label: 'hot ones', updated: false }, nodes: 2, edges: 0, legend: 'Kind' })
    expect(navigated).toEqual([`/unigraph/2d?style=${encodeURIComponent(r.rendering.id)}`])
    const e = store.get(r.rendering.id)!
    expect(e.type).toBe('rendering')
    const overlay = (e.data as { overlay?: { nodes?: Record<string, unknown>; source?: { scriptId?: string } } }).overlay
    expect(overlay?.nodes).toEqual({ p1: { color: '#ff0000', size: 20 }, p2: { shape: 'square' } })
    expect(overlay?.source?.scriptId).toBe(s.id)
    expect((await script({ action: 'apply', id: s.id })).rendering).toMatchObject({ id: r.rendering.id, updated: true })
    expect(store.ofType('rendering').length).toBe(1)
    const text = await script({ action: 'save', open: false, code: 'return "text"', name: 'text', kind: 'style' })
    await expect(script({ action: 'apply', id: text.id })).rejects.toThrow(/returned no style/)
  })

  it('apply as a layout saves the script\'s layout and opens the explorer holding it', async () => {
    const { store, navigated, script } = setup()
    const s = await script({ action: 'save', open: false, code: '// LAYOUT', name: 'rows' })
    expect(s.kind).toBe('layout')
    const r = await script({ action: 'apply', id: s.id })
    expect(r).toMatchObject({ applied: 'layout', layout: { label: 'row', placed: 2, dimensions: 2, updated: false } })
    expect(navigated).toEqual([`/unigraph/2d?layout=${encodeURIComponent(r.layout.id)}`])
    const d = store.get(r.layout.id)!.data as { algorithm?: string; positions?: Record<string, unknown>; source?: { scriptId?: string } }
    expect(d.algorithm).toBe('script')
    expect(d.positions).toEqual({ p1: { x: 1, y: 2 }, p2: { x: 3, y: 4 } })
    expect(d.source?.scriptId).toBe(s.id)
    // A scene script's positions serve as a layout when asked for one.
    const scene = await script({ action: 'save', open: false, code: '// SCENE', name: 'ring' })
    expect((await script({ action: 'apply', id: scene.id, kind: 'layout' })).layout).toMatchObject({ placed: 2 })
  })

  it('a locked script refuses save, edit and delete until it is unlocked; list and get say so', async () => {
    const { store, script } = setup()
    const s = await script({ action: 'save', open: false, code: 'return "text"', name: 'shipped', locked: true })
    expect(s.locked).toBe(true)
    await expect(script({ action: 'save', id: s.id, code: 'return 2' })).rejects.toThrow(/locked/)
    await expect(script({ action: 'edit', id: s.id, find: 'text', replace: 'x' })).rejects.toThrow(/locked/)
    await expect(script({ action: 'delete', id: s.id })).rejects.toThrow(/locked/)
    expect(store.get(s.id)?.data.code).toBe('return "text"')
    expect((await script({ action: 'list' })).scripts.find((x: { id: string }) => x.id === s.id).locked).toBe(true)
    // A copy under a new name is always allowed; unlocking with a change applies both.
    const copy = await script({ action: 'save', open: false, code: 'return 2', name: 'shipped copy' })
    expect(copy.locked).toBeUndefined()
    const u = await script({ action: 'save', id: s.id, locked: false, code: 'return 3' })
    expect([u.locked, store.get(s.id)?.data.code]).toEqual([undefined, 'return 3'])
    expect((await script({ action: 'get', id: s.id })).locked).toBeUndefined()
    expect((await script({ action: 'delete', id: s.id })).deleted).toBe(true)
  })
})
