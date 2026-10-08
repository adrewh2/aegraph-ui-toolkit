import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A drawing is data, and Excalidraw frames an embeddable element's page (YouTube, Figma, gists, …) the moment the
 * drawing is shown, from its own allow-list, whatever the Third-party services switch says. The canvas turns that
 * off; Excalidraw needs a browser to mount, so this reads the prop where it is set.
 */
describe('the drawing canvas', () => {
  it('frames no embeddable', () => {
    const src = readFileSync(new URL('../DiagramEditor.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/<Excalidraw[\s\S]*?validateEmbeddable=\{false\}[\s\S]*?>/)
  })
})
