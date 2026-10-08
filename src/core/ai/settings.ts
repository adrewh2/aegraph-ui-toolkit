import { useSyncExternalStore } from 'react'

/**
 * Assistant configuration, kept in localStorage. Two ways to reach Claude: an API key of the user's own, which the
 * browser sends straight to the Claude API (see ./client.ts), or Claude Code over the bridge — on this machine, the
 * only one.
 */

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORT_LEVELS)[number]

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
] as const

export interface AiSettings {
  apiKey: string
  model: string
  effort: Effort
  /** Answer through Claude Code over the local bridge even when a key is set (without a key the bridge is used whenever it is connected). */
  viaClaudeCode: boolean
  /**
   * The model and effort of a turn answered by Claude Code (`claude -p --model --effort`), kept apart from the API's:
   * a chat that writes documents spends most of its time thinking and generating, and Claude Code on a subscription
   * is best fast by default.
   */
  codeModel: string
  codeEffort: Effort
}

const KEY = 'aegraph:ai:settings'
const DEFAULTS: AiSettings = { apiKey: '', model: 'claude-opus-5', effort: 'high', viaClaudeCode: false, codeModel: 'claude-sonnet-5', codeEffort: 'medium' }

let current: AiSettings = load()
const listeners = new Set<() => void>()

function load(): AiSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<AiSettings>
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULTS.model,
      effort: (EFFORT_LEVELS as readonly string[]).includes(parsed.effort ?? '') ? (parsed.effort as Effort) : DEFAULTS.effort,
      viaClaudeCode: parsed.viaClaudeCode === true,
      codeModel: typeof parsed.codeModel === 'string' && parsed.codeModel ? parsed.codeModel : DEFAULTS.codeModel,
      codeEffort: (EFFORT_LEVELS as readonly string[]).includes(parsed.codeEffort ?? '') ? (parsed.codeEffort as Effort) : DEFAULTS.codeEffort,
    }
  } catch {
    return DEFAULTS
  }
}

export const getAiSettings = () => current

/**
 * Running on this machine (the dev server, or a local preview). Locally the assistant answers through Claude Code
 * over the bridge only — the Claude API is never called from localhost, whatever key is present.
 */
export const isLocalHost = () => typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)

/** Whether the Claude API is reachable: with the user's own key, straight from the browser. Never locally. */
export const hasApiCredentials = (s: AiSettings = current) => !isLocalHost() && !!s.apiKey

export function setAiSettings(patch: Partial<AiSettings>) {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* private mode — settings live for the session only */
  }
  listeners.forEach((l) => l())
}

export function useAiSettings(): AiSettings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
    () => current,
  )
}
