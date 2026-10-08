import type { DemoEntry } from '../datasets/demos'
import type { LocalDemo } from '../datasets/localDemos'

/**
 * Everything that opens as a project, in one list: the demos fetched from
 * the demos repo (aegraph-ui-demos, put under /demos/ at build time — the
 * app ships no projects of its own) and the bundles on this machine the dev
 * server serves. A dataset is a project — the same file,
 * the same open — so the choice belongs in one place rather than a page of
 * cards, each with its own button.
 */
export interface Openable {
  id: string
  title: string
  description?: string
  /** Where the bundle is, on this origin. */
  url: string
  where: 'demo' | 'local'
  bytes?: number
  previewUrl?: string
  counts?: { entities: number; relationships: number }
  /** A line or three about what is inside, from the demo's own catalogue entry. */
  highlights?: string[]
  tags?: string[]
  /** Sorted on: newest local file first, then the catalog's order. */
  modified?: string
}

const BUNDLE = /\.(ae\.json|aeb|ae|aegraph\.json)(\.gz)?$/i
/** Whether a file is a project bundle rather than a dataset to import row by row. */
export const isBundleName = (name: string): boolean => BUNDLE.test(name)

const fromDemo = (d: DemoEntry): Openable => ({ id: d.id, title: d.title, description: d.description, url: d.bundleUrl, where: 'demo', bytes: d.bytes, previewUrl: d.previewUrl, counts: d.counts ? { entities: d.counts.entities, relationships: d.counts.relationships } : undefined, highlights: d.highlights?.slice(0, 3), tags: d.tags?.slice(0, 4) })
const fromLocal = (d: LocalDemo): Openable => ({ id: `local:${d.id}`, title: d.label, description: `On this machine · ${d.file}`, url: `/__local/demos/${encodeURIComponent(d.id)}`, where: 'local', bytes: d.bytes, modified: d.modified })

/** One list: newest local bundles first, then the demos in the catalog's order. */
export function openables(demos: DemoEntry[] = [], local: LocalDemo[] = []): Openable[] {
  const fromDemos = demos.map(fromDemo)
  const fromLocals = local.filter((d) => d.kind === 'file' && isBundleName(d.file)).map(fromLocal)
  fromLocals.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''))
  return [...fromLocals, ...fromDemos]
}

/** What the row says under the title: where it came from, how big it is, what it holds. */
export function describeOpenable(o: Openable): string {
  const bits: string[] = []
  if (o.counts) bits.push(`${o.counts.entities.toLocaleString()} entities · ${o.counts.relationships.toLocaleString()} relationships`)
  if (o.bytes) bits.push(o.bytes >= 1_048_576 ? `${(o.bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(o.bytes / 1024)).toLocaleString()} KB`)
  if (o.where === 'local') bits.push('on this machine')
  return bits.join(' · ')
}
