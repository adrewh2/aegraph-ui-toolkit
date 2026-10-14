import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ToastProvider } from '../../../components/ui/useToast'
import { BrowserView } from '../BrowserView'

/** `/browser`: anyone's page for what aegraph keeps in this browser — stash, restore, clear, and clear to an empty Library. */
describe('the This browser page', () => {
  it('stashes, clears, and can clear to an empty Library rather than the site’s demo', () => {
    const out = renderToString(
      <MemoryRouter>
        <ToastProvider>
          <BrowserView />
        </ToastProvider>
      </MemoryRouter>,
    )
    expect(out).toContain('This browser')
    expect(out).toContain('Stash now')
    expect(out).toContain('Clear this browser')
    expect(out).toContain('Start empty (no demo)')
    expect(out).toContain('Stash what is here first')
  })
})
