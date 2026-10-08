import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { displayLabel } from '../core/entity/entity'
import { EntityStore } from '../core/entity/store'
import { TypeRegistry } from '../core/entity/typeRegistry'
import type { AegraphDocument, EntityId } from '../core/entity/types'
import { getProjectHistory } from '../core/projects/history'
import { isProjectEntity } from '../core/projects/project'
import type { AppContext, AppHost } from '../features/assistant/tools'
import { FileBlobs } from './historyBlobs'
import { PathRoot } from './paths'

/**
 * aegraph without a screen.
 *
 * The app is a renderer over a logical engine — an entity store, an
 * ontology, filters, layouts, metrics, projects and bundles — and none of
 * that needs a DOM. This is that engine hosted in Node: one workspace file
 * on disk, read at boot, written back when it changes, driven over MCP with
 * the same tools the assistant and the bridge use in the tab.
 *
 * What is deliberately absent is anything whose answer is a picture or a
 * pointer — the camera, the canvas, the player, the workstation. Those
 * tools are not registered (see `tools.ts`); everything else answers in the
 * same JSON it answers with in the browser.
 */

export interface WorkspaceFile extends AegraphDocument {
  /**
   * The project the engine had open when the workspace was written, reopened
   * on load. Not `project`, which in an aegraph document means "this file is
   * that project's bundle" — this file is the whole Library.
   */
  openProject?: EntityId
}

export interface EngineOptions {
  /** The workspace to read and write: a `.ae.json` or `.ae.json.gz` file. Created on the first save. */
  file: string
  /** Write after every change that touches the data (default), or only when `workspace_save` asks. */
  autosave?: boolean
  /** Destructive tools ask before they act; headless there is nobody to ask. `allow` runs them, `refuse` declines. */
  confirm?: 'allow' | 'refuse'
  /**
   * A tool handed a URL on another site asks before it is reached (a confirmation of kind `fetch`); headless there is
   * nobody to ask, and the URL came from the data or the model, not from whoever started the engine. `refuse` (the
   * default) declines every such fetch; `allow` (`--allow-network`) lets them go — to public addresses only, as ever.
   */
  network?: 'allow' | 'refuse'
  /** The one directory `import_file` / `export_file` may touch (`paths.ts`). Default: the workspace file's directory. */
  root?: string
}

const isGzip = (b: Buffer) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b

export class HeadlessEngine {
  readonly store = new EntityStore()
  readonly file: string
  private readonly autosave: boolean
  readonly allowDestructive: boolean
  readonly allowNetwork: boolean
  private readonly rootDir: string
  private pathRoot: PathRoot | undefined
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private saveError: string | null = null
  private registryAt = -1
  private cachedRegistry: TypeRegistry | undefined
  /** Where a navigating tool would have taken the app. A headless caller reads it as "what is on screen". */
  route = '/'

  constructor(opts: EngineOptions) {
    this.file = resolve(opts.file)
    this.autosave = opts.autosave !== false
    this.allowDestructive = (opts.confirm ?? 'allow') === 'allow'
    this.allowNetwork = opts.network === 'allow'
    this.rootDir = resolve(opts.root ?? dirname(this.file))
    // The history service is created once per store, so its blob store is chosen before anything asks for one:
    // commit content goes in a folder beside the workspace, not into a map that the next process would not have.
    getProjectHistory(this.store, new FileBlobs(`${this.file.replace(/\.gz$/, '')}.history`))
    this.load()
    // Data writes make the workspace dirty; bookkeeping (a touch, a script's last run) does not.
    this.store.subscribe((ev) => {
      if (ev.type === 'upsert' && ev.volatile) return
      this.dirty = true
      if (this.autosave) this.scheduleSave()
    })
  }

  /** Read the workspace from disk. A missing file is an empty workspace, not an error: the first save creates it. */
  load(): { entities: number; project: EntityId | null } {
    if (!existsSync(this.file)) return { entities: 0, project: null }
    const raw = readFileSync(this.file)
    const text = (isGzip(raw) ? gunzipSync(raw) : raw).toString('utf8')
    const doc = JSON.parse(text) as WorkspaceFile
    if (!Array.isArray(doc.entities)) throw new Error(`${this.file}: not an aegraph document (no entities array).`)
    this.store.setScope(null)
    this.store.loadDocument(doc, { replace: true })
    const open = doc.openProject ?? doc.project
    if (open && isProjectEntity(this.store.get(open))) this.store.setScope(open)
    this.dirty = false
    return { entities: doc.entities.length, project: this.store.scope }
  }

  /** Write the workspace where it came from — through a temporary file, so a crash mid-write cannot lose it. */
  save(): { file: string; entities: number; bytes: number } {
    const doc: WorkspaceFile = {
      $schema: 'aegraph/v1',
      exportedAt: new Date().toISOString(),
      openProject: this.store.scope ?? undefined,
      state: { route: this.route },
      tags: this.store.tagInfos(),
      // The whole Library, whatever project is open: the workspace is the file, not the view.
      entities: this.store.library.all(),
    }
    const text = JSON.stringify(doc)
    const body = this.file.endsWith('.gz') ? gzipSync(text, { level: 9 }) : Buffer.from(text)
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.writing`
    writeFileSync(tmp, body)
    renameSync(tmp, this.file)
    this.dirty = false
    this.saveError = null
    return { file: this.file, entities: doc.entities.length, bytes: body.length }
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer)
    // An import is thousands of writes; the workspace is written once, just after they stop.
    this.saveTimer = setTimeout(() => {
      try {
        this.save()
      } catch (err) {
        // Keep the process and its unsaved data alive so a caller can recover.
        this.saveError = err instanceof Error ? err.message : String(err)
        console.error('[headless] autosave failed:', this.saveError)
      }
    }, 250)
  }

  /** Everything pending is on disk (the debounce flushed). Called before the process exits. */
  flush() {
    clearTimeout(this.saveTimer)
    if (this.dirty) this.save()
  }

  status() {
    return {
      file: this.file,
      entities: this.store.library.entityCount(),
      relationships: this.store.library.relationshipCount(),
      tags: this.store.library.tags().length,
      history: `${this.file.replace(/\.gz$/, '')}.history`,
      project: this.store.scope,
      unsaved: this.dirty,
      saveError: this.saveError,
      autosave: this.autosave,
      route: this.route,
    }
  }

  /** The ontology, rebuilt when the data changed — the tab's `registryFor`, without React. */
  registry(): TypeRegistry {
    if (!this.cachedRegistry || this.registryAt !== this.store.dataVersion) {
      this.cachedRegistry = new TypeRegistry(this.store)
      this.registryAt = this.store.dataVersion
    }
    return this.cachedRegistry
  }

  /** Where tools may read and write files: resolved on first use, so a workspace whose directory is created by its first save still works. */
  paths(): PathRoot {
    if (!this.pathRoot) {
      mkdirSync(this.rootDir, { recursive: true })
      this.pathRoot = new PathRoot(this.rootDir)
    }
    return this.pathRoot
  }

  /** The host the tools expect: a store, an ontology, somewhere to "navigate", and an answer to a confirmation. */
  host(): AppHost {
    // A getter, not a value: the ontology is rebuilt when the data changes, and a tool asks per call.
    const registry = () => this.registry()
    return {
      store: this.store,
      get registry() {
        return registry()
      },
      navigate: (to: string) => {
        this.route = to
      },
      getContext: (): AppContext => {
        const project = this.store.scope ? this.store.get(this.store.scope) : undefined
        return {
          route: this.route,
          headless: true,
          project: project ? { id: project.id, label: displayLabel(project), entities: this.store.all().length } : undefined,
        }
      },
      // Nobody is watching: each question is answered by how the engine was started — reaching a site a tool was handed
      // by `--allow-network`, anything else (a delete, a replace, a rewrite) by `--yes` / `--refuse-destructive`. One
      // switch for both would let a destructive allowance carry every fetch with it.
      confirm: async (_message, o) => (o?.kind === 'fetch' ? this.allowNetwork : this.allowDestructive),
      choose: async () => null,
    }
  }
}
