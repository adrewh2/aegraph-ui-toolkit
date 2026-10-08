import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EntityStore } from '../../../core/entity/store'
import { TOOL_FEATURES } from '../toolFeatures'

/**
 * A feature a deployment turns off (`app/features.ts`, `AEGRAPH_FEATURES_OFF`) takes its tools with it: decided in
 * `toolFeatures.ts`, applied by `createAppTools` and the headless engine. The default build's list — everything on —
 * is the sorted list in `assistant.test.ts`. The flag is read when `app/features.ts` loads, so each case stubs the
 * variable, resets the module registry and imports the tool set afresh.
 */

const MAP_TOOLS = ['create_map', 'add_location', 'add_path', 'add_area', 'annotate_map', 'enrich_location', 'map_state', 'map_import']
const GLOBE_TOOLS = ['globe', 'globe_load']
const VIDEO_TOOLS = ['create_video', 'annotate_video', 'capture_video_frame']
const AUDIO_TOOLS = ['create_audio', 'annotate_audio']
const ALL_OFF = 'maps,globe,videos,audio'

const host = (store: EntityStore) => ({ store, navigate: () => {}, getContext: () => ({ route: '/' }), confirm: async () => true })

async function withFeaturesOff(off: string) {
  vi.stubEnv('AEGRAPH_FEATURES_OFF', off)
  vi.resetModules()
  return { tools: await import('../tools'), features: await import('../../../app/features') }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('tools of a feature turned off', () => {
  it('names only tools that exist, each under a known feature', async () => {
    const { createAppTools } = await import('../tools')
    const names = new Set(createAppTools(host(new EntityStore())).map((t) => t.name))
    for (const [tool, features] of Object.entries(TOOL_FEATURES)) {
      expect(names.has(tool), tool).toBe(true)
      for (const f of features) expect(['maps', 'globe', 'videos', 'audio']).toContain(f)
    }
  })

  it('does not register their tools, so tools/list does not offer them', async () => {
    const { tools } = await withFeaturesOff(ALL_OFF)
    const names = tools.createAppTools(host(new EntityStore())).map((t) => t.name)
    for (const n of [...MAP_TOOLS, ...GLOBE_TOOLS, ...VIDEO_TOOLS, ...AUDIO_TOOLS, 'control_playback']) expect(names).not.toContain(n)
    // The rest are all there: images, tables, the graph.
    for (const n of ['view_image', 'create_image', 'table_layout', 'open', 'workstation', 'graph_state']) expect(names).toContain(n)
  })

  it('keeps control_playback while either player is on', async () => {
    const { tools } = await withFeaturesOff('videos')
    const names = tools.createAppTools(host(new EntityStore())).map((t) => t.name)
    expect(names).toContain('control_playback')
    expect(names).toContain('create_audio')
    for (const n of VIDEO_TOOLS) expect(names).not.toContain(n)
  })

  it('refuses their pages in open and workstation, and leaves them out of the descriptions', async () => {
    const { tools } = await withFeaturesOff(ALL_OFF)
    const list = tools.createAppTools(host(new EntityStore()))
    const run = async (name: string, input: unknown) => {
      const t = list.find((x) => x.name === name)!
      return t.run(t.parse(input) as never)
    }
    await expect(run('open', { page: 'maps' })).rejects.toThrow('Maps is turned off on this deployment.')
    await expect(run('open', { page: '/videos' })).rejects.toThrow('Videos is turned off on this deployment.')
    await expect(run('workstation', { action: 'open_tab', path: '/audio' })).rejects.toThrow('Audio is turned off on this deployment.')
    const describe = (name: string) => (list.find((x) => x.name === name) as { description?: string }).description ?? ''
    expect(describe('workstation')).not.toMatch(/`maps`|`videos`|`audio`/)
    expect(describe('open')).not.toMatch(/videos|audio|maps,/)
  })

  it('the globe alone off leaves the flat map', async () => {
    const { features, tools } = await withFeaturesOff('globe')
    expect(features.featureOn('maps')).toBe(true)
    expect(features.pathOff('/maps/x')).toBeUndefined()
    expect(features.pathOff('/maps/x?view=globe')).toBe('globe')
    const names = tools.createAppTools(host(new EntityStore())).map((t) => t.name)
    for (const n of GLOBE_TOOLS) expect(names).not.toContain(n)
    for (const n of MAP_TOOLS) expect(names).toContain(n)
  })
  it('applies to the headless engine too, which reads the same variable', async () => {
    vi.stubEnv('AEGRAPH_FEATURES_OFF', ALL_OFF)
    vi.resetModules()
    const { HeadlessEngine } = await import('../../../headless/engine')
    const { createHeadlessTools } = await import('../../../headless/tools')
    const dir = mkdtempSync(join(tmpdir(), 'aegraph-flags-test-'))
    try {
      const names = createHeadlessTools(new HeadlessEngine({ file: join(dir, 'w.ae.json'), autosave: false })).map((t) => t.name)
      for (const n of MAP_TOOLS) expect(names).not.toContain(n)
      expect(names).toContain('graph_scene')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
