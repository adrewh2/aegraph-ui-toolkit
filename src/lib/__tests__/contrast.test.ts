import { describe, expect, it } from 'vitest'
import { contrastText } from '../format'

describe('contrastText', () => {
  it('uses white on dark backgrounds and ink on light ones', () => {
    expect(contrastText('#1e3a8a')).toBe('#fff')
    expect(contrastText('#000')).toBe('#fff')
    expect(contrastText('rgb(20, 30, 40)')).toBe('#fff')
    expect(contrastText('hsl(220 55% 30%)')).toBe('#fff')
    expect(contrastText('#fde68a')).toBe('#1f1e1b')
    expect(contrastText('hsl(120 55% 78%)')).toBe('#1f1e1b')
    expect(contrastText('#eaf1fb')).toBe('#1f1e1b')
    expect(contrastText(undefined)).toBe('#1f1e1b')
  })
})
