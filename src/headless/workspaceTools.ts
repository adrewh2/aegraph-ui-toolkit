import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { constants } from 'node:fs'
import { open as openFile, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { displayLabel } from '../core/entity/entity'
import { FORMATS, type FormatId } from '../core/exchange/formats'
import { serialize } from '../core/exchange/export'
import { loadParsed, parseFile } from '../core/exchange/import'
import { importBundle } from '../core/projects/bundle'
import { listProjects, scopeCounts } from '../core/projects/project'
import { json } from '../features/assistant/toolkit'
import type { HeadlessEngine } from './engine'

/** A document that is a project bundle (it names the project its entities belong to), or nothing. */
function bundleProjectOf(bytes: Buffer, format: string): unknown | undefined {
  if (format !== 'json') return undefined
  try {
    const doc = JSON.parse(bytes.toString('utf8')) as { project?: string; entities?: unknown[] }
    return doc.project && Array.isArray(doc.entities) ? doc : undefined
  } catch {
    return undefined
  }
}

/**
 * The tools that only exist without a screen: the workspace file itself
 * (what is loaded, where it is written, when), and the one piece of app
 * state a headless caller cannot see for itself — which project is open.
 *
 * In the tab the file is a download and the project is a click; here both
 * are tools, and everything else behaves exactly as it does in the browser.
 */
export function createWorkspaceTools(engine: HeadlessEngine) {
  const requireDestructive = () => {
    if (!engine.allowDestructive) throw new Error('Destructive file operations are disabled. Restart with --yes to allow them.')
  }
  const status = betaTool({
    name: 'workspace_status',
    description: 'Reports unsaved and saveError (the last failed autosave); workspace_save retries a failed save. What this engine is holding: the workspace file, entity and relationship counts, the open project, and whether anything is unsaved. Call it first — it is the headless equivalent of looking at the window.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
    run: () => {
      const projects = listProjects(engine.store).map((p) => {
        const counts = scopeCounts(engine.store, p.id)
        return { id: p.id, label: displayLabel(p), entities: counts.entities, relationships: counts.relationships, open: engine.store.scope === p.id }
      })
      return json({ ...engine.status(), projects })
    },
  })

  const save = betaTool({
    name: 'workspace_save',
    description: 'Write the workspace to its file now. Autosave already does this a moment after every change; call it to be certain, or before the process is stopped.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
    run: () => json(engine.save()),
  })

  const reload = betaTool({
    name: 'workspace_reload',
    description: 'Re-read the workspace from its file, discarding anything unsaved in memory. For when the file was changed by something else (a generator, another process, an editor). Refused with unsaved changes when destructive operations are disabled.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
    run: () => {
      if (engine.status().unsaved) requireDestructive()
      return json({ ...engine.load(), ...engine.status() })
    },
  })

  const open = betaTool({
    name: 'open_project',
    description: 'Scope the engine to a project (its marks and the marks of the projects it includes), or to the whole Library with no id. Everything afterwards — searches, graphs, metrics, documents — sees only that scope, exactly as the app does when a project is open.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The project entity id; omit for the whole Library' } },
      additionalProperties: false,
    } as const,
    run: ({ id }) => {
      if (id && !listProjects(engine.store).some((p) => p.id === id)) throw new Error(`No project with id ${id}. workspace_status lists them.`)
      engine.store.setScope(id ?? null)
      const counts = id ? scopeCounts(engine.store, id) : undefined
      return json({ project: engine.store.scope, entities: counts?.entities ?? engine.store.library.entityCount(), relationships: counts?.relationships ?? engine.store.library.relationshipCount() })
    },
  })

  const importPath = betaTool({
    name: 'import_file',
    description: `Read a file from disk into the workspace: ${Object.values(FORMATS)
      .map((f) => f.extension)
      .join(', ')}, optionally gzipped — the app's own importer, so the same formats and the same normalisation. Replacing or overwriting existing entity IDs requires destructive operations to be enabled. A project bundle (a document with a \`project\`) is opened as that project, ids merged by id the way the app opens one; anything else is merged into the open project, or into \`into\`. \`replace\` clears the workspace first.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A file under the engine\'s root (the workspace\'s directory, or --root); a relative path is taken from there' },
        mode: { type: 'string', enum: ['merge', 'replace'], description: 'merge (default) upserts by id; replace clears the workspace first' },
        into: { type: 'string', description: "Mark what is read as this project's; omit to use the open project (if any)" },
        as_project: { type: 'boolean', description: 'A bundle is opened as its own project (default true); false merges its entities like any other file' },
      },
      required: ['path'],
      additionalProperties: false,
    } as const,
    run: async ({ path, mode, into, as_project }) => {
      const file = engine.paths().forRead(path)
      if (into && !listProjects(engine.store).some((p) => p.id === into)) throw new Error(`No project with id ${into}. workspace_status lists them.`)
      const bytes = await readFile(file)
      const before = engine.store.library.size()
      // The importer takes a File, and Node has had one since 20: the browser's path is the path here too.
      const parsed = await parseFile(new File([bytes], basename(file)), {})
      // A bundle carries its own project and its entities are already marked as its: opening it is what the app does.
      const bundle = as_project !== false ? bundleProjectOf(bytes, parsed.format) : undefined
      if (mode === 'replace' || parsed.entities.some((e) => engine.store.has(e.id))) requireDestructive()
      if (bundle) {
        const r = importBundle(engine.store, bundle, { name: basename(file), source: `import:${file}` })
        engine.store.setScope(r.project.id)
        return json({ file, opened: { id: r.project.id, label: displayLabel(r.project) }, created: r.created, updated: r.updated, upToDate: r.upToDate, skipped: r.skipped, entities: engine.store.library.entityCount(), relationships: engine.store.library.relationshipCount() })
      }
      const scope = into ?? engine.store.scope ?? undefined
      if (into) engine.store.setScope(into)
      await loadParsed(parsed, engine.store, { mode: mode === 'replace' ? 'replace' : 'merge' })
      // Entities that arrived with marks of their own keep them; asked for a project, put them in it as well.
      if (scope) engine.store.mark(parsed.entities.map((e) => e.id), scope)
      return json({ file, format: parsed.format, count: parsed.entities.length, tags: parsed.tags.length, skipped: parsed.skipped, added: engine.store.library.size() - before, project: engine.store.scope, entities: engine.store.library.entityCount(), relationships: engine.store.library.relationshipCount() })
    },
  })

  const exportPath = betaTool({
    name: 'export_file',
    description: `Write what is in scope to a file on disk — the open project, or the whole Library with \`library\`. Formats: ${Object.values(FORMATS).filter((f) => f.id !== 'pack').map((f) => `${f.id} (${f.extension})`).join(', ')}; a \`.gz\` path is gzipped as it is written. This is the download button, as a path. Existing files cannot be overwritten when destructive operations are disabled.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Where to write it, under the engine\'s root (the workspace\'s directory, or --root); a relative path is taken from there' },
        format: { type: 'string', enum: Object.keys(FORMATS).filter((f) => f !== 'pack'), description: 'Default: from the extension, else json' },
        library: { type: 'boolean', description: 'Write the whole Library rather than the open project' },
        pretty: { type: 'boolean', description: 'json: indented' },
      },
      required: ['path'],
      additionalProperties: false,
    } as const,
    run: async ({ path, format, library, pretty }) => {
      const file = engine.paths().forWrite(path)
      const stripped = file.replace(/\.gz$/, '')
      const id = (format as FormatId) ?? (Object.values(FORMATS).find((f) => f.id !== 'pack' && stripped.endsWith(f.extension))?.id ?? 'json')
      const entities = library ? engine.store.library.all() : engine.store.all()
      const project = !library && engine.store.scope ? engine.store.scope : undefined
      const text = Readable.from(serialize({ entities, tags: engine.store.tagInfos(), project }, id, !!pretty))
      // O_NOFOLLOW: a symlink planted between the check and the open is refused by the kernel, not followed.
      const out = (await openFile(file, constants.O_WRONLY | constants.O_CREAT | (engine.allowDestructive ? constants.O_TRUNC : constants.O_EXCL) | constants.O_NOFOLLOW)).createWriteStream()
      if (file.endsWith('.gz')) await pipeline(text, createGzip({ level: 9 }), out)
      else await pipeline(text, out)
      return json({ file, format: id, entities: entities.length, scope: project ?? 'library' })
    },
  })

  return [status, save, reload, open, importPath, exportPath]
}
