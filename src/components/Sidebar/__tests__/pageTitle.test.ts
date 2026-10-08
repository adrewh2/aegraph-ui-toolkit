import { describe, expect, it } from 'vitest'
import { documentTitle, pageName } from '../pageTitle'

describe('the browser tab names the page', () => {
  it('by the name the sidebar gives it', () => {
    expect(documentTitle('/')).toBe('Dashboard · aegraph')
    expect(documentTitle('/entities')).toBe('Entities · aegraph')
    expect(documentTitle('/docs')).toBe('Documentation · aegraph')
  })

  it('a deeper address takes the name of the page it sits in', () => {
    expect(pageName('/documents/doc-42')).toBe('Documents')
    expect(pageName('/unigraph/3d')).toBe('Unigraph')
    expect(pageName('/docs/assistant')).toBe('Documentation')
    expect(pageName('/ontology/type/person/edit')).toBe('Ontology')
  })

  it('the nearest page wins: a group’s children, not a shorter prefix', () => {
    expect(pageName('/analytics/scripts/reference')).toBe('Scripts')
    expect(pageName('/analytics/datasets/new')).toBe('Datasets')
  })

  it('pages reached from elsewhere than the sidebar have names too', () => {
    expect(pageName('/projects/p1/history')).toBe('Projects')
    expect(pageName('/browser')).toBe('This browser')
  })

  it('an address that is no page is just the app', () => {
    expect(pageName('/nowhere')).toBeNull()
    expect(documentTitle('/nowhere')).toBe('aegraph')
    // A prefix of a word is not the page: /documentsx is not Documents, and / only matches itself.
    expect(pageName('/documentsx')).toBeNull()
  })
})
