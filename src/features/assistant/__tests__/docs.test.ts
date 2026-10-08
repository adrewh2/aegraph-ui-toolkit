import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/graph/types'
import '../../../core/resources/types'
import { docPageAt, readDoc, searchDocs, sectionsOf } from '../../docs/lookup'
import { DOC_PAGES, docPage } from '../../docs/pages'
import { HOSTS, registerHost, type HostCommand } from '../../workstation/hosts'
import { activateTab, addTab, firstRunWorkstation, panes, type Workstation } from '../../workstation/model'
import { createAppTools, type AppContext, type AppHost } from '../tools'

const run = async (name: string, input: unknown, navigated: string[] = []) => {
  const store = new EntityStore()
  const host: AppHost = { store, navigate: (to) => void navigated.push(to), getContext: () => ({ route: '/docs/about' }), confirm: async () => true }
  const t = createAppTools(host).find((x) => x.name === name) as BetaRunnableTool
  const r = await t.run(t.parse(input))
  return JSON.parse(typeof r === 'string' ? r : JSON.stringify(r)) as Record<string, unknown>
}

describe('the documentation as the assistant reads it', () => {
  it('knows which page a route or a pane path shows, with the section', () => {
    expect(docPageAt('/docs/about')?.page.id).toBe('about')
    expect(docPageAt('/docs/about#the-model')).toMatchObject({ page: { id: 'about' }, section: 'the-model' })
    expect(docPageAt('/docs/explorer?x=1#large-graphs')).toMatchObject({ page: { id: 'explorer' }, section: 'large-graphs' })
    expect(docPageAt('/model')?.page.id).toBe('model')
    expect(docPageAt('/docs/nope')).toBeUndefined()
    expect(docPageAt('/documents/doc:about-this-map')).toBeUndefined() // a workspace document, not the docs
    expect(docPageAt('/graph/2d')).toBeUndefined()
  })

  it('splits a page at its headings: a lead titled as the page, then each h2/h3 with its anchor; code fences do not start sections', () => {
    const s = sectionsOf(docPage('about')!)
    expect(s[0]).toMatchObject({ id: '', title: 'About aegraph', level: 1 })
    expect(s.map((x) => x.id)).toContain('the-model')
    expect(s.find((x) => x.id === 'types-are-entities')).toMatchObject({ level: 3 })
    expect(s.every((x) => !x.text.startsWith('#'))).toBe(true)
    const fenced = sectionsOf({ id: 'x', title: 'X', source: '# X\n\nlead\n\n```\n## not a heading\n```\n\n## Real\n\nbody' })
    expect(fenced.map((x) => x.id)).toEqual(['', 'real'])
    expect(fenced[0].text).toContain('## not a heading')
  })

  it('reads a page, or one section by anchor or by heading text, and says what else is on the page', () => {
    const whole = readDoc('about')!
    expect(whole.text.startsWith('#')).toBe(false) // the h1 is the title, not repeated
    expect(whole.text).toContain('aegraph is a workbench')
    expect(whole.sections).toContain('where-it-is-going')
    const one = readDoc('about', '#the-model')!
    expect(one.title).toBe('About aegraph › The model')
    expect(one.text).not.toContain('aegraph is a workbench')
    expect(one.text.length).toBeLessThan(whole.text.length)
    expect(readDoc('about', 'Where it is going')?.section).toBe('where-it-is-going')
    const missing = readDoc('about', 'nothing here')!
    expect(missing.section).toBeUndefined()
    expect(missing.note).toContain('No section')
    expect(readDoc('model')?.note).toContain('list_entity_types')
    expect(readDoc('assistant')?.note).toContain('tool reference')
    expect(readDoc('nope')).toBeUndefined()
  })

  it('searches every page by section: all the words, titles weigh more, an excerpt around the first hit', () => {
    const hits = searchDocs('view budget')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]).toMatchObject({ id: 'explorer' })
    expect(hits[0].excerpt.toLowerCase()).toMatch(/view|budget/)
    for (const h of hits) expect(DOC_PAGES.some((p) => p.id === h.id)).toBe(true)
    const byTitle = searchDocs('position layouts')
    expect(byTitle[0].id).toBe('positions')
    expect(searchDocs('zxqv-nothing-matches')).toEqual([])
    expect(searchDocs('   ')).toEqual([])
    expect(searchDocs('graph', 3)).toHaveLength(3)
  })

  it('the docs tool: list → every page with its sections; read → Markdown with a path; search → hits that say how to read them', async () => {
    const list = await run('docs', {})
    const groups = list.pages as { group: string; pages: { id: string; sections: string[] }[] }[]
    expect(groups.map((g) => g.group)).toContain('Start here')
    expect(groups.flatMap((g) => g.pages).map((p) => p.id).sort()).toEqual(DOC_PAGES.map((p) => p.id).sort())
    expect(groups[0].pages.find((p) => p.id === 'about')?.sections).toContain('the-model')

    const page = await run('docs', { id: 'about' })
    expect(page).toMatchObject({ id: 'about', title: 'About aegraph', path: '/docs/about' })
    expect(String(page.markdown)).toContain('aegraph is a workbench')

    const section = await run('docs', { action: 'read', id: 'about', section: 'the-model' })
    expect(section).toMatchObject({ section: 'the-model', path: '/docs/about#the-model' })
    expect(String(section.markdown)).not.toContain('aegraph is a workbench')

    const found = await run('docs', { query: 'view budget', limit: 2 })
    const hits = found.hits as { id: string; read: { id: string; section: string } }[]
    expect(hits).toHaveLength(2)
    expect(hits[0].read).toMatchObject({ id: hits[0].id })
    expect((await run('docs', { query: 'zxqv-nothing' })).note).toContain('No section')

    await expect(run('docs', { id: 'nope' })).rejects.toThrow(/No docs page/)
    await expect(run('docs', { action: 'search' })).rejects.toThrow(/needs a query/)
    await expect(run('docs', { action: 'read' })).rejects.toThrow(/needs a page id/)
  })

  it('open: away from the Workstation it navigates to the page, at the section; a missing section is an error, not a blind jump', async () => {
    const navigated: string[] = []
    expect(await run('docs', { action: 'open', id: 'explorer', section: 'large-graphs' }, navigated)).toMatchObject({ opened: '/docs/explorer#large-graphs', where: 'documentation view' })
    expect(await run('docs', { action: 'open', id: 'about' }, navigated)).toMatchObject({ opened: '/docs/about' })
    expect(navigated).toEqual(['/docs/explorer#large-graphs', '/docs/about'])
    await expect(run('docs', { action: 'open', id: 'about', section: 'no-such-section' }, navigated)).rejects.toThrow(/No section/)
    await expect(run('docs', { action: 'open' }, navigated)).rejects.toThrow(/needs a page id/)
    expect(navigated).toHaveLength(2)
  })

  it('open: with the Workstation on screen the page becomes a tab in the focused pane, and a tab already showing it is brought to the front instead', async () => {
    let ws: Workstation = firstRunWorkstation()
    const commands: HostCommand[] = []
    const unregister = registerHost({
      key: HOSTS.workstation.key,
      get: () => ws,
      run: (c) => {
        commands.push(c)
        if (c.type === 'addTab') ws = addTab(ws, c.paneId, c.tab)
        else if (c.type === 'activate') ws = activateTab(ws, c.paneId, c.index)
        else if (c.type === 'focus') ws = { ...ws, focused: c.paneId }
      },
    })
    try {
      const navigated: string[] = []
      const focusedBefore = ws.focused
      const opened = await run('docs', { action: 'open', id: 'pipeline' }, navigated)
      expect(opened).toMatchObject({ opened: '/docs/pipeline', where: 'workstation tab' })
      const pane = panes(ws.root).find((p) => p.id === focusedBefore)!
      expect(pane.tabs[pane.active]).toMatchObject({ path: '/docs/pipeline', title: 'The pipeline' })
      expect(navigated).toEqual([]) // no route change: the user stays at the Workstation

      // A tab already showing the page is brought to the front rather than a second one added.
      const pane0 = panes(ws.root).find((p) => p.id === focusedBefore)!
      ws = activateTab(ws, pane0.id, 0)
      const tabsBefore = panes(ws.root).reduce((n, p) => n + p.tabs.length, 0)
      const again = await run('docs', { action: 'open', id: 'pipeline' }, navigated)
      expect(again).toMatchObject({ opened: '/docs/pipeline', where: 'workstation tab' })
      expect(panes(ws.root).reduce((n, p) => n + p.tabs.length, 0)).toBe(tabsBefore)
      const docPane = panes(ws.root).find((p) => p.tabs.some((t) => t.path === '/docs/pipeline'))!
      expect(ws.focused).toBe(docPane.id)
      expect(docPane.tabs[docPane.active].path).toBe('/docs/pipeline')
      expect(commands.map((c) => c.type)).toEqual(['addTab', 'focus', 'activate'])
    } finally {
      unregister()
    }
  })

  it('the app context type carries the docs on screen', () => {
    // A compile-time check that the context can name a docs page, as useAppHost fills it from the route and the panes.
    const ctx: AppContext = { route: '/workstation', docs: [{ id: 'about', title: 'About aegraph', where: 'focused pane' }] }
    expect(ctx.docs?.[0].where).toBe('focused pane')
  })
})
