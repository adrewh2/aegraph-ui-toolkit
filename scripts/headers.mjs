import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The response headers are written once, in `vercel.json`, and this makes the
 * dev server and `vite preview` send the same ones — so the Content-Security-
 * Policy that SECURITY.md describes is the one a developer running this
 * locally gets, not only the deployed site.
 *
 * `vite preview` serves the built app and sends the policy exactly. The dev
 * server adds one thing: @vitejs/plugin-react puts an inline module script
 * (the Fast Refresh preamble) into the page, which a `script-src` without
 * `'unsafe-inline'` refuses. It is allowed by the hash of its exact text,
 * nothing wider — any other inline script is still refused in development.
 */

const ROOT = join(import.meta.dirname, '..')

/** `vercel.json`'s header rules. */
export function headerRules(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')).headers ?? []
}

/**
 * The headers Vercel sends for a path: every rule whose `source` matches, later ones overriding earlier ones.
 * The sources here are literal paths ending in `(.*)`, which read the same as a regular expression.
 */
export function headersFor(path, rules = headerRules()) {
  const out = {}
  for (const rule of rules) {
    if (!new RegExp(`^${rule.source}$`).test(path)) continue
    for (const { key, value } of rule.headers) out[key] = value
  }
  return out
}

/** The CSP source for an inline script's exact text. */
export const scriptHash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

/** A policy with sources added to one directive (and nothing else changed). */
export function withSources(policy, directive, sources) {
  if (!sources.length) return policy
  return policy
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (d.split(/\s+/)[0] === directive ? `${d} ${sources.join(' ')}` : d))
    .join('; ')
}

/**
 * A Vite plugin sending `vercel.json`'s headers from the dev server and from `vite preview`.
 *
 * @param {{ devInlineScripts?: string[] }} options the exact text of inline scripts the dev server itself injects
 */
export function securityHeaders({ devInlineScripts = [] } = {}) {
  const rules = headerRules()
  const devHashes = devInlineScripts.map(scriptHash)
  const middleware = (dev) => (req, res, next) => {
    const path = (req.originalUrl ?? req.url ?? '/').split('?')[0]
    for (const [key, value] of Object.entries(headersFor(path, rules))) {
      // Caching headers are the CDN's business; locally they would only make a rebuilt file stale.
      if (key.toLowerCase() === 'cache-control' && !path.startsWith('/api/')) continue
      res.setHeader(key, dev && key.toLowerCase() === 'content-security-policy' ? withSources(value, 'script-src', devHashes) : value)
    }
    next()
  }
  return {
    name: 'aegraph-security-headers',
    configureServer(server) {
      server.middlewares.use(middleware(true))
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(false))
    },
  }
}
