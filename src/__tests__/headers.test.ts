import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import { describe, expect, it } from 'vitest'
import { headersFor as vercelHeadersFor, scriptHash, securityHeaders, withSources } from '../../scripts/headers.mjs'

/**
 * What the deployment sends back, asserted against what the app needs.
 *
 * A Content-Security-Policy is one string in one file, and both ways of getting
 * it wrong are quiet. Tighten it and the script sandboxes stop running, with no
 * error a user could read — that is measured in `SECURITY.md`, and it is the
 * reason `blob:` and the two eval sources are in here. Loosen it and the
 * protection that matters is gone: `'unsafe-inline'` in `script-src` would let
 * an injected `<script>`, a `javascript:` URL or an inline handler run, which
 * is exactly what a hostile diagram, document or bundle carries.
 *
 * So the policy is tested rather than trusted to review.
 */
const config = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'vercel.json'), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[]
}

const headersFor = (source: string) => Object.fromEntries((config.headers.find((h) => h.source === source)?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]))
const everyResponse = headersFor('/(.*)')
const csp = Object.fromEntries(
  (everyResponse['content-security-policy'] ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const [name, ...sources] = d.split(/\s+/)
      return [name, sources]
    }),
) as Record<string, string[]>

describe('the policy every response carries', () => {
  it('forbids inline script, which is the vector data can carry', () => {
    expect(csp['script-src']).toBeDefined()
    expect(csp['script-src']).not.toContain("'unsafe-inline'")
    // …and does not let one in through the back door either.
    expect(csp['default-src'] ?? []).not.toContain("'unsafe-inline'")
    expect(csp['script-src-elem'] ?? []).not.toContain("'unsafe-inline'")
    expect(csp['script-src-attr'] ?? []).not.toContain("'unsafe-inline'")
  })

  it('allows what the script sandboxes are built on, or they stop running silently', () => {
    // A sandbox frame inherits this policy and cannot widen it: its bootstrap is a file on this
    // origin and everything after it is a blob: script (src/scripting/README.md).
    expect(csp['script-src']).toContain("'self'")
    expect(csp['script-src']).toContain('blob:')
    // QuickJS, Pyodide and the Graphviz renderer are all WebAssembly.
    expect(csp['script-src']).toContain("'wasm-unsafe-eval'")
    // Pyodide's glue compiles functions at run time; there is no way to grant that to the frame alone.
    expect(csp['script-src']).toContain("'unsafe-eval'")
    // The engines' workers, and the Python sandbox's worker, come from blobs.
    expect(csp['worker-src']).toEqual(expect.arrayContaining(["'self'", 'blob:']))
    // The sandboxes themselves are frames.
    expect(csp['frame-src']).toEqual(expect.arrayContaining(["'self'", 'blob:']))
  })

  it('allows what the app reaches for: the bridge on the loopback, and the services a feature needs', () => {
    expect(csp['connect-src']).toEqual(expect.arrayContaining(["'self'", 'https:']))
    // The Claude Code bridge is a WebSocket to 127.0.0.1 (SECURITY.md › The bridge).
    expect(csp['connect-src'].some((s) => s.startsWith('ws://127.0.0.1'))).toBe(true)
    // Map tiles, Wikipedia pictures, a document's images.
    expect(csp['img-src']).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']))
  })

  it('closes what nothing here uses', () => {
    expect(csp['object-src']).toEqual(["'none'"])
    expect(csp['base-uri']).toEqual(["'self'"])
    expect(csp['form-action']).toEqual(["'self'"])
    expect(csp['frame-ancestors']).toEqual(["'self'"])
  })

  it('carries the rest of the headers a deployment is judged on', () => {
    expect(everyResponse['x-content-type-options']).toBe('nosniff')
    expect(everyResponse['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(everyResponse['x-frame-options']).toBe('SAMEORIGIN')
    expect(everyResponse['cross-origin-opener-policy']).toBe('same-origin')
    // Only what a feature actually uses: the map's "my location", voice, a video still.
    const permissions = everyResponse['permissions-policy'] ?? ''
    expect(permissions).toContain('geolocation=(self)')
    expect(permissions).toContain('camera=()')
    expect(permissions).toContain('payment=()')
  })

  it('answers API calls without caching them, and without a referrer', () => {
    const api = headersFor('/api/(.*)')
    expect(api['cache-control']).toBe('no-store')
    expect(api['referrer-policy']).toBe('no-referrer')
  })

  it('lets the sandbox fetch the libraries it imports, whose origin is opaque', () => {
    // A module import from a sandboxed frame is cross-origin, so these need CORS —
    // as the dev server already gives them (`vite.config.ts` › pyodideCors).
    for (const source of ['/vendor/(.*)', '/pyodide/(.*)']) {
      expect(headersFor(source)['access-control-allow-origin'], source).toBe('*')
    }
  })
})

describe('the same policy on this machine', () => {
  // `npm run dev` and `vite preview` send vercel.json's headers too (scripts/headers.mjs), so what SECURITY.md says
  // about the policy holds for a developer running the app locally, not only for the deployed site.
  type Res = { headers: Record<string, string>; setHeader: (k: string, v: string) => void }
  const serve = async (hook: 'configureServer' | 'configurePreviewServer', url: string, devInlineScripts: string[] = []) => {
    const plugin = securityHeaders({ devInlineScripts }) as unknown as Record<string, (s: unknown) => void>
    let handler: ((req: { url: string }, res: Res, next: () => void) => void) | undefined
    plugin[hook]({ middlewares: { use: (fn: typeof handler) => (handler = fn) } })
    const res: Res = { headers: {}, setHeader: (k, v) => (res.headers[k.toLowerCase()] = v) }
    handler!({ url }, res, () => {})
    return res.headers
  }

  it('vite preview sends the deployed policy exactly', async () => {
    const h = await serve('configurePreviewServer', '/maps')
    expect(h['content-security-policy']).toBe(everyResponse['content-security-policy'])
    expect(h['x-frame-options']).toBe('SAMEORIGIN')
    expect(h['cross-origin-opener-policy']).toBe('same-origin')
    expect((await serve('configurePreviewServer', '/api/openai/v1/models'))['cache-control']).toBe('no-store')
  })

  it('the dev server adds the hash of the Fast Refresh preamble to script-src, and nothing else', async () => {
    const preamble = react.preambleCode.replace('__BASE__', '/')
    const h = await serve('configureServer', '/', [preamble])
    expect(h['content-security-policy']).toBe(withSources(everyResponse['content-security-policy'], 'script-src', [scriptHash(preamble)]))
    expect(csp['script-src']).not.toContain("'unsafe-inline'")
    expect(vercelHeadersFor('/')['Content-Security-Policy']).toBe(everyResponse['content-security-policy'])
  })

  it('vite.config.ts installs it', () => {
    const vite = readFileSync(join(import.meta.dirname, '..', '..', 'vite.config.ts'), 'utf8')
    expect(vite).toMatch(/securityHeaders\(\{ devInlineScripts: \[react\.preambleCode/)
  })
})
