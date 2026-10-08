import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import { isTemplateDocument } from '../../../core/projects/template'
import { openBundleText } from '../projectActions'
import '../../../core/graph/types'
import '../../../core/resources/types'
import '../../conversations/conversation'

/**
 * The atlas pipeline writes one file — an aegraph/v1 project bundle whose
 * project names the `conversation-atlas` template — and the app opens it
 * as a project with the template's pictures in place. The fixture is a
 * synthetic two-conversation corpus run through the pipeline's export
 * (tests/test_pipeline.py::_corpus there), and the template is the one
 * the app ships.
 */
const fixture = readFileSync(resolve(__dirname, 'fixtures/atlas-sample.ae.json'), 'utf8')
const template = JSON.parse(readFileSync(resolve(__dirname, '../../../../public/templates/conversation-atlas.template.ae.json'), 'utf8'))

describe('a pipeline bundle', () => {
  const mem: Record<string, string> = {}
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k], clear: () => Object.keys(mem).forEach((k) => delete mem[k]) })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/templates/conversation-atlas.template.ae.json') ? new Response(JSON.stringify(template)) : new Response('', { status: 404 }))))
  })

  it('opens as a project with the template applied once, the conversations linked to their segments, and the map placed', async () => {
    expect(isTemplateDocument(template)).toBe(true)
    const store = new EntityStore()
    const report = await openBundleText(store, fixture, 'atlas')
    expect(report.project).toMatchObject({ id: 'project:conversation-atlas', label: 'Conversation Atlas', data: { template: 'conversation-atlas' } })
    expect(store.scope).toBe('project:conversation-atlas')
    const ofType = (t: string) => store.ofType(t).filter((e) => e.kind === 'entity')
    expect(ofType('segment')).toHaveLength(3)
    expect(ofType('conversation')).toHaveLength(2)
    expect(ofType('plot')).toHaveLength(14)
    expect(ofType('script')).toHaveLength(8)
    expect(ofType('scene')).toHaveLength(4)
    expect(store.get('type:segment')?.type).toBe('schema:type')
    const c1 = store.get('chatgpt-c1')!
    expect((c1.data.messages as unknown[]).length).toBe(4)
    expect((c1.data.atlas as { segments: unknown[] }).segments).toHaveLength(2)
    expect(c1.tags).toContain('topic:graphs')
    expect(store.relationshipsOf('chatgpt-c1', 'in').map((r) => r.type).sort()).toEqual(['segment-of', 'segment-of'])
    expect(store.relationshipsOf('chatgpt-c1', 'out').find((r) => r.type === 'on-topic')?.data).toEqual({ weight: 2, via: 'segments' })
    expect(store.get('layout:conversation-atlas-map')?.data.positions).toHaveProperty('segment:c2')
    expect(store.getTagInfo('region:code').color).toBe('#7aa2f7')
    expect(report.route ?? '').toBe('')
    // The same bundle again: data updated in place, nothing doubled, the template left as it is.
    const again = await openBundleText(store, fixture, 'atlas')
    expect(again.project.id).toBe('project:conversation-atlas')
    expect(ofType('plot')).toHaveLength(14)
    expect(ofType('segment')).toHaveLength(3)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('opens a bundle that names no template, or one the app does not ship, as a plain project', async () => {
    const store = new EntityStore()
    const doc = JSON.parse(fixture)
    doc.entities.find((e: { id: string }) => e.id === 'project:conversation-atlas').data.template = 'nope'
    const r = await openBundleText(store, JSON.stringify(doc), 'atlas')
    expect(r.project.id).toBe('project:conversation-atlas')
    expect(store.ofType('plot')).toHaveLength(0)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })
})
