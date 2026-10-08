import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { SCENE_TYPE } from '../../../core/graph/scene'
import { createProject } from '../../../core/projects/project'
import { createDocument } from '../../documents/documents'
import { saveFindingAsClaim } from '../../knowledge/claims'
import { mdHtml, publishProject } from '../publish'
import { parseMarkdown } from '../../../lib/markdown'

function fixture() {
  const store = new EntityStore()
  const ents = []
  for (let i = 0; i < 8; i++) ents.push(createEntity({ id: `p${i}`, type: 'person', label: `Person ${i}`, tags: ['team', i % 2 ? 'dev' : 'ops'], description: i === 0 ? 'The <lead> & founder' : undefined }))
  for (let i = 0; i < 3; i++) ents.push(createEntity({ id: `o${i}`, type: 'organization', label: `Org ${i}` }))
  store.upsertMany(ents)
  const rels = []
  for (let i = 1; i < 8; i++) rels.push(createRelationship({ id: `k${i}`, type: 'knows', source: `p${i - 1}`, target: `p${i}` }))
  for (let i = 0; i < 8; i++) rels.push(createRelationship({ id: `w${i}`, type: 'works-at', source: `p${i}`, target: `o${i % 3}` }))
  store.upsertMany(rels)
  const doc = createDocument(store, { label: 'Notes', extension: 'md', content: '# Notes\n\nA *plan* with `code` and <script>alert(1)</script>.\n\n- one\n- [x] two\n\n| a | b |\n|---|--:|\n| 1 | 2 |' })
  store.upsert(doc)
  const filter = createEntity({ id: 'f1', type: 'filter', label: 'People', data: { types: ['person'] } })
  const layout = createEntity({ id: 'l1', type: 'layout', label: 'Line', data: { algorithm: 'grid', positions: { p0: { x: 0, y: 0 }, p1: { x: 40, y: 0 } } } })
  const rendering = createEntity({ id: 'r1', type: 'rendering', label: 'By tag', data: {} })
  const scene = createEntity({ id: 's1', type: SCENE_TYPE, label: 'Team', data: { filterId: 'f1', layoutId: 'l1', renderingId: 'r1', renderer: '2d' } })
  store.upsertMany([filter, layout, rendering, scene])
  const p = createProject({ id: 'proj', label: 'Team & co', description: 'Who knows whom' })
  store.upsert(p)
  store.mark([...ents.map((e) => e.id), ...rels.map((r) => r.id), doc.id, 'f1', 'l1', 'r1', 's1'], p.id)
  // A finding kept as a claim lands in the project when it is the scope.
  store.setScope(p.id)
  saveFindingAsClaim(store, { id: 'centrality:hubs', analysis: 'centrality', title: 'Person 3 holds the team together', detail: 'Highest betweenness.', score: 0.7, entities: ['p3', 'p2'] }, { key: 'k', computedAt: '2026-09-15T00:00:00Z' }, 'Key players')
  store.setScope(null)
  return { store, registry: new TypeRegistry(store), project: p }
}

describe('publishProject', () => {
  it('writes one self-contained page with the overview, the scene, the claim, the document and every entity', async () => {
    const { store, registry, project } = fixture()
    const r = await publishProject(store, registry, project.id, { skipCharts: true })
    expect(r.filename).toBe('team-co.html')
    // 8 people, 3 organisations, the document, the claim; 15 relationships plus the claim's 2 supports.
    expect(r.stats).toMatchObject({ entities: 13, relationships: 17, scenes: 1, charts: 0, claims: 1, documents: 1 })
    const h = r.html
    expect(h.startsWith('<!doctype html>')).toBe(true)
    expect(h).toContain('<title>Team &amp; co</title>')
    expect(h).toContain('Who knows whom')
    // Overview: the types with counts; relationships by type.
    expect(h).toContain(`<b>8</b><span>${registry.get('person').pluralLabel}</span>`)
    expect(h).toContain('works-at <b>8</b>')
    // The scene as inline SVG: its 8 people drawn, the organisations filtered out.
    expect(h).toContain('id="graphs"')
    expect(h).toMatch(/<svg[^>]*>/)
    expect(h).toContain('filter: 1 type')
    expect((h.match(/<circle/g) ?? []).length).toBeGreaterThanOrEqual(8)
    // The claim with its evidence, linking into the table.
    expect(h).toContain('Person 3 holds the team together')
    expect(h).toContain('href="#e-p3"')
    // The document, rendered and escaped.
    expect(h).toContain('<h2>Notes</h2>')
    expect(h).toContain('<em>plan</em>')
    expect(h).not.toContain('<script>alert')
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // The entity data for the table, escaped for a script block.
    const data = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(h)![1])
    expect(data.nodes).toHaveLength(13)
    expect(data.edges).toHaveLength(17)
    expect(data.nodes.find((n: { id: string }) => n.id === 'p0').d).toBe('The <lead> & founder')
    expect(h).not.toContain('</script>.')
    // No external resources.
    expect(h).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/)
    if (process.env.PUBLISH_OUT) {
      mkdirSync(process.env.PUBLISH_OUT, { recursive: true })
      writeFileSync(`${process.env.PUBLISH_OUT}/${r.filename}`, h)
    }
  })

  it('caps the table and says so', async () => {
    const { store, registry, project } = fixture()
    const r = await publishProject(store, registry, project.id, { skipCharts: true, maxEntities: 5 })
    expect(r.html).toContain('The first 5 of 13 entities are listed.')
    const data = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(r.html)![1])
    expect(data.nodes).toHaveLength(5)
  })

  it('publishes the Library when no project is given', async () => {
    const { store, registry } = fixture()
    const r = await publishProject(store, registry, null, { skipCharts: true })
    expect(r.filename).toBe('library.html')
    expect(r.stats.entities).toBe(13)
  })
})

describe('mdHtml', () => {
  it('renders the everyday subset and never passes raw HTML through', () => {
    const html = mdHtml(parseMarkdown('## Title\n\nText with **bold**, a [link](https://x.y) and a [bad](javascript:alert) one.\n\n```js\nlet a = "<b>"\n```\n\n> quote\n\n1. one\n2. two'))
    expect(html).toBe('<h3>Title</h3><p>Text with <strong>bold</strong>, a <a href="https://x.y" rel="noopener">link</a> and a bad one.</p><pre><code class="lang-js">let a = &quot;&lt;b&gt;&quot;</code></pre><blockquote><p>quote</p></blockquote><ol><li><p>one</p></li><li><p>two</p></li></ol>')
  })
})
