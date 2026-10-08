import { afterEach, describe, expect, it } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import { displayLabel } from '../../../core/entity/entity'
import { communityEntityFor, COMMUNITY_TYPE, MEMBER_OF, nameCommunity } from '../claims'
import { describeMembers, memberSample, NAME_COMMUNITY_EVENT, requestNameCommunity, suggestedName, type NameCommunityRequest } from '../nameCommunity'

/**
 * Naming a community, at the edges the dialog meets: the name an analysis
 * suggests (quoted, curly-quoted, with a full stop, only spaces, nothing at
 * all), the line that says who is in it (a member removed since the run,
 * exactly as many as fit, one more than fits, none), the request reaching
 * the dialog as raised; and the naming itself asked twice, with a label of
 * spaces, a label another community already carries, and a relationship as
 * a member.
 */
const g = globalThis as Record<string, unknown>

afterEach(() => {
  delete g.window
})

describe('the name to offer', () => {
  it('takes an analysis’s quotes and full stop off, and comes back empty when there is nothing to offer', () => {
    expect(suggestedName('"Systems and infrastructure"')).toBe('Systems and infrastructure')
    expect(suggestedName('“Systems and infrastructure”')).toBe('Systems and infrastructure')
    expect(suggestedName('‘Music and mood’')).toBe('Music and mood')
    expect(suggestedName('  Systems and infrastructure.  ')).toBe('Systems and infrastructure')
    expect(suggestedName('"A group about Kubernetes, CI and on-call."')).toBe('A group about Kubernetes, CI and on-call')
    expect(suggestedName(undefined)).toBe('')
    expect(suggestedName('   ')).toBe('')
    // Quotes inside the name are the name's own.
    expect(suggestedName('The "hub" services')).toBe('The "hub" services')
    expect(suggestedName('Émile’s circle 🎧')).toBe('Émile’s circle 🎧')
  })
})

describe('who is in it', () => {
  const nameOf = (id: string) => (id.startsWith('p') ? `Person ${id.slice(1)}` : undefined)

  it('names the first few, counts the rest, and shows an id for a member that is no longer there', () => {
    expect(memberSample(['p1', 'p2', 'ghost'], nameOf)).toEqual({ names: ['Person 1', 'Person 2', 'ghost'], more: 0 })
    expect(memberSample(Array.from({ length: 6 }, (_, i) => `p${i}`), nameOf).more).toBe(0)
    expect(memberSample(Array.from({ length: 7 }, (_, i) => `p${i}`), nameOf)).toMatchObject({ more: 1 })
    expect(memberSample(Array.from({ length: 1006 }, (_, i) => `p${i}`), nameOf, 3)).toEqual({ names: ['Person 0', 'Person 1', 'Person 2'], more: 1003 })
    expect(memberSample([], nameOf)).toEqual({ names: [], more: 0 })
  })

  it('writes the line with the profile when there is one, and says only what it has', () => {
    expect(describeMembers({ names: ['A', 'B'], more: 0 }, '12 people, 3 teams')).toBe('12 people, 3 teams · A, B')
    expect(describeMembers({ names: ['A'], more: 1003 })).toBe('A … and 1,003 more')
    expect(describeMembers({ names: [], more: 0 }, 'nothing in it')).toBe('nothing in it')
    expect(describeMembers({ names: [], more: 0 })).toBe('')
  })
})

describe('the request reaching the dialog', () => {
  it('is raised as one event carrying what the dialog needs', () => {
    const heard: NameCommunityRequest[] = []
    const listeners: Record<string, ((e: Event) => void)[]> = {}
    g.window = {
      dispatchEvent: (e: Event) => {
        for (const l of listeners[e.type] ?? []) l(e)
        return true
      },
      addEventListener: (t: string, l: (e: Event) => void) => void (listeners[t] ??= []).push(l),
      removeEventListener: () => {},
    }
    ;(g.window as { addEventListener: (t: string, l: (e: Event) => void) => void }).addEventListener(NAME_COMMUNITY_EVENT, (e) => heard.push((e as CustomEvent<NameCommunityRequest>).detail))
    const req: NameCommunityRequest = { community: 3, metricsKey: 'k1', members: ['a', 'b'], suggested: '"Infra"', profile: '2 services' }
    requestNameCommunity(req)
    expect(heard).toEqual([req])
    expect(suggestedName(heard[0].suggested)).toBe('Infra')
  })
})

describe('naming it, twice and oddly', () => {
  const store = () => {
    const s = new EntityStore()
    s.upsertMany([createEntity({ id: 'p0', type: 'person', label: 'P0' }), createEntity({ id: 'p1', type: 'person', label: 'P1' }), createEntity({ id: 'p2', type: 'person', label: 'P2' })])
    return s
  }

  it('two communities may carry the same name — the run and the number tell them apart, not the label', () => {
    const s = store()
    const a = nameCommunity(s, { label: 'Core', members: ['p0'], community: 0, metricsKey: 'k1' })
    const b = nameCommunity(s, { label: 'Core', members: ['p1'], community: 1, metricsKey: 'k1' })
    expect(a.entity.id).not.toBe(b.entity.id)
    expect(s.ofType(COMMUNITY_TYPE)).toHaveLength(2)
    expect(communityEntityFor(s, 'k1', 0)?.id).toBe(a.entity.id)
    expect(displayLabel(s.get(b.entity.id)!)).toBe('Core')
    // The same number under a later run is a third one: the numbers mean nothing across runs.
    const c = nameCommunity(s, { label: 'Core', members: ['p2'], community: 0, metricsKey: 'k2' })
    expect(new Set([a.entity.id, b.entity.id, c.entity.id]).size).toBe(3)
  })

  it('takes the label as given (the dialog is what refuses a blank one) and tags and types every community the same', () => {
    const s = store()
    // The dialog disables its button on a blank name; the function itself does not second-guess a caller.
    const blank = nameCommunity(s, { label: '   ', members: ['p0'], community: 9, metricsKey: 'k1' })
    expect(s.get(blank.entity.id)?.label).toBe('   ')
    const e = s.get(nameCommunity(s, { label: 'Named', members: ['p0', 'p1'], community: 1, metricsKey: 'k1' }).entity.id)!
    expect(e.type).toBe(COMMUNITY_TYPE)
    expect(e.tags).toEqual(['community'])
    expect(e.meta.source).toBe('insights')
    expect(e.data).toMatchObject({ community: 1, metricsKey: 'k1', size: 2 })
    expect(e.id).toMatch(/\S/)
  })

  it('a relationship among the members belongs to it like anything else, and a member named twice is linked once', () => {
    const s = store()
    s.upsert({ ...createEntity({ id: 'r0', type: 'knows' }), kind: 'relationship', source: { id: 'p0' }, target: { id: 'p1' } } as never)
    const r = nameCommunity(s, { label: 'With an edge', members: ['p0', 'r0', 'p0'], community: 2, metricsKey: 'k1' })
    expect(r.members).toBe(2) // p0 named twice is one member, and one link
    const links = s.relationshipsOf(r.entity.id, 'in').filter((x) => x.type === MEMBER_OF)
    expect(links.map((x) => x.source.id).sort()).toEqual(['p0', 'r0'])
    expect(links).toHaveLength(2)
  })
})
