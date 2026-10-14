import type { EntityStore } from '../../core/entity/store'
import type { EntityId } from '../../core/entity/types'
import { exportToBlob, saveBlob } from '../../core/exchange/export'
import { looksPacked, readPack, readResponseBytes } from '../../core/exchange/import'
import { readUiState, stashUiState, switchProject } from '../../core/projects/active'
import { buildBundle, importBundleAsync, type BundleReport } from '../../core/projects/bundle'
import { demoBundlePath, forkProject, requireProject, type ProjectData, type ProjectEntity } from '../../core/projects/project'
import { applyTemplate, fetchTemplate, TEMPLATE_CATALOG } from '../../core/projects/template'
import { displayLabel } from '../../core/entity/entity'
import { preloadFor } from '../../app/preload'
import { writeBundleToFolder } from './folder'
import { gunzipText } from '../../core/exchange/gunzip'
import { classifyUrl } from '../../core/net/url'
import { requireExternalServices } from '../account/settings'

/** The file stem a project saves as; the exporter adds `.ae.json[.gz]`. */
export const bundleStem = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'

/** Write the project's bundle: into the projects folder when one is chosen (see `folder.ts`), else as a download. */
export async function saveProjectBundle(store: EntityStore, id: EntityId, opts: { route?: string; gzip?: boolean; /** `.ae.json` (the default, what other tools read) or `.aeb`, the pack: a sixth the size and quicker to load. */ format?: 'json' | 'pack'; /** Carry the assistant's chats and memory for the project (default true). */ assistant?: boolean } = {}) {
  const project = requireProject(store, id)
  let outside = 0
  const doc = buildBundle(store, id, { route: opts.route ?? (typeof location !== 'undefined' ? location.pathname + location.search : undefined), assistant: opts.assistant, onClosure: (c) => (outside = c.outside) })
  const r = await exportToBlob({ entities: doc.entities, tags: doc.tags, project: doc.project, state: doc.state }, { format: opts.format ?? 'json', gzip: opts.gzip }, bundleStem(displayLabel(project)))
  const inFolder = await writeBundleToFolder(r.filename, r.blob)
  if (!inFolder) saveBlob(r.blob, r.filename)
  // `outside`: entities from elsewhere in the Library that the project's references reach and the file carries.
  return { filename: r.filename, bytes: r.bytes, count: r.count, outside, where: inFolder ? ('folder' as const) : ('downloads' as const) }
}

/**
 * Save what is open as a new project and switch to it, carrying the
 * current screen state (explorer, positions, camera, workstation) along so
 * the copy opens looking the same. `from` null saves the Library.
 */
export function saveAsNewProject(store: EntityStore, from: EntityId | null, init: { label: string; description?: string; home?: ProjectData['home'] }, opts: { route?: string; open?: boolean } = {}) {
  const r = forkProject(store, from, init)
  if (store.scope === from) stashUiState(r.project.id, readUiState())
  if (opts.open !== false) switchProject(store, r.project.id, { route: opts.route ?? (typeof location !== 'undefined' ? location.pathname + location.search : undefined) })
  return r
}

/** Import a bundle file and make it the active project. */
export async function openBundleFile(store: EntityStore, file: File): Promise<BundleReport> {
  const name = file.name.replace(/\.aeb$|\.ae\.json(\.gz)?$|\.ae(\.gz)?$|\.aegraph\.json(\.gz)?$|\.json(\.gz)?$/i, '')
  return openBundleBytes(store, new Uint8Array(await file.arrayBuffer()), name)
}

const EMPTY_BYTES = new Uint8Array(0)

/** A bundle from its bytes, whatever they are: a pack (`.aeb`, gzipped or not), gzipped JSON, or JSON text. */
export async function openBundleBytes(store: EntityStore, bytes: Uint8Array, name: string, source = 'import'): Promise<BundleReport> {
  if (looksPacked(bytes)) {
    // A gzip that is not a pack falls through to the text path below.
    try {
      const doc = await readPack(bytes)
      // The file itself goes with the import: an open that puts every entity in as decoded is saved as these bytes —
      // gzipped as they arrived — rather than packed again (`BulkSource`); otherwise it is dropped once the import is done.
      const file = bytes
      bytes = EMPTY_BYTES
      // The page the project opens on starts loading now, while the entities go into the store below.
      const page = preloadRoute(doc.state?.route)
      // The decoder hands back entities in the app's own shape: no per-entity normalisation pass.
      const report = await importBundleAsync(store, { $schema: 'aegraph/v1', exportedAt: doc.exportedAt ?? '', entities: doc.entities, tags: doc.tags, project: doc.project, state: doc.state }, { name, source: `import:${source}`, normalized: true, file })
      return openImported(store, report, page, source)
    } catch (err) {
      if (!(err instanceof Error && /Not an aegraph pack/.test(err.message))) throw err
    }
  }
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
  // What a gzip becomes is unbounded, so `gunzipText` counts it and refuses past the limit.
  const text = gzipped ? await gunzipText(bytes) : new TextDecoder().decode(bytes)
  return openBundleText(store, text, name, source)
}

/**
 * Where a bundle URL comes from, which decides whether opening it needs asking.
 *
 * `own` is this site — a path, or an absolute URL on this origin: the demos and
 * templates the app serves, and what a link in the app points at. `elsewhere`
 * is someone else's server, which a link can name (`/open?url=…`) without the
 * person who followed it knowing: a bundle is data that becomes their
 * workspace, so that is asked first. Anything that is not http(s) is refused.
 */
export function bundleOrigin(url: string): { kind: 'own' } | { kind: 'elsewhere'; host: string } | { kind: 'refused'; why: string } {
  const v = classifyUrl(url, 'A bundle')
  return v.kind === 'elsewhere' ? { kind: 'elsewhere', host: v.host } : v.kind === 'own' ? { kind: 'own' } : v
}

/** Fetch a bundle by URL (same origin or CORS-enabled) and make it the active project. A URL that is not http(s) is refused. */
export async function openBundleUrl(store: EntityStore, url: string): Promise<BundleReport> {
  const where = bundleOrigin(url)
  if (where.kind === 'refused') throw new Error(where.why)
  // Another site's bundle is a third party like any other: not fetched with Third-party services off.
  if (where.kind === 'elsewhere') requireExternalServices('Opening a project from another site')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`)
  const name = decodeURIComponent(url.split('/').pop() ?? 'bundle').replace(/\.aeb$|\.ae\.json(\.gz)?$|\.ae(\.gz)?$|\.aegraph\.json(\.gz)?$|\.json(\.gz)?$/i, '')
  // Servers often send a .gz with Content-Encoding: gzip, which the browser has already undone; look at the bytes, not the
  // name. Read within the pack's ceiling: what such a body becomes is the server's to choose.
  return openBundleBytes(store, await readResponseBytes(res), name, url)
}

export async function openBundleText(store: EntityStore, text: string, name: string, source = 'import'): Promise<BundleReport> {
  const doc = JSON.parse(text) as { state?: { route?: string } } | unknown[]
  const page = preloadRoute(Array.isArray(doc) ? undefined : doc?.state?.route)
  return openImported(store, await importBundleAsync(store, doc, { name, source: `import:${source}` }), page, source)
}

/**
 * The code of the page a route shows, fetched ahead of the switch to it. The switch remounts the app on the new
 * route in one synchronous render when the page's code is here; a page still loading renders through a Suspense
 * fallback and then in a concurrent retry — which every write meanwhile (the autosave's commit, the persistence
 * status as each page lands) interrupts and restarts from scratch. Over a city's worth of entities each restart
 * sorted the table again: three starts, three sorts.
 */
const PRELOAD_WAIT_MS = 2500
const preloadRoute = (route: string | undefined) => (route ? preloadFor(route.split('?')[0]).catch(() => undefined) : Promise.resolve())

/**
 * Switch to a project just imported — after giving it the template it names, when it names one the app ships and
 * has not got it yet. A pipeline can then write one file that opens with its charts, scripts and scenes in place:
 * its project entity says `data.template: "conversation-atlas"`, and the first open adds them; later opens leave
 * the project's own versions of them alone.
 */
async function openImported(store: EntityStore, report: BundleReport, page: Promise<void> = Promise.resolve(), source = 'import'): Promise<BundleReport> {
  let project = report.project
  // Opened from one of the demos: said on the project, so the Projects dialog files it under Demos. A bookkeeping
  // write — `updatedAt` stays the bundle's, so a newer build of the demo still updates it in place.
  const demo = demoBundlePath(source)
  if (demo && project.data.demo !== demo) {
    project = { ...project, data: { ...project.data, demo } }
    store.upsert(project)
    report = { ...report, project }
  }
  const wanted = project.data.template
  let route = report.route
  if (wanted && TEMPLATE_CATALOG.some((t) => t.id === wanted) && !hasTemplate(store, project, wanted)) {
    try {
      const applied = applyTemplate(store, await fetchTemplate(wanted), project.id)
      route = route ?? applied.route
    } catch (err) {
      // The data is in either way; the template is a convenience.
      console.warn(`Template ${wanted} not applied:`, err)
    }
  }
  // The route (or the project's home) is the bundle's to name, but not to make anything run: `?run=1` would run a script
  // the reader has never seen. Consent gates that too (scripts/consent.ts); the parameter is not carried in either way.
  route = withoutAutorun(route ?? project.data.home?.route)
  // Waited for, within reason: a page whose code is slow to arrive still opens, through its fallback, as before.
  if (route) await Promise.race([Promise.all([page, preloadRoute(route)]), new Promise((r) => setTimeout(r, PRELOAD_WAIT_MS))])
  // A file that changed the project and carries a screen brings that screen with it, even over the project already
  // open: the tabs kept from before hold their own copies of the scenes' parts and would go on drawing the old
  // version. One that changed nothing, or has no screen of its own, leaves the screen as the reader arranged it.
  switchProject(store, project.id, { route, screen: !!report.screen && report.created + report.updated > 0 })
  return report
}

/** A route from a bundle without the parameters that make a page act on arrival (`run`). Other parameters stay. */
export function withoutAutorun(route: string | undefined): string | undefined {
  if (!route) return route
  const q = route.indexOf('?')
  if (q < 0) return route
  const hash = route.indexOf('#', q)
  const params = new URLSearchParams(route.slice(q + 1, hash < 0 ? undefined : hash))
  if (!params.has('run')) return route
  params.delete('run')
  const rest = params.toString()
  return `${route.slice(0, q)}${rest ? `?${rest}` : ''}${hash < 0 ? '' : route.slice(hash)}`
}

/** Whether the project already holds something the template wrote (its entities carry `meta.source` = `template:<id>`). */
const hasTemplate = (store: EntityStore, project: ProjectEntity, id: string) => store.library.all().some((e) => e.meta.source === `template:${id}` && (e.meta.projects ?? []).includes(project.id))
