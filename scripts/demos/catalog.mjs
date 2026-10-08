/**
 * What `scripts/demos/fetch.mjs` accepts from the demos catalog. The catalog is
 * data from another repository, and what fetch writes is served from the app's
 * own origin — where `script-src 'self'` would run a script it carried — so
 * nothing it names is taken on trust:
 *
 * - every name that becomes a path (the id, the bundle, the preview) is a plain
 *   file name, so nothing can be written outside public/demos/<id>/;
 * - the bundle is a bundle (`.ae.json`, `.ae.json.gz`, `.aeb`) and the preview a
 *   picture (`.png`, `.jpg`, `.jpeg`, `.webp`) whose first bytes say so — never
 *   a page or a script;
 * - each entry of the catalog that is written is rebuilt from the fields the app
 *   reads (`DemoEntry` in src/features/datasets/demos.ts), each of its own type,
 *   never a copy of what the other repository wrote.
 *
 * `vercel.json` serves /demos/ with `Content-Security-Policy: sandbox` besides.
 * The demos repository's CI applies the same name rules before anything merges.
 */

/** A name from the catalog that becomes a path: letters, digits, `_`, `.`, `-`, and not starting with a dot. */
export const PLAIN = /^[\w-][\w.-]*$/
/** What a demo's bundle may be called: a bundle, gzipped or not, or the pack. */
export const BUNDLE = /\.(ae\.json|ae\.json\.gz|aeb)$/
/** What a demo's preview may be called: a picture. */
export const PREVIEW = /\.(png|jpe?g|webp)$/

/** Whether bytes are the picture their name says: PNG, JPEG or WebP, by their magic numbers. */
export function isPicture(name, bytes) {
  const b = Buffer.from(bytes)
  if (/\.png$/.test(name)) return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (/\.jpe?g$/.test(name)) return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  if (/\.webp$/.test(name)) return b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
  return false
}

/** Throws, naming the first name of a catalog entry that may not become a path here. */
export function checkNames(d) {
  for (const [what, name, shape, says] of [
    ['id', d?.id, null, ''],
    ['bundle', d?.bundle, BUNDLE, 'an .ae.json, .ae.json.gz or .aeb file'],
    ['preview', d?.preview ?? 'preview.png', PREVIEW, 'a .png, .jpg or .webp picture'],
  ]) {
    if (typeof name !== 'string' || !PLAIN.test(name)) throw new Error(`demo ${what} ${JSON.stringify(name)} is not a plain name`)
    // An id is a folder beside catalog.json: one named like a file there (`catalog.json`) would take its place.
    if (what === 'id' && /\.json$/i.test(name)) throw new Error(`demo id ${JSON.stringify(name)} is named like a file`)
    if (shape && !shape.test(name)) throw new Error(`demo ${what} ${JSON.stringify(name)} is not ${says}`)
  }
}

const str = (v) => (typeof v === 'string' ? v : undefined)
const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function counts(c) {
  if (!c || typeof c !== 'object') return undefined
  const byType = c.byType && typeof c.byType === 'object' ? Object.fromEntries(Object.entries(c.byType).filter(([k, n]) => k !== '__proto__' && num(n) !== undefined)) : undefined
  return { entities: num(c.entities) ?? 0, relationships: num(c.relationships) ?? 0, ...(byType ? { byType } : {}) }
}

/** The catalog entry the app reads, built field by field; `urls` are the ones fetch made, on this origin. */
export function catalogEntry(d, urls) {
  const home = str(d.home)
  return {
    id: d.id,
    title: str(d.title) ?? d.id,
    description: str(d.description) ?? '',
    tags: strs(d.tags),
    // A route in this app: a path, never `//host` or a scheme.
    home: home && /^\/(?!\/)/.test(home) ? home : undefined,
    highlights: strs(d.highlights),
    author: str(d.author),
    created: str(d.created),
    updated: str(d.updated),
    counts: counts(d.counts),
    bytes: num(d.bytes),
    exportedAt: str(d.exportedAt),
    bundleUrl: urls.bundleUrl,
    previewUrl: urls.previewUrl,
    readmeUrl: urls.readmeUrl,
  }
}

/**
 * An entry of a site's published catalog (`<site>/demos/catalog.json`, what `catalogEntry` wrote there) as an entry of
 * the repo's, so a build can take its demos from a site that publishes them: the bundle and the preview are named by
 * the last part of their URLs, which must be `/demos/<id>/<plain name>` on that site — anything else is refused, as a
 * name the repo could not have had. `checkNames` then holds it to the same rules.
 */
export function fromPublished(d) {
  const id = d?.id
  const file = (url, what) => {
    if (url === undefined) return undefined
    const m = typeof url === 'string' ? /^\/demos\/([^/]+)\/([^/]+)$/.exec(url) : null
    if (!m || m[1] !== id) throw new Error(`published demo ${JSON.stringify(id)}: ${what} ${JSON.stringify(url)} is not /demos/<id>/<file>`)
    return m[2]
  }
  const entry = { ...d, bundle: file(d?.bundleUrl, 'bundleUrl'), preview: file(d?.previewUrl, 'previewUrl') }
  checkNames(entry)
  return entry
}
