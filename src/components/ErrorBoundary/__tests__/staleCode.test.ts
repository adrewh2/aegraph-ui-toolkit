import { describe, expect, it } from 'vitest'
import { isStaleCode } from '../ErrorBoundary'

describe('isStaleCode — a crash that only a reload fixes', () => {
  it('knows a hook list lost to a hot-swap, and two copies of React', () => {
    // What the sidebar died of when useAppHost gained a hook under a mounted component.
    expect(isStaleCode(new TypeError("Cannot read properties of null (reading 'getSnapshot')"))).toBe(true)
    expect(isStaleCode(new Error('Rendered more hooks than during the previous render.'))).toBe(true)
    expect(isStaleCode(new TypeError("Cannot read properties of null (reading 'useState')"))).toBe(true)
  })
  it('knows a chunk a deploy removed', () => {
    expect(isStaleCode(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js'))).toBe(true)
  })
  it('does not call an ordinary bug stale', () => {
    expect(isStaleCode(new TypeError("Cannot read properties of undefined (reading 'label')"))).toBe(false)
  })
})
