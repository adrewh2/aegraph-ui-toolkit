import { describe, expect, it } from 'vitest'
import { chunk, isStaleChunk, preloadFor, registerPreload } from '../preload'

/**
 * The boot's preload: a chunk loads once however often it is asked, is
 * readable synchronously once it has arrived, and `preloadFor` goes round
 * until the chunks a chunk registered on arrival are here too — the
 * explorer registers its renderers only once its own code has run. A chunk
 * that failed is not remembered as failed: the next attempt fetches again,
 * so a blip — or a deploy that moved the file — can be recovered from.
 */
describe('preload', () => {
  it('loads a chunk once and exposes it synchronously afterwards', async () => {
    let calls = 0
    const c = chunk(async () => (calls++, { answer: 42 }))
    expect(c.peek()).toBeUndefined()
    const [a, b] = await Promise.all([c.load(), c.load()])
    expect(a).toBe(b)
    expect(calls).toBe(1)
    expect(c.peek()?.answer).toBe(42)
  })

  it('preloads what a path needs, in rounds, and swallows a chunk that fails — and tries it again next time', async () => {
    const order: string[] = []
    const renderer = chunk(async () => (order.push('renderer'), {}))
    const page = chunk(async () => {
      order.push('page')
      // The page's code registers what it draws with, as the explorer does for its renderers.
      registerPreload((p) => p.startsWith('/t/'), () => [renderer])
      return {}
    })
    const broken = chunk(async () => {
      order.push('broken')
      throw new Error('offline')
    })
    registerPreload((p) => p.startsWith('/t/'), () => [page, broken])
    registerPreload((p) => p.startsWith('/elsewhere'), () => [chunk(async () => (order.push('elsewhere'), {}))])
    await preloadFor('/t/x')
    expect(order).toEqual(['page', 'broken', 'renderer'])
    expect(renderer.peek()).toBeTruthy()
    // What arrived is not fetched again; what failed is.
    await preloadFor('/t/x')
    expect(order).toEqual(['page', 'broken', 'renderer', 'broken'])
  })

  it('knows a chunk that is no longer on the server from any other failure', async () => {
    expect(isStaleChunk(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Page-a1b2.js'))).toBe(true)
    expect(isStaleChunk(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isStaleChunk(new Error('offline'))).toBe(false)
  })
})
