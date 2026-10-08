import type { Language } from '../../scripting/types'
import { bridge } from '../bridge/bridge'
import { PY_API, SCRIPT_API } from './api'
import { CONVERT_SYSTEM, codeOfReply, convertPrompt } from './languageSwitch'

/**
 * A script converted between JavaScript and Python by the assistant in one
 * turn — through whichever backend the user has: Claude Code over the
 * bridge, or the Claude API with their credentials. Nothing is written to
 * the chat transcript. Resolves null when no backend is available (the
 * user is not set up for the assistant) or the reply holds no code; the
 * caller then leaves the script alone.
 */
export async function assistantAvailable(): Promise<boolean> {
  const { currentBackend } = await import('../assistant/session')
  return currentBackend() !== null
}

export async function convertWithAssistant(code: string, from: Language, to: Language): Promise<string | null> {
  const { currentBackend } = await import('../assistant/session')
  const backend = currentBackend()
  if (!backend) return null
  const system = CONVERT_SYSTEM(to, SCRIPT_API, PY_API)
  const prompt = convertPrompt(from, to, code)
  let text = ''
  if (backend === 'claude-code') {
    const run = bridge.chat(prompt, {
      system,
      onEvent: (ev) => {
        if (ev.type === 'assistant') {
          const blocks = ((ev.message as { content?: { type: string; text?: string }[] } | undefined)?.content ?? []) as { type: string; text?: string }[]
          for (const b of blocks) if (b.type === 'text' && b.text) text += b.text
        } else if (ev.type === 'result' && typeof ev.result === 'string' && !text) text = ev.result
      },
    })
    await run.done
  } else {
    const { createClient } = await import('../../core/ai/client')
    const { getAiSettings } = await import('../../core/ai/settings')
    const client = createClient()
    const res = await client.messages.create({ model: getAiSettings().model, max_tokens: 8192, system, messages: [{ role: 'user', content: prompt }] })
    for (const b of res.content) if (b.type === 'text') text += b.text
  }
  const out = codeOfReply(text)
  return out.trim() ? out : null
}
