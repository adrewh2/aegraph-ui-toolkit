import { renderToString } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The server renderer has no portals: render a dialog's box in place, and give it a body to be portalled to.
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }))

/** How a dialog is announced: by its title and its description, not a label that repeats the title. */
describe('Dialog', () => {
  beforeAll(() => vi.stubGlobal('document', { body: {}, activeElement: null }))
  afterAll(() => vi.unstubAllGlobals())

  it('is labelled by its title and described by its description', async () => {
    const { Dialog } = await import('../Dialog')
    const html = renderToString(
      <Dialog open title="Rename type" description="The new name shows everywhere." onClose={() => {}}>
        <input />
      </Dialog>,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).not.toContain('aria-label=')
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1]
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1]
    expect(labelledBy).toBeTruthy()
    expect(html).toMatch(new RegExp(`<h2 id="${labelledBy}"[^>]*>Rename type</h2>`))
    expect(html).toMatch(new RegExp(`<p id="${describedBy}"[^>]*>The new name shows everywhere.</p>`))
    // The box itself can hold the focus when nothing inside can.
    expect(html).toContain('tabindex="-1"')
  })

  it('without a description, describes nothing', async () => {
    const { Dialog } = await import('../Dialog')
    const html = renderToString(<Dialog open title="Hello" onClose={() => {}} />)
    expect(html).not.toContain('aria-describedby')
  })

  it('a confirmation is described by its message', async () => {
    const { ConfirmDialog } = await import('../Dialog')
    const html = renderToString(<ConfirmDialog open title="Delete 3 entities?" message="This cannot be undone." danger onConfirm={() => {}} onCancel={() => {}} />)
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1]
    expect(describedBy).toBeTruthy()
    expect(html).toMatch(new RegExp(`<p id="${describedBy}"[^>]*>This cannot be undone.</p>`))
  })

  it('a question a tool asked starts with its yes disabled, and an ordinary one does not', async () => {
    const { ConfirmDialog } = await import('../Dialog')
    const yesOf = (html: string) => html.match(/<button[^>]*btn--primary[^>]*>/)?.[0] ?? ''
    const guarded = renderToString(<ConfirmDialog open title="Claude Code wants your go-ahead" message="Fetch https://x.example/?" confirmLabel="Fetch" guarded onConfirm={() => {}} onCancel={() => {}} />)
    expect(yesOf(guarded)).toContain('disabled')
    const plain = renderToString(<ConfirmDialog open title="Rename?" message="Sure?" onConfirm={() => {}} onCancel={() => {}} />)
    expect(yesOf(plain)).not.toContain('disabled')
  })

  it('renders nothing while closed', async () => {
    const { Dialog } = await import('../Dialog')
    expect(renderToString(<Dialog open={false} title="Hidden" onClose={() => {}} />)).toBe('')
  })
})
