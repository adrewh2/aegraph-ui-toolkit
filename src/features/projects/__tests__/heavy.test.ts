import { describe, expect, it } from 'vitest'
import { heavyWarning } from '../heavy'

describe('a demo that pushes the browser to its limits says so on its card', () => {
  it('the WildChat atlas does; the Toronto trees and a demo without counts do not', () => {
    const atlas = heavyWarning({ counts: { entities: 1_000_516, relationships: 1_085_769 } })
    expect(atlas?.label).toBe('Pushes this browser to its limits')
    expect(atlas?.detail).toMatch(/2\.1 million entities and relationships: about 1.5 GB of memory/)
    expect(atlas?.detail).toMatch(/clearing it asks before drawing everything/)
    expect(heavyWarning({ counts: { entities: 688_755, relationships: 602 } })).toBeUndefined()
    expect(heavyWarning({})).toBeUndefined()
  })
})
