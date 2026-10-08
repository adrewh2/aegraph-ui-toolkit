import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEntity } from '../../core/entity/entity'
import { HeadlessEngine } from '../engine'
import { refuse, sameSecret } from '../httpGate'
import { PathRoot } from '../paths'
import { createWorkspaceTools } from '../workspaceTools'

/**
 * The headless engine's two edges with this machine: the files a tool call
 * may name, and who may speak to it over a port. A model writes the paths
 * and anything on the loopback can knock, so both are held.
 */
let dir: string
let outside: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'aegraph-root-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'aegraph-outside-')))
  writeFileSync(join(outside, 'secret'), 'id_rsa')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('PathRoot', () => {
  it('reads and writes inside the root, relative paths taken from it', () => {
    const root = new PathRoot(dir)
    writeFileSync(join(dir, 'a.json'), '{}')
    expect(root.forRead('a.json')).toBe(join(dir, 'a.json'))
    mkdirSync(join(dir, 'out'))
    expect(root.forWrite('out/b.csv')).toBe(join(dir, 'out', 'b.csv'))
    expect(root.forWrite(join(dir, 'c.ae.json'))).toBe(join(dir, 'c.ae.json'))
  })

  it('refuses a path outside the root, by .. or absolute', () => {
    const root = new PathRoot(dir)
    expect(() => root.forRead(join(outside, 'secret'))).toThrow(/only under/)
    expect(() => root.forRead(`../${outside.split('/').pop()}/secret`)).toThrow(/only under/)
    expect(() => root.forWrite(join(outside, 'x.json'))).toThrow(/only under/)
    expect(() => root.forRead('/etc/passwd')).toThrow(/only under/)
  })

  it('follows a symlink to where it leads before judging a read, and never writes through one', () => {
    const root = new PathRoot(dir)
    symlinkSync(join(outside, 'secret'), join(dir, 'looks-local'))
    expect(() => root.forRead('looks-local')).toThrow(/only under/)
    symlinkSync(outside, join(dir, 'linked-dir'))
    expect(() => root.forWrite('linked-dir/x.json')).toThrow(/only under/)
    writeFileSync(join(dir, 'real.json'), '{}')
    symlinkSync(join(dir, 'real.json'), join(dir, 'alias.json'))
    expect(() => root.forWrite('alias.json')).toThrow(/symbolic link/)
  })

  it('never writes into .git or a dotfile at the root', () => {
    const root = new PathRoot(dir)
    mkdirSync(join(dir, 'repo', '.git', 'hooks'), { recursive: true })
    expect(() => root.forWrite('repo/.git/hooks/pre-commit')).toThrow(/\.git/)
    expect(() => root.forWrite('.zshrc')).toThrow(/dotfile/)
  })

  it('never reads or writes through a dot-directory — the root is often a home', () => {
    const root = new PathRoot(dir)
    mkdirSync(join(dir, '.ssh'), { recursive: true })
    writeFileSync(join(dir, '.ssh', 'id_rsa'), 'secret')
    expect(() => root.forRead('.ssh/id_rsa')).toThrow(/dot-directory/)
    expect(() => root.forWrite('.ssh/authorized_keys')).toThrow(/dot-directory/)
    expect(() => root.forRead('.env')).toThrow()
  })
})

describe('import_file / export_file', () => {
  it('are held to the root', async () => {
    const engine = new HeadlessEngine({ file: join(dir, 'w.ae.json'), autosave: false })
    const tools = createWorkspaceTools(engine)
    const run = (name: string, args: unknown) => (tools.find((t) => t.name === name) as unknown as { run: (a: unknown) => Promise<unknown> }).run(args)
    await expect(run('import_file', { path: join(outside, 'secret') })).rejects.toThrow(/only under/)
    await expect(run('export_file', { path: join(outside, 'leak.json') })).rejects.toThrow(/only under/)
    await run('export_file', { path: 'here.ae.json' })
    expect(JSON.parse(readFileSync(join(dir, 'here.ae.json'), 'utf8'))).toBeTruthy()
  })

  it('refuse everything outside a --root given explicitly', async () => {
    const root = join(dir, 'exports')
    const engine = new HeadlessEngine({ file: join(dir, 'w.ae.json'), autosave: false, root })
    const tools = createWorkspaceTools(engine)
    const run = (name: string, args: unknown) => (tools.find((t) => t.name === name) as unknown as { run: (a: unknown) => Promise<unknown> }).run(args)
    await expect(run('export_file', { path: join(dir, 'x.ae.json') })).rejects.toThrow(/only under/)
    await run('export_file', { path: 'x.ae.json' })
    expect(readFileSync(join(root, 'x.ae.json'), 'utf8').length).toBeGreaterThan(0)
  })
})

describe('destructive file policy', () => {
  it('refuses reload, colliding imports, replacement and export overwrites without losing work', async () => {
    const file = join(dir, 'workspace.ae.json')
    const engine = new HeadlessEngine({ file, autosave: false, confirm: 'refuse' })
    const tools = createWorkspaceTools(engine)
    const run = async (name: string, args: unknown = {}) => (tools.find((t) => t.name === name) as unknown as { run: (a: unknown) => unknown }).run(args)
    engine.store.upsert(createEntity({ id: 'a', type: 'concept', label: 'saved' }))
    engine.save()
    engine.store.upsert(createEntity({ id: 'a', type: 'concept', label: 'unsaved' }))
    await expect(run('workspace_reload')).rejects.toThrow(/Destructive/)
    writeFileSync(join(dir, 'incoming.json'), JSON.stringify({ $schema: 'aegraph/v1', entities: [createEntity({ id: 'a', type: 'concept', label: 'incoming' })] }))
    await expect(run('import_file', { path: 'incoming.json' })).rejects.toThrow(/Destructive/)
    await expect(run('import_file', { path: 'incoming.json', mode: 'replace' })).rejects.toThrow(/Destructive/)
    expect(engine.store.get('a')?.label).toBe('unsaved')
    writeFileSync(join(dir, 'protected.json'), 'keep me')
    await expect(run('export_file', { path: 'protected.json' })).rejects.toThrow(/EEXIST/)
    expect(readFileSync(join(dir, 'protected.json'), 'utf8')).toBe('keep me')
    await run('export_file', { path: 'new.json' })
    expect(JSON.parse(readFileSync(join(dir, 'new.json'), 'utf8')).entities).toHaveLength(1)
    writeFileSync(join(dir, 'unique.json'), JSON.stringify({ $schema: 'aegraph/v1', entities: [createEntity({ id: 'b', type: 'concept', label: 'new' })] }))
    await run('import_file', { path: 'unique.json' })
    expect(engine.store.get('b')?.label).toBe('new')
  })
})

describe('the HTTP gate', () => {
  const opts = { port: 8788, token: 't0ken', origins: [] as string[] }
  const ok = { host: '127.0.0.1:8788', authorization: 'Bearer t0ken' }

  it('lets a client with the token through on the loopback host', () => {
    expect(refuse(ok, opts)).toBeUndefined()
    expect(refuse({ ...ok, host: 'localhost:8788' }, opts)).toBeUndefined()
  })

  it('refuses a rebound host, a browser origin and a missing or wrong token', () => {
    expect(refuse({ ...ok, host: 'evil.example:8788' }, opts)?.[0]).toBe(421)
    expect(refuse({ ...ok, host: undefined }, opts)?.[0]).toBe(421)
    expect(refuse({ ...ok, origin: 'https://evil.example' }, opts)?.[0]).toBe(403)
    expect(refuse({ ...ok, origin: 'http://127.0.0.1:5199' }, opts)?.[0]).toBe(403)
    expect(refuse({ ...ok, authorization: undefined }, opts)?.[0]).toBe(401)
    expect(refuse({ ...ok, authorization: 'Bearer t0ke' }, opts)?.[0]).toBe(401)
  })

  it('lets an origin given with --allow-origin through', () => {
    expect(refuse({ ...ok, origin: 'http://127.0.0.1:5199' }, { ...opts, origins: ['http://127.0.0.1:5199'] })).toBeUndefined()
  })

  it('compares secrets in constant time, whatever their lengths', () => {
    expect(sameSecret('a', 'a')).toBe(true)
    expect(sameSecret('a', 'ab')).toBe(false)
  })
})
