import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { describe, expect, it, vi } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/resources/types'
import { createDiagram } from '../../diagrams/diagrams'
import { createMoreTools } from '../moreTools'
import { withInputChecks } from '../validate'
import type { AppHost } from '../tools'

/**
 * view_diagram with the renderer stood in for (Graphviz and Mermaid need
 * a browser; render.ts is covered by the smoke suite): the parse summary,
 * the source on request, the picture as an image block, and the two
 * ways a render can come back empty — an error, or nothing to draw.
 */
vi.mock('../../diagrams/render', () => ({
  layoutEngine: () => 'dot',
  extractGeometry: async () => undefined,
  renderDiagram: async (source: string) => {
    if (source.includes('BOOM')) throw new Error('layout failed')
    if (source.trim() === 'digraph {}') return ''
    return '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
  },
  svgToPng: async (_svg: string, scale: number) => `data:image/png;base64,PNG${scale}`,
}))

function setup() {
  const store = new EntityStore()
  const host: AppHost = { store, navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => true }
  const t = withInputChecks(createMoreTools(host).find((x) => x.name === 'view_diagram') as BetaRunnableTool)
  const run = async (input: unknown) => t.run(t.parse(input))
  return { store, run }
}

describe('view_diagram', () => {
  it('describes the diagram and returns its picture, the source only when asked', async () => {
    const { store, run } = setup()
    const d = createDiagram(store, { label: 'Flow', source: 'digraph { a -> b [label="knows"]; b -> c }' })
    const blocks = (await run({ id: d.id })) as { type: string; text?: string; source?: { media_type: string; data: string } }[]
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image'])
    const head = JSON.parse(blocks[0].text!)
    expect(head).toMatchObject({ id: d.id, label: 'Flow', format: 'dot', nodes: 3, edges: 2 })
    expect(head.source).toBeUndefined()
    expect(blocks[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'PNG2' })
    const scaled = (await run({ id: d.id, source: true, scale: 3 })) as { text?: string; source?: { data: string } }[]
    expect(JSON.parse(scaled[0].text!).source).toContain('a -> b')
    expect(scaled[1].source?.data).toBe('PNG3')
  })

  it('reports a render that fails or draws nothing, and refuses what is not a diagram', async () => {
    const { store, run } = setup()
    const broken = createDiagram(store, { label: 'Broken', source: 'digraph { BOOM }' })
    expect(JSON.parse(String(await run({ id: broken.id })))).toMatchObject({ id: broken.id, renderError: 'layout failed' })
    const empty = createDiagram(store, { label: 'Empty', source: 'digraph {}' })
    expect(JSON.parse(String(await run({ id: empty.id })))).toMatchObject({ id: empty.id, nodes: 0, note: expect.stringMatching(/Nothing to draw/) })
    store.upsert(createEntity({ id: 'n1', type: 'note', label: 'N', data: {} }))
    await expect(run({ id: 'n1' })).rejects.toThrow(/not a diagram/)
    await expect(run({ id: 'ghost' })).rejects.toThrow(/ghost/)
    await expect(run({ id: broken.id, scale: 9 })).rejects.toThrow(/scale/)
  })
})
