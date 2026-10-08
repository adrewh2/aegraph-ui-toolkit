import { describe, expect, it } from 'vitest'
import { atIntrinsicSize } from '../render'

describe('atIntrinsicSize', () => {
  it('gives Mermaid’s responsive picture the size of its viewBox, so a zoom scales it', () => {
    const svg = '<svg id="mmd-1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 548.5px; background-color: white;" viewBox="-8 -8 548.5 318" role="graphics-document document"><g/></svg>'
    const out = atIntrinsicSize(svg)
    expect(out).toContain('width="548.5"')
    expect(out).toContain('height="318"')
    expect(out).not.toContain('width="100%"')
    expect(out).not.toContain('max-width')
    expect(out).toContain('background-color: white;')
    expect(out.endsWith('<g/></svg>')).toBe(true)
  })

  it('leaves a picture that already has a size alone (Graphviz)', () => {
    const svg = '<svg width="206pt" height="116pt" viewBox="0.00 0.00 206.00 116.00" xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    expect(atIntrinsicSize(svg)).toBe(svg)
  })

  it('leaves what it cannot read alone', () => {
    expect(atIntrinsicSize('')).toBe('')
    expect(atIntrinsicSize('<svg width="100%"><g/></svg>')).toBe('<svg width="100%"><g/></svg>')
  })
})
