import { isTextual } from './webPage'

/**
 * A fetched response, as the `web_fetch` tool reads it — whether the tab fetched it, the headless engine did, or the
 * dev server's `/api/fetch` (`dev/fetch.ts`) did on the tab's behalf (which answers with this, as JSON). Text is read up to a cap; anything
 * else (a Parquet file, an image, an archive) is described — its type and size — and not read.
 */
export interface WebResponse {
  /** Where it ended up, redirects followed. */
  url: string
  status: number
  contentType: string
  /** The size the server gave, else what was read. */
  bytes?: number
  text?: string
  /** The text stops at the cap. */
  truncated?: boolean
  /**
   * A redirect not followed — to another host, which the user has not agreed to — and where it points. `web_fetch`
   * asks about that host before it goes on.
   */
  redirect?: string
}

/** How much of a text response is read: pages and scripts are rarely more, and the model is handed a slice anyway. */
export const MAX_TEXT_BYTES = 3 * 1024 * 1024

const decoderFor = (contentType: string) => {
  const label = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/"/g, '')
  try {
    return new TextDecoder(label || 'utf-8')
  } catch {
    return new TextDecoder('utf-8')
  }
}

/** Read a response into a `WebResponse`: text up to `max` bytes, nothing of a body that is not text. */
export async function readResponse(res: Response, max = MAX_TEXT_BYTES, url = res.url): Promise<WebResponse> {
  const contentType = res.headers.get('content-type') ?? ''
  const length = Number(res.headers.get('content-length'))
  const base: WebResponse = { url, status: res.status, contentType, ...(Number.isFinite(length) && length > 0 ? { bytes: length } : {}) }
  // A redirect that was not followed is the answer, with where it points.
  const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
  if (location) {
    await res.body?.cancel().catch(() => {})
    try {
      return { ...base, redirect: new URL(location, url).href }
    } catch {
      return base
    }
  }
  if (!res.body || !isTextual(contentType)) {
    await res.body?.cancel().catch(() => {})
    return base
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = res.headers.get('x-aegraph-truncated') === '1'
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size))
      size = max
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return { ...base, bytes: base.bytes ?? size, text: decoderFor(contentType).decode(all), ...(truncated ? { truncated } : {}) }
}
