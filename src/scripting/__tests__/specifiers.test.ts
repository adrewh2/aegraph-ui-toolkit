import { describe, expect, it } from 'vitest'
import { resolveSpecifier, rewriteSpecifiers, viewImportMap } from '../view/specifiers'

/**
 * The import map a Visual script used to get from an inline
 * `<script type="importmap">`, which a Content-Security-Policy on the app
 * forbids inside the sandbox. `import * as THREE from 'three'` is documented,
 * so it has to keep working — by rewriting, now.
 */
const map = viewImportMap('https://aegraph.dev')

describe('resolving a specifier the way the import map did', () => {
  it('takes an exact key, and a prefix key with the rest of the path appended', () => {
    expect(resolveSpecifier('three', map)).toBe('https://aegraph.dev/vendor/three/build/three.module.js')
    expect(resolveSpecifier('three/addons/controls/OrbitControls.js', map)).toBe('https://aegraph.dev/vendor/three/examples/jsm/controls/OrbitControls.js')
    expect(resolveSpecifier('three/examples/jsm/loaders/GLTFLoader.js', map)).toBe('https://aegraph.dev/vendor/three/examples/jsm/loaders/GLTFLoader.js')
  })

  it('leaves alone what the map does not name', () => {
    for (const spec of ['./local.js', '../up.js', '/abs.js', 'https://cdn.example/x.js', 'd3', 'threejs', 'three-x']) {
      expect(resolveSpecifier(spec, map), spec).toBeNull()
    }
  })
})

describe('rewriting a module’s imports', () => {
  it('rewrites every form a specifier can appear in', () => {
    const out = rewriteSpecifiers(
      [
        `import * as THREE from 'three'`,
        `import { OrbitControls } from "three/addons/controls/OrbitControls.js"`,
        `import 'three'`,
        `export { Scene } from 'three'`,
        `const m = await import('three')`,
        `const n = await import( "three/addons/loaders/GLTFLoader.js" )`,
      ].join('\n'),
      map,
    )
    expect(out).not.toMatch(/'three'|"three"|'three\/|"three\//)
    expect(out.match(/vendor\/three/g)).toHaveLength(6)
    expect(out).toContain(`import * as THREE from 'https://aegraph.dev/vendor/three/build/three.module.js'`)
    expect(out).toContain(`examples/jsm/controls/OrbitControls.js"`)
    expect(out).toContain(`await import('https://aegraph.dev/vendor/three/build/three.module.js')`)
  })

  it('leaves a script that imports nothing, or nothing mapped, byte for byte', () => {
    for (const code of [
      `const scene = { nodes: ds.nodes }\naegraph.result({ text: 'hi' })`,
      `import './helper.js'\nimport x from 'https://cdn.example/x.js'`,
      `// the word three, and a string 'three-ish', in a comment`,
    ]) {
      expect(rewriteSpecifiers(code, map), code).toBe(code)
    }
  })

  it('keeps the quote style it found, so a script reads back as it was written', () => {
    expect(rewriteSpecifiers(`import a from "three"`, map)).toContain(`from "https://`)
    expect(rewriteSpecifiers(`import a from 'three'`, map)).toContain(`from 'https://`)
  })

  it('is a no-op with an empty map', () => {
    expect(rewriteSpecifiers(`import * as THREE from 'three'`, {})).toBe(`import * as THREE from 'three'`)
  })
})
