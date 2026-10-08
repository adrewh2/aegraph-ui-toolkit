import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handle } from '../openai'

const req = (path: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:5199${path}`, { method: 'POST', body: 'clip', ...init })

describe('the dev server’s /api/openai', () => {
  const upstream = vi.fn<typeof fetch>()
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-openai-local'
    upstream.mockReset()
    upstream.mockResolvedValue(new Response('mp3bytes', { status: 200, headers: { 'content-type': 'audio/mpeg', 'x-request-id': 'r1', 'set-cookie': 'nope' } }))
    vi.stubGlobal('fetch', upstream)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.OPENAI_API_KEY
  })

  it('answers 503 without the key in .env.local, before reaching OpenAI', async () => {
    delete process.env.OPENAI_API_KEY
    const res = await handle(req('/api/openai/v1/audio/speech'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe('not_configured')
    expect(body.error.message).toContain('.env.local')
    expect(upstream).not.toHaveBeenCalled()
  })

  it('only passes on the two audio endpoints, POST only', async () => {
    for (const path of ['/api/openai/v1/chat/completions', '/api/openai/v1/models', '/api/openai/', '/api/openai?path=v1/audio/speech']) expect((await handle(req(path))).status, path).toBe(404)
    expect((await handle(req('/api/openai/v1/audio/speech', { method: 'GET', body: undefined }))).status).toBe(405)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses a body past the limit', async () => {
    expect((await handle(req('/api/openai/v1/audio/speech', { body: new Uint8Array(4_000_001) }))).status).toBe(413)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('forwards the multipart clip with the local key and passes the audio back', async () => {
    const res = await handle(req('/api/openai/v1/audio/transcriptions', { headers: { 'content-type': 'multipart/form-data; boundary=abc', authorization: 'Bearer whatever-the-tab-sent', cookie: 'c=1' } }))
    expect(upstream).toHaveBeenCalledTimes(1)
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    const sent = new Headers(init.headers)
    expect(sent.get('authorization')).toBe('Bearer sk-openai-local')
    expect(sent.get('content-type')).toBe('multipart/form-data; boundary=abc')
    expect(sent.get('cookie')).toBeNull()
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('clip')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('x-request-id')).toBe('r1')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await res.text()).toBe('mp3bytes')
  })
})
