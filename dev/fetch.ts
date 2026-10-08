import { apiError, json } from './http.js'
import { publicFetch } from '../src/headless/publicFetch.js'
import { isTextual } from '../src/core/net/webPage.js'
import { MAX_TEXT_BYTES, readResponse } from '../src/core/net/webResponse.js'

/**
 * The `web_fetch` tool's way to a page the browser may not read, served by the dev server at `/api/fetch`
 * (`vite.config.ts › localApi`). A tab can only read another site's response when that site allows it (CORS), and
 * most pages do not; this handler fetches the page itself and answers with what the tool needs (`WebResponse` as
 * JSON: where it ended up, the status, the type, the size, and the text of a text response, up to 3 MB). A binary
 * file is described, never downloaded. Nothing deploys it: on a deployed site there is no such reader.
 *
 * It is a fetcher for anyone who can call it, so it is kept narrow:
 * - **This page's own fetch only**: the dev server hands it a request only when `scripts/devOrigin.mjs ›
 *   localApiRoute` says it came from the page itself, with the address in an `x-fetch-url` header.
 * - **Public addresses only**, through `publicFetch` (the headless engine's fetch): every address a name resolves to
 *   is checked in the connection's own lookup, every redirect hop again — no loopback, no private network, no
 *   cloud metadata endpoint.
 * - **GET only**, no cookies or credentials of anyone's, no request headers passed through but a user agent; 20 s.
 * - **One host.** A redirect is followed only on the host it was asked for; one to another host is answered as
 *   `redirect` (where it points), and the tab asks the user about that host before it goes on.
 */

/** A redirect `/api/fetch` follows itself: on the same host (and port) and the same scheme — never from https down to plain http. Any other comes back as `redirect`, for the tab to ask about. */
export const sameHost = (from: URL, to: URL) => from.host.toLowerCase() === to.host.toLowerCase() && from.protocol === to.protocol

const TIMEOUT_MS = 20_000
const USER_AGENT = 'Mozilla/5.0 (compatible; aegraph-web-fetch/1.0; +https://aegraph.dev/docs/assistant)'

export async function handle(request: Request): Promise<Response> {
  if (request.method !== 'GET') return apiError(405, 'invalid_request_error', 'Method not allowed.')
  // The address comes in a header — never the query, which an image or a link written into data can carry.
  const raw = request.headers.get('x-fetch-url') ?? ''
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return apiError(400, 'invalid_request_error', 'url must be an absolute http(s) URL.')
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return apiError(400, 'invalid_request_error', 'Only http(s) is fetched.')
  let res: Response
  try {
    res = await publicFetch(
      target,
      { signal: request.signal },
      {
        maxBytes: MAX_TEXT_BYTES,
        truncate: true,
        timeoutMs: TIMEOUT_MS,
        readBody: isTextual,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/*;q=0.8,*/*;q=0.5' },
        // A redirect to another host is reported, not followed: the user agreed to this host, not that one.
        follow: sameHost,
      },
    )
  } catch (err) {
    return apiError(502, 'fetch_error', `Could not fetch ${target.host}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return json(200, await readResponse(res, MAX_TEXT_BYTES, res.url || target.href))
}
