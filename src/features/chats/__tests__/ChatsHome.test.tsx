import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { EntityStoreContext } from '../../../core/entity/hooks'
import { EntityStore } from '../../../core/entity/store'
import { ChatsHome } from '../ChatsHome'

const groups = { open: [], earlier: [], imported: [] }
const html = (canChat: boolean, showSettings: boolean) =>
  renderToString(
    <MemoryRouter>
      <EntityStoreContext.Provider value={new EntityStore()}>
        <ChatsHome groups={groups} canChat={canChat} placeholder="Add your API key, or connect Claude Code, in settings to chat" onStart={() => {}} showSettings={showSettings} onSettings={() => {}} />
      </EntityStoreContext.Provider>
    </MemoryRouter>,
  )

/**
 * On a deployed copy with no key and no bridge the landing cannot chat: it must not be a dead end. The settings stand
 * in for the composer (where the key goes), and once closed the composer's Settings button brings them back.
 */
describe('the Chats landing with nothing to answer', () => {
  it('shows the assistant settings, with the key field, in place of the composer', () => {
    const out = html(false, true)
    expect(out).toContain('Anthropic API key')
    expect(out).not.toContain('chome__input')
  })

  it('with the settings closed, offers a Settings button beside the disabled composer', () => {
    const out = html(false, false)
    expect(out).toContain('chome__input')
    expect(out).toMatch(/title="Assistant settings"[^>]*>.*Settings<\/button>/s)
    expect(out).not.toContain('Anthropic API key')
  })

  it('able to chat, the composer is there and the gear stays one click away', () => {
    const out = html(true, false)
    expect(out).toContain('chome__input')
    expect(out).toContain('title="Assistant settings"')
  })
})
