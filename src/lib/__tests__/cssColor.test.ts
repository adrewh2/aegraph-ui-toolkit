import { describe, expect, it } from 'vitest'
import { cssColor, isCssColor } from '../cssColor'

describe('isCssColor — a colour from data, and nothing else', () => {
  it('takes the forms the app writes', () => {
    for (const c of ['#abc', '#abcd', '#a1b2c3', '#a1b2c3d4', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'hsl(210deg 50% 40%)', 'hsla(210, 50%, 40%, .4)', 'teal', 'RebeccaPurple', ' red ']) expect(isCssColor(c), c).toBe(true)
  })
  it('refuses markup and CSS smuggled in as a colour', () => {
    for (const c of ['red"><img src=x onerror=alert(1)>', 'red;background:url(https://x)', 'rgb(1,2,3);background:url(https://x)', 'rgb(url(https://x))', 'url(https://x)', 'var(--x)', 'expression(alert(1))', '#12', '#12345', '', 'a'.repeat(80)]) expect(isCssColor(c), c).toBe(false)
    expect(isCssColor(5)).toBe(false)
  })
  it('falls back when it is not one', () => {
    expect(cssColor('red"><b>', '#888')).toBe('#888')
    expect(cssColor(' teal ', '#888')).toBe('teal')
  })
})
