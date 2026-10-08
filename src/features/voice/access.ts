import { isLocalHost } from '../../core/ai/settings'
import { getVoiceSettings, type VoiceEngine, type VoiceEngineSetting } from './settings'

/**
 * How OpenAI's audio endpoints are reached, if at all: with the user's own key straight from the browser, or, on this
 * machine, through the dev server's `/api/openai` (`dev/openai.ts`, the key in `.env.local`). Neither means no
 * OpenAI: the browser's own recogniser and voice.
 */

export type OpenAiAccess = { kind: 'key'; key: string } | { kind: 'local' }

export const OPENAI_LOCAL_PATH = '/api/openai'

export function openAiAccess(): OpenAiAccess | null {
  const key = getVoiceSettings().openaiKey
  if (key) return { kind: 'key', key }
  if (isLocalHost()) return { kind: 'local' }
  return null
}

/** The URL and headers for one call to an OpenAI audio endpoint (`v1/audio/speech`, `v1/audio/transcriptions`). */
export async function openAiRequest(access: OpenAiAccess, path: string): Promise<{ url: string; headers: Record<string, string> }> {
  if (access.kind === 'key') return { url: `https://api.openai.com/${path}`, headers: { Authorization: `Bearer ${access.key}` } }
  const origin = typeof location !== 'undefined' && location.origin ? location.origin : 'http://localhost'
  return { url: new URL(`${OPENAI_LOCAL_PATH}/${path}`, origin).href, headers: {} }
}

/** Why an OpenAI audio call failed, for the pill: the key, the dev server's key, or OpenAI itself. */
export async function explainFailure(res: Response, access: OpenAiAccess, what: 'transcription' | 'speech'): Promise<Error> {
  let detail = ''
  try {
    detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? ''
  } catch {
    /* not json */
  }
  if (res.status === 401) return new Error(access.kind === 'key' ? `OpenAI rejected the key for ${what}.` : 'OpenAI rejected the key in .env.local.')
  if (res.status === 403 && access.kind === 'local') return new Error('The dev server refused voice to this page.')
  if (res.status === 503 && access.kind === 'local') return new Error('Voice is not set up here: put OPENAI_API_KEY in .env.local and restart the dev server.')
  return new Error(`OpenAI ${what} failed (${res.status})${detail ? `: ${detail}` : ''}`)
}

/** What an engine setting means right now: `auto` is OpenAI whenever it is reachable. */
export function resolveEngine(setting: VoiceEngineSetting, access: OpenAiAccess | null = openAiAccess()): VoiceEngine {
  if (setting === 'auto') return access ? 'openai' : 'browser'
  return setting
}

/** A phrase for the settings pane: why `auto` resolves the way it does. */
export function describeAccess(access: OpenAiAccess | null = openAiAccess()): string {
  if (!access) return 'browser — add a key for OpenAI'
  return access.kind === 'key' ? 'OpenAI, with your key' : 'OpenAI, with the key in .env.local'
}
