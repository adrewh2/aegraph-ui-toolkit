import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every dropdown is ours: `components/ui/Select`, drawn by the app's `Menu`, never the browser's `<select>` — whose
 * look is the operating system's, whose chevron sits where the browser puts it, and whose list ignores the app's
 * theme. A native one creeping back into a view fails here.
 */
const SRC = join(__dirname, '..', '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
    return name.endsWith('.tsx') ? [path] : []
  })
}

describe('dropdowns', () => {
  it('are the app’s Select, never a native <select>', () => {
    const native = sources(SRC).filter((f) => /<select\b/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
    expect(native.map((f) => f.slice(SRC.length + 1))).toEqual([])
  })
})
