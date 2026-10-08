import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PY_API } from '../../features/scripts/api'
import { detectLanguage } from '../detect'
import { outputsOf } from '../outputs'

/**
 * The Python prelude against the text that documents it (by reading —
 * no Pyodide here), and the language detector at its edges: nothing,
 * only comments, shebangs, a Python-looking line inside a JS string,
 * `import` in both languages, print beside console.log, JS that indexes
 * `entities[`, Python that mentions `null`, ternaries ending in a colon,
 * a canvas in a comment; then image outputs of odd shapes.
 */
describe('python prelude ↔ PY_API pairing', () => {
  const src = readFileSync(fileURLToPath(new URL('../python/prelude.py', import.meta.url)), 'utf8')
  const functions = [...src.matchAll(/^def ([a-z]\w*)\(/gm)].map((m) => m[1])
  const globals = [...src.matchAll(/^([a-z]\w*) = /gm)].map((m) => m[1])

  it('every public function and global the prelude defines is documented, and every call the text names is defined', () => {
    expect(functions).toEqual(['get', 'type_def', 'properties', 'describe', 'by_type', 'out', 'inn', 'neighbors', 'degree', 'metric', 'graph', 'ms', 'bin', 'days_between', 'hours_between', 'iso_date', 'count', 'mean', 'quantile', 'median', 'distinct', 'correlation', 'group_by', 'rollup', 'sort_by', 'top_k', 'rolling', 'line', 'scatter', 'bar', 'area', 'box', 'histogram', 'heatmap', 'pie', 'log', 'figure', 'table', 'scene', 'layout', 'style'])
    expect(globals).toEqual(['ds', 'entities', 'relationships', 'metrics', 'ontology', 'project', 'tags'])
    for (const f of functions) expect(PY_API, f).toMatch(new RegExp(`\\b${f}\\(`))
    for (const g of globals) expect(PY_API, g).toMatch(new RegExp(`^\\s+${g} — `, 'm'))
    // Calls the text spells out, minus pandas/plotly and the example's own names.
    const named = [...new Set([...PY_API.matchAll(/(?<![\w.'])([a-z_]+)\(/g)].map((m) => m[1]))].filter((n) => !['print', 'analyze', 'ds'].includes(n))
    expect(named.filter((n) => !functions.includes(n))).toEqual([])
    // Private helpers stay private: nothing with a leading underscore is documented.
    for (const priv of [...src.matchAll(/^def (_\w+)\(/gm)].map((m) => m[1])) expect(PY_API).not.toContain(priv)
  })
})

describe('language detection edges', () => {
  const d = detectLanguage
  it('nothing, whitespace and shebangs alone are JavaScript; a lone comment says its language', () => {
    expect(d('')).toBe('js')
    expect(d('   \n\t\n')).toBe('js')
    expect(d('#!/usr/bin/env python3')).toBe('js') // no space after the hash: not read as a Python comment
    expect(d('#!/usr/bin/env node')).toBe('js')
    expect(d('# just a note')).toBe('python')
    expect(d('// just a note')).toBe('js')
    expect(d('/* block */')).toBe('js')
    expect(d('"""a docstring"""')).toBe('js') // a docstring alone carries no signal
  })

  it('a Python-looking line inside a JavaScript string does not turn the script, nor does print beside const; print alone with console.log is Python', () => {
    expect(d(`const s = "print(hello)"\nreturn s`)).toBe('js')
    expect(d(`const s = 'if x:'; return s;`)).toBe('js')
    expect(d(`print("x")\nconsole.log("y")`)).toBe('python')
    expect(d(`const a = 1\nprint(a)`)).toBe('js') // a tie with no import falls to JavaScript
    expect(d(`x = None`)).toBe('python')
    expect(d(`x = null`)).toBe('js')
    expect(d(`return ds.entities[0]`)).toBe('js') // `entities[` counts for Python, `ds.entities` for JavaScript: a tie
    expect(d(`entities[entities.type == 'incident']`)).toBe('python')
    expect(d(`const y = ok ? 1 :\n  2`)).toBe('js')
    expect(d(`for i in range(3):\n    pass`)).toBe('python')
    expect(d(`for (let i = 0; i < 3; i++) {}`)).toBe('js')
    expect(d(`lambda x: x`)).toBe('python')
    expect(d(`const f = (x) => x`)).toBe('js')
  })

  it('imports: a Python import is Python, a JavaScript module import of three is a view, other module imports read as Python (scripts cannot import anyway), and a tie breaks on import', () => {
    expect(d(`import pandas as pd`)).toBe('python')
    expect(d(`from collections import Counter`)).toBe('python')
    expect(d(`import * as THREE from 'three'`)).toBe('view')
    expect(d(`import { OrbitControls } from 'three/addons/controls/OrbitControls.js'`)).toBe('view')
    expect(d(`import _ from 'lodash'`)).toBe('python')
    expect(d(`import { x } from 'y'`)).toBe('python')
    expect(d(`import x\nconst y = 1`)).toBe('python')
  })

  it('a view needs two signs or one of the sure ones; a canvas in a comment alone is not enough, and JavaScript that only mentions a canvas stays JavaScript', () => {
    expect(d(`// draw on the canvas\nconst x = 1`)).toBe('js')
    expect(d(`const c = document.createElement('canvas')`)).toBe('view')
    expect(d(`requestAnimationFrame(tick)`)).toBe('js')
    expect(d(`requestAnimationFrame(tick)\nconst r = new WebGLRenderer()`)).toBe('view')
    expect(d(`Plotly.newPlot(el, data)`)).toBe('view')
    expect(d(`const Plotly = await aegraph.load('plotly'); Plotly.react(el, data)`)).toBe('js') // react alone is one sign
    expect(d(`d3.select('svg')`)).toBe('view')
    expect(d(`aegraph.width`)).toBe('js')
    expect(d(`aegraph.width + aegraph.height`)).toBe('js') // the same sign twice is one sign
    expect(d(`aegraph.width\ndocument.body.append(el)`)).toBe('view')
  })
})

describe('image outputs of odd shapes', () => {
  it('reads an image only from a string png; a number, a missing png, an empty png or a bare string are values; an image beside text keeps both', () => {
    expect(outputsOf({ image: { png: 'AAAA' } })).toEqual([{ kind: 'image', png: 'AAAA' }])
    expect(outputsOf({ image: { png: 1 } })).toEqual([{ kind: 'value', value: { image: { png: 1 } } }])
    expect(outputsOf({ image: { jpeg: 'x' } })).toEqual([{ kind: 'value', value: { image: { jpeg: 'x' } } }])
    expect(outputsOf({ image: 'AAAA' })).toEqual([{ kind: 'value', value: { image: 'AAAA' } }])
    expect(outputsOf({ image: { png: '' } })).toEqual([{ kind: 'value', value: { image: { png: '' } } }])
    expect(outputsOf({ image: { png: 'AAAA' }, text: 'caption' }).map((o) => o.kind)).toEqual(['text', 'image'])
    expect(outputsOf({ image: null })).toEqual([{ kind: 'value', value: { image: null } }])
  })
})
