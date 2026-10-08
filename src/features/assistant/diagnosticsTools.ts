import { crashes, lastCrash, recentSamples, storageReport } from '../../app/memoryWatch'
import { saveStatus } from '../../app/unsaved'
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import type { AnyEntity } from '../../core/entity/types'
import { HOST_NAMES, HOSTS, mountedHost } from '../workstation/hosts'
import { json } from './toolkit'
import type { AppHost } from './tools'

/**
 * What the tab weighs: the JS heap, what the store holds (bytes by type,
 * estimated from a sample of each type's entities), the biggest single
 * entities, and what is mounted. For finding out why a page is slow or
 * heavy — the answer is usually a type whose `data` carries text the
 * views never read, or a page kept mounted with a renderer in it.
 */

interface MemoryInfo {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

const mb = (n: number) => Math.round((n / 1048576) * 10) / 10

/** Bytes an entity would take as JSON — a fair proxy for its heap weight (strings dominate). */
const bytesOf = (e: AnyEntity) => {
  try {
    return JSON.stringify(e).length
  } catch {
    return 0
  }
}

export function createDiagnosticsTools(host: AppHost) {
  const { store } = host

  const diagnostics = betaTool({
    name: 'app_diagnostics',
    description:
      'What the tab weighs and why: JS heap used / limit (Chrome), the store\'s entities by type with their estimated bytes (JSON size, sampled per type and scaled), the heaviest single entities and which data keys make them heavy, the pane hosts that are mounted, and the number of graph explorers alive. Use it when the app is slow, when memory is high, or before loading more data. `top` = how many types / entities to list (default 12). `watch` is the tab\'s flight recorder: its last samples (every 2 s: heap, main-thread time lost to long tasks, route, mounted pages, canvases, transcript items, stored chat sizes) and `lastCrash` — the last minute of the last page that ended without closing (Chrome killed it, usually out of memory), read after the reload. Use it when the user says the page crashed. `saving` is where the store\'s writes to this browser stand: `idle`, `saving` (with `pending`), or `error` with the reason and `unsaved` — writes that failed, kept and tried again with the next change; a reload before they land loses them. Use it when the user says something they made is gone after a reload.',
    inputSchema: { type: 'object', properties: { top: { type: 'integer', minimum: 1, maximum: 100 }, sample: { type: 'integer', minimum: 10, maximum: 5000, description: 'Entities sampled per type for the byte estimate (default 200)' } }, additionalProperties: false } as const,
    run: ({ top, sample }) => {
      const k = top ?? 12
      const perType = sample ?? 200
      const perf = (globalThis as { performance?: { memory?: MemoryInfo } }).performance
      const memory = perf?.memory ? { usedMB: mb(perf.memory.usedJSHeapSize), totalMB: mb(perf.memory.totalJSHeapSize), limitMB: mb(perf.memory.jsHeapSizeLimit) } : undefined
      const registry = new TypeRegistry(store)
      // Bytes by type from a sample: every type's first `perType` entities in full, scaled up.
      const types: { type: string; kind: string; count: number; estimatedMB: number; meanBytes: number; heaviestKeys: { key: string; share: number }[] }[] = []
      const heaviest: { id: string; type: string; label?: string; bytes: number }[] = []
      for (const t of registry.all()) {
        const all = store.ofType(t.type)
        if (!all.length) continue
        const step = Math.max(1, Math.floor(all.length / perType))
        let sum = 0
        let n = 0
        const keyBytes = new Map<string, number>()
        for (let i = 0; i < all.length; i += step) {
          const e = all[i]
          const b = bytesOf(e)
          sum += b
          n++
          for (const [key, v] of Object.entries(e.data)) {
            const s = typeof v === 'string' ? v.length : v == null ? 4 : JSON.stringify(v).length
            keyBytes.set(key, (keyBytes.get(key) ?? 0) + s)
          }
          if (heaviest.length < k * 3 || b > heaviest[heaviest.length - 1].bytes) {
            heaviest.push({ id: e.id, type: e.type, label: e.label, bytes: b })
            heaviest.sort((a, c) => c.bytes - a.bytes)
            if (heaviest.length > k) heaviest.length = k
          }
        }
        const mean = n ? sum / n : 0
        types.push({
          type: t.type,
          kind: t.kind === 'relationship' ? 'relationship' : 'entity',
          count: all.length,
          estimatedMB: mb(mean * all.length),
          meanBytes: Math.round(mean),
          heaviestKeys: [...keyBytes]
            .sort((a, c) => c[1] - a[1])
            .slice(0, 3)
            .map(([key, bytes]) => ({ key, share: sum ? Math.round((100 * bytes) / sum) / 100 : 0 })),
        })
      }
      types.sort((a, c) => c.estimatedMB - a.estimatedMB)
      const totalMB = Math.round(types.reduce((s, t) => s + t.estimatedMB, 0) * 10) / 10
      const hosts = HOST_NAMES.filter((n) => mountedHost(HOSTS[n].key))
      const explorers = typeof document !== 'undefined' ? document.querySelectorAll('.gx-canvas canvas, .gx-3d canvas').length : 0
      const keptPages = typeof document !== 'undefined' ? [...document.querySelectorAll('.app-page')].map((p) => ({ hidden: (p as HTMLElement).hidden, canvases: p.querySelectorAll('canvas').length })) : []
      return json({
        memory,
        store: { entities: store.entityCount(), relationships: store.relationshipCount(), estimatedMB: totalMB, note: 'JSON bytes as a proxy for heap; the live objects take roughly 1.5–3× that' },
        types: types.slice(0, k),
        heaviestEntities: heaviest.map((h) => ({ ...h, kb: Math.round(h.bytes / 1024) })),
        mounted: { hosts, keptPages, canvases: explorers },
        // The flight recorder: this page's last samples, and the last minute of the last page that was killed.
        watch: { recent: recentSamples().slice(-8), lastCrash: lastCrash() ?? null, crashes: crashes() },
        // localStorage: a full one fails every write quietly (transcripts, positions, this recorder).
        localStorage: storageReport(),
        // The store's writes to IndexedDB: a failed one is kept and tried again, and a reload before it lands loses it.
        saving: saveStatus(),
      })
    },
  })

  return [diagnostics]
}
