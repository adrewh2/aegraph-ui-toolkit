import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Who may speak to the engine over `--port`.
 *
 * The engine reads and writes this machine's files, so its HTTP face is held
 * to three rules, checked before a request reaches MCP:
 *
 * - **Host** must be `127.0.0.1:<port>` or `localhost:<port>`. A page on
 *   another site that re-points its own hostname at 127.0.0.1 (DNS
 *   rebinding) arrives with its own name in `Host` and is refused.
 * - **Origin**, when present, must be one given with `--allow-origin`. A
 *   browser page always sends one on a cross-origin POST; an MCP client does
 *   not send one at all. The default list is empty: no page may drive it.
 * - **A bearer token** is required: `AEGRAPH_HEADLESS_TOKEN`, or one made at
 *   startup and printed with the `claude mcp add` line that carries it.
 *   Anything else on this machine that can open a loopback socket — another
 *   user's process, a local web app — then needs the token too.
 */
export interface GateOptions {
  port: number
  token: string
  origins: string[]
}

export interface GateRequest {
  host?: string
  origin?: string
  authorization?: string
}

/** Constant-time: hashing first makes the lengths equal, so the comparison says nothing about how close a guess was. */
export function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(h(a), h(b))
}

/** Why the request is refused, as [status, message], or undefined when it may pass. */
export function refuse(req: GateRequest, opts: GateOptions): [number, string] | undefined {
  const hosts = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]
  if (!req.host || !hosts.includes(req.host.toLowerCase())) return [421, `aegraph-headless answers only ${hosts.join(' or ')}`]
  if (req.origin !== undefined && !opts.origins.includes(req.origin)) return [403, `origin ${req.origin} may not drive this engine (--allow-origin adds one)`]
  const m = /^Bearer\s+(.+)$/i.exec(req.authorization ?? '')
  if (!m || !sameSecret(m[1].trim(), opts.token)) return [401, 'a bearer token is required (AEGRAPH_HEADLESS_TOKEN, printed at startup)']
  return undefined
}
