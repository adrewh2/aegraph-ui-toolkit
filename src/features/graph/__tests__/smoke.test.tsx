import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../../components/ui/useToast'
import { EntityStoreContext } from '../../../core/entity/hooks'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/resources/types'
import '../../../core/graph/types'
import '../../../core/graph/scene'
import { ExplorerProvider } from '../explorerState'
import { PipelineBar } from '../PipelineBar'
import { LayoutPanel } from '../LayoutPanel'
import { StatsPanel } from '../StatsPanel'
import { FilterPanel } from '../FilterPanel'
import { StylePanel } from '../StylePanel'

describe('explorer panels render', () => {
  it('renders the dataset line and panels server-side without throwing', () => {
    const html = renderToString(
      <EntityStoreContext.Provider value={new EntityStore()}>
        <ToastProvider>
        <MemoryRouter>
          <ExplorerProvider>
            <PipelineBar exportProvenance={() => ({})} />
            <FilterPanel />
            <LayoutPanel dims={2} />
            <StylePanel />
            <StatsPanel />
          </ExplorerProvider>
        </MemoryRouter>
        </ToastProvider>
      </EntityStoreContext.Provider>,
    )
    expect(html).toContain('gx-dataset')
  })
})
