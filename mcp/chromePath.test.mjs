import { describe, expect, it } from 'vitest'
import { chromePath } from './chromePath.mjs'

describe('which Chrome the driver launches', () => {
  it('takes CHROME_PATH first, on any platform', () => {
    for (const platform of ['darwin', 'linux', 'win32']) expect(chromePath({ env: { CHROME_PATH: '/opt/chrome/chrome' }, platform })).toBe('/opt/chrome/chrome')
  })

  it("defaults to Google Chrome's install path on macOS", () => {
    expect(chromePath({ env: {}, platform: 'darwin' })).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })

  it('finds google-chrome or chromium on PATH elsewhere, in that order', () => {
    const on = (paths) => (p) => paths.includes(p)
    expect(chromePath({ env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux', exists: on(['/usr/bin/chromium', '/usr/bin/google-chrome']) })).toBe('/usr/bin/google-chrome')
    expect(chromePath({ env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux', exists: on(['/usr/bin/chromium']) })).toBe('/usr/bin/chromium')
  })

  it('says what to set when there is none', () => {
    expect(() => chromePath({ env: { PATH: '/usr/bin' }, platform: 'linux', exists: () => false })).toThrow(/CHROME_PATH/)
  })
})
