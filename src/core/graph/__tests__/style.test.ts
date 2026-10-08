import { describe, expect, it } from 'vitest'
import { edgeColor, nodeColor, nodeSize, toHexColor } from '../style'

const HEX = /^#[0-9a-f]{6}$/

describe('graph style colours', () => {
  it('turns every colour form the app produces into #rrggbb, and leaves the rest alone', () => {
    expect(toHexColor('#1a2b3c')).toBe('#1a2b3c')
    expect(toHexColor('#ABC')).toBe('#aabbcc')
    expect(toHexColor('rgb(255, 0, 128)')).toBe('#ff0080')
    expect(toHexColor('rgba(10,20,30,0.5)')).toBe('#0a141e')
    expect(toHexColor('hsl(0 100% 50%)')).toBe('#ff0000')
    expect(toHexColor('hsl(120 100% 25%)')).toBe('#008000')
    expect(toHexColor('hsl(240 0% 50%)')).toBe('#808080')
    expect(toHexColor('tomato')).toBe('tomato')
    expect(toHexColor('')).toBe('')
  })

  it('hands renderers hex for a readable type colour and greys a near-white one', () => {
    // Dark enough to read: unchanged in value, hex in form (a renderer cannot parse hsl()).
    expect(nodeColor('#336699', 'note')).toBe('#336699')
    expect(nodeColor('hsl(210 50% 40%)', 'note')).toMatch(HEX)
    // Near white would vanish on the page: mixed toward grey, and darker on every channel.
    const pale = nodeColor('#fafafa', 'note')
    const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(pale)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThan(250)
    expect(Number(m![1])).toBeGreaterThan(110)
    // The pull is capped: pure white lands at the same grey band, never lighter than about 170.
    const white = /^rgb\((\d+)/.exec(nodeColor('#ffffff', 'note'))!
    expect(Number(white[1])).toBeLessThanOrEqual(170)
    expect(Math.abs(Number(white[1]) - Number(m![1]))).toBeLessThan(6)
    // No type colour: a colour hashed from the type name, stable and hex.
    expect(nodeColor(undefined, 'person')).toBe(nodeColor(undefined, 'person'))
    expect(nodeColor(undefined, 'person')).toMatch(/^#|^rgb\(/)
    // A form toRgb does not know passes through as it came.
    expect(nodeColor('tomato', 'note')).toBe('tomato')
  })

  it('gives each relationship type a stable pale hex edge colour', () => {
    expect(edgeColor('cites')).toMatch(HEX)
    expect(edgeColor('cites')).toBe(edgeColor('cites'))
    expect(edgeColor('cites')).not.toBe(edgeColor('supports'))
    // Pale: every channel well above mid grey.
    const [r, g, b] = edgeColor('cites').slice(1).match(/../g)!.map((h) => parseInt(h, 16))
    for (const v of [r, g, b]) expect(v).toBeGreaterThan(150)
  })

  it('sizes nodes by degree, growing with its logarithm', () => {
    expect(nodeSize(0)).toBe(3)
    expect(nodeSize(1)).toBeGreaterThan(nodeSize(0))
    expect(nodeSize(100) - nodeSize(10)).toBeLessThan(nodeSize(10) - nodeSize(0))
    expect(nodeSize(1000)).toBeLessThan(20)
  })
})
