import { renderToString } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The server renderer has no portals: render the menu in place, and give it a body to be portalled to.
vi.mock('react-dom', async (original) => ({ ...(await original<typeof import('react-dom')>()), createPortal: (node: unknown) => node }))

/** How a menu is announced: a plain action is a menu item; a choice among several (a dropdown's options) a radio item, the chosen one checked. */
describe('Menu', () => {
  beforeAll(() => vi.stubGlobal('document', { body: {}, activeElement: null }))
  afterAll(() => vi.unstubAllGlobals())

  it('actions are menu items; choices are radio items with aria-checked', async () => {
    const { Menu } = await import('../Menu')
    const html = renderToString(
      <Menu
        x={0}
        y={0}
        onClose={() => {}}
        items={[
          { kind: 'item', label: 'Rename…', onSelect: () => {} },
          { kind: 'sep' },
          { kind: 'label', label: 'Sort' },
          { kind: 'item', label: 'By name', checked: true, onSelect: () => {} },
          { kind: 'item', label: 'By date', checked: false, onSelect: () => {} },
        ]}
      />,
    )
    expect(html).toContain('role="menu"')
    expect(html).toMatch(/role="menuitem"[^>]*>.*Rename…/)
    expect(html).not.toMatch(/role="menuitem"[^>]*aria-checked/)
    expect(html).toMatch(/role="menuitemradio" aria-checked="true"[^>]*>.*By name/)
    expect(html).toMatch(/role="menuitemradio" aria-checked="false"[^>]*>.*By date/)
    expect(html).toContain('role="separator"')
  })
})
