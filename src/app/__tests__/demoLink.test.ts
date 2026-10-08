import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../core/entity/store'
import { createEntity } from '../../core/entity/entity'
import { demoIdOf, demoLink, linkedScene, readDemoLink, sceneTab, withoutDemoLink } from '../demoLink'
import type { ProjectEntity } from '../../core/projects/project'

/** A link that opens a demo on one of its scenes: read from any page's address, built for sharing, resolved safely. */
describe('demo links', () => {
  it('reads ?demo= and an optional scene from any address, and only a plain demo id', () => {
    expect(readDemoLink('?demo=kestrel-story&scene=from-information-to-decks')).toEqual({ demo: 'kestrel-story', scene: 'from-information-to-decks' })
    expect(readDemoLink('?demo=aurora')).toEqual({ demo: 'aurora', scene: undefined })
    for (const q of ['', '?scene=x', '?demo=', '?demo=../x', '?demo=a/b', '?demo=https://evil.example/x', '?demo=.hidden']) expect(readDemoLink(q), q).toBeUndefined()
    expect(withoutDemoLink('?demo=a&scene=b&tab=c')).toBe('?tab=c')
    expect(withoutDemoLink('?demo=a')).toBe('')
  })

  it('builds a link on the site’s own origin, the scene by its short name under the demo', () => {
    expect(demoLink('https://aegraph.sh', 'kestrel-story', 'scene:kestrel-story:from-information-to-decks')).toBe('https://aegraph.sh/?demo=kestrel-story&scene=from-information-to-decks')
    expect(demoLink('https://aegraph.dev', 'aurora')).toBe('https://aegraph.dev/?demo=aurora')
    expect(demoLink('https://aegraph.dev', 'aurora', 'scene:other')).toBe('https://aegraph.dev/?demo=aurora&scene=scene%3Aother')
  })

  it('finds the scene by id or short name, a graph scene only, and opens it as it was saved', () => {
    const store = new EntityStore()
    const scene = createEntity({ id: 'scene:kestrel-story:from-information-to-decks', type: 'scene:unigraph', label: 'From information to decks', data: { renderer: '3d', view: { physics: true } } })
    store.upsertMany([scene, createEntity({ id: 'doc:x', type: 'document', label: 'Not a scene' })])
    expect(linkedScene(store, { demo: 'kestrel-story', scene: 'from-information-to-decks' })?.id).toBe(scene.id)
    expect(linkedScene(store, { demo: 'kestrel-story', scene: scene.id })?.id).toBe(scene.id)
    expect(linkedScene(store, { demo: 'kestrel-story', scene: 'doc:x' })).toBeUndefined()
    expect(linkedScene(store, { demo: 'kestrel-story', scene: 'nope' })).toBeUndefined()
    expect(sceneTab(scene)).toEqual({ path: '/unigraph/3d?scene=scene%3Akestrel-story%3Afrom-information-to-decks&physics=1', title: 'From information to decks' })
  })

  it('knows which demo a project was opened from, by the bundle path it remembers', () => {
    const p = (demo?: string) => ({ data: demo ? { demo } : {} }) as unknown as ProjectEntity
    expect(demoIdOf(p('/demos/kestrel-story/bundle.ae.json.gz'))).toBe('kestrel-story')
    expect(demoIdOf(p('/datasets/x.ae.json'))).toBeUndefined()
    expect(demoIdOf(p())).toBeUndefined()
  })
})
