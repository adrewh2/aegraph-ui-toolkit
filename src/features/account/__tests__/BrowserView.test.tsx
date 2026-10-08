import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ToastProvider } from '../../../components/ui/useToast'
import { BrowserView } from '../BrowserView'
import { AccountButton, AccountPanel } from '../AccountMenu'

const html = (node: React.ReactNode) =>
  renderToString(
    <MemoryRouter>
      <ToastProvider>{node}</ToastProvider>
    </MemoryRouter>,
  )

describe('the This browser page', () => {
  it('stashes, restores and clears this browser — and has no sign-in to keep', () => {
    const out = html(<BrowserView />)
    expect(out).toContain('This browser')
    expect(out).toContain('Stash now')
    expect(out).toContain('Include keys in stashes')
    expect(out).toContain('Clear this browser')
    expect(out).not.toMatch(/sign(ed)? ?in|allow list|admin|password/i)
  })
})

describe('the settings menu', () => {
  it('is a settings button, not a sign-in', () => {
    const out = html(<AccountButton rail={false} />)
    expect(out).toContain('Settings')
    expect(out).not.toMatch(/sign in|signed in/i)
  })

  it('links to This browser and holds the settings', () => {
    const out = html(<AccountPanel />)
    expect(out).toContain('href="/browser"')
    expect(out).toContain('Third-party services')
    expect(out).toContain('Developer tools')
    expect(out).not.toMatch(/sign(ed)? ?in|admin/i)
  })
})
