import { BrowserRouter } from 'react-router-dom'
import { AppProviders } from './app/providers'
import { AppRoutes } from './app/AppRoutes'
import { KeptPages } from './app/KeptPages'
import { NameCommunityDialog } from './features/knowledge/NameCommunityDialog'
import { CommandPalette } from './features/search/CommandPalette'
import { SpotifyImportDialog } from './features/spotify/SpotifyImportDialog'
import { AppLayout } from './components/Layout/AppLayout'

// Routes live in src/app/AppRoutes.tsx so the workstation can render them inside panes too.
function App() {
  return (
    <AppProviders>
      <BrowserRouter>
        <AppLayout>
          <KeptPages>
            <AppRoutes />
          </KeptPages>
        </AppLayout>
        <CommandPalette />
        <NameCommunityDialog />
        <SpotifyImportDialog />
      </BrowserRouter>
    </AppProviders>
  )
}

export default App
