export function sameDevOrigin(headers: { host?: string; origin?: string; 'sec-fetch-site'?: string }): boolean
export function localApiRoute(url: string | undefined, headers: Record<string, string | string[] | undefined>): null | { module: string } | { refused: string }
/** Whether the socket's other end is this machine (`req.socket.remoteAddress`): the dev server's own routes answer the loopback alone. */
export function isLoopbackPeer(address: string | undefined): boolean
