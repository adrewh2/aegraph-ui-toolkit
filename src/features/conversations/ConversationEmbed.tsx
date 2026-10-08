import { Copy, Search, Sparkles, Waypoints, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Markdown } from '../../components/Markdown'
import { useToast } from '../../components/ui/useToast'
import { useEntityStore } from '../../core/entity/hooks'
import { formatDate, formatNumber } from '../../lib/format'
import { messageTime, roleLabel, transcriptMarkdown, type ConversationEntity } from './conversation'
import './conversations.css'

/** The transcript as a chat: role-coloured bubbles, timestamps, in-thread search, copy as Markdown. */
export default function ConversationEmbed({ conversation }: { conversation: ConversationEntity }) {
  const toast = useToast()
  const store = useEntityStore()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const { messages, summary, topic, keywords, model, messageCount, charLength, atlas } = conversation.data
  const needle = q.trim().toLowerCase()
  const visible = useMemo(() => (needle ? messages.filter((m) => m.content.toLowerCase().includes(needle)) : messages), [messages, needle])

  // Where each atlas segment starts in the thread: the pipeline counts messages per segment in thread order.
  const segmentAt = useMemo(() => {
    const at = new Map<number, NonNullable<typeof atlas>['segments'][number]>()
    if (!atlas?.segments.length) return at
    let i = 0
    for (const s of [...atlas.segments].sort((a, b) => a.index - b.index)) {
      at.set(i, s)
      i += s.messages ?? 0
      if (!s.messages) break // no counts: mark the first only
    }
    return at
  }, [atlas])
  const openHub = (kind: 'region' | 'cluster' | 'topic' | 'domain', value: string) => {
    // Hubs are keyed by the pipeline's slug; find by label when the id is not there.
    const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const byId = store.get(`${kind}::${slug}`)
    const hit = byId ?? store.ofType(kind).find((e) => e.label === value)
    if (hit) navigate(`/entities?category=knowledge&type=${kind}&sel=${encodeURIComponent(hit.id)}`)
  }
  const chips = (s: NonNullable<typeof atlas>['segments'][number]): ReactNode => (
    <>
      {s.region && <button className="cv__chip cv__chip--region" onClick={() => openHub('region', s.region!)}>{s.region}</button>}
      {s.cluster && <button className="cv__chip cv__chip--cluster" onClick={() => openHub('cluster', s.cluster!)}>{s.cluster}</button>}
      {s.domains.map((d) => (
        <button key={`d-${d}`} className="cv__chip" onClick={() => openHub('domain', d)}>{d}</button>
      ))}
      {s.topics.map((t) => (
        <button key={`t-${t}`} className="cv__chip cv__chip--topic" onClick={() => openHub('topic', t)}>{t}</button>
      ))}
    </>
  )

  return (
    <div className="cv">
      <div className="cv__bar">
        <span className="muted">
          {formatNumber(messageCount)} messages · {formatNumber(charLength)} chars{model ? ` · ${model}` : ''}
        </span>
        <span className="spacer" />
        <label className="cv__search">
          <Search size={12} />
          <input value={q} placeholder="Find in conversation…" onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button className="btn btn--sm btn--icon btn--ghost" onClick={() => setQ('')} aria-label="Clear">
              <X size={12} />
            </button>
          )}
        </label>
        {conversation.data.source === 'assistant' && (
          <button
            className="btn btn--sm btn--primary"
            title="Continue this chat in the assistant, with everything said so far"
            onClick={() => {
              // The chats load with the panel; resumed, the chat is the tab in front.
              void import('../assistant/instance').then(({ loadChats }) => loadChats()).then((c) => {
                if (c.resume(conversation)) window.dispatchEvent(new CustomEvent('aegraph:assistant', { detail: { open: true } }))
              })
            }}
          >
            <Sparkles size={13} /> Resume in the assistant
          </button>
        )}
        <button className="btn btn--sm" title="Copy the transcript as Markdown" onClick={() => (navigator.clipboard.writeText(transcriptMarkdown(conversation)), toast('Transcript copied'))}>
          <Copy size={13} /> Copy
        </button>
      </div>
      {(summary || topic || keywords?.length) && (
        <div className="cv__meta">
          {topic && <span className="badge">{topic}</span>}
          {summary && <span className="cv__summary">{summary}</span>}
          {keywords?.length ? <span className="muted">{keywords.join(' · ')}</span> : null}
        </div>
      )}
      {atlas && (
        <div className="cv__atlas">
          <Waypoints size={13} />
          <span className="muted">
            {atlas.segments.length} segment{atlas.segments.length === 1 ? '' : 's'} in the atlas
            {atlas.regions.length ? ` · ${atlas.regions.length === 1 ? 'region' : 'regions'}:` : ''}
          </span>
          {atlas.regions.map((r) => (
            <button key={r} className="cv__chip cv__chip--region" onClick={() => openHub('region', r)}>{r}</button>
          ))}
          {atlas.clusters.length > 0 && <span className="muted">· clusters:</span>}
          {atlas.clusters.map((c) => (
            <button key={c} className="cv__chip cv__chip--cluster" onClick={() => openHub('cluster', c)}>{c}</button>
          ))}
        </div>
      )}
      <div className="cv__thread">
        {messages.length === 0 && <div className="insp__empty">{summary ? 'This prepared record has no messages — only the analysis above. Load the raw conversations.json to see the transcript.' : 'No messages.'}</div>}
        {needle && visible.length === 0 && messages.length > 0 && <div className="insp__empty">No messages match “{q}”.</div>}
        {visible.map((m, i) => (
          <div key={m.id ?? i} className={`cv__msg cv__msg--${m.role === 'user' || m.role === 'assistant' ? m.role : 'other'}`}>
            {!needle && segmentAt.has(i) && (
              <div className="cv__segment" title={segmentAt.get(i)!.summary}>
                <span className="cv__segment-idx">segment {segmentAt.get(i)!.index + 1}</span>
                <button className="cv__segment-title" onClick={() => navigate(`/entities?category=resource&type=segment&sel=${encodeURIComponent(segmentAt.get(i)!.id)}`)}>{segmentAt.get(i)!.label}</button>
                {chips(segmentAt.get(i)!)}
              </div>
            )}
            <div className="cv__who">
              <span>{roleLabel(m.role)}</span>
              {m.at && (
                <span className="muted" title={messageTime(m.at)}>
                  {formatDate(m.at)}
                </span>
              )}
            </div>
            <div className="cv__bubble">
              <Markdown source={m.content} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
