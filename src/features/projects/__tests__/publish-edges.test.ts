import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { SCENE_TYPE } from '../../../core/graph/scene'
import { createProject } from '../../../core/projects/project'
import { parseMarkdown } from '../../../lib/markdown'
import { createDocument, FOLDER } from '../../documents/documents'
import { esc, mdHtml, publishProject, sceneSvg } from '../publish'

/**
 * Publishing at its edges: an empty project; a title and description of
 * reserved characters and emoji; two documents of one name, a document
 * of whitespace, a plain-text one, a folder; a scene whose filter matches
 * nothing and one whose parts are missing; the entity table's cap and
 * its data block against a description holding </script>; every label,
 * tag and type escaped; relative links dropped and anchors kept in
 * documents; a large project's size and time; publishing twice. Then
 * what a scene draws: the project's own members against the whole
 * Library, a saved layout holding positions for nodes that are not
 * there, and a style that ranks by a metric nobody has computed; the
 * caps at nought; markdown trying to get out of an attribute; and `esc`
 * itself.
 */
const stripTimes = (html: string) => html.replace(/Published from aegraph[^<]*/g, 'Published from aegraph')

function empty() {
  const store = new EntityStore()
  const p = createProject({ id: 'proj', label: 'Empty & "odd" <name> 🎉' })
  store.upsert(p)
  return { store, registry: new TypeRegistry(store), project: p }
}

describe('publish edges', () => {
  it('an empty project publishes a page with only the overview and an empty table; the title and file name are safe; the description is escaped', async () => {
    const { store, registry, project } = empty()
    const r = await publishProject(store, registry, project.id, { skipCharts: true })
    expect(r.stats).toEqual({ entities: 0, relationships: 0, scenes: 0, charts: 0, findings: 0, claims: 0, documents: 0, bytes: expect.any(Number) })
    expect(r.filename).toBe('empty-odd-name.html')
    expect(r.html).toContain('<title>Empty &amp; &quot;odd&quot; &lt;name&gt; 🎉</title>')
    expect(r.html).toContain('<h1>Empty &amp; &quot;odd&quot; &lt;name&gt; 🎉</h1>')
    expect(r.html).not.toContain('<name>')
    expect(r.html).toMatch(/<nav class="nav"><div class="wrap"><a href="#overview">Overview<\/a><a href="#entities">Entities<\/a><\/div><\/nav>/)
    expect(r.html).not.toContain('id="graphs"')
    expect(r.html).not.toContain('id="documents"')
    expect(r.html).toContain('0 entities · 0 relationships · 0 types')
    const data = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(r.html)![1])
    expect(data).toEqual({ nodes: [], edges: [], types: {} })
    store.update(project.id, { description: 'Say <b>hi</b> & bye' })
    expect((await publishProject(store, registry, project.id, { skipCharts: true })).html).toContain('<p class="lead">Say &lt;b&gt;hi&lt;/b&gt; &amp; bye</p>')
    expect(esc('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('documents: two of one name are two sections by id, a whitespace document and a folder are left out, plain text is preformatted and escaped, relative links drop to text and anchors stay', async () => {
    const { store, registry, project } = empty()
    const a = createDocument(store, { label: 'Same', content: 'See [the other](/documents/x) and [top](#overview) and ![pic](data:image/png;base64,AAAA).' })
    const b = createDocument(store, { label: 'Same', content: 'Second' })
    const blank = createDocument(store, { label: 'Blank', content: '  \n\t ' })
    const txt = createDocument(store, { label: 'Plain', extension: 'txt', content: 'a < b && c\n\ttabbed' })
    const folder = createDocument(store, { label: 'Folder', extension: FOLDER })
    store.mark([a.id, b.id, blank.id, txt.id, folder.id], project.id)
    const r = await publishProject(store, registry, project.id, { skipCharts: true })
    expect(r.stats.documents).toBe(3)
    expect(r.html.match(/<details class="doc"/g)?.length).toBe(3)
    expect(r.html).toContain(`id="e-${a.id}"`)
    expect(r.html).toContain(`id="e-${b.id}"`)
    expect(r.html).not.toContain(`id="e-${blank.id}"`)
    expect(r.html).toContain('<p>See the other and <a href="#overview" rel="noopener">top</a> and pic.</p>')
    expect(r.html).toContain('<pre class="plain">a &lt; b &amp;&amp; c\n\ttabbed</pre>')
    expect(r.html).toContain(' · .txt · 18 chars')
    expect(r.html).not.toContain('Folder<span')
    // The cap on documents rendered in full.
    const capped = await publishProject(store, registry, project.id, { skipCharts: true, maxDocuments: 1 })
    expect(capped.html.match(/<details class="doc"/g)?.length).toBe(1)
    expect(capped.html).toContain('2 more documents are listed under Entities.')
  })

  it('a scene whose filter matches nothing is skipped, one whose parts are missing is drawn with defaults, and the caption says what was left out at the cap', async () => {
    const { store, registry, project } = empty()
    const ents = Array.from({ length: 6 }, (_, i) => createEntity({ id: `n${i}`, type: 'note', label: `N${i}` }))
    store.upsertMany(ents)
    store.upsertMany([createRelationship({ id: 'r', type: 'r', source: 'n0', target: 'n1' })])
    const noMatch = createEntity({ id: 'f-none', type: 'filter', label: 'None', data: { types: ['unicorn'] } })
    const s1 = createEntity({ id: 's1', type: SCENE_TYPE, label: 'Nothing', data: { filterId: 'f-none' } })
    const s2 = createEntity({ id: 's2', type: SCENE_TYPE, label: 'Ghost parts', data: { filterId: 'gone', layoutId: 'gone', renderingId: 'gone', algorithm: 'no-such-layout' } })
    const s3 = createEntity({ id: 's3', type: SCENE_TYPE, label: 'No data', data: {} })
    store.upsertMany([noMatch, s1, s2, s3])
    store.mark([...ents.map((e) => e.id), 'r', 'f-none', 's1', 's2', 's3'], project.id)
    expect(sceneSvg(store, registry, s1, undefined, 100)).toBeNull()
    const drawn = sceneSvg(store, registry, s2, new Set(['n0', 'n1', 'r']), 100)!
    expect(drawn.svg).toContain('<svg')
    expect(drawn.caption).toMatch(/^2 nodes, 1 edges · filter: .* · layout: .* · style: /)
    const capped = sceneSvg(store, registry, s3, undefined, 2)!
    expect(capped.caption).toMatch(/^2 nodes, \d+ edges \(4 more not drawn\)/)
    const r = await publishProject(store, registry, project.id, { skipCharts: true })
    expect(r.stats.scenes).toBe(2)
    expect(r.html).toContain('<b>Ghost parts</b>')
    expect(r.html).not.toContain('<b>Nothing</b>')
    expect(r.html).toContain('· 2 graphs')
  })

  it('every label, tag and type is escaped, the data block cannot close its own script tag, and the table cap is stated; a large project publishes quickly and compactly', async () => {
    const { store, registry, project } = empty()
    const ents = [
      createEntity({ id: 'e1', type: 'we<ird', label: 'A & B', tags: ['<t>', 'x"y'], description: 'ends with </script><script>alert(1)</script>' }),
      createEntity({ id: 'e2', type: 'we<ird', label: "it's" }),
    ]
    store.upsertMany(ents)
    store.mark(['e1', 'e2'], project.id)
    const r = await publishProject(store, registry, project.id, { skipCharts: true })
    expect(r.html).not.toContain('we<ird')
    expect(r.html).toContain('data-type="we&lt;ird"')
    expect(r.html).toContain('<span class="tag" style="">&lt;t&gt; <b>1</b></span>') // an uncoloured tag carries an empty style
    expect(r.html).toContain('x&quot;y')
    const block = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(r.html)![1]
    expect(block).not.toContain('</script>')
    expect(block).toContain('\\u003c/script>')
    expect(JSON.parse(block).nodes.find((n: { id: string }) => n.id === 'e1').d).toContain('</script>')
    // Large: three thousand entities in a chain.
    const big = new EntityStore()
    const bp = createProject({ id: 'big', label: 'Big' })
    big.upsert(bp)
    const many = Array.from({ length: 3000 }, (_, i) => createEntity({ id: `b${i}`, type: i % 3 ? 'note' : 'person', label: `Entity number ${i}`, tags: ['t'], description: 'd'.repeat(50) }))
    const links = Array.from({ length: 2999 }, (_, i) => createRelationship({ id: `l${i}`, type: 'next', source: `b${i}`, target: `b${i + 1}` }))
    big.upsertMany([...many, ...links])
    big.mark([...many.map((e) => e.id), ...links.map((l) => l.id)], bp.id)
    const t0 = performance.now()
    const br = await publishProject(big, new TypeRegistry(big), bp.id, { skipCharts: true, maxEntities: 1000 })
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(br.stats).toMatchObject({ entities: 3000, relationships: 2999 })
    expect(br.html).toContain('The first 1,000 of 3,000 entities are listed.')
    const bd = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(br.html)![1])
    expect(bd.nodes).toHaveLength(1000)
    expect(bd.edges).toHaveLength(999) // only edges among the listed
    expect(br.stats.bytes).toBeLessThan(400_000)
  })

  it('publishing twice gives the same page but for the timestamps; the Library page carries its own words', async () => {
    const { store, registry, project } = empty()
    store.upsert(createEntity({ id: 'x', type: 'note', label: 'X' }))
    store.mark(['x'], project.id)
    const a = await publishProject(store, registry, project.id, { skipCharts: true })
    const b = await publishProject(store, registry, project.id, { skipCharts: true })
    expect(stripTimes(a.html)).toBe(stripTimes(b.html))
    expect(a.stats).toEqual(b.stats)
    const lib = await publishProject(store, registry, null, { skipCharts: true })
    expect(lib.html).toContain('<p class="lead">Everything in the Library.</p>')
    expect(lib.stats.entities).toBe(1) // the project entity itself is hidden
  })

  it('mdHtml: task items, table alignment, a numbered start, nested quotes, a data image as its alt, a mailto link, a hard break', () => {
    const html = mdHtml(parseMarkdown('- [ ] todo\n- [x] done\n\n| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n\n3. three\n4. four\n\n> > deep\n\n![alt](data:image/png;base64,AAAA) and [mail](mailto:a@b.c)  \nnext'))
    expect(html).toContain('<ul><li><input type="checkbox" disabled> <p>todo</p></li><li><input type="checkbox" disabled checked> <p>done</p></li></ul>')
    expect(html).toContain('<th style="text-align:left">l</th><th style="text-align:center">c</th><th style="text-align:right">r</th>')
    expect(html).toContain('<ol start="3"><li><p>three</p></li><li><p>four</p></li></ol>')
    expect(html).toContain('<blockquote><blockquote><p>deep</p></blockquote></blockquote>')
    expect(html).toContain('<p>alt and <a href="mailto:a@b.c" rel="noopener">mail</a><br>next</p>')
    expect(mdHtml([])).toBe('')
  })
})

describe('publish edges: the scene, the caps at nought, and the escaping underneath', () => {
  const chain = () => {
    const store = new EntityStore()
    const people = Array.from({ length: 6 }, (_, i) => createEntity({ id: `p${i}`, type: 'person', label: `Person ${i}` }))
    const rels = Array.from({ length: 5 }, (_, i) => createRelationship({ id: `k${i}`, type: 'knows', source: `p${i}`, target: `p${i + 1}` }))
    const outsider = createEntity({ id: 'out', type: 'person', label: 'Outsider' })
    const toOutsider = createRelationship({ id: 'kout', type: 'knows', source: 'p0', target: 'out' })
    const filter = createEntity({ id: 'f-people', type: 'filter', label: 'People', data: { types: ['person'] } })
    const scene = createEntity({ id: 's-chain', type: SCENE_TYPE, label: 'Chain', data: { filterId: 'f-people' } })
    store.upsertMany([...people, ...rels, outsider, toOutsider, filter, scene])
    const project = createProject({ id: 'chain', label: 'Chain' })
    store.upsert(project)
    const mine = [...people.map((e) => e.id), ...rels.map((r) => r.id), 'f-people', 's-chain']
    store.mark(mine, project.id)
    // What publishProject hands the scene: every id in the project's scope, relationships included.
    return { store, registry: new TypeRegistry(store), project, scene, members: new Set(mine) }
  }

  it('draws the project and not the Library: the same scene loses the entity outside the project', () => {
    const { store, registry, scene, members } = chain()
    expect(sceneSvg(store, registry, scene, members, 4000)!.caption).toMatch(/^6 nodes, 5 edges/)
    expect(sceneSvg(store, registry, scene, undefined, 4000)!.caption).toMatch(/^7 nodes, 6 edges/) // no members: the whole Library
  })

  it('places the nodes a saved layout knows and ignores the positions it holds for nodes that are not drawn', () => {
    const { store, registry, project, members } = chain()
    store.upsert(createEntity({ id: 'lay', type: 'layout', label: 'Two placed', data: { algorithm: 'grid', positions: { p0: { x: -400, y: -300 }, ghost: { x: 9999, y: 9999 } } } }))
    store.mark(['lay'], project.id)
    const scene = createEntity({ id: 's-lay', type: SCENE_TYPE, label: 'Placed', data: { filterId: 'f-people', layoutId: 'lay' } })
    const drawn = sceneSvg(store, registry, scene, members, 4000)!
    expect(drawn.svg).not.toContain('9999') // nothing to place: the ghost is not in the slice
    expect(drawn.svg.match(/<circle/g)?.length).toBe(6) // and every node that is still got somewhere to sit
  })

  it('computes the metrics a style ranks by rather than drawing every node the same size', () => {
    const { store, registry, project, members } = chain()
    store.upsert(createEntity({ id: 'r-metric', type: 'rendering', label: 'By PageRank', data: { nodes: { default: { size: { mode: 'ranking', attr: { kind: 'metric', key: 'pagerank' }, min: 4, max: 20 } } } } }))
    store.mark(['r-metric'], project.id)
    const scene = createEntity({ id: 's-metric', type: SCENE_TYPE, label: 'Ranked', data: { filterId: 'f-people', renderingId: 'r-metric' } })
    const radii = [...sceneSvg(store, registry, scene, members, 4000)!.svg.matchAll(/<circle[^>]*\br="([\d.]+)"/g)].map((m) => Number(m[1]))
    expect(radii).toHaveLength(6)
    expect(new Set(radii).size).toBeGreaterThan(1) // the ends of a chain do not rank with its middle
  })

  it('takes a cap of nought as nought, and still says what is there', async () => {
    const { store, registry, project } = chain()
    const docs = ['One', 'Two'].map((label) => createDocument(store, { label, extension: 'md', content: `# ${label}` }))
    store.upsertMany(docs)
    store.mark(docs.map((d) => d.id), project.id)
    const r = await publishProject(store, registry, project.id, { skipCharts: true, maxEntities: 0, maxDocuments: 0 })
    expect(r.html).not.toContain('<details class="doc"')
    expect(r.html).toContain('2 more documents are listed under Entities.')
    expect(r.html).toContain('The first 0 of 8 entities are listed.')
    const data = JSON.parse(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(r.html)![1])
    expect(data.nodes).toEqual([])
    expect(data.edges).toEqual([]) // an edge needs both its ends listed
    expect(r.stats).toMatchObject({ entities: 8, relationships: 5, documents: 2 }) // the stats count the project, not the page's caps
  })

  it('never lets a link, an image or a code fence out of its attribute', () => {
    const html = mdHtml(parseMarkdown('[x](https://a.b/?q="><script>alert(1)</script>)\n\n![p](https://a.b/i.png"onerror="alert(1))\n\n```"><b>\ncode\n```'))
    // Every quote and bracket a URL or a language carried is an entity, so nothing closes the attribute it sits in:
    // what reads like an event handler below is inert text inside `src`, not an attribute of its own.
    expect(html).not.toContain('<script')
    expect(html).toContain('href="https://a.b/?q=&quot;&gt;"')
    // A remote picture is a link (the page loads nothing from another host), and its URL stays inside the attribute.
    expect(html).toContain('href="https://a.b/i.png&quot;onerror=&quot;alert(1)"')
    expect(html).toContain('class="lang-&quot;&gt;&lt;b&gt;"')
    expect(/<[a-z]+[^>]*\son[a-z]+=/i.test(html)).toBe(false)
    expect(mdHtml(parseMarkdown('<img src=x onerror=alert(1)>'))).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  })

  it('escapes the five characters that matter, and only those', () => {
    expect(esc('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
    expect(esc('already &amp; escaped')).toBe('already &amp;amp; escaped') // not idempotent, and must not be
    expect(esc('')).toBe('')
    expect(esc('héllo — 🎉')).toBe('héllo — 🎉')
  })
})

describe('publish leaves the assistant out', () => {
  it('a published page carries neither the assistant’s memory nor its chats, unless asked', async () => {
    const { store, registry, project } = empty()
    const memory = createDocument(store, { label: 'Assistant memory', content: 'The user’s private note: REMEMBERED-SECRET', tags: ['assistant:memory'] })
    store.mark([memory.id], project.id)
    store.upsert(createEntity({ id: 'assistant-chat:1', type: 'conversation', label: 'CHAT-TITLE', tags: ['assistant:chat'], data: { messages: [{ role: 'user', content: 'CHAT-SECRET' }] }, meta: { source: 'assistant', projects: [project.id] } }))
    const kept = createDocument(store, { label: 'Notes', content: 'Project notes' })
    store.mark([kept.id], project.id)
    const r = await publishProject(store, registry, project.id, { skipCharts: true })
    expect(r.html).not.toContain('REMEMBERED-SECRET')
    expect(r.html).not.toContain('CHAT-TITLE')
    expect(r.html).toContain('Project notes')
    const asked = await publishProject(store, registry, project.id, { skipCharts: true, assistant: true })
    expect(asked.html).toContain('REMEMBERED-SECRET')
  })
})
