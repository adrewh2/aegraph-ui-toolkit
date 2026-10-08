import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ToastProvider } from '../../../components/ui/useToast'
import { EntityStoreContext } from '../../../core/entity/hooks'
import { EntityStore } from '../../../core/entity/store'
import { parseMarkdown } from '../../../lib/markdown'
import '../../../core/resources/types'
import '../../../core/graph/types'
import { createAppTools } from '../../assistant/tools'
import { DocsView } from '../DocsView'
import { DOC_PAGES, docPage } from '../pages'
import { toolReferenceMarkdown } from '../toolReference'

describe('documentation', () => {
  it('every page parses and starts with a title', () => {
    for (const p of DOC_PAGES) {
      if (p.component) continue // live pages have no Markdown
      const blocks = parseMarkdown(p.source)
      expect(blocks[0]).toMatchObject({ t: 'heading', level: 1 })
      expect(p.source.length).toBeGreaterThan(500)
    }
    expect(new Set(DOC_PAGES.map((p) => p.id)).size).toBe(DOC_PAGES.length)
  })

  it('internal links point at existing pages', () => {
    const ids = new Set(DOC_PAGES.map((p) => p.id))
    for (const p of DOC_PAGES) {
      for (const m of p.source.matchAll(/\]\(\/docs\/([a-z-]+)(#[a-z-]+)?\)/g)) expect(ids.has(m[1]), `${p.id} → ${m[1]}`).toBe(true)
    }
  })

  it('the tool reference lists every tool with its parameters', () => {
    const tools = createAppTools({ store: new EntityStore(), navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => false })
    const md = toolReferenceMarkdown(tools)
    for (const t of tools) expect(md).toContain(`### \`${t.name}\``)
    expect(md).toContain('`graph_positions`')
    expect(md).toContain('| `action` * |')
    expect(parseMarkdown(md).some((b) => b.t === 'table')).toBe(true)
  })

  it('renders a page server-side', () => {
    const html = renderToString(
      <EntityStoreContext.Provider value={new EntityStore()}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/docs/pipeline']}>
            <Routes>
              <Route path="/docs/:page" element={<DocsView />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </EntityStoreContext.Provider>,
    )
    expect(html).toContain('Dataset')
    expect(html).toContain('docs__link is-active')
    expect(docPage('pipeline')?.title).toBe('The pipeline')
  })
})
