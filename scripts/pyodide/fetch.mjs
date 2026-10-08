#!/usr/bin/env node
/**
 * Fetch the Python engine's files into public/pyodide/ (generated, not
 * committed): the Pyodide runtime plus the wheels the Scripts page loads —
 * numpy, pandas, matplotlib, scipy, scikit-learn, networkx, statsmodels
 * and their dependencies from the Pyodide distribution, and plotly from
 * PyPI. Serving them from our own origin keeps the sandbox's network
 * allowance to this origin and makes loads fast and offline-capable.
 *
 * Idempotent: files already present are kept; pass --force to refetch.
 * Runs before `npm run dev` / `npm run build`; a failed download only
 * warns (the engine then falls back to the CDN at run time).
 *
 * Everything fetched is checked before it is kept, because it ships in the
 * build and runs in the Python sandbox: the runtime's own files against the
 * SHA-256 pinned below for this version, every wheel against the sha256 that
 * pinned `pyodide-lock.json` carries for it, and plotly — pinned to one
 * version — against the digest PyPI publishes for that exact file. A file
 * that does not match is deleted and the script exits non-zero: a tampered
 * download is an error, never a warning. Files already on disk are checked
 * the same way on every run.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const PYODIDE_VERSION = '0.27.7'
/** SHA-256 of the runtime's files for PYODIDE_VERSION (checked against jsdelivr on 2026-09-26). Bump with the version. */
const CORE_SHA256 = {
  'pyodide.js': 'b4cb23a53aba19c221659b9fb40a2f18281d685691dc06647fb0afd0681baf98',
  'pyodide.asm.js': '6b4c90de5b7172873f04f21884d0e9d2274e305fe32116558fe3e4fbe3618d51',
  'pyodide.asm.wasm': 'a50dd1843f805a0b7c45b61037ee0d7b26dfe85efe0e18ef95a34ad24e401f5f',
  'python_stdlib.zip': '16611534726e5d8ac2bd8f926410b2dcb8d6f49aa24913463533b457a2115c16',
  'pyodide-lock.json': '9c45b916001a750f4102fc287494f3eab215909c7535c626a20db80fd6333e2c',
}
/** plotly is pinned to one release; its wheel is checked against PyPI's digest for that file. */
const PLOTLY_VERSION = '7.0.0'
/** A file name from the lock or PyPI becomes a path under public/pyodide: a plain name, nothing that climbs out. */
const SAFE_NAME = /^[\w.+-]+$/
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full`
const DIR = resolve(process.argv[1], '../../../public/pyodide')
const WANT = ['micropip', 'numpy', 'pandas', 'matplotlib', 'scipy', 'scikit-learn', 'networkx', 'statsmodels', 'narwhals', 'packaging', 'tzdata', 'regex']
const CORE = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']
const force = process.argv.includes('--force')
const quiet = process.argv.includes('--quiet')
const log = (...a) => !quiet && console.log(...a)

mkdirSync(DIR, { recursive: true })

class IntegrityError extends Error {}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** Fetch `url` to `file` unless it is already there — either way, the file on disk must hash to `expected`. */
async function download(url, file, expected) {
  if (!SAFE_NAME.test(file) || file.startsWith('.')) throw new IntegrityError(`refusing the file name ${JSON.stringify(file)}`)
  if (!/^[0-9a-f]{64}$/.test(expected ?? '')) throw new IntegrityError(`no SHA-256 to check ${file} against`)
  const path = resolve(DIR, file)
  if (!force && existsSync(path) && statSync(path).size > 0) {
    if (sha256(readFileSync(path)) === expected) return false
    rmSync(path)
    log(`[pyodide] ${file} on disk does not match its SHA-256; fetching it again`)
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  const body = Buffer.from(await res.arrayBuffer())
  const got = sha256(body)
  if (got !== expected) throw new IntegrityError(`${file} from ${url} has SHA-256 ${got}, expected ${expected} — not kept`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return true
}

try {
  let fetched = 0
  for (const f of CORE) if (await download(`${CDN}/${f}`, f, CORE_SHA256[f])) fetched++
  const lock = JSON.parse(readFileSync(resolve(DIR, 'pyodide-lock.json'), 'utf8'))
  const packages = lock.packages
  const need = new Set()
  const visit = (name) => {
    const p = packages[name]
    if (!p) throw new Error(`pyodide-lock.json has no package ${name}`)
    if (need.has(name)) return
    need.add(name)
    for (const d of p.depends) visit(d)
  }
  for (const w of WANT) visit(w)
  for (const name of need) if (await download(`${CDN}/${packages[name].file_name}`, packages[name].file_name, packages[name].sha256)) fetched++
  // plotly is pure Python and not in the distribution: one pinned release's wheel from PyPI, installed by micropip from our origin.
  const manifestPath = resolve(DIR, 'manifest.json')
  const manifest = existsSync(manifestPath) && !force ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
  const plotlyOnDisk = manifest.plotly && SAFE_NAME.test(manifest.plotly) && existsSync(resolve(DIR, manifest.plotly)) ? resolve(DIR, manifest.plotly) : null
  if (manifest.plotlyVersion !== PLOTLY_VERSION || !plotlyOnDisk || sha256(readFileSync(plotlyOnDisk)) !== manifest.plotlySha256) {
    const meta = await (await fetch(`https://pypi.org/pypi/plotly/${PLOTLY_VERSION}/json`)).json()
    const wheel = meta.urls.find((u) => u.packagetype === 'bdist_wheel' && u.filename.endsWith('py3-none-any.whl'))
    if (!wheel) throw new Error(`No pure wheel for plotly ${PLOTLY_VERSION} on PyPI`)
    if (!wheel.url.startsWith('https://files.pythonhosted.org/')) throw new IntegrityError(`plotly's wheel is not on files.pythonhosted.org: ${wheel.url}`)
    if (await download(wheel.url, wheel.filename, wheel.digests.sha256)) fetched++
    manifest.plotly = wheel.filename
    manifest.plotlyVersion = PLOTLY_VERSION
    manifest.plotlySha256 = wheel.digests.sha256
  }
  manifest.pyodide = PYODIDE_VERSION
  manifest.packages = [...need].sort()
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const total = [...need].reduce((s, n) => s + statSync(resolve(DIR, packages[n].file_name)).size, 0) + CORE.reduce((s, f) => s + statSync(resolve(DIR, f)).size, 0)
  log(`pyodide ${PYODIDE_VERSION}: ${need.size} packages + plotly ${manifest.plotlyVersion} in public/pyodide (${(total / 1048576).toFixed(0)} MB${fetched ? `, ${fetched} files fetched` : ', up to date'})`)
} catch (e) {
  if (e instanceof IntegrityError) {
    console.error(`[pyodide] integrity check failed: ${e.message}`)
    process.exit(1)
  }
  console.warn(`[pyodide] could not complete the download (${e instanceof Error ? e.message : e}); the Python engine will load from the CDN instead.`)
}
