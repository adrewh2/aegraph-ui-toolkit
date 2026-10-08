import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../../components/ui/useToast'
import { EntityStoreContext } from '../../../core/entity/hooks'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/resources/types'
import { EntitiesWorkspace } from '../EntitiesWorkspace'

describe('entities workspace', () => {
  it('renders the browser inside a single tabbed pane', () => {
    const html = renderToString(
      <EntityStoreContext.Provider value={new EntityStore()}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/entities']}>
            <EntitiesWorkspace />
          </MemoryRouter>
        </ToastProvider>
      </EntityStoreContext.Provider>,
    )
    expect(html).toContain('ws--tabs')
    expect(html).toContain('ws-tab')
    expect(html).toContain('page-title')
  })
})
