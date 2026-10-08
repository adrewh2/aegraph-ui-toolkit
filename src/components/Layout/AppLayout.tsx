import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
// The assistant — and the API SDK and every tool behind it — loads when the panel first opens.
const AssistantPanel = lazy(() => import('../../features/assistant/AssistantPanel').then((m) => ({ default: m.AssistantPanel })))
import { VoiceControl } from '../../features/voice/VoiceControl'
import { TextSelectionMenu } from '../../features/textInsights/TextSelectionMenu'
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary'
import { Sidebar } from '../Sidebar/Sidebar'
import { useDocumentTitle } from '../Sidebar/pageTitle'
import './AppLayout.css'

const OPEN_KEY = 'aegraph:ai:open'

export function AppLayout({ children }: { children: ReactNode }) {
  // The Chats page is the chat, full size: the dock steps aside there (and comes back on leaving, as it was).
  const { pathname } = useLocation()
  const onChatsPage = /^\/chats(\/|$)/.test(pathname)
  // The browser tab says which page this is: "Documents · aegraph".
  useDocumentTitle(pathname)
  const [assistantOpen, setAssistantOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const setOpen = (v: boolean) => {
    setAssistantOpen(v)
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  // ⌘J toggles the assistant from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setOpen(!assistantOpen)
      }
    }
    // `detail.open` forces a state; no detail toggles (the sidebar button).
    const onOpen = (e: Event) => setOpen((e as CustomEvent<{ open?: boolean } | undefined>).detail?.open ?? !assistantOpen)
    window.addEventListener('keydown', onKey)
    window.addEventListener('aegraph:assistant', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('aegraph:assistant', onOpen)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantOpen])

  // The dock mounts at zero width, is laid out once, and only then gets `is-open`, so the width change
  // runs as a CSS transition and the page slides along with the panel. On close it stays mounted until
  // the width transition finishes, then unmounts.
  const [assistantMounted, setAssistantMounted] = useState(assistantOpen)
  const [assistantShown, setAssistantShown] = useState(assistantOpen) // already-open on load: no slide
  const dockRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (assistantOpen) setAssistantMounted(true)
    else setAssistantShown(false)
  }, [assistantOpen])
  useLayoutEffect(() => {
    if (!assistantMounted || !assistantOpen || assistantShown) return
    dockRef.current?.getBoundingClientRect() // commit the zero-width start state before switching
    setAssistantShown(true)
  }, [assistantMounted, assistantOpen, assistantShown])

  return (
    <div className="app">
      {/* Each part crashes on its own: a broken page leaves the sidebar and the assistant working, and the reverse. */}
      <ErrorBoundary what="The sidebar" scope="sidebar" compact>
        <Sidebar />
      </ErrorBoundary>
      <main className="app-main">
        <div className="app-content">
          <ErrorBoundary what="This page" scope="page" resetKey={pathname}>
            {children}
          </ErrorBoundary>
        </div>
      </main>
      {/* Voice control (⌘⇧U): talks to the assistant whether or not its panel is open. */}
      <VoiceControl />
      {/* Right-click on selected text anywhere: Insights, Ask about this, Search, and Copy (Cut/Paste where editable). */}
      <ErrorBoundary what="The text menu" scope="text-menu" compact>
        <TextSelectionMenu />
      </ErrorBoundary>
      {/* The assistant opens from the sidebar (or ⌘J); nothing floats over the page's own controls. */}
      {assistantMounted && !onChatsPage && (
        <div
          ref={dockRef}
          className={`ai-dock ${assistantShown ? 'is-open' : ''}`}
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget && e.propertyName === 'width' && !assistantOpen) setAssistantMounted(false)
          }}
        >
          <ErrorBoundary what="The assistant" scope="assistant">
            <Suspense fallback={null}>
              <AssistantPanel onClose={() => setOpen(false)} />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
    </div>
  )
}
