/** The JSON answers the dev server's handlers give, in the Claude API's error shape (`{ type: 'error', error: { type, message } }`). */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

export function apiError(status: number, type: string, message: string): Response {
  return json(status, { type: 'error', error: { type, message } })
}
