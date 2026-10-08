import Anthropic from '@anthropic-ai/sdk'
import { getAiSettings, isLocalHost } from './settings'

/**
 * The Anthropic client for the browser: the user's own API key, sent straight to the Claude API —
 * `dangerouslyAllowBrowser` is deliberate: this is a local-first app with no server of its own, and the key is the
 * user's. Without a key there is no client; the chat is Claude Code over the bridge instead (`currentBackend`).
 */
export function createClient(): Anthropic {
  if (isLocalHost()) throw new LocalOnlyError()
  const { apiKey } = getAiSettings()
  if (apiKey) return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, ...clientOverrides })
  throw new MissingApiKeyError()
}

type ClientOverrides = Partial<NonNullable<ConstructorParameters<typeof Anthropic>[0]>>
let clientOverrides: ClientOverrides = {}
/** Test seam: inject a fake `fetch` (or other client options) without touching the network. */
export function overrideClientOptions(opts: ClientOverrides) {
  clientOverrides = opts
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('Add your Anthropic API key in the assistant settings, or connect Claude Code, to start chatting.')
    this.name = 'MissingApiKeyError'
  }
}

/** Locally the chat goes through Claude Code, never to the Claude API — see `isLocalHost`. */
export class LocalOnlyError extends Error {
  constructor() {
    super('Running locally, the assistant answers through Claude Code only: connect the bridge (run `claude` in this checkout, or `npm run mcp`) to chat.')
    this.name = 'LocalOnlyError'
  }
}

/** Human-readable message for anything the SDK or our tools throw. */
export function describeError(err: unknown): string {
  if (err instanceof MissingApiKeyError || err instanceof LocalOnlyError) return err.message
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Check it in settings.'
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use that model.'
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited — wait a moment and try again.'
  if (err instanceof Anthropic.BadRequestError) return `The request was rejected: ${err.message}`
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check your connection (and that the key allows browser use).'
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ''}: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}
