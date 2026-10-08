import { ArrowUp, MessagesSquare, Settings2 } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import { formatDate } from '../../lib/format'
import { ARTIFACT_ICONS } from './artifactPath'
import type { ChatGroups } from './useChatRows'
import type { Attachment } from '../assistant/attachments'
import { SettingsPane } from '../assistant/AssistantPanel'
import { AttachButton, AttachmentTray } from '../assistant/AttachmentTray'
import { useAttachmentTray } from '../assistant/useAttachmentTray'
import { suggestionsFor } from '../assistant/suggestions'

const greeting = () => {
  const h = new Date().getHours()
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/**
 * `/chats` with no chat open — where a chat starts. A composer that becomes a new chat on the first message,
 * suggestions in the open project's words, the chats you were in last (each with what it made), and the things
 * chats made most recently, one click from opening beside their chat. Files dropped anywhere on the page, pasted or
 * picked go with the first message, as in a chat. With nothing to answer yet (no key, no bridge) the assistant's
 * settings stand in for the composer, as they do in a chat, and the composer's gear brings them back.
 */
export function ChatsHome({ groups, canChat, placeholder, onStart, showSettings, onSettings }: {
  groups: ChatGroups
  canChat: boolean
  placeholder: string
  onStart: (text: string, attachments: Attachment[]) => void
  showSettings: boolean
  onSettings: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const store = useEntityStore()
  useStoreVersion(store)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const focusInput = useCallback(() => input.current?.focus(), [])
  const tray = useAttachmentTray({ enabled: canChat, onAdded: focusInput })
  const project = store.scope ? store.get(store.scope) : undefined
  const suggestions = suggestionsFor(project ? displayLabel(project) : undefined)
  // The assistant's own chats, newest first: the open ones and the recorded ones (the imported never show here).
  const mine = useMemo(() => [...groups.open, ...groups.earlier].sort((a, b) => ((b.at ?? '') < (a.at ?? '') ? -1 : (b.at ?? '') > (a.at ?? '') ? 1 : 0)), [groups.open, groups.earlier])
  const recent = mine.slice(0, 6)
  const made = mine
    .flatMap((r) => r.recent.map((a) => ({ ...a, chat: r })))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i)
    .slice(0, 6)
  const start = async () => {
    const text = draft.trim()
    if (!text && !tray.files.length) return
    if (!canChat || tray.attaching) return
    const attached = await tray.take()
    if (!attached) return
    setDraft('')
    onStart(text, attached)
  }

  return (
    <div className="chome" {...tray.dropProps}>
      <div className="chome__inner">
        <header className="chome__hero">
          <p className="chome__greet muted">{greeting()}</p>
          <h1 className="chome__title">What are we working on?</h1>
          <p className="chome__lede muted">Ask about the workspace or hand over the work: bring in data from the web and explore it in Unigraph, write documents and link the ideas they share, put places on a map or the globe. What the assistant makes is kept with the chat, each piece a tab beside it.</p>
        </header>

        {showSettings ? (
          <div className="chome__settings">
            <SettingsPane onClose={() => onSettings(false)} />
          </div>
        ) : (
          <div className={`chome__composer${tray.dropping ? ' is-dropping' : ''}`} onClick={() => input.current?.focus()}>
            <AttachmentTray tray={tray} />
            <textarea
              ref={input}
              className="chome__input"
              rows={3}
              autoFocus
              placeholder={tray.dropping ? 'Drop images, documents or data files to attach them' : placeholder}
              value={draft}
              disabled={!canChat}
              onChange={(e) => {
                setDraft(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(320, e.target.scrollHeight) + 'px'
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void start()
                }
              }}
              onPaste={tray.onPaste}
            />
            <div className="chome__composer-foot">
              <AttachButton tray={tray} disabled={!canChat} />
              <span className="faint chome__hint">↵ to start · ⇧↵ for a new line · drop images, documents or data files to attach{project ? ` · in ${displayLabel(project)}` : ''}</span>
              <button
                className={canChat ? 'btn btn--sm btn--icon btn--ghost' : 'btn btn--sm'}
                title="Assistant settings"
                onClick={(e) => {
                  e.stopPropagation()
                  onSettings(true)
                }}
              >
                <Settings2 size={14} />
                {!canChat && ' Settings'}
              </button>
              <button className="btn btn--primary btn--icon chome__send" title={tray.attaching ? 'Adding the files to the project…' : 'Start the chat'} disabled={(!draft.trim() && !tray.files.length) || !canChat || tray.attaching} onClick={() => void start()}>
                <ArrowUp size={16} />
              </button>
            </div>
          </div>
        )}

        <div className="chome__suggestions">
          {suggestions.map((s) => (
            <button
              key={s.title}
              className="chome__suggestion"
              title={s.prompt}
              onClick={() => {
                setDraft(s.prompt)
                input.current?.focus()
              }}
            >
              <s.icon size={16} />
              <span className="chome__suggestion-text">
                <span className="chome__suggestion-title">{s.title}</span>
                <span className="chome__suggestion-hint">{s.hint}</span>
              </span>
            </button>
          ))}
        </div>

        {recent.length > 0 && (
          <section className="chome__section">
            <h2 className="chome__h2">Recent chats</h2>
            <div className="chome__cards">
              {recent.map((r) => (
                <button key={r.key} className="chome__card" onClick={() => navigate(r.to)}>
                  <div className="chome__card-head">
                    {r.busy ? <span className="ai__tab-busy" /> : <MessagesSquare size={14} className="faint" />}
                    <span className="chome__card-title">{r.title}</span>
                  </div>
                  {r.last && <p className="chome__card-last muted">{r.last}</p>}
                  <div className="chome__card-foot faint">
                    <span>{r.at ? formatDate(r.at) : ''}</span>
                    {r.messages > 0 && <span>· {r.messages} {r.messages === 1 ? 'message' : 'messages'}</span>}
                    <span className="spacer" />
                    {r.made.slice(0, 5).map((k, i) => {
                      const Icon = ARTIFACT_ICONS[k]
                      return <Icon key={i} size={13} />
                    })}
                    {r.made.length > 5 && <span>+{r.made.length - 5}</span>}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {made.length > 0 && (
          <section className="chome__section">
            <h2 className="chome__h2">Recently made</h2>
            <div className="chome__made">
              {made.map((a) => {
                const Icon = ARTIFACT_ICONS[a.kind]
                return (
                  <button key={a.id} className="chome__artifact" title={`Open beside “${a.chat.title}”`} onClick={() => navigate(`${a.chat.to}?artifact=${encodeURIComponent(a.id)}`)}>
                    <span className={`chome__artifact-icon chome__artifact-icon--${a.kind}`}>
                      <Icon size={16} />
                    </span>
                    <span className="chome__artifact-text">
                      <span className="chome__artifact-label">{a.label}</span>
                      <span className="chome__artifact-chat faint">{a.chat.title}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
