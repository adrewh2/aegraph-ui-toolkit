import { ChevronDown, ChevronRight, Download, Home, MessagesSquare, Network, PanelRight, PanelRightClose, Plus, Search, Settings2, Trash2, X } from 'lucide-react'
import { Suspense, lazy, memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ConfirmDialog } from '../../components/ui/Dialog'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { isLocalHost } from '../../core/ai/settings'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { formatDate } from '../../lib/format'
import { SettingsPane } from '../assistant/AssistantPanel'
import { ChatThread } from '../assistant/ChatThread'
import type { Attachment } from '../assistant/attachments'
import { chats } from '../assistant/chats'
import { chatEntityId } from '../assistant/record'
import { currentBackend, type AssistantSession } from '../assistant/session'
import { downloadTranscript } from '../assistant/transcript'
import { useAppHost } from '../assistant/useAppHost'
import { useBridge } from '../bridge/bridge'
import { isConversation } from '../conversations/conversation'
import { ARTIFACT_ICONS, artifactsHostKey } from './artifactPath'
import { artifactRefsOf, mergeRefs, recordedRefs, resolveArtifacts } from './artifacts'
import { ArtifactsPanel, type ArtifactRequest } from './ArtifactsPanel'
import { ChatsHome } from './ChatsHome'
import { onShowArtifact } from './show'
import { useChatRows, type ChatGroups, type ChatRow } from './useChatRows'
import './ChatsView.css'

const ConversationEmbed = lazy(() => import('../conversations/ConversationEmbed'))

const isLocal = isLocalHost()

/**
 * `/chats` — chats as a place of their own. On the left every chat: the ones open in this browser, every one the
 * Library has recorded, and imported transcripts. With none chosen, the landing (`ChatsHome`) — a composer that
 * starts a chat, and what recent chats made. With one chosen, the conversation, full size, and — when there is
 * something to show — its **artifacts** sliding in beside it: what the assistant made or changed, each open as a
 * tab (a document, a diagram, a map, an entity's detail view, a scene in Unigraph). The chat is the same one the
 * assistant panel shows (the panel steps aside while this page is open); opening a recorded chat continues it.
 */
export function ChatsView() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const store = useEntityStore()
  useStoreVersion(store)
  const host = useAppHost()
  useBridge()
  const backend = currentBackend()
  const canChat = backend !== null
  const rows = useChatRows()

  useEffect(() => {
    chats.attachHost(host)
  }, [host])

  // What the address names: nothing (the landing), a chat open here, a recorded chat (continued in a tab of its own),
  // or an imported one (read).
  const live = id ? chats.get(id) : undefined
  const entity = !live && id ? store.get(id) : undefined
  const recordedChatId = isConversation(entity) && entity.data.source === 'assistant' && typeof entity.data.sourceId === 'string' ? entity.data.sourceId : undefined
  useEffect(() => {
    if (live) {
      if (chats.active() !== live) chats.open(live.id)
      return
    }
    if (recordedChatId) {
      const s = chats.resume(entity)
      if (s) navigate(`/chats/${s.id}${params.size ? `?${params}` : ''}`, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, live, recordedChatId])

  // Nothing to answer with yet: settings first. Opened for that reason only, they step aside once the bridge connects
  // (it is often still connecting on the first render) — as the assistant panel does.
  const [showSettings, setShowSettings] = useState(!canChat)
  const settingsForLack = useRef(!canChat)
  useEffect(() => {
    if (canChat && settingsForLack.current) {
      settingsForLack.current = false
      setShowSettings(false)
    }
  }, [canChat])
  const imported = isConversation(entity) && !recordedChatId ? entity : undefined
  const placeholder = backend === 'claude-code' ? 'Ask Claude Code…' : canChat ? 'Ask or instruct…' : isLocal ? 'Connect Claude Code (see settings) to chat' : 'Add your API key, or connect Claude Code, in settings to chat'
  // The landing's composer: its first message is a new chat's.
  const start = (text: string, attachments: Attachment[] = []) => {
    const s = chats.create()
    navigate(`/chats/${s.id}`)
    void s.send(text, attachments)
  }

  return (
    <div className="chats">
      <ChatList groups={rows} current={live?.id ?? id} home={!id} />

      <section className="chats__main">
        {!id ? (
          <ChatsHome groups={rows} canChat={canChat} placeholder={placeholder} onStart={start} showSettings={showSettings} onSettings={setShowSettings} />
        ) : live ? (
          <LiveChat key={live.id} session={live} canChat={canChat} placeholder={placeholder} showSettings={showSettings} setShowSettings={setShowSettings} navigate={host.navigate} />
        ) : imported ? (
          <div className="chats__imported">
            <header className="chats__head">
              <span className="chats__title">{imported.label || 'Untitled chat'}</span>
              <span className="muted chats__sub">Imported · {imported.data.source} · read only</span>
            </header>
            <div className="chats__imported-body">
              <Suspense fallback={<div className="page-loading">Loading…</div>}>
                <ConversationEmbed conversation={imported} />
              </Suspense>
            </div>
          </div>
        ) : (
          <div className="chats__empty muted">
            {recordedChatId ? 'Opening…' : 'That chat is not here — it may have been deleted, or belong to a project that is not open.'}
            {!recordedChatId && (
              <button className="btn btn--sm" onClick={() => navigate('/chats')}>
                <Home size={13} /> Back to Chats
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * The list of chats, memoised: it renders when the rows change (a chat's title, its busy state, a record written),
 * never for a token a running chat streams — with thousands of imported conversations a render of it is not cheap.
 */
const ChatList = memo(function ChatList({ groups: all, current, home }: { groups: ChatGroups; current?: string; home: boolean }) {
  const navigate = useNavigate()
  const store = useEntityStore()
  const [query, setQuery] = useState('')
  // A row's right-click menu, and the chat it asks to delete.
  const [menu, setMenu] = useState<{ row: ChatRow; x: number; y: number } | null>(null)
  const [deleting, setDeleting] = useState<ChatRow | null>(null)
  const onMenu = (row: ChatRow, x: number, y: number) => setMenu({ row, x, y })
  const menuItems = (r: ChatRow): MenuItem[] => [
    { kind: 'item', label: 'Open', icon: MessagesSquare, onSelect: () => navigate(r.to) },
    ...(r.open ? [{ kind: 'item' as const, label: 'Close', icon: X, onSelect: () => chats.close(r.key) }] : []),
    { kind: 'sep' },
    { kind: 'item', label: 'Delete…', icon: Trash2, danger: true, onSelect: () => setDeleting(r) },
  ]
  const confirmDelete = () => {
    if (!deleting) return
    const gone = chats.delete(deleting.key, store)
    // Deleting the chat on screen goes back to the landing.
    if (current && (deleting.key === current || gone?.chat === current)) navigate('/chats')
    setDeleting(null)
  }
  const q = query.trim().toLowerCase()
  // The groups come sorted and split (`useChatRows`): only a search walks them, each on its own.
  const groups = useMemo(() => {
    if (!q) return all
    const has = (r: ChatRow) => r.title.toLowerCase().includes(q)
    return { open: all.open.filter(has), earlier: all.earlier.filter(has), imported: all.imported.filter(has) }
  }, [all, q])
  const shown = { length: groups.open.length + groups.earlier.length + groups.imported.length }
  return (
    <aside className="chats__list" aria-label="Chats">
      <div className="chats__list-head">
        <button className={`chats__home ${home ? 'is-active' : ''}`} title="Chats — start one, or pick up where you were" onClick={() => navigate('/chats')}>
          <MessagesSquare size={15} />
          <span>Chats</span>
        </button>
        <span className="spacer" />
        <button className="btn btn--sm btn--icon btn--ghost" title="New chat" onClick={() => navigate('/chats')}>
          <Plus size={15} />
        </button>
      </div>
      <label className="chats__search">
        <Search size={13} className="faint" />
        <input placeholder="Find a chat" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {/* Nothing to list: the placeholder sits in the middle of the empty column rather than at the top of it. */}
      <div className={`chats__rows${shown.length ? '' : ' chats__rows--empty'}`}>
        <RowGroup label="Open" rows={groups.open} current={current} onClose={(key) => chats.close(key)} onMenu={onMenu} />
        <RowGroup label="Earlier" rows={groups.earlier} current={current} onMenu={onMenu} />
        {/* An imported library can be thousands of transcripts: folded until asked for (a search opens it). */}
        <RowGroup label="Imported" rows={groups.imported} current={current} folded={!q} onMenu={onMenu} />
        {!shown.length && <p className="chats__none muted">{q ? 'No chat matches.' : 'Your chats will appear here'}</p>}
      </div>
      {menu && <Menu x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={() => setMenu(null)} />}
      <ConfirmDialog
        open={!!deleting}
        title="Delete this chat?"
        message={deleting ? `“${deleting.title}” — its transcript and its record in the project are deleted${deleting.busy ? ', and the reply it is working on stopped' : ''}. What it made stays.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </aside>
  )
})

/** Rows drawn a page at a time: the first PAGE, then more on request — a group can hold thousands. */
const PAGE = 40

function RowGroup({ label, rows, current, onClose, onMenu, folded = false }: { label: string; rows: ChatRow[]; current?: string; onClose?: (key: string) => void; onMenu: (row: ChatRow, x: number, y: number) => void; folded?: boolean }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(!folded)
  const [limit, setLimit] = useState(PAGE)
  if (!rows.length) return null
  const expanded = open || !folded
  const visible = expanded ? rows.slice(0, limit) : []
  return (
    <div className="chats__group">
      {folded ? (
        <button className="chats__group-label chats__group-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {label} · {rows.length.toLocaleString()}
        </button>
      ) : (
        <div className="chats__group-label">
          {label}
          {rows.length > PAGE ? ` · ${rows.length.toLocaleString()}` : ''}
        </div>
      )}
      {visible.map((r) => (
        <div
          key={r.key}
          className={`chats__row ${r.key === current ? 'is-active' : ''}`}
          onContextMenu={(e) => {
            e.preventDefault()
            onMenu(r, e.clientX, e.clientY)
          }}
        >
          <button className="chats__row-open" onClick={() => navigate(r.to)} title={r.title}>
            {r.busy && <span className="ai__tab-busy" />}
            <span className="chats__row-title">{r.title}</span>
            {/* When, and how long — left out when there is neither; the row keeps its height and centres the title. */}
            {meta(r) && <span className="chats__row-meta">{meta(r)}</span>}
          </button>
          {onClose && (
            <button className="chats__row-close" title="Close this chat (its record stays under Earlier)" onClick={() => onClose(r.key)}>
              <X size={11} />
            </button>
          )}
        </div>
      ))}
      {expanded && rows.length > visible.length && (
        <button className="chats__more muted" onClick={() => setLimit((n) => n + PAGE * 5)}>
          Show {Math.min(PAGE * 5, rows.length - visible.length).toLocaleString()} more of {(rows.length - visible.length).toLocaleString()}
        </button>
      )}
    </div>
  )
}

const meta = (r: ChatRow) => [r.at ? formatDate(r.at) : '', r.messages ? `${r.messages.toLocaleString()} message${r.messages === 1 ? '' : 's'}` : r.open ? 'Not started' : ''].filter(Boolean).join(' · ')

const hasTabs = (chatId: string) => {
  try {
    return !!localStorage.getItem(artifactsHostKey(chatId))
  } catch {
    return false
  }
}

function LiveChat({ session, canChat, placeholder, showSettings, setShowSettings, navigate }: {
  session: AssistantSession
  canChat: boolean
  placeholder: string
  showSettings: boolean
  setShowSettings: (v: boolean | ((v: boolean) => boolean)) => void
  navigate: (path: string) => void
}) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const [params, setParams] = useSearchParams()
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  // Everything the chat has made: the record's list (earlier sessions of a resumed chat) with this session's on top.
  const artifacts = useMemo(
    () => resolveArtifacts(mergeRefs(recordedRefs(store.get(chatEntityId(session.id))), artifactRefsOf(state.items)), store),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.items, version, session.id, store],
  )

  // The panel is not there until you open something in it: the header's Artifacts menu, a tool card's Show, a link
  // with `?artifact=`, or the chat tool's show when you ask the assistant to. Nothing the chat does on its own opens
  // it. It goes when its last tab closes.
  const [panelOpen, setPanelOpen] = useState(false)
  // Every request to show something, in order (the last few kept): a turn that makes three documents asks three times
  // in a burst, and one request held in state kept only the last of them.
  const [requests, setRequests] = useState<ArtifactRequest[]>([])
  const next = useRef(0)
  const show = (id: EntityId, graph = false) => {
    setPanelOpen(true)
    const r = { id, n: ++next.current, graph }
    setRequests((q) => [...q.slice(-15), r])
  }
  const asked = params.get('artifact')
  useEffect(() => {
    if (!asked) return
    show(asked)
    params.delete('artifact')
    setParams(params, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked])
  useEffect(
    () =>
      onShowArtifact((chatId, artifact) => {
        if (chatId !== session.id) return false
        show(artifact)
        return true
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.id],
  )

  const title = session.title()
  const stored = hasTabs(session.id)
  const menuItems: MenuItem[] = [
    { kind: 'label', label: artifacts.length ? `What this chat made · ${artifacts.length}` : 'Nothing made yet' },
    ...artifacts.map((a): MenuItem => ({ kind: 'item', label: displayLabel(a.entity), icon: ARTIFACT_ICONS[a.kind], onSelect: () => show(a.id) })),
    ...(artifacts.length > 1 ? [{ kind: 'sep' } as MenuItem, { kind: 'item', label: 'Graph of this chat', icon: Network, onSelect: () => show('graph', true) } as MenuItem] : []),
  ]

  return (
    <div className="chats__chat">
      <div className="chats__thread">
        <header className="chats__head">
          {renaming !== null ? (
            <input
              className="chats__rename"
              autoFocus
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={() => {
                chats.rename(session.id, renaming)
                setRenaming(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <button className="chats__title" title="Double-click to rename" onDoubleClick={() => setRenaming(title)}>
              {title}
            </button>
          )}
          <span className="spacer" />
          <button
            className={`chats__artifacts-btn ${artifacts.length ? '' : 'is-empty'}`}
            title="What this chat made — open one beside the chat"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setMenu({ x: r.left, y: r.bottom + 4, anchor: e.currentTarget })
            }}
          >
            Artifacts
            {artifacts.length > 0 && <span className="chats__count">{artifacts.length}</span>}
            <ChevronDown size={13} />
          </button>
          {(panelOpen || stored) && (
            <button className="btn btn--sm btn--icon btn--ghost" title={panelOpen ? 'Hide the artifacts' : 'Show the artifacts you had open'} onClick={() => setPanelOpen((v) => !v)}>
              {panelOpen ? <PanelRightClose size={15} /> : <PanelRight size={15} />}
            </button>
          )}
          <button className="btn btn--sm btn--icon btn--ghost" title="Download this chat's transcript (Markdown)" disabled={!state.items.length} onClick={() => downloadTranscript(session, 'markdown')}>
            <Download size={14} />
          </button>
          <button className={`btn btn--sm btn--icon btn--ghost ${showSettings ? 'is-active' : ''}`} title="Assistant settings" onClick={() => setShowSettings((v) => !v)}>
            <Settings2 size={14} />
          </button>
          {menu && <Menu x={menu.x} y={menu.y} anchor={menu.anchor} items={menuItems} onClose={() => setMenu(null)} />}
        </header>
        <div className="ai chats__ai">
          <ChatThread
            session={session}
            navigate={navigate}
            canChat={canChat}
            placeholder={placeholder}
            replace={showSettings ? <SettingsPane onClose={() => setShowSettings(false)} /> : undefined}
            onSent={() => setShowSettings(false)}
            onArtifact={(id) => show(id)}
            welcome={() => (
              <div className="ai__welcome">
                <p>Ask about anything in the workspace, or hand the assistant work. What it makes — documents, diagrams, maps, scenes, entities — is kept with the chat under Artifacts, to open beside it.</p>
              </div>
            )}
          />
        </div>
      </div>
      <ArtifactsPanel chatId={session.id} chatTitle={title} artifacts={artifacts} requests={requests} open={panelOpen} onEmpty={() => setPanelOpen(false)} />
    </div>
  )
}
