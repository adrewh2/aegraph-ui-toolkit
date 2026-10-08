#!/usr/bin/env node
/**
 * Copy the libraries the Visual script sandbox can import into
 * public/vendor/ (generated, not committed): three.js (ESM build + the
 * addons under examples/jsm), d3 and Plotly (UMD). The sandbox is an
 * opaque-origin iframe whose CSP allows scripts only from this origin, so
 * the libraries must be served here, not from a CDN.
 *
 * Also the ONNX runtime that search by meaning runs (public/vendor/ort/):
 * transformers.js otherwise imports it from cdn.jsdelivr.net at run time —
 * executable code from a third party, in the app's own origin, with no
 * integrity check. `src/features/search/embedder.ts` points it here.
 *
 * Runs before `npm run dev` / `npm run build`; pass --force to recopy.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = resolve(process.argv[1], '../..')
const OUT = resolve(ROOT, 'public/vendor')
const force = process.argv.includes('--force')
const quiet = process.argv.includes('--quiet')
const version = (dir) => JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')).version

const three = resolve(ROOT, 'node_modules/three')
const d3 = resolve(ROOT, 'node_modules/d3')
const plotly = resolve(ROOT, 'node_modules/plotly.js-dist-min')
// The runtime transformers.js bundles (it picks the JSEP build when WebGPU is there, the plain one otherwise).
const ort = resolve(ROOT, 'node_modules/onnxruntime-web')
const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']
const manifest = { three: version(three), d3: version(d3), plotly: version(plotly), ort: version(ort) }
const manifestPath = resolve(OUT, 'manifest.json')
if (!force && existsSync(manifestPath) && readFileSync(manifestPath, 'utf8') === JSON.stringify(manifest, null, 2)) {
  if (!quiet) console.log(`vendor: three ${manifest.three}, d3 ${manifest.d3}, plotly ${manifest.plotly}, ort ${manifest.ort} up to date`)
  process.exit(0)
}
mkdirSync(OUT, { recursive: true })
cpSync(resolve(three, 'build'), resolve(OUT, 'three/build'), { recursive: true })
cpSync(resolve(three, 'examples/jsm'), resolve(OUT, 'three/examples/jsm'), { recursive: true })
mkdirSync(resolve(OUT, 'd3'), { recursive: true })
cpSync(resolve(d3, 'dist/d3.min.js'), resolve(OUT, 'd3/d3.min.js'))
mkdirSync(resolve(OUT, 'plotly'), { recursive: true })
cpSync(resolve(plotly, 'plotly.min.js'), resolve(OUT, 'plotly/plotly.min.js'))
mkdirSync(resolve(OUT, 'ort'), { recursive: true })
for (const f of ORT_FILES) {
  const from = resolve(ort, 'dist', f)
  if (!existsSync(from)) throw new Error(`vendor: ${f} is not in onnxruntime-web ${manifest.ort} — update ORT_FILES`)
  cpSync(from, resolve(OUT, 'ort', f))
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
if (!quiet) console.log(`vendor: copied three ${manifest.three}, d3 ${manifest.d3}, plotly ${manifest.plotly}, ort ${manifest.ort} into public/vendor`)
