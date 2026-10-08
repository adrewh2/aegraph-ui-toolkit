import { apiError } from './http.js'

/**
 * Voice on this machine: OpenAI's two audio endpoints, served by the dev server at `/api/openai/<path>`
 * (`vite.config.ts › localApi`) with `OPENAI_API_KEY` from `.env.local`, so the browser never holds the key — what
 * voice control transcribes with and speaks through when the app runs locally. Only the two audio endpoints are
 * reachable, with the bodies (a multipart clip in, an mp3 out) passed through untouched, and only for this page's
 * own fetch (`scripts/devOrigin.mjs › localApiRoute`). Without the key it answers 503, and the app uses the
 * browser's own voice. Nothing deploys it: on a deployed site voice is a key of the user's own, or the browser's.
 */

const UPSTREAM = 'https://api.openai.com'
const ALLOWED = [/^v1\/audio\/speech$/, /^v1\/audio\/transcriptions$/]
/** `content-type` carries the multipart boundary; anything else the browser sent is dropped. */
const FORWARD_REQUEST = ['content-type', 'accept']
const FORWARD_RESPONSE = ['content-type', 'content-length', 'x-request-id', 'retry-after']
const MAX_BODY_BYTES = 4_000_000

export async function handle(request: Request): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return apiError(503, 'not_configured', 'Voice is not set up here: put OPENAI_API_KEY in .env.local and restart the dev server.')

  const path = new URL(request.url).pathname.replace(/^\/api\/openai\/?/, '')
  if (!ALLOWED.some((re) => re.test(path))) return apiError(404, 'not_found_error', `Not proxied: ${path}`)
  if (request.method !== 'POST') return apiError(405, 'invalid_request_error', 'Method not allowed.')

  // An audio clip or a sentence to speak: nothing near this.
  const body = await request.arrayBuffer()
  if (body.byteLength > MAX_BODY_BYTES) return apiError(413, 'request_too_large', `The request is over ${MAX_BODY_BYTES} bytes.`)

  const headers = new Headers({ authorization: `Bearer ${apiKey}` })
  for (const name of FORWARD_REQUEST) {
    const v = request.headers.get(name)
    if (v) headers.set(name, v)
  }

  let upstream: Response
  try {
    upstream = await fetch(`${UPSTREAM}/${path}`, { method: 'POST', headers, body, signal: request.signal })
  } catch (err) {
    return apiError(502, 'api_error', `Could not reach OpenAI: ${err instanceof Error ? err.message : String(err)}`)
  }

  const out = new Headers({ 'cache-control': 'no-store' })
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.headers.get(name)
    if (v) out.set(name, v)
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}
