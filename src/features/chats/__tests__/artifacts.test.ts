import { describe, expect, it } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import type { TranscriptItem } from '../../assistant/session'
import { artifactRefsOf, idsOfCall, mergeRefs, recordedRefs, resolveArtifacts } from '../artifacts'

const tool = (name: string, input: unknown, result: unknown, startedAt = 1_790_000_000_000, status: 'done' | 'error' | 'running' = 'done'): TranscriptItem => ({ kind: 'tool', id: `t${Math.random()}`, name, input, status, result: typeof result === 'string' ? result : JSON.stringify(result), startedAt })

describe('a chat’s artifacts', () => {
  it('are what writing tools made or changed, never what reading tools looked at', () => {
    expect(idsOfCall('create_document', { title: 'Plan' }, '{"id":"d1","type":"document"}')).toEqual(['d1'])
    expect(idsOfCall('edit_document', { document_id: 'd1', find: 'a', replace: 'b' }, '{"id":"d1"}')).toEqual(['d1'])
    // A place put on a map is the map's: the map is the artifact, not a chip per pin.
    expect(idsOfCall('add_location', { map_id: 'm1', label: 'Oslo' }, '{"id":"p1","lat":59.9,"lng":10.7,"onMap":"m1"}')).toEqual(['m1'])
    expect(idsOfCall('add_path', { map_id: 'm1' }, '{"id":"path1","points":4}')).toEqual(['m1'])
    // A place on no map is its own artifact.
    expect(idsOfCall('add_location', { label: 'Oslo' }, '{"id":"p1","lat":59.9,"lng":10.7}')).toEqual(['p1'])
    expect(idsOfCall('graph_save', { kind: 'scene' }, '{"id":"s1","type":"scene:unigraph"}')).toEqual(['s1'])
    expect(idsOfCall('get_entity', { id: 'e1' }, '{"id":"e1"}')).toEqual([])
    expect(idsOfCall('read_document', { id: 'd1' }, '{"id":"d1"}')).toEqual([])
    expect(idsOfCall('search_entities', { query: 'x' }, '{"results":[{"id":"e1"}]}')).toEqual([])
  })

  it('name what an annotation annotates, not the annotation', () => {
    expect(idsOfCall('annotate_document', { document_id: 'd1', quote: 'q' }, '{"id":"ann1","type":"annotation"}')).toEqual(['d1'])
  })

  it('survive a result that is not JSON', () => {
    expect(idsOfCall('update_entity', { id: 'e1' }, 'Updated.')).toEqual(['e1'])
  })

  it('are kept once each, at their latest touch, and only from calls that finished', () => {
    const refs = artifactRefsOf([
      { kind: 'user', id: 'u', text: 'hi' },
      tool('create_document', {}, { id: 'd1' }, 1000),
      tool('create_diagram', {}, { id: 'g1' }, 2000),
      tool('edit_document', { document_id: 'd1' }, { id: 'd1' }, 3000),
      tool('create_map', {}, { id: 'm1' }, 4000, 'error'),
      tool('create_map', {}, { id: 'm2' }, 5000, 'running'),
    ])
    expect(refs.map((r) => [r.id, r.tool])).toEqual([
      ['g1', 'create_diagram'],
      ['d1', 'edit_document'],
    ])
    expect(refs[1].at).toBe(new Date(3000).toISOString())
  })

  it('merge a record’s list with a session’s, the later touch winning', () => {
    const merged = mergeRefs([{ id: 'a', tool: 'create_entity' }, { id: 'b', tool: 'create_entity' }], [{ id: 'a', tool: 'update_entity' }])
    expect(merged).toEqual([{ id: 'b', tool: 'create_entity' }, { id: 'a', tool: 'update_entity' }])
  })

  it('resolve against the store, newest first, dropping what is gone, links and chats', () => {
    const store = new EntityStore()
    const doc = createEntity({ id: 'd1', type: 'document', label: 'Plan', data: {} })
    const map = createEntity({ id: 'm1', type: 'map', label: 'Trip', data: {} })
    const person = createEntity({ id: 'p1', type: 'person', label: 'Ada', data: {} })
    const chat = createEntity({ id: 'c1', type: 'conversation', label: 'Chat', data: { source: 'assistant', messages: [], messageCount: 0, charLength: 0 } })
    store.upsert(doc)
    store.upsert(map)
    store.upsert(person)
    store.upsert(chat)
    const got = resolveArtifacts(
      ['d1', 'gone', 'm1', 'c1', 'p1'].map((id) => ({ id, tool: 'create_entity' })),
      store,
    )
    expect(got.map((a) => [a.id, a.kind])).toEqual([
      ['p1', 'entity'],
      ['m1', 'map'],
      ['d1', 'document'],
    ])
  })

  it('read from a record defensively', () => {
    const e = createEntity({ type: 'conversation', label: 'x', data: { source: 'assistant', messages: [], messageCount: 0, charLength: 0, artifacts: [{ id: 'a', tool: 't' }, { id: 3 }, null, 'b'] } })
    expect(recordedRefs(e)).toEqual([{ id: 'a', tool: 't' }])
    expect(recordedRefs(undefined)).toEqual([])
  })

})
