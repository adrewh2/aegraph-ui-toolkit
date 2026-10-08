import { describe, expect, it } from 'vitest'
import { headerComment } from '../script'

describe('script descriptions', () => {
  it('reads the comment block a script opens with, as paragraphs', () => {
    expect(headerComment('// Reliability terrain — weeks × services.\n//\n// Height is latency; colour is\n// availability.\nimport x from "y"\n// not this')).toBe('Reliability terrain — weeks × services.\n\nHeight is latency; colour is availability.')
    expect(headerComment('# MTTR by month\n# before and after\nimport pandas as pd')).toBe('MTTR by month before and after')
    expect(headerComment('"""Degree distribution.\n\nOne bar per type."""\nimport networkx')).toBe('Degree distribution.\n\nOne bar per type.')
    expect(headerComment('"""one line"""\nx = 1')).toBe('one line')
    expect(headerComment('const a = 1 // trailing')).toBe('')
    expect(headerComment('')).toBe('')
  })

})
