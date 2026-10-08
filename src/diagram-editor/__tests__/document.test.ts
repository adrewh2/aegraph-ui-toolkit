import { describe, expect, it } from 'vitest'
import { EMPTY_SCENE, isScene, sceneSummary } from '../document'

describe('diagram-editor document', () => {
  it('recognises scenes and counts what is in them', () => {
    expect(isScene(EMPTY_SCENE)).toBe(true)
    expect(isScene('digraph { a -> b }')).toBe(false)
    expect(isScene(undefined)).toBe(false)
    expect(sceneSummary(EMPTY_SCENE)).toEqual({ elements: 0, shapes: 0, arrows: 0, text: 0 })
    const scene = JSON.stringify({ type: 'excalidraw', elements: [{ type: 'rectangle' }, { type: 'arrow' }, { type: 'text' }, { type: 'ellipse', isDeleted: true }] })
    expect(sceneSummary(scene)).toEqual({ elements: 3, shapes: 1, arrows: 1, text: 1 })
    expect(sceneSummary('not json')).toEqual({ elements: 0, shapes: 0, arrows: 0, text: 0 })
  })
})
