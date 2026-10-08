/**
 * The demo projects the app ships with: bundles from the `aegraph-ui-demos`
 * repo, put under /demos/ at build time by scripts/demos/fetch.mjs. Shared
 * by the Projects dialog's Demos tab and the `load_dataset` tool. The catalog is
 * fetched only when something asks for it — never on page load.
 */
export interface DemoEntry {
  id: string
  title: string
  description: string
  tags?: string[]
  /** Where the bundle is served from, on this origin. */
  bundleUrl: string
  previewUrl?: string
  readmeUrl?: string
  /** The route the project opens on, when the bundle carries none. */
  home?: string
  highlights?: string[]
  author?: string
  created?: string
  counts?: { entities: number; relationships: number; byType?: Record<string, number> }
  /** The bundle's size before compression. */
  bytes?: number
  exportedAt?: string
}

export interface DemoCatalog {
  generatedAt?: string
  fetchedAt?: string
  demos: DemoEntry[]
}

let cached: Promise<DemoCatalog | null> | null = null

/**
 * The catalog, or null when this build has no demos (the fetch script had no source). Remembered for the page's life —
 * except on the dev server, which serves a demos checkout live: there each ask reads it again, so a rebuilt demo shows.
 */
export function fetchDemoCatalog(): Promise<DemoCatalog | null> {
  if (import.meta.env.DEV) cached = null
  cached ??= (async () => {
    try {
      const r = await fetch('/demos/catalog.json', { headers: { accept: 'application/json' } })
      if (!r.ok) return null
      const c = (await r.json()) as DemoCatalog
      return Array.isArray(c.demos) ? c : null
    } catch {
      return null
    }
  })()
  return cached
}
