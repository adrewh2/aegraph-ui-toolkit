import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/themes.css'
import App from './App.tsx'
import { startMemoryWatch } from './app/memoryWatch'
import { startTheme } from './features/account/settings'
import { migrateHeldPositions, POSITIONS_KEY, prefetchHeldPositions, sessionsToRestore, sweepExplorerSessionData } from './features/graph/heldPositions'
import { browserResetPending, finishBrowserReset } from './app/reset'
import { finishStashRestore, stashRestorePending } from './app/stash'

// The theme the settings name, kept from here on (`public/theme-boot.js` showed it before the first paint).
startTheme()

// Asked to clear this browser, or to restore a stash of it (the This browser page, the `account` tool): done before anything
// opens a database or writes, then the front page loads. The app does not start on this load.
const reset = browserResetPending()
const restore = reset ? null : stashRestorePending()
if (reset) void finishBrowserReset(reset)
else if (restore) void finishStashRestore(restore)
else {
  // A big view's held positions, read from IndexedDB now — beside the Library's own load — for the sessions this
  // load will show (the address's, the tab in front in each pane): the explorer, which asks once it has mounted,
  // finds them read. At a million nodes that took the restore off the end of a twenty-second reload.
  try {
    prefetchHeldPositions(sessionsToRestore(location.href).map((s) => `${POSITIONS_KEY}:${s}`))
  } catch {
    /* no storage: the explorer reads them itself */
  }
  // The tab's flight recorder: a crash leaves no trace of its own (see memoryWatch.ts).
  startMemoryWatch()
  // When the tab is idle: held graph positions an earlier version kept in localStorage move to IndexedDB, and records
  // whose marker is gone (a swept session's — see providers.tsx) are deleted.
  setTimeout(() => void migrateHeldPositions().then(() => sweepExplorerSessionData()), 3000)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
