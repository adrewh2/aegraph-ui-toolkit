import { describe, expect, it } from 'vitest'
import { createEntity } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/resources/types'
import { ancestorsOf, buildTree, compareDocs, createDocument, deleteDocument, descendantsOf, duplicateDocument, filenameOf, flatten, FOLDER, moveDocument, quoteContext, stripTitleHeading, textStats, type DocumentEntity } from '../documents'

/**
 * The document model at its edges: filenames from labels of reserved
 * characters, an existing extension in another case, nothing at all;
 * the order of folders and numbered names; a tree with a self-parent, a
 * cycle of three, a parent that is a document not a folder; ancestors
 * and descendants through a cycle; a document created from a whitespace
 * label, a folder and a pdf without content, an empty parent id; moves
 * to a missing folder, to itself, to a document, to a descendant, to the
 * same parent; the cascade of a delete through a cycle; quotes at the
 * bounds; stats on nothing, whitespace, CRLF, emoji, one long line; the
 * title heading in every disguise.
 */
describe('documents edges', () => {
  it('filenames: reserved characters become dashes, an extension already there in any case is not doubled, a blank label is untitled, folders take no extension', () => {
    const doc = (label: string, extension: string) => createEntity({ id: 'x', type: 'document', label, data: { extension } })
    expect(filenameOf(doc('a/b\\c:d*e?f"g<h>i|j', 'md'))).toBe('a-b-c-d-e-f-g-h-i-j.md')
    expect(filenameOf(doc('Notes.MD', 'md'))).toBe('Notes.MD')
    expect(filenameOf(doc('Notes.md.md', 'md'))).toBe('Notes.md.md')
    expect(filenameOf(doc('   ', 'txt'))).toBe('x.txt') // a blank label shows as the id
    expect(filenameOf(doc('///', 'txt'))).toBe('untitled.txt')
    expect(filenameOf(doc('-notes-', 'txt'))).toBe('-notes-.txt')
    expect(filenameOf(doc('Stuff', FOLDER))).toBe('Stuff')
    expect(filenameOf(doc('Stuff', ''))).toBe('Stuff')
    expect(filenameOf(createEntity({ id: 'x', type: 'document', data: { extension: 'pdf' } }))).toMatch(/\.pdf$/)
  })

  it('ordering: folders first whatever their name, then labels with numbers in order and case ignored', () => {
    const d = (label: string, extension = 'md') => createEntity({ id: label, type: 'document', label, data: { extension } })
    const sorted = [d('z folder', FOLDER), d('file 10'), d('File 9'), d('a folder', FOLDER), d('file 1'), d('É')].sort(compareDocs).map((e) => e.label)
    expect(sorted).toEqual(['a folder', 'z folder', 'É', 'file 1', 'File 9', 'file 10'].slice(0, 2).concat(['É', 'file 1', 'File 9', 'file 10']))
  })

  it('the tree: a self-parent, a cycle of three and a child of a document (not a folder) all surface at the root; every document appears exactly once; flatten honours expansion', () => {
    const doc = (id: string, parentId?: string, extension = 'md') => createEntity({ id, type: 'document', label: id, data: { extension, ...(parentId ? { parentId } : {}) } }) as DocumentEntity
    const docs = [doc('self', 'self'), doc('a', 'b'), doc('b', 'c'), doc('c', 'a'), doc('leaf', 'plain'), doc('plain'), doc('f', undefined, FOLDER), doc('in-f', 'f')]
    const tree = buildTree(docs)
    expect(tree.map((n) => n.entity.id)).toEqual(['f', 'plain', 'self', 'a', 'b', 'c', 'leaf'])
    expect(tree[0].children.map((n) => [n.entity.id, n.depth])).toEqual([['in-f', 1]])
    expect(tree.find((n) => n.entity.id === 'plain')!.children).toEqual([]) // a document holds nothing; its "child" is a root
    const ids = flatten(tree, () => true).map((n) => n.entity.id)
    expect(ids.length).toBe(docs.length)
    expect(new Set(ids).size).toBe(docs.length)
    expect(flatten(tree, () => false).map((n) => n.entity.id)).toEqual(['f', 'plain', 'self', 'a', 'b', 'c', 'leaf'])
    expect(buildTree([])).toEqual([])
  })

  it('ancestors and descendants stop on cycles and on a self-parent; a document that is not there has none', () => {
    const store = new EntityStore()
    const doc = (id: string, parentId?: string, extension = FOLDER) => store.upsert(createEntity({ id, type: 'document', label: id, data: { extension, ...(parentId ? { parentId } : {}) } }))
    doc('a', 'b')
    doc('b', 'c')
    doc('c', 'a')
    doc('self', 'self')
    doc('top')
    doc('mid', 'top')
    doc('leaf', 'mid', 'md')
    doc('under-leaf', 'leaf', 'md') // a child of a document, not a folder
    expect(ancestorsOf(store, 'a')).toEqual(['b', 'c'])
    expect(ancestorsOf(store, 'self')).toEqual([])
    expect(ancestorsOf(store, 'nope')).toEqual([])
    expect(ancestorsOf(store, 'under-leaf')).toEqual(['leaf', 'mid', 'top'])
    expect(descendantsOf(store, 'a').map((d) => d.id)).toEqual(['c', 'b'])
    expect(descendantsOf(store, 'self')).toEqual([])
    expect(descendantsOf(store, 'top').map((d) => d.id)).toEqual(['mid', 'leaf']) // the walk goes through folders only
    expect(descendantsOf(store, 'nope')).toEqual([])
  })

  it('creating: a whitespace label is Untitled or New folder, a folder and a pdf carry no content, an empty parent id is no parent, extra data rides along', () => {
    const store = new EntityStore()
    const blank = createDocument(store, { label: '   ' })
    expect(blank.label).toBe('Untitled')
    expect(blank.data).toEqual({ extension: 'md', content: '' })
    const folder = createDocument(store, { label: '\t', extension: FOLDER, content: 'ignored' })
    expect(folder.label).toBe('New folder')
    expect(folder.data).toEqual({ extension: FOLDER })
    const pdf = createDocument(store, { label: 'P', extension: 'pdf', parentId: '', data: { sourceUrl: 'u' } })
    expect(pdf.data).toEqual({ extension: 'pdf', sourceUrl: 'u' })
    expect(pdf.data).not.toHaveProperty('parentId')
    const crlf = createDocument(store, { label: 'C', content: 'a\r\nb' })
    expect(crlf.data.content).toBe('a\r\nb') // kept as written
    expect(createDocument(store, { label: 'S', source: 'import' }).meta.source).toBe('import')
  })

  it('moving: to a folder that is not there, to itself, to a document, to a descendant — refused; to the same parent — true without a write; to the top — parentId gone', () => {
    const store = new EntityStore()
    const root = createDocument(store, { label: 'R', extension: FOLDER })
    const sub = createDocument(store, { label: 'S', extension: FOLDER, parentId: root.id })
    const doc = createDocument(store, { label: 'D', parentId: sub.id })
    expect(moveDocument(store, root.id, 'nope')).toBe(false)
    expect(moveDocument(store, root.id, root.id)).toBe(false)
    expect(moveDocument(store, sub.id, doc.id)).toBe(false)
    expect(moveDocument(store, root.id, sub.id)).toBe(false)
    expect(moveDocument(store, 'nope', root.id)).toBe(false)
    const before = store.get(doc.id)!
    expect(moveDocument(store, doc.id, sub.id)).toBe(true)
    expect(store.get(doc.id)).toBe(before)
    expect(moveDocument(store, doc.id, undefined)).toBe(true)
    expect(store.get(doc.id)!.data).not.toHaveProperty('parentId')
    expect(moveDocument(store, doc.id, root.id)).toBe(true)
    expect(store.get(doc.id)!.data.parentId).toBe(root.id)
    // A non-document entity cannot be moved; a folder can move under its sibling.
    store.upsert(createEntity({ id: 'note', type: 'note' }))
    expect(moveDocument(store, 'note', root.id)).toBe(false)
    const sib = createDocument(store, { label: 'T', extension: FOLDER, parentId: root.id })
    expect(moveDocument(store, sub.id, sib.id)).toBe(true)
    expect(ancestorsOf(store, sub.id)).toEqual([sib.id, root.id])
  })

  it('deleting a folder takes its contents, through a cycle only what is reachable; duplicating a document copies its content and points back', () => {
    const store = new EntityStore()
    const root = createDocument(store, { label: 'R', extension: FOLDER })
    const sub = createDocument(store, { label: 'S', extension: FOLDER, parentId: root.id })
    const d = createDocument(store, { label: 'D', parentId: sub.id, content: 'hello' })
    const stray = createDocument(store, { label: 'X', parentId: d.id }) // under a document: not a descendant by the walk
    expect(deleteDocument(store, root.id).sort()).toEqual([root.id, sub.id, d.id].sort())
    expect(store.has(stray.id)).toBe(true)
    expect(deleteDocument(store, 'nope')).toEqual(['nope'])
    const src = createDocument(store, { label: 'Orig', content: 'body', tags: ['t'] })
    const copy = duplicateDocument(store, src)
    expect(copy.label).toBe('Orig (copy)')
    expect(copy.data.content).toBe('body')
    expect(copy.tags).toEqual(['t'])
    expect(copy.meta.derivedFrom).toEqual({ id: src.id })
    expect(copy.id).not.toBe(src.id)
  })

  it('quotes at the bounds, stats on nothing, whitespace, CRLF, emoji and one long line; the title heading in every disguise', () => {
    expect(quoteContext('abc', 0, 3)).toEqual({ exact: 'abc', prefix: undefined, suffix: undefined })
    expect(quoteContext('abcdef', 2, 4, 1)).toEqual({ exact: 'cd', prefix: 'b', suffix: 'e' })
    expect(quoteContext('abcdef', 2, 4, 0)).toEqual({ exact: 'cd', prefix: '', suffix: '' })
    expect(quoteContext('abc', 5, 9)).toEqual({ exact: '', prefix: 'abc', suffix: undefined })
    expect(quoteContext('', 0, 0)).toEqual({ exact: '', prefix: undefined, suffix: undefined })
    expect(textStats('')).toEqual({ words: 0, chars: 0, lines: 0, minutes: 1 })
    expect(textStats('   \n\t ')).toEqual({ words: 0, chars: 6, lines: 2, minutes: 1 })
    expect(textStats('a\r\nb\r\nc')).toEqual({ words: 3, chars: 7, lines: 3, minutes: 1 })
    expect(textStats('🎉 naïve café 👨‍👩‍👧')).toMatchObject({ words: 4, lines: 1 })
    expect(textStats('🎉').chars).toBe(2) // UTF-16 units, as the editor counts
    expect(textStats('word '.repeat(10_000))).toMatchObject({ words: 10_000, lines: 1, minutes: 45 })
    expect(textStats('word '.repeat(109)).minutes).toBe(1)
    expect(textStats('word '.repeat(331)).minutes).toBe(2)
    expect(stripTitleHeading('# Title\n\nbody', 'Title')).toBe('body')
    expect(stripTitleHeading('# Title  \n\nbody', ' Title ')).toBe('body')
    expect(stripTitleHeading('# Title\nbody', 'Title')).toBe('body')
    expect(stripTitleHeading('# Title', 'Title')).toBe('# Title') // no newline after it: left alone
    expect(stripTitleHeading('# Title\r\n\r\nbody', 'Title')).toBe('body') // CRLF is whitespace to the pattern
    expect(stripTitleHeading('# title\n\nbody', 'Title')).toBe('# title\n\nbody') // case differs
    expect(stripTitleHeading('## Title\n\nbody', 'Title')).toBe('## Title\n\nbody')
    expect(stripTitleHeading('\n# Title\n\nbody', 'Title')).toBe('\n# Title\n\nbody')
    expect(stripTitleHeading('# Title\n\nbody', undefined)).toBe('# Title\n\nbody')
    expect(stripTitleHeading('', 'x')).toBe('')
  })
})
