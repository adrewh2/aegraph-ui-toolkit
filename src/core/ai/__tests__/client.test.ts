import Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, describeError, LocalOnlyError, MissingApiKeyError, overrideClientOptions } from '../client'
import { hasApiCredentials, isLocalHost, setAiSettings } from '../settings'

/** One request through a client built from the current settings; returns what went on the wire. */
async function send() {
  const seen: { url: string; headers: Headers } = { url: '', headers: new Headers() }
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url)
    seen.headers = new Headers(init?.headers)
    return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
  })
  overrideClientOptions({ fetch: fetchMock as unknown as typeof fetch, maxRetries: 0 })
  await createClient().messages.create({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
  return seen
}

describe('createClient', () => {
  afterEach(() => {
    overrideClientOptions({})
    setAiSettings({ apiKey: '' })
  })

  it('with an API key talks to the Claude API directly', async () => {
    setAiSettings({ apiKey: 'sk-ant-test' })
    expect(hasApiCredentials()).toBe(true)
    const seen = await send()
    expect(seen.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen.headers.get('x-api-key')).toBe('sk-ant-test')
    expect(seen.headers.get('authorization')).toBeNull()
  })

  it('without a key there is no client, and nothing to send through', () => {
    setAiSettings({ apiKey: '' })
    expect(hasApiCredentials()).toBe(false)
    expect(() => createClient()).toThrow(MissingApiKeyError)
    expect(describeError(new MissingApiKeyError())).toContain('API key')
  })

  it('says a rejected key is the key', () => {
    setAiSettings({ apiKey: 'sk-ant-bad' })
    const err = new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers())
    expect(describeError(err)).toBe('The API key was rejected. Check it in settings.')
  })

  it('on localhost never reaches the Claude API, whatever the key — the chat is Claude Code there', () => {
    const g = globalThis as { location?: unknown }
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      g.location = { hostname }
      try {
        expect(isLocalHost()).toBe(true)
        setAiSettings({ apiKey: 'sk-ant-test' })
        expect(hasApiCredentials()).toBe(false)
        expect(() => createClient()).toThrow(LocalOnlyError)
        expect(describeError(new LocalOnlyError())).toContain('Claude Code')
      } finally {
        delete g.location
      }
    }
    g.location = { hostname: 'example.org' }
    try {
      expect(isLocalHost()).toBe(false)
      expect(hasApiCredentials()).toBe(true)
    } finally {
      delete g.location
    }
  })
})
