import { describe, expect, it } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/resources/types'
import {
  ancestorsOf,
  annotateDocument,
  annotationsOf,
  buildTree,
  createDocument,
  deleteDocument,
  descendantsOf,
  duplicateDocument,
  filenameOf,
  flatten,
  FOLDER,
  moveDocument,
  quoteContext,
  stripTitleHeading,
  textStats,
} from '../documents'

function workspace() {
  const store = new EntityStore()
  const root = createDocument(store, { label: 'Research', extension: FOLDER })
  const sub = createDocument(store, { label: 'Papers', extension: FOLDER, parentId: root.id })
  const a = createDocument(store, { label: 'Zeta notes', extension: 'md', parentId: root.id, content: 'The quick brown fox jumps over the lazy dog.' })
  const b = createDocument(store, { label: 'alpha', extension: 'txt', parentId: sub.id })
  const top = createDocument(store, { label: 'Top level', extension: 'md' })
  const pdf = createDocument(store, { label: 'Spec', extension: 'pdf', data: { sourceUrl: 'https://x.y/spec.pdf' } })
  return { store, root, sub, a, b, top, pdf }
}

describe('createDocument', () => {
  it('starts text documents empty and leaves pdf/folder without content', () => {
    const { a, pdf, root, b } = workspace()
    expect(a.data.content).toBe('The quick brown fox jumps over the lazy dog.')
    expect(createDocument(new EntityStore(), { label: 'Hi' }).data.content).toBe('')
    expect(b.data.content).toBe('')
    expect(pdf.data.content).toBeUndefined()
    expect(root.data.content).toBeUndefined()
    expect(a.data.parentId).toBe(root.id)
  })

  it('defaults labels by kind', () => {
    const s = new EntityStore()
    expect(createDocument(s, { extension: FOLDER }).label).toBe('New folder')
    expect(createDocument(s, {}).label).toBe('Untitled')
  })
})

describe('buildTree / flatten', () => {
  it('nests by parentId, folders first, then by label', () => {
    const { store, root, sub, a, b, top, pdf } = workspace()
    const tree = buildTree(store.ofType('document') as never)
    expect(tree.map((n) => n.entity.id)).toEqual([root.id, pdf.id, top.id])
    const r = tree[0]
    expect(r.children.map((n) => n.entity.id)).toEqual([sub.id, a.id])
    expect(r.children[0].children.map((n) => n.entity.id)).toEqual([b.id])
    expect(r.children[0].children[0].depth).toBe(2)
  })

  it('promotes orphans and cycles to the root', () => {
    const s = new EntityStore()
    const x = createDocument(s, { label: 'x', extension: FOLDER, parentId: 'nope' })
    const y = createDocument(s, { label: 'y', extension: FOLDER })
    const z = createDocument(s, { label: 'z', extension: FOLDER, parentId: y.id })
    s.update(y.id, { data: { ...y.data, parentId: z.id } }) // y → z → y
    const tree = buildTree(s.ofType('document') as never)
    expect(tree.map((n) => n.entity.id).sort()).toEqual([x.id, y.id, z.id].sort())
  })

  it('flattens respecting expansion', () => {
    const { store, root, sub, a, b } = workspace()
    const tree = buildTree(store.ofType('document') as never)
    expect(flatten(tree, () => false).map((n) => n.entity.id)).toHaveLength(3)
    expect(flatten(tree, (id) => id === root.id).map((n) => n.entity.id)).toContain(a.id)
    expect(flatten(tree, (id) => id === root.id).map((n) => n.entity.id)).not.toContain(b.id)
    expect(flatten(tree, () => true).map((n) => n.entity.id)).toContain(sub.id)
  })
})

describe('ancestorsOf / descendantsOf', () => {
  it('walks both directions', () => {
    const { store, root, sub, a, b } = workspace()
    expect(ancestorsOf(store, b.id)).toEqual([sub.id, root.id])
    expect(ancestorsOf(store, root.id)).toEqual([])
    expect(descendantsOf(store, root.id).map((d) => d.id).sort()).toEqual([sub.id, a.id, b.id].sort())
    expect(descendantsOf(store, sub.id).map((d) => d.id)).toEqual([b.id])
  })
})

describe('moveDocument', () => {
  it('moves into folders and to the top level', () => {
    const { store, sub, a } = workspace()
    expect(moveDocument(store, a.id, sub.id)).toBe(true)
    expect(store.get(a.id)?.data.parentId).toBe(sub.id)
    expect(moveDocument(store, a.id, undefined)).toBe(true)
    expect(store.get(a.id)?.data.parentId).toBeUndefined()
  })

  it('refuses cycles, self, and non-folder targets', () => {
    const { store, root, sub, a } = workspace()
    expect(moveDocument(store, root.id, sub.id)).toBe(false)
    expect(moveDocument(store, root.id, root.id)).toBe(false)
    expect(moveDocument(store, sub.id, a.id)).toBe(false)
    expect(store.get(root.id)?.data.parentId).toBeUndefined()
  })
})

describe('deleteDocument', () => {
  it('cascades through folders', () => {
    const { store, root, sub, a, b, top } = workspace()
    const removed = deleteDocument(store, root.id)
    expect(removed.sort()).toEqual([root.id, sub.id, a.id, b.id].sort())
    expect(store.has(top.id)).toBe(true)
    expect(store.has(b.id)).toBe(false)
  })
})

describe('duplicateDocument', () => {
  it('copies a folder subtree with remapped parents', () => {
    const { store, root, sub } = workspace()
    const before = store.size()
    const copy = duplicateDocument(store, root)
    expect(copy.label).toBe('Research (copy)')
    expect(store.size()).toBe(before + 4)
    const kids = descendantsOf(store, copy.id)
    expect(kids).toHaveLength(3)
    expect(kids.map((k) => k.label).sort()).toEqual(['Papers', 'Zeta notes', 'alpha'].sort())
    expect(descendantsOf(store, sub.id)).toHaveLength(1) // original untouched
    expect(copy.meta.derivedFrom?.id).toBe(root.id)
  })
})

describe('annotations', () => {
  it('creates an annotation + annotates relationship with a text selector', () => {
    const { store, a } = workspace()
    const q = quoteContext(a.data.content!, 4, 19)
    expect(q).toEqual({ exact: 'quick brown fox', prefix: 'The ', suffix: ' jumps over the lazy dog.' })
    const ann = annotateDocument(store, a, q, 'nice', ['todo'])
    expect(ann.type).toBe('annotation')
    expect(ann.data.selectedText).toBe('quick brown fox')
    const list = annotationsOf(store, a.id)
    expect(list).toHaveLength(1)
    expect(list[0].annotation.id).toBe(ann.id)
    expect(list[0].exact).toBe('quick brown fox')
    expect(list[0].selector).toMatchObject({ kind: 'text', exact: 'quick brown fox', prefix: 'The ' })
    // Deleting the annotation removes the relationship; the doc no longer lists it.
    store.remove(ann.id)
    expect(annotationsOf(store, a.id)).toHaveLength(0)
    expect(store.relationshipCount()).toBe(0)
  })

  it('ignores non-annotation incoming links', () => {
    const { store, a, top } = workspace()
    store.upsert({ ...createDocument(store, { label: 'tmp' }), id: 'r', kind: 'relationship', type: 'annotates', source: { id: top.id }, target: { id: a.id }, directed: true } as never)
    expect(annotationsOf(store, a.id)).toHaveLength(0)
  })
})

describe('misc', () => {
  it('filenameOf appends the extension safely', () => {
    const { a, root, pdf } = workspace()
    expect(filenameOf(a)).toBe('Zeta notes.md')
    expect(filenameOf(root)).toBe('Research')
    expect(filenameOf(pdf)).toBe('Spec.pdf')
    expect(filenameOf({ ...a, label: 'a/b: c.md' })).toBe('a-b- c.md')
  })

  it('textStats', () => {
    expect(textStats('')).toEqual({ words: 0, chars: 0, lines: 0, minutes: 1 })
    expect(textStats('one two\nthree')).toEqual({ words: 3, chars: 13, lines: 2, minutes: 1 })
  })

  it('stripTitleHeading drops only a heading that repeats the label', () => {
    expect(stripTitleHeading('# Plan\n\nbody', 'Plan')).toBe('body')
    expect(stripTitleHeading('# Plan\nbody', 'Plan')).toBe('body')
    expect(stripTitleHeading('# Other\n\nbody', 'Plan')).toBe('# Other\n\nbody')
    expect(stripTitleHeading('## Plan\n\nbody', 'Plan')).toBe('## Plan\n\nbody')
    expect(stripTitleHeading('body', 'Plan')).toBe('body')
    expect(stripTitleHeading('# Plan', undefined)).toBe('# Plan')
  })
})
