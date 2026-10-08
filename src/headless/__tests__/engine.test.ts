import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity } from '../../core/entity/entity'
import { createProject } from '../../core/projects/project'
import { HeadlessEngine } from '../engine'
import { createHeadlessTools } from '../tools'

/**
 * The engine without a screen: a workspace file in, the same store the app
 * has, the file back out — and a tool set that has dropped what needs a
 * browser and gained what a file needs.
 */
describe('the headless engine', () => {
  let dir: string
  const path = (name: string) => join(dir, name)
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegraph-headless-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const doc = (entities: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ $schema: 'aegraph/v1', exportedAt: new Date().toISOString(), entities, ...extra })

  it('a missing file is an empty workspace, and the first save creates it', () => {
    const file = path('new.ae.json')
    const engine = new HeadlessEngine({ file, autosave: false })
    expect(engine.status().entities).toBe(0)
    engine.store.upsert(createEntity({ type: 'concept', label: 'one' }))
    const saved = engine.save()
    expect(saved.entities).toBe(1)
    expect(JSON.parse(readFileSync(file, 'utf8')).entities).toHaveLength(1)
  })

  it('reads a gzipped workspace, and writes one back when the name says so', () => {
    const gz = path('work.ae.json.gz')
    writeFileSync(gz, gzipSync(doc([createEntity({ id: 'a', type: 'concept', label: 'a' })])))
    const engine = new HeadlessEngine({ file: gz, autosave: false })
    expect(engine.store.get('a')?.label).toBe('a')
    const saved = engine.save()
    // Gzip, not JSON: the magic number rather than a brace.
    expect(readFileSync(gz)[0]).toBe(0x1f)
    expect(saved.bytes).toBeLessThan(600)
  })

  it('reopens the project that was open, and saves the whole Library whichever project that is', () => {
    const file = path('scoped.ae.json')
    const project = createProject({ label: 'Scoped', id: 'p1' })
    const engine = new HeadlessEngine({ file, autosave: false })
    engine.store.upsert(project)
    engine.store.setScope('p1')
    engine.store.upsert(createEntity({ type: 'concept', label: 'in the project' }))
    engine.store.setScope(null)
    engine.store.upsert(createEntity({ type: 'concept', label: 'in the Library' }))
    engine.store.setScope('p1')
    expect(engine.store.all()).toHaveLength(1)
    // Saved from inside the project: the file still holds everything, and says which project was open.
    engine.save()
    const written = JSON.parse(readFileSync(file, 'utf8')) as { entities: unknown[]; openProject?: string }
    expect(written.entities).toHaveLength(3)
    expect(written.openProject).toBe('p1')
    const reopened = new HeadlessEngine({ file, autosave: false })
    expect(reopened.store.scope).toBe('p1')
    expect(reopened.store.all()).toHaveLength(1)
    expect(reopened.store.library.all()).toHaveLength(3)
  })

  it('autosaves a moment after a data write, and not for a volatile one', async () => {
    const file = path('auto.ae.json')
    const engine = new HeadlessEngine({ file })
    engine.store.upsert(createEntity({ type: 'concept', label: 'watched' }), { volatile: true })
    await new Promise((r) => setTimeout(r, 400))
    expect(() => readFileSync(file)).toThrow()
    engine.store.upsert(createEntity({ type: 'concept', label: 'material' }))
    await new Promise((r) => setTimeout(r, 400))
    expect(JSON.parse(readFileSync(file, 'utf8')).entities).toHaveLength(2)
    expect(engine.status().unsaved).toBe(false)
  })

  it('keeps unsaved data alive after autosave fails and allows an explicit retry', async () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const file = path('retry.ae.json')
      const engine = new HeadlessEngine({ file })
      engine.store.upsert(createEntity({ id: 'a', type: 'concept', label: 'original' }))
      engine.save()
      // A filesystem failure at the temporary output must not crash the process.
      mkdirSync(`${file}.writing`)
      engine.store.upsert(createEntity({ id: 'a', type: 'concept', label: 'pending' }))
      await vi.advanceTimersByTimeAsync(300)
      expect(engine.status().unsaved).toBe(true)
      expect(engine.status().saveError).toBeTruthy()
      expect(engine.store.get('a')?.label).toBe('pending')
      expect(JSON.parse(readFileSync(file, 'utf8')).entities[0].label).toBe('original')
      rmSync(`${file}.writing`, { recursive: true })
      engine.save()
      expect(engine.status().saveError).toBeNull()
      expect(engine.status().unsaved).toBe(false)
      expect(JSON.parse(readFileSync(file, 'utf8')).entities[0].label).toBe('pending')
    } finally {
      errors.mockRestore()
      vi.useRealTimers()
    }
  })

  it('refuses a file that is not an aegraph document', () => {
    const file = path('nope.ae.json')
    writeFileSync(file, JSON.stringify({ hello: 'world' }))
    expect(() => new HeadlessEngine({ file, autosave: false })).toThrow(/not an aegraph document/)
  })

  it('exposes the app tools that work without a browser, and none that need one', () => {
    const engine = new HeadlessEngine({ file: path('tools.ae.json'), autosave: false })
    const names = new Set(createHeadlessTools(engine).map((t) => t.name))
    for (const has of ['workspace_status', 'workspace_save', 'open_project', 'import_file', 'export_file', 'graph_slice', 'graph_metrics', 'graph_layout', 'create_entity', 'create_document', 'project_create', 'project_commit', 'define_entity_type', 'analyze', 'constraint', 'memory', 'validate_ae']) expect(names).toContain(has)
    for (const none of ['gpu_graph', 'graph_filter', 'graph_viewport', 'globe', 'workstation', 'control_playback', 'voice', 'view_diagram', 'project_publish', 'project_save', 'open']) expect(names).not.toContain(none)
  })

  it('confirms or refuses destructive tools by how it was started, with nobody to ask', async () => {
    const allow = new HeadlessEngine({ file: path('allow.ae.json'), autosave: false })
    const refuse = new HeadlessEngine({ file: path('refuse.ae.json'), autosave: false, confirm: 'refuse' })
    expect(await allow.host().confirm('delete everything?')).toBe(true)
    expect(await refuse.host().confirm('delete everything?')).toBe(false)
    expect(allow.host().getContext().headless).toBe(true)
  })

  it('answers a fetch of a handed URL by its own switch: declined unless started with --allow-network, whatever --yes says', async () => {
    const yes = new HeadlessEngine({ file: path('yes.ae.json'), autosave: false, confirm: 'allow' })
    const net = new HeadlessEngine({ file: path('net.ae.json'), autosave: false, confirm: 'refuse', network: 'allow' })
    expect(await yes.host().confirm('Fetch https://evil.example/?', { yes: 'Fetch', kind: 'fetch' })).toBe(false)
    expect(await yes.host().confirm('Delete it?', { yes: 'Delete', danger: true })).toBe(true)
    expect(await net.host().confirm('Fetch https://example.com/?', { yes: 'Fetch', kind: 'fetch' })).toBe(true)
    expect(await net.host().confirm('Delete it?', { yes: 'Delete', danger: true })).toBe(false)
  })
})
