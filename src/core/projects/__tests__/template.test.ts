import { describe, expect, it } from 'vitest'
import { createEntity } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { createProject } from '../project'
import { applyTemplate, isTemplateDocument, templateEntityId, type TemplateDocument } from '../template'

const tpl = (): TemplateDocument => ({
  $schema: 'aegraph/v1',
  exportedAt: '2026-09-15T00:00:00.000Z',
  template: { id: 't', label: 'T', requires: ['segment'], adopts: ['segment', 'topic'], home: '/analytics' },
  entities: [
    createEntity({ id: 'tpl:t:chart-a', type: 'plot', label: 'A', data: { spec: { selector: { types: ['segment'] }, traces: [{ kind: 'bar', x: 'data.created', bin: 'month' }] } } }),
    createEntity({ id: 'tpl:t:filter-s', type: 'filter', label: 'S · filter', data: { types: ['segment'] } }),
    createEntity({ id: 'tpl:t:scene-s', type: 'scene', label: 'S', data: { renderer: '2d', filterId: 'tpl:t:filter-s' } }),
  ],
  state: { route: '/analytics', ui: { 'aegraph:analytics:v1': JSON.stringify({ ws: { root: { kind: 'pane', id: 'p', active: 0, tabs: [{ id: 't0', path: '/analytics/charts?plot=tpl:t:chart-a', back: [], forward: [] }] }, focused: 'p' } }) } },
})

describe('project templates', () => {
  it('recognises a template document', () => {
    expect(isTemplateDocument(tpl())).toBe(true)
    expect(isTemplateDocument({ $schema: 'aegraph/v1', entities: [] })).toBe(false)
  })

  it('applies to a project: ids rewritten everywhere, marks set, home taken, requirements checked; applying again updates', () => {
    const store = new EntityStore()
    const p = createProject({ id: 'proj', label: 'P' })
    store.upsert(p)
    store.upsert(createEntity({ id: 's1', type: 'segment', label: 's', data: { created: '2025-01-01' }, meta: { projects: ['proj'] } }))
    const r = applyTemplate(store, tpl(), 'proj')
    expect(r.created).toBe(3)
    expect(r.missing).toEqual([])
    expect(r.route).toBe('/analytics')
    const scene = store.get(templateEntityId('proj', 'tpl:t:scene-s'))!
    expect(scene.data.filterId).toBe('proj:tpl:t:filter-s')
    expect(scene.meta.projects).toEqual(['proj'])
    expect(scene.meta.source).toBe('template:t')
    expect(store.get('proj')!.data.template).toBe('t')
    expect((store.get('proj')!.data.home as { route: string }).route).toBe('/analytics')
    const again = applyTemplate(store, tpl(), 'proj')
    expect(again.created).toBe(0)
    expect(again.updated).toBe(3)
    // Another project without segments gets the pictures and a warning.
    store.upsert(createProject({ id: 'empty', label: 'E' }))
    expect(applyTemplate(store, tpl(), 'empty').missing).toEqual(['segment'])
    expect(store.get('empty:tpl:t:chart-a')).toBeDefined()
  })
})

describe('adopting loose data', () => {
  it('a new project from a template takes the Library’s unmarked entities of its kinds, not those in other projects', () => {
    const store = new EntityStore()
    store.upsert(createProject({ id: 'other', label: 'O' }))
    store.upsert(createEntity({ id: 's1', type: 'segment', label: 'loose' }))
    store.upsert(createEntity({ id: 't1', type: 'topic', label: 'loose topic' }))
    store.upsert(createEntity({ id: 's2', type: 'segment', label: 'theirs', meta: { projects: ['other'] } }))
    store.upsert(createEntity({ id: 'd1', type: 'document', label: 'unrelated' }))
    store.upsert(createProject({ id: 'fresh', label: 'F' }))
    const r = applyTemplate(store, tpl(), 'fresh', { adopt: true })
    expect(r.adopted).toBe(2)
    expect(r.missing).toEqual([])
    expect(store.get('s1')!.meta.projects).toEqual(['fresh'])
    expect(store.get('t1')!.meta.projects).toEqual(['fresh'])
    expect(store.get('s2')!.meta.projects).toEqual(['other'])
    expect(store.get('d1')!.meta.projects ?? []).toEqual([])
  })
})
