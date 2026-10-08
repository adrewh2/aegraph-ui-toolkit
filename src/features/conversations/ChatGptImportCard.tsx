import { MessagesSquare } from 'lucide-react'
import { useState } from 'react'
import { useToast } from '../../components/ui/useToast'
import { useEntityStore } from '../../core/entity/hooks'
import { isRelationship } from '../../core/entity/types'
import { chatGptToEntities, parseChatGpt } from '../../core/exchange/chatgpt'
import { withAtlasLinks } from './linkAtlas'
import { pickFile } from '../../lib/download'
import { formatNumber } from '../../lib/format'

interface Props {
  busy: boolean
  /** Replace or merge, as chosen on the page. */
  mode: 'merge' | 'replace'
  say: (line: string) => void
  /** Writes entities the way the page's other loaders do (one transaction, optional clear). */
  commit: (entities: ReturnType<typeof chatGptToEntities>['entities'], tags: { tag: string; color?: string; description?: string }[], label: string) => Promise<number>
}

/**
 * Loads a ChatGPT export from a file on this machine. The file is read in
 * the browser and never leaves it; the resulting entities live in this
 * workspace's local store like everything else.
 */
export function ChatGptImportCard({ busy, mode, say, commit }: Props) {
  const store = useEntityStore()
  const toast = useToast()
  const [topics, setTopics] = useState(true)
  const [keywords, setKeywords] = useState(true)
  const [linkTitles, setLinkTitles] = useState(false)

  const load = async () => {
    const file = await pickFile('.json,application/json')
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const { format, conversations } = parseChatGpt(data)
      const linkByTitle = linkTitles && mode === 'merge' ? store.all().filter((e) => !isRelationship(e) && e.label).map((e) => ({ id: e.id, label: e.label! })) : undefined
      const { entities: parsedEntities, topics: topicCount, linked } = chatGptToEntities(format, conversations, { topics, keywordsAsTags: keywords, linkByTitle })
      // A loaded atlas (segments, regions, clusters…) is joined to these conversations on the way in.
      const { entities, note } = mode === 'merge' ? withAtlasLinks(store, parsedEntities) : { entities: parsedEntities, note: undefined }
      const ms = await commit(entities, [{ tag: 'chatgpt', color: '#10a37f', description: 'Loaded from a ChatGPT export' }], `${formatNumber(conversations.length)} conversations`)
      if (note) say(`ChatGPT: ${note}`)
      const msgs = conversations.reduce((n, c) => n + c.messages.length, 0)
      say(`ChatGPT ${format === 'export' ? 'export' : 'prepared file'} ${file.name}: ${formatNumber(conversations.length)} conversations${msgs ? `, ${formatNumber(msgs)} messages` : ''}${topicCount ? `, ${topicCount} topics` : ''}${linked ? `, ${linked} linked by title` : ''} · indexed ${ms.toFixed(0)}ms`)
      toast(`Loaded ${formatNumber(conversations.length)} conversations`)
    } catch (err) {
      say(`ChatGPT load failed: ${err instanceof Error ? err.message : String(err)}`)
      toast('Could not load that file — see the activity log')
    }
  }

  return (
    <section className="ds__card">
      <header>
        <span className="ds__icon" style={{ background: '#d1fae5', color: '#065f46' }}>
          <MessagesSquare size={18} />
        </span>
        <div>
          <h2>ChatGPT export</h2>
          <p>
            Load <code>conversations.json</code> from a ChatGPT data export, or a prepared conversations file (summaries, topics, keywords). Each conversation becomes a <em>conversation</em> resource with its messages; open one to read it as a chat. The file is read here in the browser and stays on this machine — never bundled, uploaded, or committed.
          </p>
        </div>
      </header>
      <div className="ds__actions">
        <button className="btn btn--primary" disabled={busy} onClick={load}>
          Choose file…
        </button>
        <label className="ds__inline" title="Prepared files carry a topic per conversation">
          <input type="checkbox" checked={topics} onChange={(e) => setTopics(e.target.checked)} /> topic entities
        </label>
        <label className="ds__inline" title="Prepared files carry keywords per conversation">
          <input type="checkbox" checked={keywords} onChange={(e) => setKeywords(e.target.checked)} /> keywords as tags
        </label>
        <label className="ds__inline" title="When merging: link a conversation to an existing entity whose label matches its title">
          <input type="checkbox" checked={linkTitles} disabled={mode !== 'merge'} onChange={(e) => setLinkTitles(e.target.checked)} /> link by title
        </label>
      </div>
    </section>
  )
}
