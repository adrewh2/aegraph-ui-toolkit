import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream'
/// <reference types="vitest/config" />
import { configDefaults } from 'vitest/config'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { isLoopbackPeer, localApiRoute, sameDevOrigin } from './scripts/devOrigin.mjs'
import { securityHeaders } from './scripts/headers.mjs'

/**
 * The Python and Visual script sandboxes are iframes with an opaque origin, so
 * their requests for the runtime, wheels and libraries under /pyodide/ and
 * /vendor/ are cross-origin and need this header; a production host must
 * send it for those paths too.
 */
function pyodideCors(): Plugin {
  const allow = (server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/pyodide/') || req.url?.startsWith('/vendor/')) res.setHeader('Access-Control-Allow-Origin', '*')
      next()
    })
  }
  return { name: 'aegraph-pyodide-cors', configureServer: allow, configurePreviewServer: allow }
}

/**
 * Dev-only: datasets that live on this machine, listed in `.env.local` as
 *
 *   AEGRAPH_LOCAL_DEMOS="ChatGPT atlas=/abs/path/conversation-atlas.json;Other=/abs/path/other.json"
 *
 * The Projects dialog lists them under "On this machine" and loads them with
 * one click. `.env.local` is gitignored, so the paths (and the data) never
 * reach the repo; the files are streamed by the dev server only. A path may
 * be a directory (a ChatGPT data export): its `conversations*.json` files
 * are listed and served one by one.
 */
function localDemos(env: Record<string, string>): Plugin {
  const entries = (env.AEGRAPH_LOCAL_DEMOS ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf('=')
      const label = i > 0 ? s.slice(0, i).trim() : basename(s)
      const path = i > 0 ? s.slice(i + 1).trim() : s
      return { id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label, path }
    })
  return {
    name: 'aegraph-local-demos',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__local/demos', (req, res) => {
        if (!isLoopbackPeer(req.socket.remoteAddress) || !sameDevOrigin(req.headers as Record<string, string>)) {
          res.statusCode = 403
          res.end('only this page may read local demos')
          return
        }
        const [id, file] = decodeURIComponent((req.url ?? '/').replace(/^\//, '').split('?')[0]).split('/')
        const chunksOf = (dir: string) =>
          readdirSync(dir)
            .filter((f) => /^conversations.*\.json$/i.test(f))
            .sort()
            .map((f) => ({ name: f, bytes: statSync(join(dir, f)).size }))
        if (!id) {
          const list = entries.flatMap((e) => {
            try {
              const st = statSync(e.path)
              if (st.isDirectory()) {
                const files = chunksOf(e.path)
                return [{ id: e.id, label: e.label, file: basename(e.path), kind: 'directory', files, bytes: files.reduce((n, f) => n + f.bytes, 0), modified: st.mtime.toISOString() }]
              }
              return [{ id: e.id, label: e.label, file: basename(e.path), kind: 'file', bytes: st.size, modified: st.mtime.toISOString() }]
            } catch {
              return []
            }
          })
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(list))
          return
        }
        const e = entries.find((x) => x.id === id)
        if (!e) {
          res.statusCode = 404
          res.end('no such local demo')
          return
        }
        try {
          const st = statSync(e.path)
          // A directory: one of its chunk files (never a path outside it).
          const target = st.isDirectory() ? (file && chunksOf(e.path).some((f) => f.name === file) ? join(e.path, file) : undefined) : e.path
          if (!target) {
            res.statusCode = 404
            res.end('no such file in this demo')
            return
          }
          res.setHeader('content-type', 'application/json')
          res.setHeader('content-length', String(statSync(target).size))
          // Not `.pipe`: a page that stops reading (a reload mid-download) would leave the file open for good.
          pipeline(createReadStream(target), res, () => {})
        } catch (err) {
          res.statusCode = 404
          res.end(String(err))
        }
      })
    },
  }
}

/**
 * Dev-only: the demo projects served live from a checkout of `aegraph-ui-demos`
 * on this machine (`AEGRAPH_DEMOS_DIR`, else `../aegraph-ui-demos` or
 * `~/workspace/aegraph-ui-demos` — the places `scripts/demos/fetch.mjs` looks).
 * `/demos/catalog.json` and each demo's bundle, preview and README are read
 * from the checkout on every request, so a generator's rebuild is what the
 * Projects dialog opens next — no fetch script, no restart. What the catalog
 * does not list falls through to the copies in `public/demos/`, which is what
 * a build serves. `AEGRAPH_DEMOS_LIVE=0` turns this off.
 */
function liveDemos(env: Record<string, string>): Plugin {
  const dir = [env.AEGRAPH_DEMOS_DIR, resolve('..', 'aegraph-ui-demos'), join(homedir(), 'workspace', 'aegraph-ui-demos')].find((d) => d && existsSync(join(d, 'catalog.json')))
  const types: Record<string, string> = { '.json': 'application/json', '.gz': 'application/gzip', '.aeb': 'application/octet-stream', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' }
  type Demo = { id: string; bundle: string; preview?: string; bytes?: number; [k: string]: unknown }
  const catalog = (): { demos: Demo[]; [k: string]: unknown } => {
    const c = JSON.parse(readFileSync(join(dir!, 'catalog.json'), 'utf8'))
    return { ...c, demos: (Array.isArray(c.demos) ? c.demos : []).filter((d: Demo) => /^[\w.-]+$/.test(d.id) && typeof d.bundle === 'string') }
  }
  return {
    name: 'aegraph-live-demos',
    apply: 'serve',
    configureServer(server) {
      if (!dir || env.AEGRAPH_DEMOS_LIVE === '0') return
      server.config.logger.info(`  [demos] served live from ${dir}`)
      server.middlewares.use('/demos', (req, res, next) => {
        // The live checkout is a private repository on this disk: only this page, on this machine, may read it
        // (scripts/devOrigin.mjs).
        if (!isLoopbackPeer(req.socket.remoteAddress) || !sameDevOrigin(req.headers as Record<string, string>)) {
          res.statusCode = 403
          res.end('only this page may read the live demos')
          return
        }
        const path = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\//, '')
        try {
          const c = catalog()
          const send = (type: string, body: string | { file: string }) => {
            res.setHeader('content-type', type)
            res.setHeader('cache-control', 'no-store')
            if (typeof body === 'string') return void res.end(body)
            res.setHeader('content-length', String(statSync(body.file).size))
            // Not `.pipe`: a page that stops reading (a reload mid-download) would leave the file open for good.
            pipeline(createReadStream(body.file), res, () => {})
          }
          if (path === 'catalog.json') {
            const demos = c.demos.map((d) => {
              const at = (f?: string) => (f && existsSync(join(dir, 'demos', d.id, f)) ? `/demos/${d.id}/${f}` : undefined)
              const bundle = join(dir, 'demos', d.id, d.bundle)
              return { ...d, bytes: existsSync(bundle) ? statSync(bundle).size : d.bytes, bundleUrl: at(d.bundle), previewUrl: at(d.preview), readmeUrl: at('README.md') }
            })
            return send('application/json', JSON.stringify({ ...c, source: 'live checkout', fetchedAt: new Date().toISOString(), demos: demos.filter((d) => d.bundleUrl) }))
          }
          // Only the files the catalog names, never a path of the request's choosing.
          const [id, file, ...rest] = path.split('/')
          const d = c.demos.find((x) => x.id === id)
          if (d && file && !rest.length && [d.bundle, d.preview, 'README.md'].includes(file)) {
            const target = join(dir, 'demos', id, file)
            if (existsSync(target)) return send(types[extname(file)] ?? 'application/octet-stream', { file: target })
          }
        } catch (err) {
          server.config.logger.warn(`[demos] live catalog unreadable, serving the copies: ${err instanceof Error ? err.message : String(err)}`)
        }
        next()
      })
    },
  }
}

/**
 * Dev-only: the dev server's own handlers (`dev/`), at the paths the app calls — `/api/openai` (voice, with
 * `OPENAI_API_KEY` from `.env.local`: on this machine voice simply uses that key) and `/api/fetch` (the `web_fetch`
 * tool's reader). Nothing deploys them. The dev server only listens on the loopback, and a handler loads on the
 * first request, in the dev server's process (nothing is bundled). Without the key `/api/openai` answers 503 and the
 * app uses the browser's own voice. There is no chat handler: locally the chat is Claude Code only. Only this page
 * may call them (`scripts/devOrigin.mjs`): being on the loopback does not stop another site's page from posting to
 * them blind.
 */
function localApi(env: Record<string, string>): Plugin {
  if (env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = env.OPENAI_API_KEY
  return {
    name: 'aegraph-local-api',
    apply: 'serve',
    configureServer(server) {
      // `/api/openai` (voice, with the key in .env.local) and `/api/fetch` (the web_fetch tool's way to a page the
      // browser may not read), with no gate of their own. Ungated, so only this page's own fetch may
      // use them (`localApiRoute`): a blind request from any other site would spend the key or use this machine to
      // fetch, and an image or a frame written as `/api/fetch?url=…` in data would fetch any address on sight.
      server.middlewares.use((req, res, next) => {
        const route = localApiRoute(req.url, req.headers as Record<string, string>)
        if (!route) return next()
        if (!isLoopbackPeer(req.socket.remoteAddress)) {
          res.statusCode = 403
          res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'the local routes answer this machine only' } }))
          return
        }
        if ('refused' in route) {
          res.statusCode = 403
          res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: route.refused } }))
          return
        }
        const module = route.module
        void (async () => {
          const { handle } = (await server.ssrLoadModule(module)) as { handle: (r: Request) => Promise<Response> }
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
          const method = req.method ?? 'GET'
          const request = new Request(new URL(req.originalUrl ?? req.url ?? '/', 'http://127.0.0.1'), { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks) })
          const response = await handle(request)
          res.statusCode = response.status
          response.headers.forEach((v, k) => res.setHeader(k, v))
          if (response.body) for await (const chunk of response.body) res.write(chunk)
          res.end()
        })().catch((err: unknown) => {
          res.statusCode = 500
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err instanceof Error ? err.message : String(err) } }))
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // vercel.json's headers, CSP included, from the dev server and `vite preview` too (scripts/headers.mjs). The one
  // inline script the dev server injects — plugin-react's Fast Refresh preamble — is allowed by its hash.
  plugins: [react(), securityHeaders({ devInlineScripts: [react.preambleCode.replace('__BASE__', '/')] }), pyodideCors(), localDemos(loadEnv(mode, process.cwd(), 'AEGRAPH_')), liveDemos(loadEnv(mode, process.cwd(), 'AEGRAPH_')), localApi(loadEnv(mode, process.cwd(), ''))],
  // Every worker here is a module worker (`{ type: 'module' }`), and as ES output a worker keeps its dynamic imports
  // as separate chunks: the layout worker fetches a layout engine (ELK, WebCola, ngraph) only the first time a
  // layout asks for it. As an IIFE (the default) they would all be inlined into the worker.
  worker: { format: 'es' },
  // Bound to the IPv4 loopback, not the default `localhost` (which macOS resolves to `::1` only): OAuth providers
  // that refuse a `localhost` redirect accept `http://127.0.0.1:<port>` as a loopback address, and Spotify's
  // callback is built from `location.origin`. `localhost` keeps working — the browser falls back to IPv4 — but it
  // is a different origin, with its own Library, tokens and bridge settings. Not `0.0.0.0`: the dev server streams
  // the datasets named in `.env.local`, which have no business on the network.
  server: {
    host: '127.0.0.1',
    // What lives in a checkout but is not source: the headless driver's and the profilers' Chrome profiles (tens of
    // thousands of files a running browser rewrites constantly), its downloads, the builds. Watched, every write
    // costs the dev server memory, and an .html among them reloads every open tab — bursts of ten a second while a
    // driver ran.
    // `.claude/` holds agents' worktrees — whole copies of the tree — while they work.
    watch: { ignored: ['**/*-profile/**', '**/downloads/**', '**/dist/**', '**/dist-headless/**', '**/.vite/**', '**/coverage/**', '**/.claude/**'] },
  },
  // Pre-bundled dependencies are cached per checkout, not in node_modules: worktrees share one node_modules through a
  // symlink, and a dev server that re-bundles into a shared cache rewrites it under every other server's open tabs.
  cacheDir: '.vite',
  optimizeDeps: {
    // Everything the app pulls in lazily, pre-bundled at start. Otherwise the dev server discovers a dependency the
    // first time a route or worker loads it, rebuilds every dependency (React included) and reloads — and a
    // workstation pane that was mid-load ends up with two copies of React ("Cannot read properties of null
    // (reading 'useContext')"). Adding a dependency? Add it here too.
    include: [
      // Guarded by src/__tests__/optimizeDeps.test.ts: every package the app imports is listed.
      '@anthropic-ai/sdk',
      '@anthropic-ai/sdk/helpers/beta/json-schema',
      '@codemirror/commands',
      '@codemirror/lang-javascript',
      '@codemirror/lang-python',
      '@codemirror/language',
      '@codemirror/state',
      '@codemirror/view',
      '@jitl/quickjs-singlefile-browser-release-sync',
      '@dagrejs/dagre',
      '@huggingface/transformers',
      '@tiptap/core',
      '@tiptap/extension-image',
      '@tiptap/extension-table',
      '@tiptap/extension-task-item',
      '@tiptap/extension-task-list',
      '@tiptap/extensions',
      '@tiptap/markdown',
      '@tiptap/pm/state',
      '@tiptap/pm/view',
      '@tiptap/react',
      '@tiptap/react/menus',
      '@tiptap/starter-kit',
      '@viz-js/viz',
      'd3-force-3d',
      'elkjs/lib/elk-api.js',
      'graphology',
      'graphology-communities-louvain',
      'graphology-gexf/browser',
      'graphology-graphml/browser',
      'graphology-layout-forceatlas2',
      'graphology-layout-forceatlas2/worker',
      'graphology-layout-noverlap',
      'graphology-layout/circlepack',
      'graphology-shortest-path/dijkstra',
      'graphology-shortest-path/unweighted',
      'hyparquet',
      'hyparquet-compressors',
      'leaflet',
      'lucide-react',
      'mermaid',
      'ngraph.forcelayout',
      'ngraph.graph',
      'plotly.js-dist-min',
      'quickjs-emscripten-core',
      'react',
      'react-dom',
      'react-dom/client',
      'react-router-dom',
      'three',
      'webcola',
      '@codemirror/autocomplete',
      '@codemirror/lint',
      '@excalidraw/excalidraw',
      '@lezer/highlight',
      'elkjs/lib/elk.bundled.js',
      'n3',
      'react-globe.gl',
      'three/addons/controls/OrbitControls.js',
    ],
  },
  // Agents' worktrees under `.claude/` are copies of this tree: their tests are theirs, not this checkout's.
  test: { exclude: [...configDefaults.exclude, '**/.claude/**'] },
}))
