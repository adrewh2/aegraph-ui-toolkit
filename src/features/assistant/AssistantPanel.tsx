import { Braces, Cable, Download, FileText, KeyRound, Mic, Plus, Settings2, Sparkles, Volume2, X } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { DOCUMENT_SUGGESTIONS, SHOWCASES } from './suggestions'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Menu } from '../../components/ui/Menu'
import { EFFORT_LEVELS, MODELS, hasApiCredentials, isLocalHost, setAiSettings, useAiSettings, type Effort } from '../../core/ai/settings'
import { bridge, useBridge } from '../bridge/bridge'
import { describeAccess, openAiAccess, resolveEngine } from '../voice/access'
import { OPENAI_STT_MODELS, OPENAI_VOICES, PAUSE_OPTIONS, setVoiceSettings, useVoiceSettings, type VoiceEngineSetting } from '../voice/settings'
import { browserVoices } from '../voice/speakers'
import { useVoice, voice } from '../voice/voice'
import { ChatThread } from './ChatThread'
import { chats, useChats, type ChatTab } from './chats'
import { loadChats } from './instance'
import { currentBackend } from './session'
import { downloadTranscript } from './transcript'
import { useAppHost } from './useAppHost'
import './AssistantPanel.css'
import { Select } from '../../components/ui/Select'

/** The Claude Code bridge only makes sense against a dev server on this machine. */
const isLocal = isLocalHost()


export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const host = useAppHost()
  // On a document's page the suggestions are about that document; elsewhere, what the app can do.
  const onDocument = /^\/documents\/[^/]+/.test(useLocation().pathname)
  const settings = useAiSettings()
  // Who answers, as of this render: the API with the user's key, or Claude Code over the bridge. The bridge
  // subscription is what re-renders this when a server connects.
  useBridge()
  const backend = currentBackend()
  const modelLabel = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id
  const canChat = backend !== null
  const { tabs, active: session } = useChats()
  const empty = useSyncExternalStore(session.subscribe, () => session.getState().items.length === 0, () => session.getState().items.length === 0)
  // Nothing to answer with: open on settings. Opened for that reason only, the pane steps aside once the bridge connects.
  const [showSettings, setShowSettings] = useState(!canChat)
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  const settingsForLackOfBackend = useRef(!canChat)
  useEffect(() => {
    if (canChat && settingsForLackOfBackend.current) {
      settingsForLackOfBackend.current = false
      setShowSettings(false)
    }
  }, [canChat])

  useEffect(() => {
    chats.attachHost(host)
    void loadChats() // registers these (already loaded) chats as the shared ones for voice control
  }, [host])

  return (
    <aside className="ai" aria-label="Assistant">
      <header className="ai__head">
        <Sparkles size={15} className="ai__spark" />
        <span className="ai__title">Assistant</span>
{canChat && (
        <span className="ai__model muted" title={backend === 'claude-code' ? 'Answers come from Claude Code over the local bridge, on your subscription' : undefined}>
          {backend === 'claude-code' ? 'Claude Code' : modelLabel(settings.model)}
        </span>
        )}
        <span className="spacer" />
        <button className="btn btn--sm btn--icon btn--ghost" title="New chat (a new tab)" onClick={() => chats.create()}>
          <Plus size={14} />
        </button>
        <button className="btn btn--sm btn--icon btn--ghost" title="Download this chat's transcript — every message and tool call, with inputs, results and timings" disabled={empty} onClick={(e) => setExportMenu({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget })}>
          <Download size={14} />
        </button>
        {exportMenu && (
          <Menu
            x={exportMenu.x}
            y={exportMenu.y}
            anchor={exportMenu.anchor}
            onClose={() => setExportMenu(null)}
            items={[
              { kind: 'label', label: 'Download transcript' },
              { kind: 'item', label: 'Markdown (readable)', icon: FileText, onSelect: () => downloadTranscript(session, 'markdown') },
              { kind: 'item', label: 'JSON (with API history)', icon: Braces, onSelect: () => downloadTranscript(session, 'json') },
            ]}
          />
        )}
        <button className={`btn btn--sm btn--icon btn--ghost ${showSettings ? 'is-active' : ''}`} title="Settings" onClick={() => setShowSettings((v) => !v)}>
          <Settings2 size={14} />
        </button>
        <button className="btn btn--sm btn--icon btn--ghost" title="Close (⌘J)" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      {(tabs.length > 1 || !empty) && (
        <div className="ai__tabs" role="tablist" aria-label="Chats">
          {tabs.map((t) => (
            <ChatTabButton key={t.id} tab={t} onOpen={() => chats.open(t.id)} onClose={() => chats.close(t.id)} onRename={(name) => chats.rename(t.id, name)} />
          ))}
          <button className="ai__tab-add" title="New chat" onClick={() => chats.create()}>
            <Plus size={12} />
          </button>
        </div>
      )}

      <ChatThread
        session={session}
        navigate={host.navigate}
        canChat={canChat}
        placeholder={backend === 'claude-code' ? 'Ask Claude Code…' : canChat ? 'Ask or instruct…' : isLocal ? 'Connect Claude Code (see settings) to chat' : 'Add your API key, or connect Claude Code, in settings first'}
        replace={showSettings ? <SettingsPane onClose={() => setShowSettings(false)} /> : undefined}
        onSent={() => setShowSettings(false)}
        welcome={(fill) => (
      <div className="ai__welcome">
        <p>
          Ask about anything in the workspace, or hand me work: fetch data from the web and explore it in Unigraph, write documents and link what they share, put places on a map or the globe, tag and link entities. I act through the same entity model you see in the app.
        </p>
        <div className="ai__suggestions">
          {onDocument
            ? DOCUMENT_SUGGESTIONS.map((s) => (
                <button key={s} className="ai__suggestion" onClick={() => fill(s)}>
                  {s}
                </button>
              ))
            : SHOWCASES.slice(0, 4).map((s) => (
                <button key={s.title} className="ai__suggestion" title={s.prompt} onClick={() => fill(s.prompt)}>
                  <strong>{s.title}</strong>
                  <span className="ai__suggestion-hint">{s.hint}</span>
                </button>
              ))}
        </div>
        {!hasApiCredentials(settings) && backend !== 'claude-code' && (
          <div className="ai__connect">
            <button className="btn btn--sm" onClick={() => setShowSettings(true)}>
              {isLocal ? <Cable size={13} /> : <KeyRound size={13} />} {isLocal ? 'Connect Claude Code to begin' : 'Add your API key to begin'}
            </button>
            {isLocal && <BridgeOption compact />}
          </div>
        )}
        {backend === 'claude-code' && (
          <p className="ai__bridge ai__bridge--compact">
            <Cable size={13} className="faint" />
            <span>Connected to Claude Code — messages run on your subscription, with the same tools.</span>
          </p>
        )}
      </div>
        )}
      />
    </aside>
  )
}

/** One chat's tab: click to open, × to close, double-click to rename. A dot pulses while its chat is busy. */
function ChatTabButton({ tab, onOpen, onClose, onRename }: { tab: ChatTab; onOpen: () => void; onClose: () => void; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(tab.title)
  if (editing)
    return (
      <input
        className="ai__tab-edit"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          setEditing(false)
          onRename(name)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setEditing(false)
            onRename(name)
          }
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  return (
    <div className={`ai__tab ${tab.active ? 'is-active' : ''}`} role="tab" aria-selected={tab.active} title={tab.title}>
      <button
        className="ai__tab-open"
        onClick={onOpen}
        onDoubleClick={() => {
          setName(tab.title)
          setEditing(true)
        }}
      >
        {tab.busy && <span className="ai__tab-busy" />}
        <span className="ai__tab-title">{tab.title}</span>
      </button>
      <button className="ai__tab-close" title="Close this chat" onClick={onClose}>
        <X size={11} />
      </button>
    </div>
  )
}

export function SettingsPane({ onClose }: { onClose: () => void }) {
  const s = useAiSettings()
  const [apiKey, setApiKey] = useState(s.apiKey)
  const [model, setModel] = useState(s.model)
  const [effort, setEffort] = useState<Effort>(s.effort)
  const [codeModel, setCodeModel] = useState(s.codeModel)
  const [codeEffort, setCodeEffort] = useState<Effort>(s.codeEffort)
  const [viaClaudeCode, setViaClaudeCode] = useState(s.viaClaudeCode)
  const b = useBridge()
  const keyRef = useRef<HTMLInputElement>(null)
  const connected = hasApiCredentials(s)
  useEffect(() => {
    // Nothing set yet on a deployed copy: the cursor goes to the key.
    if (!connected && !isLocal) keyRef.current?.focus({ preventScroll: true })
  }, [connected])
  const save = () => {
    setAiSettings({ apiKey: apiKey.trim(), model, effort, viaClaudeCode, codeModel, codeEffort })
    onClose()
  }
  return (
    <div className="ai__settings">
      <div className="ai__settings-head">
        <KeyRound size={14} className="faint" />
        <span className="ai__settings-title">{connected || isLocal ? 'Assistant settings' : 'Connect to Claude'}</span>
      </div>
      {isLocal ? (
        // Locally the chat is Claude Code only (no key, no proxy) and voice is the OpenAI key in .env.local: nothing to connect here.
        <p className="ai__settings-note muted">Running locally, the assistant answers through Claude Code only — the Claude API is never called from this machine — and voice uses the OpenAI key in .env.local.</p>
      ) : (
        <div className="field">
          <label>Anthropic API key</label>
          <input ref={keyRef} className="input" type="password" autoComplete="off" placeholder="sk-ant-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          <span className="muted" style={{ fontSize: 12 }}>
            Stored in this browser only and sent straight from it to the Claude API. Or connect Claude Code (the Claude Code entry in the sidebar) and chat on your subscription with no key.
          </span>
        </div>
      )}
      {!isLocal && (
        <>
          <div className="field">
            <label>Model</label>
            <Select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>Effort</label>
            <Select className="input" value={effort} onChange={(e) => setEffort(e.target.value as Effort)}>
              {EFFORT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
            <span className="muted" style={{ fontSize: 12 }}>
              Lower effort is faster and cheaper; high is a good default for editing work.
            </span>
          </div>
        </>
      )}
      {(isLocal || b.enabled) && (
        <>
          <div className="field">
            <label>{isLocal ? 'Model' : 'Model — through Claude Code'}</label>
            <Select className="input" value={codeModel} onChange={(e) => setCodeModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>{isLocal ? 'Effort' : 'Effort — through Claude Code'}</label>
            <Select className="input" value={codeEffort} onChange={(e) => setCodeEffort(e.target.value as Effort)}>
              {EFFORT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
            <span className="muted" style={{ fontSize: 12 }}>
              Sonnet writes several times faster than Opus; lower effort thinks less before it answers. Opus at high is slower and more careful. A spoken turn always runs at low.
            </span>
          </div>
        </>
      )}
      <VoiceSettingsFields />
      {isLocal && <BridgeOption />}
      {!isLocal && b.enabled && (
        <label className="ai__bridge-toggle ai__bridge-prefer">
          <input type="checkbox" checked={viaClaudeCode} onChange={(e) => setViaClaudeCode(e.target.checked)} />
          <span>
            Answer through Claude Code even when a key is set
            <span className="muted ai__bridge-hint">Without a key, the chat goes to Claude Code whenever the bridge is connected.</span>
          </span>
        </label>
      )}
      <div className="ai__settings-actions">
        <button className="btn btn--sm" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--sm btn--primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  )
}

/**
 * How the assistant listens and sounds. These apply as they are changed (no Save needed): the listener — the
 * browser's recogniser, or OpenAI transcription of each command — the speaker — the browser's best voice, or
 * OpenAI's neural voices — the OpenAI key both use (kept in this browser), and the pause that ends a command.
 */
function VoiceSettingsFields() {
  const vs = useVoiceSettings()
  const st = useVoice()
  const access = openAiAccess()
  const [voices, setVoices] = useState<{ name: string; lang: string }[]>([])
  useEffect(() => {
    void browserVoices().then((list) => setVoices(list.map((v) => ({ name: v.name, lang: v.lang }))))
  }, [])
  const lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US'
  const base = lang.split('-')[0]
  // The language's voices first, then the rest, novelty ones and all — the user may want one.
  const ordered = useMemo(() => [...voices].sort((a, b) => Number(b.lang.startsWith(base)) - Number(a.lang.startsWith(base)) || a.name.localeCompare(b.name)), [voices, base])
  const test = () => void voice.speak('This is how replies will sound. Filtered the graph to 84 people around Ada; the three hubs are Babbage, Lovelace and Menabrea.')
  return (
    <div className="ai__voice-settings">
      <div className="ai__settings-head">
        <Mic size={14} className="faint" />
        <span className="ai__settings-title">Voice</span>
      </div>
      <p className="ai__settings-note muted">
        Automatic uses OpenAI when it can be reached — with a key of your own below{isLocal ? ', or the key in .env.local, served by the dev server' : ''} — and the browser otherwise. Right now: <strong>{describeAccess(access)}</strong>.
      </p>
      <div className="field">
        <label>Listener</label>
        <Select className="input" value={vs.listener} onChange={(e) => setVoiceSettings({ listener: e.target.value as VoiceEngineSetting })}>
          <option value="auto">Automatic — {resolveEngine('auto', access) === 'openai' ? 'OpenAI transcription' : 'browser recognition'}</option>
          <option value="browser">Browser recognition (free; hears names poorly)</option>
          <option value="openai">OpenAI transcription</option>
        </Select>
        {resolveEngine(vs.listener, access) === 'openai' ? (
          <>
            <Select className="input" value={vs.openaiSttModel} onChange={(e) => setVoiceSettings({ openaiSttModel: e.target.value as typeof vs.openaiSttModel })} style={{ marginTop: 6 }}>
              {OPENAI_STT_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m} {m.includes('mini') ? '— $0.003 a minute, the default' : '— $0.006 a minute, for hard audio'}
                </option>
              ))}
            </Select>
            <span className="muted" style={{ fontSize: 12 }}>
              Each command is recorded until you stop talking, then transcribed whole — names and long sentences come through — with the names on screen as a hint.
            </span>
          </>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>Chrome's own recogniser streams words as you speak; fine for short commands.</span>
        )}
      </div>
      {(vs.listener !== 'browser' || vs.speaker !== 'browser') && (
        <div className="field">
          <label>OpenAI API key {access?.kind === 'local' ? '(optional — .env.local has one)' : ''}</label>
          <input className="input" type="password" autoComplete="off" placeholder={access?.kind === 'local' ? 'Only to use your own instead' : 'sk-…'} value={vs.openaiKey} onChange={(e) => setVoiceSettings({ openaiKey: e.target.value.trim() })} />
          <span className="muted" style={{ fontSize: 12 }}>
            Stored in this browser only and sent straight to OpenAI; used for transcription (gpt-4o-mini-transcribe) and speech (gpt-4o-mini-tts) as chosen here. Anything that fails falls back to the browser.
          </span>
        </div>
      )}
      <div className="field">
        <label>Speaker</label>
        <Select className="input" value={vs.speaker} onChange={(e) => setVoiceSettings({ speaker: e.target.value as VoiceEngineSetting })}>
          <option value="auto">Automatic — {resolveEngine('auto', access) === 'openai' ? 'OpenAI neural voice' : 'browser voice'}</option>
          <option value="browser">Browser voice</option>
          <option value="openai">OpenAI neural voice</option>
        </Select>
      </div>
      {resolveEngine(vs.speaker, access) === 'browser' ? (
        <div className="field">
          <label>Voice</label>
          <Select className="input" value={vs.browserVoice} onChange={(e) => setVoiceSettings({ browserVoice: e.target.value })}>
            <option value="">Best available for {lang}</option>
            {ordered.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} · {v.lang}
              </option>
            ))}
          </Select>
          <span className="muted" style={{ fontSize: 12 }}>
            {st.canSpeak ? 'Premium and enhanced voices sound much better than the default; on a Mac, download them in System Settings › Accessibility › Spoken Content.' : 'This browser cannot speak.'}
          </span>
        </div>
      ) : (
        <div className="field">
          <label>Voice</label>
          <Select className="input" value={vs.openaiVoice} onChange={(e) => setVoiceSettings({ openaiVoice: e.target.value as typeof vs.openaiVoice })}>
            {OPENAI_VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className="field">
        <label>Dictation ends after</label>
        <Select className="input" value={vs.pauseMs} onChange={(e) => setVoiceSettings({ pauseMs: Number(e.target.value) })}>
          {PAUSE_OPTIONS.map((o) => (
            <option key={o.ms} value={o.ms}>
              {o.label}
            </option>
          ))}
        </Select>
        <span className="muted" style={{ fontSize: 12 }}>
          A command is as long as you keep talking; this silence ends it. With the browser recogniser you can also end it with “send it” or “that's all”.
        </span>
      </div>
      <div>
        <button className="btn btn--sm" onClick={test} disabled={!st.canSpeak}>
          <Volume2 size={13} /> Test the voice
        </button>
        {st.error && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{st.error}</span>}
      </div>
    </div>
  )
}

/**
 * Running locally, Claude Code can drive this tab over the MCP bridge instead — the same tools, on the
 * user's subscription, with no API key. Compact form is a one-line hint; the full form has the toggle.
 */
function BridgeOption({ compact }: { compact?: boolean }) {
  const b = useBridge()
  const status = b.status === 'connected' ? `connected · ${b.calls} call${b.calls === 1 ? '' : 's'}` : b.status === 'connecting' ? 'waiting for the server…' : 'off'
  if (compact) {
    return (
      <div className="ai__bridge ai__bridge--compact">
        <Cable size={13} className="faint" />
        <span>
          Or, running locally: <button className="ai__link" onClick={() => bridge.setEnabled(true)}>connect Claude Code</button> over MCP — no key needed.
        </span>
        {b.enabled && <span className={`ai__bridge-state ai__bridge-state--${b.status}`}>{status}</span>}
      </div>
    )
  }
  return (
    <div className="ai__bridge">
      <label className="ai__bridge-toggle">
        <input type="checkbox" checked={b.enabled} onChange={(e) => bridge.setEnabled(e.target.checked)} />
        <span>
          <span className="ai__bridge-title">
            <Cable size={13} className="faint" /> Connect Claude Code (local MCP)
          </span>
          <span className={`ai__bridge-state ai__bridge-state--${b.status}`}>{status}</span>
        </span>
      </label>
      <p className="ai__settings-note muted">
        Two-way, on your subscription — no API key. Claude Code drives this tab through the same tools, and this chat sends its messages to Claude Code (a <span className="mono">claude -p</span> turn per message; anything beyond the app's tools asks you first). Run <span className="mono">claude</span> in <span className="mono">aegraph-ui</span> (it picks up <span className="mono">.mcp.json</span>), or <span className="mono">npm run mcp</span>, and this tab connects to <span className="mono">{b.url}</span>.
      </p>
    </div>
  )
}
