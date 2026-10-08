import { typedAnswer } from '../voice/speech'
import { ArrowUp, Check, ChevronDown, ChevronRight, CircleHelp, FileText, Loader2, Mic, PanelRight, Square, Table2, Wrench, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Markdown } from '../../components/Markdown'
import { formatNumber } from '../../lib/format'
import { useVoice, voice } from '../voice/voice'
import { idsOfCall } from '../chats/artifacts'
import { useEntityStore } from '../../core/entity/hooks'
import { attachmentPath, type Attachment } from './attachments'
import { AttachButton, AttachmentTray } from './AttachmentTray'
import { useAttachmentTray } from './useAttachmentTray'
import type { AssistantSession, TranscriptItem } from './session'
import './AssistantPanel.css'

/**
 * One chat's thread: the transcript, the question the assistant is waiting on, the composer and the token count.
 * The assistant panel (the dock) and the Chats page both show a chat through this, so a chat reads and behaves
 * the same wherever it is open. What surrounds it — tabs, settings, the welcome, the artifacts — is the host's.
 */
export interface ChatThreadProps {
  session: AssistantSession
  /** Where an in-app link in an answer goes (stays in the router, so the chat stays put). */
  navigate: (path: string) => void
  canChat: boolean
  placeholder: string
  /** Shown while the chat is empty; `fill` puts a suggestion in the composer. */
  welcome?: (fill: (text: string) => void) => ReactNode
  /** Shown instead of the transcript (the panel's settings). */
  replace?: ReactNode
  /** Called when a message is sent. */
  onSent?: () => void
  /** Given, each tool card that made or changed something offers to show it (the Chats page's artifacts panel). */
  onArtifact?: (id: string) => void
}

export function ChatThread({ session, navigate, canChat, placeholder, welcome, replace, onSent, onArtifact }: ChatThreadProps) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const voiceState = useVoice()
  // Files waiting to go with the next message (picked, dropped anywhere on the thread, or pasted); entities once it is sent.
  const focusInput = useCallback(() => inputRef.current?.focus(), [])
  const tray = useAttachmentTray({ enabled: canChat, onAdded: focusInput })

  // A new chat wants the cursor.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [session])

  // Stuck to the newest message: when a chat opens (a reload included), as a reply streams in, and as anything in the
  // transcript grows after it is drawn (Markdown, an image, a tool card opening). Scrolling up lets go, so reading back
  // is never yanked away; scrolling back to the bottom, or sending, holds again.
  const stuck = useRef(true)
  const empty = state.items.length === 0
  useLayoutEffect(() => {
    stuck.current = true
  }, [session])
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const toBottom = () => {
      if (stuck.current) el.scrollTop = el.scrollHeight
    }
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const grows = new ResizeObserver(toBottom)
    grows.observe(el)
    for (const child of Array.from(el.children)) grows.observe(child)
    toBottom()
    return () => {
      el.removeEventListener('scroll', onScroll)
      grows.disconnect()
    }
  }, [session, empty, replace])
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [state.items, state.busy])

  const send = async () => {
    // A question is waiting and the draft answers it ("yes", "no", or the button's word): that is the answer.
    const waiting = state.items.find((i): i is Extract<TranscriptItem, { kind: 'confirm' }> => i.kind === 'confirm' && i.answer === undefined)
    const typed = waiting && !tray.files.length ? typedAnswer(draft, waiting.yes) : undefined
    if (waiting && typed !== undefined) {
      setDraft('')
      session.answer(waiting.id, typed)
      return
    }
    if ((!draft.trim() && !tray.files.length) || state.busy || tray.attaching) return
    const text = draft
    const attached = await tray.take()
    if (!attached) return
    setDraft('')
    stuck.current = true
    onSent?.()
    void session.send(text, attached)
  }
  const fill = useCallback((text: string) => {
    setDraft(text)
    inputRef.current?.focus()
  }, [])

  return (
    <>
      <div ref={scrollRef} className={`ai__scroll ${tray.dropping ? 'is-dropping' : ''}`} {...tray.dropProps}>
        {replace ? (
          replace
        ) : empty ? (
          welcome && <Slot render={welcome} fill={fill} />
        ) : (
          <div
            className="ai__items"
            onClick={(e) => {
              // A link into the app in an answer (/docs/explorer#large-graphs, /entities?type=…) stays in the router: no reload, the chat stays put.
              const a = (e.target as HTMLElement).closest('a')
              if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return
              const href = a.getAttribute('href') ?? ''
              if (href.startsWith('/') && !/\.[a-z0-9]+$/i.test(href)) {
                e.preventDefault()
                navigate(href)
              }
            }}
          >
            {state.items.map((item) => (
              // A question waiting for an answer is docked above the composer instead; the transcript keeps it once answered.
              (item.kind === 'confirm' || item.kind === 'question') && item.answer === undefined ? null : <Item key={item.id} item={item} session={session} onArtifact={onArtifact} navigate={navigate} />
            ))}
            {state.busy && !state.items.some((i) => i.kind === 'assistant' && i.streaming) && !state.items.some((i) => i.kind === 'tool' && i.status === 'running') && (
              <Thinking />
            )}
          </div>
        )}
      </div>

      {/* The question the assistant is waiting on, pinned where the eye goes: above the composer, marked as waiting. */}
      {state.items.filter((it): it is Extract<TranscriptItem, { kind: 'confirm' | 'question' }> => (it.kind === 'confirm' || it.kind === 'question') && it.answer === undefined).map((item) => (
        <div key={item.id} className="ai__pending" role="alertdialog" aria-live="assertive">
          <div className="ai__pending-head">
            <span className="ai__pending-dot" />
            {item.kind === 'confirm' ? 'Waiting for you to confirm' : 'Waiting for your answer'}
            {voiceState.enabled && <span className="muted ai__pending-hint">— click, or say it</span>}
          </div>
          <Item item={item} session={session} />
        </div>
      ))}
      <footer className={`ai__composer ${tray.dropping ? 'is-dropping' : ''}`} {...tray.dropProps}>
        <div className="ai__field">
          <AttachmentTray tray={tray} />
        <textarea
          ref={inputRef}
          className="ai__input"
          rows={3}
          title="↵ to send · ⇧↵ for a new line · drop or paste images, documents and data files to attach them"
          placeholder={tray.dropping ? 'Drop images, documents or data files to attach them' : placeholder}
          value={draft}
          disabled={!canChat}
          onPaste={tray.onPaste}
          onChange={(e) => {
            setDraft(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = Math.min(280, e.target.scrollHeight) + 'px'
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        </div>
        <AttachButton tray={tray} disabled={!canChat} />
        {voiceState.canListen && (
          <button
            className={`btn btn--sm btn--icon btn--ghost ai__mic ${voiceState.enabled ? 'is-on' : ''}`}
            title={voiceState.enabled ? 'Voice is on: speak to the assistant, replies are read aloud — click to turn off (⌘⇧U)' : voiceState.error ? `${voiceState.error} (⌘⇧U)` : 'Talk to the assistant: turn voice on (⌘⇧U)'}
            onClick={() => voice.toggle()}
          >
            <Mic size={14} />
          </button>
        )}
        {state.busy ? (
          <button className="btn btn--sm btn--icon ai__send" title="Stop" onClick={() => session.stop()}>
            <Square size={13} />
          </button>
        ) : (
          <button className="btn btn--sm btn--icon btn--primary ai__send" title={tray.attaching ? 'Adding the files to the project…' : 'Send'} onClick={() => void send()} disabled={(!draft.trim() && !tray.files.length) || !canChat || tray.attaching}>
            {tray.attaching ? <Loader2 size={14} className="ai__spin" /> : <ArrowUp size={14} />}
          </button>
        )}
      </footer>
      {(state.usage.input > 0 || state.usage.output > 0) && (
        <div className="ai__usage muted" title="Tokens this chat (input / output / cache reads)">
          {formatNumber(state.usage.input)} in · {formatNumber(state.usage.output)} out{state.usage.cacheRead ? ` · ${formatNumber(state.usage.cacheRead)} cached` : ''}
        </div>
      )}
    </>
  )
}

/** "Thinking…" with how long it has been: a minute of silence reads as stuck, a counting clock as work. */
function Thinking() {
  const [s, setS] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setS((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="ai__thinking muted">
      <Loader2 size={13} className="ai__spin" /> Thinking…{s >= 3 ? ` ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}` : ''}
    </div>
  )
}

/** The welcome, rendered as its own component so the composer's `fill` is handed over rather than called here. */
function Slot({ render, fill }: { render: (fill: (text: string) => void) => ReactNode; fill: (text: string) => void }) {
  return <>{render(fill)}</>
}

/** What a sent message carried, as the entities it became: a click opens one (or shows it beside the chat, on the Chats page). */
function SentAttachments({ attachments, onOpen }: { attachments: Attachment[]; onOpen: (a: Attachment) => void }) {
  const store = useEntityStore()
  return (
    <div className="ai__attachments ai__attachments--sent">
      {attachments.map((a) => {
        const e = store.get(a.id)
        const src = a.kind === 'image' && e && typeof (e.data as { src?: unknown }).src === 'string' ? (e.data as { src: string }).src : undefined
        return (
          <button key={a.id} className={`ai__attachment ${e ? '' : 'is-gone'}`} title={e ? `Open ${a.label}` : `${a.label} is no longer in the project`} disabled={!e} onClick={() => onOpen(a)}>
            {src ? <img src={src} alt="" /> : a.kind === 'dataset' ? <Table2 size={14} /> : <FileText size={14} />}
            <span className="ai__attachment-name">{a.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function Item({ item, session, onArtifact, navigate }: { item: TranscriptItem; session: AssistantSession; onArtifact?: (id: string) => void; navigate?: (path: string) => void }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="ai__msg ai__msg--user">
          {item.attachments?.length ? <SentAttachments attachments={item.attachments} onOpen={(a) => (onArtifact ? onArtifact(a.id) : navigate?.(attachmentPath(a)))} /> : null}
          {item.text}
        </div>
      )
    case 'assistant':
      return (
        <div className={`ai__msg ai__msg--assistant ${item.streaming ? 'is-streaming' : ''}`}>
          <Markdown source={item.text} className="ai__md" />
        </div>
      )
    case 'tool':
      return <ToolCard item={item} onArtifact={onArtifact} />
    case 'confirm':
      return (
        <div className={`ai__confirm ${item.danger ? 'ai__confirm--danger' : ''}`}>
          <div>{item.message}</div>
          {item.answer === undefined ? (
            <div className="ai__confirm-actions">
              <button className="btn btn--sm" onClick={() => session.answer(item.id, false)}>
                Cancel
              </button>
              <button className={`btn btn--sm btn--primary ${item.danger ? 'btn--danger-solid' : ''}`} onClick={() => session.answer(item.id, true)}>
                {item.yes || 'Yes'}
              </button>
            </div>
          ) : (
            <div className="muted ai__confirm-answer">{item.stopped ? 'Not answered — you stopped the chat' : item.answer ? 'Confirmed' : 'Declined'}</div>
          )}
        </div>
      )
    case 'question':
      return (
        <div className="ai__confirm ai__question">
          <div>{item.message}</div>
          {item.answer === undefined ? (
            <div className="ai__confirm-actions ai__question-options">
              {item.options.map((o) => (
                <button key={o} className="btn btn--sm" onClick={() => session.answerQuestion(item.id, o)}>
                  {o}
                </button>
              ))}
              <button className="btn btn--sm btn--ghost" onClick={() => session.answerQuestion(item.id, null)}>
                None of these
              </button>
            </div>
          ) : (
            <div className="muted ai__confirm-answer">{item.stopped ? 'Not answered — you stopped the chat' : item.answer === null ? 'Declined' : `Chose “${item.answer}”`}</div>
          )}
        </div>
      )
    case 'error':
      return <div className="ai__error">{item.text}</div>
    case 'stopped':
      return (
        <div className="ai__stopped muted" role="status">
          <Square size={9} /> Stopped
        </div>
      )
  }
}

const TOOL_LABELS: Record<string, string> = {
  get_app_context: 'Looking at the current view',
  list_documents: 'Listing documents',
  read_document: 'Reading document',
  create_document: 'Creating document',
  write_document: 'Rewriting document',
  edit_document: 'Editing document',
  move_document: 'Moving document',
  view_image: 'Looking at image',
  annotate_image: 'Drawing a box',
  create_image: 'Adding image',
  annotate_video: 'Annotating video',
  capture_video_frame: 'Capturing a frame',
  create_video: 'Adding video',
  search_entities: 'Searching',
  get_entity: 'Inspecting entity',
  create_entity: 'Creating entity',
  update_entity: 'Updating entity',
  delete_entity: 'Deleting entity',
  create_relationship: 'Linking entities',
  annotate_document: 'Annotating',
  list_tags: 'Listing tags',
  list_entity_types: 'Reading the data model',
  open: 'Navigating',
  create_diagram: 'Drawing a diagram',
  write_diagram: 'Redrawing the diagram',
  view_diagram: 'Looking at the diagram',
  create_map: 'Making a map',
  add_location: 'Placing on the map',
  add_path: 'Drawing a route',
  add_area: 'Drawing an area',
  annotate_map: 'Noting on the map',
  graph_save: 'Saving the view',
  set_properties: 'Setting properties',
  tag_entities: 'Tagging',
  chat: 'Chats',
}

const isEmptyInput = (v: unknown) => !v || (typeof v === 'object' && Object.keys(v as object).length === 0)

function ToolCard({ item, onArtifact }: { item: Extract<TranscriptItem, { kind: 'tool' }>; onArtifact?: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  // What this call made or changed, when a page shows artifacts beside the chat: the first one gets a Show button.
  const artifact = useMemo(() => (onArtifact && item.status === 'done' ? idsOfCall(item.name, item.input, item.result)[0] : undefined), [onArtifact, item.status, item.name, item.input, item.result])
  const label = TOOL_LABELS[item.name] ?? item.name
  const hint = useMemo(() => {
    const i = item.input as Record<string, unknown> | undefined
    if (!i) return ''
    const v = i.title ?? i.query ?? i.page ?? i.id ?? i.document_id ?? i.label
    return typeof v === 'string' ? v.slice(0, 60) : ''
  }, [item.input])
  return (
    <div className={`ai__tool ai__tool--${item.status}`}>
      <button className="ai__tool-head" onClick={() => setOpen((o) => !o)}>
        {item.status === 'running' ? <Loader2 size={12} className="ai__spin" /> : item.status === 'error' ? <X size={12} /> : item.status === 'unknown' ? <CircleHelp size={12} /> : <Check size={12} />}
        <Wrench size={11} className="faint" />
        <span className="ai__tool-label">{label}</span>
        {hint && <span className="ai__tool-hint muted">{hint}</span>}
        {item.status === 'unknown' && <span className="ai__tool-writing muted">outcome unknown</span>}
        {item.status === 'running' && item.writing !== undefined && (
          // The model is still writing the call's input (a document's text, a diagram's source): how much so far.
          <span className="ai__tool-writing muted">{item.writing < 400 ? 'starting…' : `writing · ~${Math.round(item.writing / 6).toLocaleString()} words`}</span>
        )}
        <span className="spacer" />
        {open ? <ChevronDown size={12} className="faint" /> : <ChevronRight size={12} className="faint" />}
      </button>
      {artifact && (
        <button className="ai__tool-show" title="Show what this made beside the chat" onClick={() => onArtifact!(artifact)}>
          <PanelRight size={12} /> Show
        </button>
      )}
      {open && (
        <div className="ai__tool-body">
          {/* The input as it had arrived when the call was cut off, rather than an empty {}. */}
          {item.partial && isEmptyInput(item.input) ? (
            <>
              <div className="ai__tool-k">input (as far as it arrived)</div>
              <pre>{item.partial}…</pre>
            </>
          ) : (
            <>
              <div className="ai__tool-k">input</div>
              <pre>{JSON.stringify(item.input, null, 1)}</pre>
            </>
          )}
          {item.result !== undefined && (
            <>
              <div className="ai__tool-k">{item.status === 'error' ? 'error' : item.status === 'unknown' ? 'what happened' : 'result'}</div>
              <pre>{item.result.length > 3000 ? item.result.slice(0, 3000) + '…' : item.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

