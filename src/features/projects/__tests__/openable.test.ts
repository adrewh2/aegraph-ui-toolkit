import { describe, expect, it } from 'vitest'
import type { DemoEntry } from '../../datasets/demos'
import type { LocalDemo } from '../../datasets/localDemos'
import { describeOpenable, isBundleName, openables } from '../openable'

/**
 * What the Open project dialog offers: the demos this build fetched from
 * the demos repo and the bundles on this machine — newest of those first,
 * and nothing that is not a project bundle. The app ships no projects of
 * its own.
 */
const demo = (id: string, over: Partial<DemoEntry> = {}): DemoEntry => ({ id, title: id, description: `About ${id}`, bundleUrl: `/demos/${id}/bundle.ae.json`, ...over })
const local = (id: string, file: string, over: Partial<LocalDemo> = {}): LocalDemo => ({ id, label: id, file, kind: 'file', bytes: 1024, modified: '2026-09-19T10:00:00Z', ...over })

describe('what can be opened as a project', () => {
  it('knows a bundle from a dataset to import row by row', () => {
    for (const name of ['atlas.ae.json', 'x.aeb', 'y.ae', 'z.aegraph.json', 'big.ae.json.gz', 'PACK.AEB']) expect(isBundleName(name), name).toBe(true)
    for (const name of ['notes.csv', 'rows.jsonl', 'graph.gexf', 'plain.json', 'export.json.gz', 'readme.md', '']) expect(isBundleName(name), name).toBe(false)
  })

  it('puts this machine first, then the demos in the catalog order', () => {
    const list = openables([demo('aurora', { title: 'Aurora', bundleUrl: '/demos/aurora/bundle.ae.json' }), demo('flights')], [local('trails', 'session-trails.ae.json', { modified: '2026-09-19T09:00:00Z' }), local('atlas', 'conversation-atlas-clean.ae.json', { modified: '2026-09-19T11:00:00Z' }), local('csv', 'rows.csv'), local('dir', 'export', { kind: 'directory' })])
    expect(list.map((o) => o.id)).toEqual(['local:atlas', 'local:trails', 'aurora', 'flights'])
    expect(list.find((o) => o.id === 'aurora')?.where).toBe('demo')
    // A CSV and a directory are not projects.
    expect(list.some((o) => o.id.includes('csv') || o.id.includes('dir'))).toBe(false)
    expect(list.every((o) => o.url)).toBe(true)
  })

  it('with nothing fetched, offers nothing', () => {
    expect(openables()).toEqual([])
    expect(openables([], [])).toEqual([])
  })

  it('says where a project came from and how big it is, and says nothing when there is nothing to say', () => {
    expect(describeOpenable({ id: 'a', title: 'A', url: '/a', where: 'demo', bytes: 2_621_440, counts: { entities: 1234, relationships: 56 } })).toBe('1,234 entities · 56 relationships · 2.5 MB')
    expect(describeOpenable({ id: 'b', title: 'B', url: '/b', where: 'local', bytes: 2048 })).toBe('2 KB · on this machine')
    expect(describeOpenable({ id: 'c', title: 'C', url: '/c', where: 'demo' })).toBe('')
    expect(describeOpenable({ id: 'd', title: 'D', url: '/d', where: 'local', bytes: 10 })).toBe('1 KB · on this machine')
  })
})
