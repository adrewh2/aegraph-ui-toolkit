import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What floats closes through `useDismiss` — a press heard as `pointerdown` in the capture phase, layers for popups
 * opened from popups, Escape for the topmost only. A `mousedown` listener on the document of its own misses presses
 * something stopped on the way (a dialog did, and its dropdowns never closed) or a canvas cancelled; one creeping back
 * fails here. Listeners that are not about closing something are named below, with why.
 */
const SRC = join(__dirname, '..', '..', '..')
const ALLOWED: Record<string, string> = {
  'components/ui/useDismiss.ts': 'the one place that listens',
  // Flags the press that dismisses the row menu, so its click does not also select a row: not a dismissal itself.
  'features/resources/EntityTable.tsx': 'marks the dismissing click',
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('closing on a press outside', () => {
  it('goes through useDismiss, never a mousedown or pointerdown listener of its own on the document or window', () => {
    const own = sources(SRC)
      .map((f) => f.slice(SRC.length + 1))
      .filter((f) => !(f in ALLOWED))
      .filter((f) => /(document|window)\.addEventListener\(\s*['"](mousedown|pointerdown|touchstart)['"]/.test(readFileSync(join(SRC, f), 'utf8')))
    expect(own).toEqual([])
  })
})
