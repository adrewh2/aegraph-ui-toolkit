/**
 * What the import map used to do.
 *
 * A Visual script is an ES module that may `import * as THREE from 'three'`.
 * Bare specifiers like that are resolved by an import map, and an import map
 * has to be an inline `<script type="importmap">` — the spec has no external
 * form. Inline script inside the sandbox frame is exactly what a
 * Content-Security-Policy on the app forbids (the frame inherits the app's
 * policy and cannot widen it), so the map is gone and the specifiers are
 * rewritten to the URLs it named before the module is made.
 *
 * The rewrite is deliberately narrow: a specifier is only touched when it is
 * exactly a key of the map, or begins with a key that ends in `/`. Anything
 * else — a relative path, a full URL, a package the map does not name — is
 * left as it was, so the error a script gets for importing something that is
 * not there is the browser's own.
 */

/** The map the sandbox is given: bare specifier (or a `…/` prefix) to a URL. */
export type ImportMap = Record<string, string>

/** Where the libraries the Visual engine offers are served from, given this origin. */
export const viewImportMap = (origin: string): ImportMap => ({
  three: `${origin}/vendor/three/build/three.module.js`,
  'three/addons/': `${origin}/vendor/three/examples/jsm/`,
  'three/examples/jsm/': `${origin}/vendor/three/examples/jsm/`,
})

/** The URL a specifier resolves to, or null when the map does not name it. Longest matching prefix wins. */
export function resolveSpecifier(spec: string, map: ImportMap): string | null {
  if (map[spec]) return map[spec]
  let best: { key: string; url: string } | null = null
  for (const [key, url] of Object.entries(map)) {
    if (!key.endsWith('/') || !spec.startsWith(key)) continue
    if (!best || key.length > best.key.length) best = { key, url }
  }
  return best ? best.url + spec.slice(best.key.length) : null
}

/**
 * `import`/`export` specifiers the map names, rewritten to their URLs.
 *
 * Covers the forms a module can name one in: `import … from '…'`,
 * a bare `import '…'`, `export … from '…'`, and a dynamic `import('…')`.
 * It works on the source text — there is no parser here — so it matches only
 * where a specifier can legally sit, and leaves everything else alone.
 */
export function rewriteSpecifiers(code: string, map: ImportMap): string {
  if (Object.keys(map).length === 0) return code
  const swap = (quote: string, spec: string) => {
    const url = resolveSpecifier(spec, map)
    return url === null ? null : `${quote}${url}${quote}`
  }
  return (
    code
      // `from '…'` — the tail of a static import or a re-export.
      .replace(/\bfrom\s*(['"])([^'"\n]+)\1/g, (whole, q: string, spec: string) => {
        const next = swap(q, spec)
        return next === null ? whole : whole.slice(0, whole.indexOf(q)) + next
      })
      // `import '…'` for a side-effect-only module, and `import('…')` for a dynamic one.
      .replace(/\bimport\s*(\(\s*)?(['"])([^'"\n]+)\2/g, (whole, paren: string | undefined, q: string, spec: string) => {
        const next = swap(q, spec)
        return next === null ? whole : `import${paren ? paren : ' '}${next}`
      })
  )
}
