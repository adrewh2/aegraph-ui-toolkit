import { describe, expect, it } from 'vitest'
import { detectLanguage } from '../detect'
import { outputsOf } from '../outputs'

describe('language detection', () => {
  it('tells Python from JavaScript', () => {
    expect(detectLanguage(`import plotly.express as px\ninc = by_type('incident')\npx.line(inc, x='startedAt', y='duration_min')`)).toBe('python')
    expect(detectLanguage(`const inc = ds.byType('incident')\nreturn figure(line(inc.map((e) => e.data.startedAt), inc.map((e) => e.data.duration_min)))`)).toBe('js')
    expect(detectLanguage(`def f(x):\n    return x * 2\nprint(f(2))`)).toBe('python')
    expect(detectLanguage(`// top by degree\nreturn table(topK(ds.entities, (e) => ds.degree(e.id), 10))`)).toBe('js')
    expect(detectLanguage(`entities.groupby('type').size()`)).toBe('python')
    expect(detectLanguage(`import * as THREE from 'three'\nconst scene = new THREE.Scene()`)).toBe('view')
    expect(detectLanguage(`const d3 = await aegraph.load('d3')\nd3.select('#app').append('svg')`)).toBe('view')
  })
  it('reads image outputs', () => {
    expect(outputsOf({ image: { png: 'iVBOR' } })).toEqual([{ kind: 'image', png: 'iVBOR' }])
  })
})
