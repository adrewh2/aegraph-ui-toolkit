import { defineConfig } from 'vite'

/**
 * The headless engine, built for Node.
 *
 * `src/headless/server.ts` imports the app's own modules, and some of those
 * reach for things only a bundler resolves — a `?raw` import, a `.py`
 * prelude, a stylesheet beside a component. So the engine is built the same
 * way the app is (one SSR pass, no DOM), which leaves a single file that
 * plain `node` runs:
 *
 *   npm run build:headless && node dist-headless/aegraph-headless.mjs work.ae.json
 *
 * `npm run headless` does both. Dependencies stay external — they are in
 * node_modules already, and bundling browser builds of React and friends
 * into a Node process buys nothing.
 */
export default defineConfig({
  build: {
    ssr: 'src/headless/server.ts',
    target: 'node20',
    outDir: 'dist-headless',
    emptyOutDir: true,
    // Nothing here serves static files: the engine answers in JSON.
    copyPublicDir: false,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      output: { entryFileNames: 'aegraph-headless.mjs', format: 'es' },
    },
  },
  ssr: { target: 'node' },
})
