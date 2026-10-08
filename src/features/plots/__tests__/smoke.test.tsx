import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../../components/ui/useToast'
import { EntityStoreContext } from '../../../core/entity/hooks'
import { EntityStore } from '../../../core/entity/store'
import { createEntity } from '../../../core/entity/entity'
import '../../../core/graph/plot'
import { PlotWorkbench } from '../PlotWorkbench'

describe('plot workbench', () => {
  it('renders the panel server-side with the default activity spec', () => {
    const store = new EntityStore()
    store.upsert(createEntity({ id: 'a', type: 'note', label: 'a' }))
    const html = renderToString(
      <EntityStoreContext.Provider value={store}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/scenes?plot=new']}>
            <PlotWorkbench />
          </MemoryRouter>
        </ToastProvider>
      </EntityStoreContext.Provider>,
    )
    expect(html).toContain('Which rows')
    expect(html).toContain('Chart kind')
    expect(html).toContain('1 rows · 1 traces')
    expect(html).toContain('meta.createdAt')
  })
})
