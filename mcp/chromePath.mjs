/**
 * Which Chrome `drive.mjs` launches. `CHROME_PATH` names it outright; otherwise Google Chrome where macOS and Windows
 * install it, and on Linux (or anywhere else) the first of google-chrome, google-chrome-stable, chromium and
 * chromium-browser found on PATH. Chrome or Chromium only: the driver speaks the DevTools protocol and passes
 * Chrome's flags.
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export const LINUX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']

export function chromePath({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (env.CHROME_PATH) return env.CHROME_PATH
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (platform === 'win32') return join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of LINUX_NAMES) {
      const candidate = join(dir, name)
      if (exists(candidate)) return candidate
    }
  }
  throw new Error(`No Chrome found: none of ${LINUX_NAMES.join(', ')} is on PATH. Set CHROME_PATH to the browser to run.`)
}
