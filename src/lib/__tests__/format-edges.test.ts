import { afterEach, describe, expect, it, vi } from 'vitest'
import { contrastText, formatDate, formatDuration, formatNumber, hashColor, hostOf, parseIsoDuration, truncate } from '../format'

/**
 * The formatting helpers every view uses, at their edges: numbers that
 * are not finite, negative zero, the rounding boundaries at a thousand
 * and a million, tiny fractions, strings and booleans; dates that do not
 * parse, epoch zero, numbers, far past and future, the relative steps;
 * durations at zero, an hour, a fraction, negative and infinite; ISO
 * durations of every shape; truncation at zero, at the length, across
 * emoji; hosts without a scheme, with ports, userinfo, IPv6, junk; the
 * hash colour's determinism and spread; contrast at the boundary.
 */
describe('format edges', () => {
  it('formatNumber: blanks and NaN are empty, infinities read as ∞, negative zero as 0, the boundaries round up a unit, tiny fractions vanish, strings and booleans coerce', () => {
    for (const blank of [null, undefined, '', NaN, 'abc', '1,234', {}]) expect(formatNumber(blank), String(blank)).toBe('')
    expect(formatNumber(Infinity)).toBe('∞')
    expect(formatNumber(-Infinity)).toBe('-∞')
    expect(formatNumber(-0)).toBe('0')
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(999)).toBe('999')
    expect(formatNumber(999.94)).toBe('999.94')
    expect(formatNumber(999.95)).toBe('1K')
    expect(formatNumber(1000)).toBe('1K')
    expect(formatNumber(1049)).toBe('1K')
    expect(formatNumber(1050)).toBe('1.1K')
    expect(formatNumber(-1500)).toBe('-1.5K')
    expect(formatNumber(999_949)).toBe('999.9K')
    expect(formatNumber(999_950)).toBe('1M')
    expect(formatNumber(1_000_000)).toBe('1M')
    expect(formatNumber(1e21)).toBe('1000000000000000M')
    expect(formatNumber(0.0004)).toBe('0')
    expect(formatNumber(0.5)).toBe('0.5')
    expect(formatNumber(1 / 3)).toBe('0.333')
    expect(formatNumber('1e3')).toBe('1K')
    expect(formatNumber(' 42 ')).toBe('42')
    expect(formatNumber(true)).toBe('1')
    expect(formatNumber([])).toBe('0')
    expect(formatNumber(2 ** 53)).toBe('9007199254.7M')
  })

  it('formatDate: nothing and epoch zero are empty, junk comes back as itself, numbers are epoch milliseconds, the relative steps, and absolute past a week', () => {
    for (const blank of [null, undefined, '', 0, false]) expect(formatDate(blank), String(blank)).toBe('')
    expect(formatDate('yesterday')).toBe('yesterday')
    expect(formatDate('2024-13-45')).toBe('2024-13-45')
    const now = Date.now()
    expect(formatDate(new Date(now - 10_000))).toBe('just now')
    expect(formatDate(new Date(now + 10_000))).toBe('just now')
    expect(formatDate(new Date(now - 5 * 60_000))).toBe('5m ago')
    expect(formatDate(new Date(now + 5 * 60_000))).toBe('in 5m')
    expect(formatDate(new Date(now - 3 * 3_600_000))).toBe('3h ago')
    expect(formatDate(new Date(now - 6 * 86_400_000))).toBe('6d ago')
    expect(formatDate(new Date(now - 6.6 * 86_400_000))).toBe('7d ago')
    expect(formatDate(new Date(now + 3 * 86_400_000))).toBe('in 3d')
    expect(formatDate(new Date(now - 8 * 86_400_000))).not.toMatch(/ago|in /)
    expect(formatDate('2024-05-01')).toMatch(/2024/)
    expect(formatDate('1970-01-01T00:00:00.000Z')).toMatch(/1970|1969/)
    expect(formatDate('9999-12-31')).toMatch(/9999/)
    expect(formatDate(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago')
    expect(formatDate(now - 5 * 60_000)).toBe('5m ago')
    expect(formatDate(1_700_000_000_000, { relative: false })).toMatch(/2023/)
    expect(formatDate('2024-05-01T12:00:00Z', { relative: false })).toMatch(/2024/)
  })

  it('formatDuration: zero, seconds, an hour, fractions floored, negative and infinite are empty; parseIsoDuration reads hours, minutes and seconds in any subset and nothing else', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(59.9)).toBe('0:59')
    expect(formatDuration(60)).toBe('1:00')
    expect(formatDuration(3599)).toBe('59:59')
    expect(formatDuration(3600)).toBe('1:00:00')
    expect(formatDuration(3661.9)).toBe('1:01:01')
    expect(formatDuration(36_000)).toBe('10:00:00')
    expect(formatDuration('90')).toBe('1:30')
    for (const blank of [null, undefined, NaN, 'x', -5, Infinity, -Infinity]) expect(formatDuration(blank), String(blank)).toBe('')
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723)
    expect(parseIsoDuration('PT45S')).toBe(45)
    expect(parseIsoDuration('PT2H')).toBe(7200)
    expect(parseIsoDuration('PT')).toBe(0)
    for (const bad of ['P1D', 'PT1.5S', 'pt1h', '1:02:03', '', null, undefined, 'PT1S2M']) expect(parseIsoDuration(bad), String(bad)).toBeUndefined()
  })

  it('truncate: at zero or one only the ellipsis, at the length the string itself, one past it ends in the ellipsis, and emoji are never cut in half', () => {
    expect(truncate('abc', 0)).toBe('…')
    expect(truncate('abc', 1)).toBe('…')
    expect(truncate('abc', 2)).toBe('a…')
    expect(truncate('abc', 3)).toBe('abc')
    expect(truncate('abcd', 3)).toBe('ab…')
    expect(truncate('', 0)).toBe('')
    expect(truncate('a'.repeat(100))).toBe('a'.repeat(79) + '…')
    expect(truncate('🎉🎉🎉', 2)).toBe('🎉…')
    expect(truncate('🎉🎉🎉', 3)).toBe('🎉🎉🎉')
    expect(truncate('👨‍👩‍👧 family', 4)).toMatch(/…$/)
    expect(truncate('naïve café', 5)).toBe('naïv…')
  })

  it('hostOf: schemes, no scheme, ports, userinfo, IPv6, uppercase, www once, and junk', () => {
    expect(hostOf('https://www.Example.com/path?q=1')).toBe('example.com')
    expect(hostOf('http://user:pw@host.io:8080/x')).toBe('host.io')
    expect(hostOf('https://[::1]:3000/')).toBe('[::1]')
    expect(hostOf('https://www.www.x.org')).toBe('www.x.org')
    expect(hostOf('ftp://files.example.net')).toBe('files.example.net')
    expect(hostOf('example.com/page')).toBe('example.com')
    expect(hostOf('sub.example.com')).toBe('sub.example.com')
    expect(hostOf('mailto:a@b.c')).toBe('')
    for (const junk of ['', null, undefined, 'not a url', 'http://', 'https://exa mple.com', {}, 42]) expect(hostOf(junk), String(junk)).toBe('')
  })

  it('hashColor: the same name gives the same colour for good, and near names land far apart', () => {
    expect(hashColor('alpha')).toBe(hashColor('alpha'))
    expect(hashColor('alpha')).not.toBe(hashColor('alpha '))
    // Pinned: these are drawn in saved pictures and must not move between releases without someone meaning it.
    expect(hashColor('')).toBe('hsl(73 72% 82%)')
    expect(hashColor('tree')).toBe('hsl(40 50% 60%)')
    const hues = new Set(Array.from({ length: 200 }, (_, i) => hashColor(`tag-${i}`)))
    expect(hues.size).toBeGreaterThan(60)
    for (const c of hues) {
      const m = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(c)!
      expect(m).not.toBeNull()
      expect(Number(m[1])).toBeGreaterThanOrEqual(0)
      expect(Number(m[1])).toBeLessThan(360)
    }
    // The types of the trees demo were four shades of one pale blue under the old hash (hues 220-252).
    const hueOf = (s: string) => Number(/^hsl\((\d+)/.exec(hashColor(s))![1])
    const hues4 = ['tree', 'species', 'genus', 'ward'].map(hueOf).sort((a, b) => a - b)
    for (let i = 1; i < hues4.length; i++) expect(hues4[i] - hues4[i - 1]).toBeGreaterThan(15)
    // A very long string still lands in range (the hash wraps rather than overflowing).
    expect(hashColor('x'.repeat(10_000))).toMatch(/^hsl\(\d{1,3} \d{2}% \d{2}%\)$/)
  })

  it('contrastText: white ink on dark, dark ink on light, one flip along the greys near #ad, every colour form, alpha ignored, unknown colours assumed light, blanks dark', () => {
    expect(contrastText('#000')).toBe('#fff')
    expect(contrastText('#fff')).toBe('#1f1e1b')
    expect(contrastText('#000', 'D', 'L')).toBe('L')
    let flips = 0
    let first = -1
    for (let g = 0; g < 256; g++) {
      const hex = `#${g.toString(16).padStart(2, '0').repeat(3)}`
      const white = contrastText(hex) === '#fff'
      if (g > 0 && white !== (contrastText(`#${(g - 1).toString(16).padStart(2, '0').repeat(3)}`) === '#fff')) {
        flips++
        first = g
      }
    }
    expect(flips).toBe(1)
    expect(first).toBeGreaterThanOrEqual(170)
    expect(first).toBeLessThanOrEqual(176)
    expect(contrastText('rgb(0, 0, 0)')).toBe('#fff')
    expect(contrastText('rgb(255 255 255)')).toBe('#1f1e1b')
    expect(contrastText('hsl(211 55% 78%)')).toBe('#1f1e1b')
    expect(contrastText('hsl(0, 0%, 0%)')).toBe('#fff')
    expect(contrastText('hsl(240deg 100% 30%)')).toBe('#fff')
    expect(contrastText('#0008')).toBe('#fff')
    expect(contrastText('#000000ff')).toBe('#fff')
    expect(contrastText('  #000  ')).toBe('#fff')
    expect(contrastText('crimson')).toBe('#1f1e1b') // no canvas here: assumed light
    expect(contrastText(undefined)).toBe('#1f1e1b')
    expect(contrastText('')).toBe('#1f1e1b')
    expect(contrastText('#zzz')).toBe('#1f1e1b')
  })
})

describe('contrastText with a canvas', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('resolves a named colour through the canvas, and takes "black" at its word', () => {
    const fills = new Map([['red', '#ff0000'], ['navy', '#000080'], ['black', '#000000'], ['nonsense', '#000000']])
    let current = '#000000'
    const ctx = { set fillStyle(v: string) { current = fills.get(v) ?? (v === '#000' ? '#000000' : current) }, get fillStyle() { return current } }
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx }) })
    expect(contrastText('red')).toBe('#fff') // pure red is dark enough for white ink
    expect(contrastText('navy')).toBe('#fff')
    expect(contrastText('black')).toBe('#fff')
    expect(contrastText('nonsense')).toBe('#1f1e1b') // resolved to black = "unknown": assumed light
  })
})
