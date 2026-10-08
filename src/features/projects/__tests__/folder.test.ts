import { describe, expect, it } from 'vitest'
import { checkoutKind, listBundlesIn, readBundleIn, refusalFor } from '../folder'

/** A directory tree as nested objects: string leaves are file bodies. */
type Tree = { [name: string]: string | Tree }

function file(name: string, body: string, lastModified: number) {
  return {
    kind: 'file' as const,
    name,
    getFile: async () => ({ name, size: body.length, lastModified, text: async () => body }) as unknown as File,
  }
}
function dir(name: string, tree: Tree, t = 1000): FileSystemDirectoryHandle {
  const entries = Object.entries(tree).map(([n, v], i) => (typeof v === 'string' ? file(n, v, t + i) : dir(n, v, t + 100 * (i + 1))))
  const h = {
    kind: 'directory' as const,
    name,
    values: async function* () {
      yield* entries
    },
    getFileHandle: async (n: string) => {
      const e = entries.find((x) => x.kind === 'file' && x.name === n)
      if (!e) throw new DOMException(`${n} not found`, 'NotFoundError')
      return e
    },
    getDirectoryHandle: async (n: string) => {
      const e = entries.find((x) => x.kind === 'directory' && x.name === n)
      if (!e) throw new DOMException(`${n} not found`, 'NotFoundError')
      return e
    },
  }
  return h as unknown as FileSystemDirectoryHandle
}

const demosRepo = dir('aegraph-ui-demos', {
  'README.md': '# demos',
  'catalog.json': '{}',
  '.git': { HEAD: 'ref' },
  node_modules: { 'x.ae.json': '{}' },
  demos: {
    'aegraph-ui-system-map': {
      'demo.json': JSON.stringify({ id: 'aegraph-ui-system-map', title: 'aegraph-ui system map', description: 'A map.', bundle: 'bundle.ae.json' }),
      'bundle.ae.json': '{"$schema":"aegraph/v1"}',
      'README.md': '# system map',
      diagrams: { 'x.svg': '<svg/>' },
    },
    untitled: {
      'thing.aeb': 'pack',
    },
  },
  'top.ae.json': '{}',
})

describe('projects folder: nested bundles', () => {
  it('lists bundles in subfolders, named by demo.json when present', async () => {
    const files = await listBundlesIn(demosRepo)
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
    expect(Object.keys(byPath).sort()).toEqual(['demos/aegraph-ui-system-map/bundle.ae.json', 'demos/untitled/thing.aeb', 'top.ae.json'])
    expect(byPath['demos/aegraph-ui-system-map/bundle.ae.json'].title).toBe('aegraph-ui system map')
    expect(byPath['demos/aegraph-ui-system-map/bundle.ae.json'].description).toBe('A map.')
    expect(byPath['demos/untitled/thing.aeb'].title).toBe('untitled / thing.aeb')
    expect(byPath['top.ae.json'].title).toBe('top.ae.json')
  })
  it('skips node_modules, dot folders and diagrams', async () => {
    const files = await listBundlesIn(demosRepo)
    expect(files.some((f) => f.path.startsWith('node_modules') || f.path.startsWith('.git'))).toBe(false)
  })
  it('reads a nested bundle by its path', async () => {
    const f = await readBundleIn(demosRepo, 'demos/aegraph-ui-system-map/bundle.ae.json')
    expect(await f?.text()).toContain('aegraph/v1')
    await expect(readBundleIn(demosRepo, 'demos/nope/bundle.ae.json')).rejects.toThrow()
  })
})

describe('a source checkout is never a projects folder', () => {
  it('knows this app’s clone by its hooks or its package name, any repository by its .git, and a plain folder by neither', async () => {
    expect(await checkoutKind(dir('aegraph-ui', { '.githooks': { 'pre-commit': '#!/bin/sh' }, 'package.json': '{"name":"aegraph-ui"}', src: {} }))).toBe('aegraph')
    // A clone without the hooks directory (a tarball, a shallow copy) is still this app's source.
    expect(await checkoutKind(dir('aegraph-ui', { 'package.json': '{"name":"aegraph-ui"}', src: {} }))).toBe('aegraph')
    expect(await checkoutKind(dir('demos', { 'package.json': '{"name":"aegraph-ui-demos"}' }))).toBe('aegraph')
    // Somebody else's source tree: refused too — projects do not belong in a repository.
    expect(await checkoutKind(dir('their-app', { 'package.json': '{"name":"their-app"}', src: {} }))).toBe('repository')
    expect(await checkoutKind(dir('notes', { '.git': { HEAD: 'ref: refs/heads/main' } }))).toBe('repository')
    // A worktree's .git is a file, not a directory.
    expect(await checkoutKind(dir('worktree', { '.git': 'gitdir: /elsewhere/.git/worktrees/x' }))).toBe('repository')
    // A folder of projects: allowed.
    expect(await checkoutKind(dir('My projects', { 'a.ae.json': '{}', 'b.aeb': 'pack', Archive: { 'c.ae.json': '{}' } }))).toBeNull()
    expect(await checkoutKind(dir('Documents', {}))).toBeNull()
    // Unreadable package.json is not a verdict either way; the git hooks still stand behind this.
    expect(await checkoutKind(dir('odd', { 'package.json': 'not json' }))).toBeNull()
  })

  it('says why, in words that name the folder’s risk', () => {
    expect(refusalFor('aegraph')).toContain('aegraph’s own source')
    expect(refusalFor('aegraph')).toMatch(/committed or pushed by accident/)
    expect(refusalFor('aegraph')).toMatch(/git clean/)
    expect(refusalFor('repository')).toContain('git repository')
  })
})
