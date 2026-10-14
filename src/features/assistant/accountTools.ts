import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { requestBrowserReset } from '../../app/reset'
import { deleteStash, listStashes, requestStashRestore, stashBrowser, type Stash } from '../../app/stash'
import { quoteLabel } from '../../core/entity/entity'
import { getUserSettings, setUserSettings } from '../account/settings'
import { currentTheme, isThemePreference, THEMES } from '../../app/theme'
import { json } from './toolkit'
import type { AppHost } from './tools'

/**
 * The settings menu at the foot of the sidebar, as a tool: `account` — the user's settings (Third-party services,
 * Developer tools) and the This browser page (`/browser`): stash, restore and clear what aegraph keeps in this
 * browser.
 */
export function createAccountTools(host: Pick<AppHost, 'confirm'>) {
  const state = () => ({ settings: getUserSettings(), themeShown: currentTheme() })
  const account = betaTool({
    name: 'account',
    description:
      "The settings menu at the foot of the sidebar and the This browser page (/browser). `get` reads the user's settings; `set` changes the settings given and returns the result. `theme` is the colour theme — `system` (the default: Paper or Dark as the operating system is set), `paper` (warm off-white), `dark`, `midnight` (cool blue-black) or `contrast` (black on white); `get` also says which one is on screen (`themeShown`). Changing it needs no question: it is how the app looks, nothing more. `developer_tools` shows the tools for working on aegraph itself — the GPU graph view's Benchmark menu (the `gpu_graph` tool runs the benchmark whatever the setting). `external_services` is the one switch over everything that leaves this machine — map tiles, place search, Wikipedia, search by meaning, the YouTube and Spotify players, linked-data import — and is on by default; with it off those features refuse rather than call out, and the map draws the places on plain ground. Changing it is the user's call: the app asks them before it changes, and says what will start or stop reaching other sites. `reset_browser` is the This browser page's *Clear this browser*: it clears everything aegraph keeps in this browser — every IndexedDB database (the Library and every project, version history, settings), localStorage (chats, page state, the bridge's link to Claude Code), sessionStorage and Cache Storage — and reloads the tab as a first visit, to see the app as a new user does. The user is asked first, always. The tab reloads just after the answer, and its bridge link is cleared with the rest: the tools stop answering until the user connects Claude Code again. Stashes are the way back: `stash_browser` copies everything aegraph keeps in this browser (every IndexedDB database and localStorage, the keys — API keys, the Spotify sign-in, the bridge link — aside unless the user ticked *Include keys in stashes* on the This browser page) into a stash kept in the browser beside it, under `name`; at most 10 stashes are kept, and one the browser has no room for is refused before anything is copied; `stashes` lists them (id, name, when, records, rough size); `restore_stash` puts the browser back as stash `id` holds it — what is here now replaced, the keys here kept unless the stash holds its own, stashed first unless `stash_first` is false — and reloads the tab as `reset_browser` does; `delete_stash` deletes stash `id`. Clearing never deletes stashes, so stash, reset, look, restore is safe. `reset_browser` stashes first too when `stash_first` is true (its default is false: a reset is usually asked for to see a first visit). Restoring and deleting ask the user first, always.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'reset_browser', 'stash_browser', 'stashes', 'restore_stash', 'delete_stash'], description: 'Default: get.' },
        theme: { type: 'string', enum: ['system', ...THEMES.map((t) => t.id)], description: 'For `set`: the colour theme. `system` follows the operating system (Paper or Dark).' },
        developer_tools: { type: 'boolean', description: 'For `set`: show (true) or hide (false) the developer tools.' },
        external_services: { type: 'boolean', description: 'For `set`: let the app call third-party services (true, the default) or not (false — offline mode).' },
        name: { type: 'string', description: 'For `stash_browser`: what to call the stash (default: its date).' },
        id: { type: 'string', description: 'For `restore_stash` and `delete_stash`: the stash (see `stashes`).' },
        stash_first: { type: 'boolean', description: 'For `restore_stash` (default true) and `reset_browser` (default false): stash what is here before it is replaced or cleared.' },
      },
      additionalProperties: false,
    } as const,
    run: async ({ action, theme, developer_tools, external_services, name, id, stash_first }) => {
      const listed = (s: Stash) => ({ id: s.id, name: s.name, createdAt: s.createdAt, records: s.records, bytes: s.bytes, databases: s.databases.map((d) => d.name) })
      if (action === 'stash_browser') return json({ stashed: listed(await stashBrowser(name ?? '')) })
      if (action === 'stashes') return json({ stashes: (await listStashes()).map(listed) })
      if (action === 'restore_stash' || action === 'delete_stash') {
        if (!id) throw new Error(`${action} needs an id (see account {action:"stashes"}).`)
        const stash = (await listStashes()).find((s) => s.id === id)
        if (!stash) throw new Error(`No stash ${id} in this browser. Use account {action:"stashes"}.`)
        if (action === 'delete_stash') {
          if (!(await host.confirm(`Delete a stash for good (this browser as it is now is not touched): ${quoteLabel(stash.name)}?`, { yes: 'Delete', danger: true }))) throw new Error('The user kept the stash.')
          await deleteStash(id)
          return json({ deleted: id })
        }
        const first = stash_first ?? true
        const ask = `Put this browser back as a stash holds it — the Library, projects, chats, history and settings as they were then replacing what is here — and reload? ${first ? 'What is here now is stashed first.' : 'What is here now and not stashed, exported or published is gone for good.'} The stash: ${quoteLabel(stash.name)}.`
        if (!(await host.confirm(ask, { yes: first ? 'Stash and restore' : 'Restore', danger: !first }))) throw new Error('The user kept this browser as it is.')
        const before = first ? await stashBrowser(`Before restoring ${quoteLabel(stash.name)}`) : undefined
        requestStashRestore(id, () => setTimeout(() => location.reload(), 300))
        return json({ restoring: id, ...(before ? { stashedFirst: listed(before) } : {}), note: 'The tab is reloading into the stash; connect Claude Code again to use the tools if the stash has no bridge link.' })
      }
      if (action === 'reset_browser') {
        const ask = `Clear everything aegraph keeps in this browser — the Library and every project, chats, history and settings — and reload as a first visit? ${stash_first ? 'What is here now is stashed first, so it can be restored.' : 'Anything not stashed, exported or published is gone for good.'}`
        if (!(await host.confirm(ask, { yes: stash_first ? 'Stash and clear' : 'Clear', danger: !stash_first }))) throw new Error('The user kept this browser as it is.')
        const before = stash_first ? await stashBrowser('Before clearing') : undefined
        // A moment's grace, so this answer reaches the caller before the tab goes.
        requestBrowserReset({}, () => setTimeout(() => location.reload(), 300))
        return json({ reset: true, ...(before ? { stashedFirst: listed(before) } : {}), note: 'The tab is reloading as a first visit; connect Claude Code again to use the tools.' })
      }
      if ((action ?? 'get') === 'set') {
        if (theme === undefined && developer_tools === undefined && external_services === undefined) throw new Error('set needs a setting to change: theme, developer_tools or external_services.')
        if (theme !== undefined && !isThemePreference(theme)) throw new Error(`No theme ${JSON.stringify(theme)}: one of system, ${THEMES.map((t) => t.id).join(', ')}.`)
        if (external_services !== undefined && external_services !== getUserSettings().externalServices) {
          const ask = external_services
            ? 'Turn Third-party services on? Map tiles, place search, Wikipedia, search by meaning, embeds and linked-data import will reach other sites again.'
            : 'Turn Third-party services off? Map tiles, place search, Wikipedia, search by meaning, embeds and linked-data import will stop reaching other sites.'
          if (!(await host.confirm(ask, { yes: external_services ? 'Turn on' : 'Turn off' }))) throw new Error('The user kept Third-party services as it was.')
        }
        setUserSettings({ ...(theme !== undefined && isThemePreference(theme) && { theme }), ...(developer_tools !== undefined && { developerTools: developer_tools }), ...(external_services !== undefined && { externalServices: external_services }) })
      }
      return json(state())
    },
  })
  return [account]
}
