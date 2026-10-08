#!/usr/bin/env node
/**
 * Bring the demo projects of the private `aegraph-ui-demos` repo into
 * public/demos/ at build time, so the deployed app serves them as static
 * files — no runtime proxy, no token in the browser, the repo stays private.
 *
 * Where they come from, first match wins:
 *   AEGRAPH_DEMOS_DIR      a checkout on this machine (default: ../aegraph-ui-demos
 *                          or ~/workspace/aegraph-ui-demos when one exists)
 *   AEGRAPH_DEMOS_TOKEN    a GitHub token that can read the repo (a fine-grained
 *                          token with Contents: read on that one repository) —
 *                          what the Vercel build uses, with
 *   AEGRAPH_DEMOS_REPO     owner/name (default adrewh2/aegraph-ui-demos) and
 *   AEGRAPH_DEMOS_REF      the branch, tag or commit (default main) — a commit SHA
 *                          pins exactly what a build ships, which is what a
 *                          fork that does not control that repository wants
 *   AEGRAPH_DEMOS_SITE     a site that publishes the demos — its own build fetched
 *                          them — read over https from <site>/demos/catalog.json
 *                          and /demos/<id>/<file> (default https://aegraph.dev,
 *                          `off` for none): how a build with neither a checkout
 *                          nor a token, a fork's or a clone's, still has them
 * None: nothing is written and the app shows no demos card.
 *
 * What is written: public/demos/catalog.json (the repo's catalog with URLs
 * pointing at this origin) and, per demo, bundle.ae.json.gz (gzipped here —
 * a sixth of the size on disk and on the wire, and the app reads gzip bytes
 * as they are) or bundle.aeb when the demo ships the pack (a very big one:
 * gzipped already, copied as it is), preview.png and README.md. A demo whose `exportedAt` and
 * `bytes` match what is already on disk is not fetched again, so a rebuild
 * costs one small request per demo. Generated, not committed.
 *
 * The catalog is data from another repository, and what is written here is
 * served from this origin: ./catalog.mjs says what is accepted from it — plain
 * names, a bundle that is a bundle, a preview that is a picture — and builds
 * each entry from the fields the app reads.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { catalogEntry, checkNames, fromPublished, isPicture } from './catalog.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'public', 'demos')
const quiet = process.argv.includes('--quiet')
const force = process.argv.includes('--force')
const log = (...a) => !quiet && console.log('[demos]', ...a)

const REPO = process.env.AEGRAPH_DEMOS_REPO || 'adrewh2/aegraph-ui-demos'
const REF = process.env.AEGRAPH_DEMOS_REF || 'main'
const TOKEN = process.env.AEGRAPH_DEMOS_TOKEN || ''
const SITE = process.env.AEGRAPH_DEMOS_SITE ?? 'https://aegraph.dev'
/** A request that takes longer than this is given up (the build goes on without demos), and no file is read past MAX_BYTES. */
const TIMEOUT_MS = 300_000
const MAX_BYTES = 512 * 1024 * 1024

/** A response's body, refused past MAX_BYTES while it streams: a source that sends without end only costs the build its demos. */
async function capped(res, what) {
  const declared = Number(res.headers.get('content-length'))
  if (declared > MAX_BYTES) throw new Error(`${what} is ${declared} bytes, over the ${MAX_BYTES} limit`)
  const chunks = []
  let total = 0
  for await (const chunk of res.body ?? []) {
    total += chunk.length
    if (total > MAX_BYTES) throw new Error(`${what} is over the ${MAX_BYTES}-byte limit`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
const dirCandidates = [process.env.AEGRAPH_DEMOS_DIR, resolve(ROOT, '..', 'aegraph-ui-demos'), join(homedir(), 'workspace', 'aegraph-ui-demos')].filter(Boolean)
const DIR = dirCandidates.find((d) => existsSync(join(d, 'catalog.json')))

/** A source: `text(path)` and `bytes(path)` for files of the repo, however it is reached. */
function source() {
  if (DIR) {
    log(`from ${DIR}`)
    return { name: DIR, text: async (p) => readFileSync(join(DIR, p), 'utf8'), bytes: async (p) => readFileSync(join(DIR, p)) }
  }
  if (TOKEN) {
    log(`from github:${REPO}@${REF}`)
    const get = async (p) => {
      const url = `https://api.github.com/repos/${REPO}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(REF)}`
      const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github.raw+json', 'user-agent': 'aegraph-ui-build' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${p}`)
      return res
    }
    return { name: REPO, text: async (p) => (await capped(await get(p), p)).toString('utf8'), bytes: async (p) => capped(await get(p), p) }
  }
  if (SITE && SITE !== 'off') {
    let origin
    try {
      const u = new URL(SITE)
      if (u.protocol !== 'https:') throw new Error('not https')
      origin = u.origin
    } catch (err) {
      log(`AEGRAPH_DEMOS_SITE ${JSON.stringify(SITE)} is not an https site (${err.message}); skipping`)
      return null
    }
    log(`from ${origin} (the demos it publishes)`)
    // The site's own layout, which its build wrote: /demos/catalog.json and /demos/<id>/<file>. No redirects: what is
    // read is what that origin serves.
    const get = async (p) => {
      const res = await fetch(new URL(p === 'catalog.json' ? '/demos/catalog.json' : `/${p}`, origin), { redirect: 'error', headers: { 'user-agent': 'aegraph-ui-build' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${p}`)
      return res
    }
    return { name: origin, published: true, text: async (p) => (await capped(await get(p), p)).toString('utf8'), bytes: async (p) => capped(await get(p), p) }
  }
  return null
}

const src = source()
if (!src) {
  log('no source (set AEGRAPH_DEMOS_DIR, AEGRAPH_DEMOS_TOKEN or AEGRAPH_DEMOS_SITE); skipping')
  process.exit(0)
}

try {
  const catalog = JSON.parse(await src.text('catalog.json'))
  if (!Array.isArray(catalog.demos)) throw new Error('catalog.json has no demos[]')
  mkdirSync(OUT, { recursive: true })
  const out = { generatedAt: typeof catalog.generatedAt === 'string' ? catalog.generatedAt : undefined, source: DIR ? 'local checkout' : src.published ? src.name : REPO, fetchedAt: new Date().toISOString(), demos: [] }
  let fetched = 0
  for (const listed of catalog.demos) {
    // A site's catalog names its files by URL; the repo's, by name. Either way the same names are accepted.
    const d = src.published ? fromPublished(listed) : listed
    checkNames(d)
    const dir = join(OUT, d.id)
    const stampPath = join(dir, '.stamp.json')
    const stamp = existsSync(stampPath) && !force ? JSON.parse(readFileSync(stampPath, 'utf8')) : null
    const bundleName = d.bundle.endsWith('.aeb') ? 'bundle.aeb' : 'bundle.ae.json.gz'
    const fresh = stamp && stamp.exportedAt === d.exportedAt && stamp.bytes === d.bytes && existsSync(join(dir, bundleName))
    if (fresh) log(`${d.id}: up to date`)
    else {
      mkdirSync(dir, { recursive: true })
      const bundle = await src.bytes(`demos/${d.id}/${d.bundle}`)
      // A demo may keep its bundle gzipped already (a big graph), or as the pack (gzipped inside): copied as it is —
      // when it is gzip. A server that decoded a .gz on the way (Content-Encoding) handed over the JSON: gzipped here.
      const gzipped = bundle.length > 2 && bundle[0] === 0x1f && bundle[1] === 0x8b
      writeFileSync(join(dir, bundleName), gzipped || d.bundle.endsWith('.aeb') ? bundle : gzipSync(bundle, { level: 9 }))
      writeFileSync(stampPath, JSON.stringify({ exportedAt: d.exportedAt, bytes: d.bytes }))
      fetched++
      log(`${d.id}: ${(d.bytes / 1048576).toFixed(1)} MB → ${bundleName}`)
    }
    // The picture and the README are small and change on their own (a card retaken, a README reworded): copied every
    // time, whether or not the bundle was — the stamp only spares the bundle.
    mkdirSync(dir, { recursive: true })
    for (const f of [d.preview, 'README.md'].filter(Boolean)) {
      try {
        const bytes = await src.bytes(`demos/${d.id}/${f}`)
        // A preview whose bytes are not the picture its name says is not written: this origin would serve whatever it is.
        if (f === d.preview && !isPicture(f, bytes)) throw new Error('not a PNG, JPEG or WebP picture')
        writeFileSync(join(dir, f), bytes)
      } catch (err) {
        rmSync(join(dir, f), { force: true })
        log(`${d.id}: no ${f} (${err.message})`)
      }
    }
    // Nothing else stays in the demo's folder: a file an earlier catalog named is not served on this one's word.
    const keep = new Set([bundleName, '.stamp.json', d.preview, 'README.md'])
    for (const f of readdirSync(dir).filter((n) => !keep.has(n))) rmSync(join(dir, f), { recursive: true, force: true })
    out.demos.push(
      catalogEntry(d, {
        bundleUrl: `/demos/${d.id}/${bundleName}`,
        previewUrl: d.preview && existsSync(join(dir, d.preview)) ? `/demos/${d.id}/${d.preview}` : undefined,
        readmeUrl: existsSync(join(dir, 'README.md')) ? `/demos/${d.id}/README.md` : undefined,
      }),
    )
  }
  // Demos that left the catalog leave the output too.
  for (const stale of readdirSync(OUT).filter((n) => !n.endsWith('.json') && !catalog.demos.some((d) => d.id === n))) {
    rmSync(join(OUT, stale), { recursive: true, force: true })
    log(`${stale}: removed`)
  }
  writeFileSync(join(OUT, 'catalog.json'), JSON.stringify(out, null, 2))
  log(`${out.demos.length} demo${out.demos.length === 1 ? '' : 's'} in the catalog, ${fetched} fetched`)
} catch (err) {
  // The build goes on without demos rather than failing over them; the app simply shows no card.
  console.warn(`[demos] not available: ${err.message}`)
}
