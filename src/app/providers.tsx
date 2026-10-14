import { Fragment, createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ToastProvider, useToast } from '../components/ui/useToast'
import { EntityStoreContext } from '../core/entity/hooks'
import { Persistence, type PersistStatus } from '../core/entity/persistence'
import { EntityStore } from '../core/entity/store'
import type { AnyEntity } from '../core/entity/types'
import { restoreActiveProject } from '../core/projects/active'
import { startAutosave, type AutosaveFailure } from '../core/projects/autosave'
import { getProjectHistory, storagePruneLedger } from '../core/projects/history'
import { useProjectEpoch } from '../core/projects/hooks'
import { migrateStore, storageMigrationLog } from '../core/resources/migrate'
import { seedStore, seedWelcome } from '../core/resources/seed'
import { fetchDemoCatalog } from '../features/datasets/demos'
import { openBundleUrl } from '../features/projects/projectActions'
import { HOSTS, writeStoredWorkstation } from '../features/workstation/hosts'
import { FIRST_RUN_TAB, firstRunWorkstation } from '../features/workstation/model'
// Registering resource types is a side effect of importing the module.
import '../core/resources/types'
import '../core/graph/types'
import '../core/graph/scene'
import '../core/graph/projection'
import '../core/graph/plot'
import '../core/slides/slides'
import '../core/datasets/dataset'
import '../features/conversations/conversation'
import '../features/maps/maps'
import '../features/scripts/script'
import '../core/constraints/constraint'
import '../core/constraints/templates'
import '../core/projects/commitType'
import { ConstraintEngine } from '../core/constraints/engine'
import { EDITION } from './edition'
import { preloadFor } from './preload'
import { linkedScene, readDemoLink, sceneTab, type DemoLink } from './demoLink'
import { databaseExists, guardUnsaved, unpersistedStore } from './unsaved'
import { sweepExplorerSessions } from '../features/graph/heldPositions'

const INIT_FLAG = 'aegraph:initialized'
/** The front door: a visit that loads the app at `/` opens the workstation (Chats in front, `defaultWorkstation`). */
const FIRST_ROUTE = '/workstation'
/**
 * The project the app opens by default, and the tab its first run opens on: the edition's (`edition.json` ›
 * `defaultDemo`, described in `edition.ts`). Opened once per key; a build without demos opens nothing.
 */
const DEFAULT_DEMO = EDITION.defaultDemo.id
const DEFAULT_DEMO_TITLE = EDITION.defaultDemo.title
const DEFAULT_DEMO_KEY = EDITION.defaultDemo.key
const DEFAULT_DEMO_TAB: { path: string; title: string } | undefined = EDITION.defaultDemo.tab ?? undefined
/** The explorer's `DETAIL_MIN_KEY` (GraphExplorer.tsx) — spelled here so the explorer stays a lazy chunk. */
const EXPLORER_DETAIL_MIN_KEY = 'aegraph:explorer:detail-min'

/**
 * The default demo open as the project, on the first run's workstation: one
 * pane, one tab, its whole graph in 3D with the force simulation running live.
 * Returns false when this build has no demos. The bundle's own screen is
 * replaced; an install that already has the project keeps its arrangement
 * (this runs once per edition).
 */
async function openDefaultDemo(store: EntityStore): Promise<boolean> {
  const tab = DEFAULT_DEMO_TAB ?? FIRST_RUN_TAB
  // The page that will show it, and its renderer, come down while the catalog and the bundle do: fetched only once the
  // project had switched, the 3D engine's code was a round trip after everything else on a first visit.
  void preloadFor(tab.path.split('?')[0]).catch(() => undefined)
  const demo = (await fetchDemoCatalog())?.demos.find((d) => d.id === DEFAULT_DEMO)
  if (!demo) return false
  await openBundleUrl(store, demo.bundleUrl)
  // After the switch, which put the project's own page state in place: the first run's screen replaces the bundle's.
  writeStoredWorkstation(HOSTS.workstation, { ws: firstRunWorkstation(tab), dirty: false })
  // The explorer's detail pane starts folded, so the pane's width goes to the picture.
  localStorage.setItem(EXPLORER_DETAIL_MIN_KEY, '1')
  return true
}

/**
 * A demo link's demo, opened as its project; on the scene it names, when the project has it, as the one tab of a
 * first-run workstation (`sceneTab`). Null when this site has no such demo; `scene` is the scene it landed on.
 */
async function openDemoLink(store: EntityStore, link: DemoLink): Promise<{ scene?: AnyEntity } | null> {
  if (link.scene) void preloadFor('/unigraph/3d').catch(() => undefined)
  const demo = (await fetchDemoCatalog())?.demos.find((d) => d.id === link.demo)
  if (!demo) return null
  await openBundleUrl(store, demo.bundleUrl)
  const scene = linkedScene(store, link)
  if (!scene) return {}
  writeStoredWorkstation(HOSTS.workstation, { ws: firstRunWorkstation(sceneTab(scene)), dirty: false })
  return { scene }
}

export const PersistenceContext = createContext<Persistence | null>(null)

export function usePersistence() {
  const p = useContext(PersistenceContext)
  if (!p) throw new Error('usePersistence must be used inside <AppProviders>')
  return p
}

export function usePersistStatus(): PersistStatus {
  const p = usePersistence()
  return useSyncExternalStore(
    (cb) => p.subscribe(cb),
    () => p.getStatus(),
    () => p.getStatus(),
  )
}

/** A write the constraints rejected or warned about: one line in a toast, the details in the console. */
function ConstraintNotices({ store }: { store: EntityStore }) {
  const toast = useToast()
  useEffect(
    () =>
      store.subscribe((event) => {
        const events = event.type === 'batch' ? event.events : [event]
        for (const ev of events) {
          if (ev.type !== 'rejected') continue
          const rejects = ev.violations.filter((v) => v.severity === 'reject')
          const warns = ev.violations.length - rejects.length
          const first = ev.violations[0]
          const head = ev.rejected.length ? `${ev.rejected.length} rejected by constraints` : `${warns} constraint warning${warns === 1 ? '' : 's'}`
          toast(`${head}: ${first.entity} — ${first.constraint}: ${first.message}${ev.violations.length > 1 ? ` (+${ev.violations.length - 1} more, see the console)` : ''}`)
          if (ev.violations.length > 1) console.warn('[constraints]', ev.violations)
        }
      }),
    [store, toast],
  )
  return null
}

/**
 * What went wrong at the start. `unsaved`: the workspace was never read, so the database is not attached and nothing
 * done now is saved; `exists` says whether this browser has one (null: it cannot say), which is then left untouched.
 */
type LoadError = { message: string; unsaved: boolean; exists?: boolean | null }

/** The Library's database (`core/entity/persistence.ts`). */
const LIBRARY_DB = 'aegraph'

interface BootScreen {
  setPhase: (phase: string) => void
  setLoadError: (error: LoadError) => void
  setDemoError: (message: string) => void
  setAutosaveError: (failure: AutosaveFailure | null) => void
}

/**
 * The page's store and its persistence, and the boot that fills one from the other — once for the page. A dev
 * server's hot swap re-runs this module and this component's memos and effects; a swap that made a new store (and a
 * second persistence, beside the first) or booted again (reading the database back over the store while its writes
 * were still queued) left the running app on a store the database no longer followed. Kept in the module's hot
 * data they outlive the swap; in a build there is no swap, and they are the component's own.
 */
const kept = import.meta.hot?.data as { store?: EntityStore; persistence?: Persistence; booted?: WeakMap<EntityStore, Promise<void>> } | undefined
const boots = kept ? (kept.booted ??= new WeakMap()) : new WeakMap<EntityStore, Promise<void>>()

function bootOnce(store: EntityStore, persistence: Persistence, ui: BootScreen): Promise<void> {
  let b = boots.get(store)
  if (!b) boots.set(store, (b = boot(store, persistence, ui)))
  return b
}

async function boot(store: EntityStore, persistence: Persistence, ui: BootScreen): Promise<void> {
  let attached = false
  try {
    if (Persistence.isSupported()) {
      const t0 = performance.now()
      // The page's code comes down while the workspace is read, so both are here when the boot screen goes: one
      // screen, then the page — no "Loading…" for the route and none for the renderer inside it. Each stage of
      // the boot is a performance measure (`boot:*`), so where a slow start goes can be read off the timeline.
      const timed = <T,>(name: string, work: Promise<T>): Promise<T> => {
        const start = performance.now()
        return work.finally(() => performance.measure(name, { start }))
      }
      const [count] = await Promise.all([timed('boot:idb', persistence.load(store)), timed('boot:preload', preloadFor(location.pathname).catch((err) => console.warn('[aegraph] preload failed:', err)))])
      console.info(`[aegraph] loaded ${count} entities from IndexedDB in ${(performance.now() - t0).toFixed(0)}ms`)
      const initialized = localStorage.getItem(INIT_FLAG) === '1'
      // Attach before seeding so the seed itself is persisted; otherwise the next load finds an empty store.
      persistence.attach(store)
      attached = true
      // The workspace is the only copy: ask the browser not to evict it under storage pressure. Not awaited — the
      // answer is the browser's, and the Projects page's storage card shows it.
      void Persistence.keepStorage()
      const tSeed = performance.now()
      // Each upgrade once per database; a new one (nothing loaded) is born upgraded.
      migrateStore(store, storageMigrationLog(localStorage), { fresh: count === 0 })
      if (count === 0 && !initialized) seedStore(store)
      seedWelcome(store)
      performance.measure('boot:seed', { start: tSeed })
      localStorage.setItem(INIT_FLAG, '1')
      // The default project, once per edition, whatever path the visit landed on (a bookmark, the omnibox
      // finishing `aegraph.dev` with a page seen before). A first run then lands on its workstation; an existing
      // install keeps the page it was on (the front door goes to the workstation too), with the project now open.
      // A link that opens a demo (`?demo=<id>&scene=<scene>`, `demoLink.ts`) is the visit's choice, on a first visit
      // or any other: that demo opens instead of the default, which then does not open over it.
      const link = readDemoLink(location.search)
      if (link) {
        ui.setPhase(`Opening ${link.demo}…`)
        try {
          const r = await openDemoLink(store, link)
          if (!r) ui.setDemoError(`There is no demo “${link.demo}” on this site — the Demos tab of the Projects dialog lists them.`)
          else {
            if (link.scene && !r.scene) ui.setDemoError(`The demo has no scene “${link.scene}”: it opened on its own first screen.`)
            // On a scene: the workstation that shows it. Otherwise the demo's own route, which the open pushed.
            if (r.scene) history.replaceState(history.state, '', FIRST_ROUTE)
          }
        } catch (err) {
          console.warn(`[aegraph] demo ${link.demo} not opened:`, err)
          ui.setDemoError(`The demo “${link.demo}” could not be opened: ${err instanceof Error ? err.message : String(err)}`)
        }
        localStorage.setItem(DEFAULT_DEMO_KEY, '1')
      } else if (localStorage.getItem(DEFAULT_DEMO_KEY) !== '1') {
        const at = location.pathname + location.search
        ui.setPhase(`Opening ${DEFAULT_DEMO_TITLE}…`)
        let opened = false
        try {
          opened = await openDefaultDemo(store)
          localStorage.setItem(DEFAULT_DEMO_KEY, '1')
        } catch (err) {
          console.warn(`[aegraph] default project ${DEFAULT_DEMO} not opened:`, err)
          ui.setDemoError(`The default project (${DEFAULT_DEMO_TITLE}) could not be opened: ${err instanceof Error ? err.message : String(err)} — it is on the Datasets page.`)
        }
        // The open pushed the bundle's own route; land where this visit belongs instead.
        if (opened) history.replaceState(history.state, '', !initialized || at === '/' ? FIRST_ROUTE : at)
      }
      // The front door is the workstation, on every visit: `/` loaded fresh (typing the address, a reload) opens it.
      // The Dashboard keeps `/` inside the app, reached from the sidebar.
      if (location.pathname === '/' && !location.search) history.replaceState(history.state, '', FIRST_ROUTE)
      // Before the app mounts, so pages open scoped.
      const tRestore = performance.now()
      restoreActiveProject(store)
      performance.measure('boot:restore', { start: tRestore })
      // Explorer sessions (Unigraph tabs) that neither stored UI state nor a saved workstation names any more let
      // go of their keys — before any page mounts, so no tab opened in this visit is judged.
      sweepExplorerSessions(localStorage, [sessionStorage], store.library.ofType('workstation').map((w) => JSON.stringify(w.data)).join('\n'))
      // Project history: autosave commits for the open project (a failure is put on screen); blobs of deleted commits
      // go once they have been orphaned a day — a blob seen orphaned now may be another tab's commit still landing.
      const projectHistory = getProjectHistory(store)
      startAutosave(store, projectHistory, { onFailure: ui.setAutosaveError })
      projectHistory.prune({ ledger: storagePruneLedger(localStorage) }).then((n) => n && console.info(`[aegraph] history: pruned ${n} orphaned commit blob${n === 1 ? '' : 's'}`)).catch(() => {})
    } else {
      await preloadFor(location.pathname)
      seedStore(store)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (attached) {
      ui.setLoadError({ message, unsaved: false })
      if (store.size() === 0) seedStore(store)
    } else {
      // The workspace was not read, and the database is not attached: nothing done now is saved. What this browser
      // holds is left as it is — a first visit's seed goes in only where there is no database for it to stand in for —
      // the notice stays on screen, and leaving the page after any change asks first.
      const exists = await databaseExists(LIBRARY_DB)
      if (exists === false && store.size() === 0) seedStore(store)
      unpersistedStore(store)
      ui.setLoadError({ message, unsaved: true, exists })
    }
  }
  performance.measure('boot:ready', { start: 0 })
  warmIndexesWhenIdle(store)
}

/**
 * What the load leaves for later (the store's tag index — `EntityStore.warmTagIndex`), built a slice at a time while
 * the page is idle, so it is ready before anyone asks and the first picture did not wait for it.
 */
function warmIndexesWhenIdle(store: EntityStore) {
  const idle = (fn: (budget: number) => void) =>
    typeof requestIdleCallback === 'function' ? requestIdleCallback((d) => fn(Math.max(4, Math.min(12, d.timeRemaining()))), { timeout: 2000 }) : setTimeout(() => fn(8), 50)
  const step = (budget: number) => {
    if (!store.warmTagIndex(budget)) idle(step)
  }
  idle(step)
}

/** What a failed save says on screen, until it lands: the writes are kept and tried again, and a reload would lose them. */
function PersistAlert({ persistence }: { persistence: Persistence }) {
  const status = useSyncExternalStore(
    (cb) => persistence.subscribe(cb),
    () => persistence.getStatus(),
    () => persistence.getStatus(),
  )
  if (status.skipped && status.state !== 'error')
    return (
      <div className="toast" role="alert">
        {status.skipped} saved page{status.skipped === 1 ? '' : 's'} of this browser’s Library could not be read and {status.skipped === 1 ? 'was' : 'were'} left out. {status.skipped === 1 ? 'It is' : 'They are'} kept as saved, untouched — export what you have (Projects › Save project…) before clearing anything, and see the console for the reason.
      </div>
    )
  if (status.state !== 'error') return null
  // Entities no browser can store (see `PersistStatus.lost`): set aside, never retried — a retry cannot help them.
  if (status.lost && !status.unsaved)
    return (
      <div className="toast" role="alert">
        Not saved to this browser: {status.error ?? 'unknown error'} What was set aside stays in the page until it closes — export it (Projects › Save project…) to keep it.
      </div>
    )
  return (
    <div className="toast" role="alert">
      Not saved to this browser{status.unsaved ? ` (${status.unsaved} change${status.unsaved === 1 ? '' : 's'} waiting)` : ''}: {status.error ?? 'unknown error'} — it is tried again with your next change.{' '}
      <button className="btn btn--sm" onClick={() => void persistence.retry()}>
        Try again
      </button>
    </div>
  )
}

/** A store with the constraint engine standing guard at its writes: what fails a rejecting constraint does not get in. */
function guardedStore(): EntityStore {
  const store = new EntityStore()
  store.setGuard(new ConstraintEngine(store).guard)
  return store
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [store] = useState(() => (kept ? (kept.store ??= guardedStore()) : guardedStore()))
  const [persistence] = useState(() => (kept ? (kept.persistence ??= new Persistence()) : new Persistence()))
  // Console convenience: `__aegraph.store.query({ text: '…' })`.
  ;(window as unknown as { __aegraph: unknown }).__aegraph = { store, persistence }
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<LoadError | null>(null)
  const [phase, setPhase] = useState('Loading workspace…')
  // The default project could not be opened (offline, a build without the bundle): said once, on screen.
  const [demoError, setDemoError] = useState<string | null>(null)
  // An autosave the history database refused: the changes are in the Library, not yet in the project's history.
  const [autosaveError, setAutosaveError] = useState<AutosaveFailure | null>(null)
  // Switching projects swaps the pages' remembered state; remounting makes them read it.
  const epoch = useProjectEpoch()

  useEffect(() => {
    let cancelled = false
    void bootOnce(store, persistence, { setPhase, setLoadError, setDemoError, setAutosaveError }).then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [store, persistence])

  // Leaving the page — a reload, the tab closed, the dev server reloading it — while a change is still on its way to
  // this browser's storage, or failed to get there, asks first: after the reload it would be gone.
  useEffect(() => guardUnsaved(persistence), [persistence])

  return (
    <EntityStoreContext.Provider value={store}>
      <PersistenceContext.Provider value={persistence}>
        <ToastProvider>
          <ConstraintNotices store={store} />
          <PersistAlert persistence={persistence} />
          {ready ? (
            <Fragment key={epoch}>{children}</Fragment>
          ) : (
            // The same markup as index.html's boot screen (its styles live there), so the hand-over is invisible.
            <div className="boot" role="status">
              <div className="boot__mark">aegraph</div>
              <div className="boot__bar" />
              <div className="boot__phase">{phase}</div>
            </div>
          )}
          {loadError &&
            (loadError.unsaved ? (
              <div className="toast" role="alert">
                Your workspace could not be read from this browser: {loadError.message}. {loadError.exists !== false ? 'What is saved here is left untouched. ' : ''}
                Nothing you do now will be saved — reload to try again.{' '}
                <button className="btn btn--sm" onClick={() => location.reload()}>
                  Reload
                </button>
              </div>
            ) : (
              <div className="toast" role="alert">
                Persistence unavailable: {loadError.message}
              </div>
            ))}
          {autosaveError && (
            <div className="toast" role="alert" onClick={() => setAutosaveError(null)}>
              Autosave could not commit to this project’s history: {autosaveError.message}. Your changes are kept in the Library; commit them from the project menu, or free some space — the next autosave tries again.
            </div>
          )}
          {demoError && (
            <div className="toast" role="alert" onClick={() => setDemoError(null)}>
              {demoError}
            </div>
          )}
        </ToastProvider>
      </PersistenceContext.Provider>
    </EntityStoreContext.Provider>
  )
}
