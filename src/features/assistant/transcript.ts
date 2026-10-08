import { getAiSettings } from '../../core/ai/settings'
import { downloadText } from '../../lib/download'
import { currentBackend, type AssistantSession, type TranscriptItem } from './session'

/**
 * A chat as a file: what was said, every tool call with its input, its
 * result in full and how long it took, the tokens — the material for
 * looking back at how the assistant worked a task and improving the tools
 * and prompts it works with. Markdown reads; JSON carries the same plus
 * the conversation as the API saw it.
 */

export type TranscriptFormat = 'markdown' | 'json'

/** A result longer than this is cut in the Markdown (the JSON keeps all of it). */
const RESULT_CHARS = 60_000

const iso = (ms: number) => new Date(ms).toISOString()
const fence = (text: string, lang = '') => `\`\`\`${lang}\n${text.replace(/```/g, '`​``')}\n\`\`\``
/** JSON, pretty when it parses, as it is otherwise. */
const pretty = (text: string): { text: string; lang: string } => {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), lang: 'json' }
  } catch {
    return { text, lang: '' }
  }
}
const cut = (text: string) => (text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n… [cut: ${text.length.toLocaleString('en-US')} characters in all; the JSON export has it whole]` : text)

export function transcriptTitle(session: AssistantSession): string {
  const st = session.getState()
  return st.name ?? (st.items.find((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user')?.text.slice(0, 60) || 'Chat')
}

function summary(session: AssistantSession) {
  const st = session.getState()
  const tools = st.items.filter((i): i is Extract<TranscriptItem, { kind: 'tool' }> => i.kind === 'tool')
  const byTool = new Map<string, { calls: number; errors: number; ms: number }>()
  for (const t of tools) {
    const c = byTool.get(t.name) ?? { calls: 0, errors: 0, ms: 0 }
    c.calls++
    if (t.status === 'error') c.errors++
    c.ms += t.ms ?? 0
    byTool.set(t.name, c)
  }
  const settings = getAiSettings()
  const backend = currentBackend()
  return {
    title: transcriptTitle(session),
    chatId: session.id,
    createdAt: iso(session.createdAt),
    exportedAt: iso(Date.now()),
    backend,
    model: backend === 'claude-code' ? 'Claude Code (bridge)' : settings.model,
    effort: backend === 'claude-code' ? undefined : settings.effort,
    turns: st.items.filter((i) => i.kind === 'user').length,
    toolCalls: tools.length,
    toolErrors: tools.filter((t) => t.status === 'error').length,
    toolMs: tools.reduce((s, t) => s + (t.ms ?? 0), 0),
    usage: st.usage,
    tools: [...byTool.entries()].sort((a, b) => b[1].calls - a[1].calls).map(([name, c]) => ({ name, ...c })),
  }
}

export function transcriptMarkdown(session: AssistantSession): string {
  const st = session.getState()
  const s = summary(session)
  const lines: string[] = []
  lines.push(`# ${s.title}`, '')
  lines.push(`- Chat \`${s.chatId}\` · started ${s.createdAt} · exported ${s.exportedAt}`)
  lines.push(`- Answered by ${s.model}${s.effort ? ` · effort ${s.effort}` : ''}`)
  lines.push(`- ${s.turns} user turn${s.turns === 1 ? '' : 's'} · ${s.toolCalls} tool call${s.toolCalls === 1 ? '' : 's'}${s.toolErrors ? ` (${s.toolErrors} failed)` : ''} · ${(s.toolMs / 1000).toFixed(1)} s in tools`)
  lines.push(`- Tokens: ${s.usage.input.toLocaleString('en-US')} in, ${s.usage.output.toLocaleString('en-US')} out, ${s.usage.cacheRead.toLocaleString('en-US')} cache read`)
  if (s.tools.length) {
    lines.push('', '| Tool | Calls | Failed | Time |', '| --- | ---: | ---: | ---: |')
    for (const t of s.tools) lines.push(`| \`${t.name}\` | ${t.calls} | ${t.errors || ''} | ${(t.ms / 1000).toFixed(2)} s |`)
  }
  lines.push('', '---', '')
  let n = 0
  for (const it of st.items) {
    if (it.kind === 'user') {
      n++
      lines.push(`## ${n}. User`, '', it.text, '')
      if (it.attachments?.length) lines.push(...it.attachments.map((a) => `- 📎 ${a.kind} **${a.label}** \`${a.id}\``), '')
    } else if (it.kind === 'assistant') {
      if (it.text.trim()) lines.push('### Assistant', '', it.text, '')
    } else if (it.kind === 'tool') {
      const status = it.status === 'running' ? 'still running' : it.status === 'error' ? 'failed' : it.status === 'unknown' ? 'outcome unknown' : 'done'
      lines.push(`### 🔧 \`${it.name}\` — ${status}${it.ms !== undefined ? ` in ${it.ms.toLocaleString('en-US')} ms` : ''}${it.startedAt ? ` · ${iso(it.startedAt)}` : ''}`, '')
      const empty = !it.input || (typeof it.input === 'object' && Object.keys(it.input as object).length === 0)
      if (it.partial && empty) lines.push('Input (as far as it arrived):', '', fence(`${it.partial}…`, 'json'), '')
      else lines.push('Input:', '', fence(JSON.stringify(it.input, null, 2), 'json'), '')
      if (it.result !== undefined) {
        const r = pretty(it.result)
        lines.push(it.status === 'error' ? 'Error:' : it.status === 'unknown' ? 'What happened:' : 'Result:', '', fence(cut(r.text), r.lang), '')
      }
    } else if (it.kind === 'confirm') {
      lines.push(`### ❓ Confirmation`, '', `> ${it.message}`, '', `Answer: ${it.stopped ? '(not answered — the chat was stopped)' : it.answer === undefined ? '(not answered)' : it.answer ? 'yes' : 'no'}`, '')
    } else if (it.kind === 'question') {
      lines.push(`### ❓ Question`, '', `> ${it.message}`, '', `Options: ${it.options.map((o) => `\`${o}\``).join(', ')}`, '', `Answer: ${it.stopped ? '(not answered — the chat was stopped)' : it.answer === undefined ? '(not answered)' : it.answer === null ? '(declined)' : it.answer}`, '')
    } else if (it.kind === 'error') {
      lines.push('### ⚠️ Error', '', fence(it.text), '')
    } else if (it.kind === 'stopped') {
      lines.push('_Stopped by the user._', '')
    }
  }
  return lines.join('\n')
}

export function transcriptJson(session: AssistantSession): string {
  const st = session.getState()
  const { history, claudeSession } = session.exportHistory()
  return JSON.stringify({ $schema: 'aegraph/transcript/v1', ...summary(session), claudeSession, items: st.items, history }, null, 2)
}

/** The file name a chat's transcript downloads as: the title, the date, the format. */
export function transcriptFilename(session: AssistantSession, format: TranscriptFormat): string {
  const slug = transcriptTitle(session)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `chat-${slug || session.id}-${iso(Date.now()).slice(0, 10)}.${format === 'json' ? 'json' : 'md'}`
}

export function downloadTranscript(session: AssistantSession, format: TranscriptFormat) {
  if (format === 'json') downloadText(transcriptFilename(session, 'json'), transcriptJson(session), 'application/json')
  else downloadText(transcriptFilename(session, 'markdown'), transcriptMarkdown(session), 'text/markdown')
}
