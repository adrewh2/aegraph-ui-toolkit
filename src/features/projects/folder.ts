/**
 * Where projects live on disk.
 *
 * The workspace itself is in the browser's IndexedDB (database `aegraph`,
 * per origin) — files on disk, but the browser's own and not ones to open.
 * A project becomes a *file you can see* as a bundle (`<name>.ae.json`, or `<name>.aeb` — the pack),
 * and this module gives bundles a home: a **projects folder** the user
 * picks once (File System Access API — Chrome and Edge). Save writes there
 * instead of Downloads; the folder's bundles are listed to open. Browsers
 * without the API fall back to Downloads, as before.
 *
 * One folder is refused: a checkout of aegraph's own source, or any other
 * git repository. Your projects are yours and the repository is the
 * project's; a bundle saved into a clone is one `git add -f` away from a
 * pull request that publishes it, and one `git clean -fdx` away from being
 * deleted. `.gitignore` and the git hooks stop it at commit and push time;
 * this stops it being written there at all. See SECURITY.md.
 */

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  values?: () => AsyncIterable<FileSystemHandle>
}

const SETTINGS_DB = 'aegraph-settings'
const HANDLES = 'handles'
const KEY = 'projectsFolder'

export const supportsProjectsFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window && typeof indexedDB !== 'undefined'

function openSettings(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SETTINGS_DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(HANDLES)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function getHandle(): Promise<DirHandle | null> {
  if (!supportsProjectsFolder()) return null
  const db = await openSettings()
  return new Promise((resolve) => {
    const req = db.transaction(HANDLES).objectStore(HANDLES).get(KEY)
    req.onsuccess = () => resolve((req.result as DirHandle | undefined) ?? null)
    req.onerror = () => resolve(null)
  })
}
async function putHandle(h: DirHandle | null) {
  const db = await openSettings()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HANDLES, 'readwrite')
    if (h) tx.objectStore(HANDLES).put(h, KEY)
    else tx.objectStore(HANDLES).delete(KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  listeners.forEach((l) => l())
}

const listeners = new Set<() => void>()
/** Re-render when the folder is chosen or forgotten. */
export function onProjectsFolderChange(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export interface ProjectsFolder {
  name: string
  /** Whether we may write now; `prompt` means a click on “Allow” is needed (permission lapses per session). */
  permission: PermissionState
}

/** The chosen folder, if any, and whether it is usable right now. */
export async function getProjectsFolder(): Promise<ProjectsFolder | null> {
  const h = await getHandle()
  if (!h) return null
  const permission = (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted'
  return { name: h.name, permission }
}

/** Ask for access again (must run in a user gesture). */
export async function allowProjectsFolder(): Promise<boolean> {
  const h = await getHandle()
  if (!h) return false
  const p = (await h.requestPermission?.({ mode: 'readwrite' })) ?? 'granted'
  listeners.forEach((l) => l())
  return p === 'granted'
}

/** Pick a folder (must run in a user gesture); remembered across sessions. */
export async function chooseProjectsFolder(): Promise<ProjectsFolder | null> {
  if (!supportsProjectsFolder()) return null
  const picker = (window as unknown as { showDirectoryPicker: (o: { mode: 'readwrite'; id?: string; startIn?: string }) => Promise<DirHandle> }).showDirectoryPicker
  let h: DirHandle
  try {
    h = await picker({ mode: 'readwrite', id: 'aegraph-projects', startIn: 'documents' })
  } catch {
    return null // cancelled
  }
  // A source checkout is never a projects folder — nothing is remembered and nothing is written.
  const kind = await checkoutKind(h)
  if (kind) throw new ProjectsFolderRefused(kind, h.name)
  await putHandle(h)
  return { name: h.name, permission: 'granted' }
}

/** Thrown by `chooseProjectsFolder` when the folder picked is a source checkout; the UI shows `message`. */
export class ProjectsFolderRefused extends Error {
  readonly kind: 'aegraph' | 'repository'
  readonly folder: string
  constructor(kind: 'aegraph' | 'repository', folder: string) {
    super(refusalFor(kind))
    this.name = 'ProjectsFolderRefused'
    this.kind = kind
    this.folder = folder
  }
}

export const forgetProjectsFolder = () => putHandle(null)

/**
 * Whether a picked directory is a source checkout — this app's own, or any
 * other repository. Read-only: the markers a repository has at its root and
 * a projects folder never does. A folder we cannot read is not a repository
 * as far as we know, and is allowed: the guards downstream still hold.
 */
export async function checkoutKind(dir: FileSystemDirectoryHandle): Promise<'aegraph' | 'repository' | null> {
  const has = async (name: string, kind: 'file' | 'directory') => {
    try {
      if (kind === 'file') await dir.getFileHandle(name)
      else await dir.getDirectoryHandle(name)
      return true
    } catch {
      return false
    }
  }
  // This app's clone: its own hook directory, or a package.json that names it.
  if (await has('.githooks', 'directory')) return 'aegraph'
  try {
    const pkg = await (await dir.getFileHandle('package.json')).getFile()
    const name = (JSON.parse(await pkg.text()) as { name?: string }).name
    if (typeof name === 'string' && /^aegraph/.test(name)) return 'aegraph'
    return 'repository' // some other project's source, package.json and all
  } catch {
    /* no package.json, or not readable JSON */
  }
  if ((await has('.git', 'directory')) || (await has('.git', 'file'))) return 'repository'
  return null
}

/** Why a folder was refused, in the words the user sees. */
export function refusalFor(kind: 'aegraph' | 'repository'): string {
  return kind === 'aegraph'
    ? 'That folder is a checkout of aegraph’s own source. Projects saved there would sit inside the repository, where they can be committed or pushed by accident — and deleted by a `git clean`. Pick a folder outside it: Documents, or a projects folder of your own.'
    : 'That folder is a git repository. Projects saved there would be inside someone’s source tree, where they can be committed or pushed by accident — and deleted by a `git clean`. Pick a folder that is not a repository.'
}

/** A writable handle when a folder is set and allowed; otherwise null (the caller falls back to Downloads). */
async function writable(): Promise<DirHandle | null> {
  const h = await getHandle()
  if (!h) return null
  const p = (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted'
  return p === 'granted' ? h : null
}

/**
 * Write a bundle into the projects folder. Returns false when there is no
 * usable folder — including one that has become a source checkout since it
 * was chosen (a folder picked before this check existed, or a repository
 * started inside it): the save falls back to Downloads rather than writing
 * into a repository.
 */
export async function writeBundleToFolder(filename: string, blob: Blob): Promise<boolean> {
  const h = await writable()
  if (!h) return false
  if (await checkoutKind(h)) {
    await putHandle(null)
    return false
  }
  const file = await h.getFileHandle(filename, { create: true })
  const w = await file.createWritable()
  await w.write(blob)
  await w.close()
  listeners.forEach((l) => l())
  return true
}

export interface BundleFile {
  /** Path inside the projects folder, `/`-separated (`bundle.ae.json`, `demos/x/bundle.ae.json`). */
  path: string
  /** The file name. */
  name: string
  /** What to call it: the `demo.json` title next to a nested bundle, else the enclosing folder, else the file name. */
  title: string
  description?: string
  bytes: number
  modifiedAt: string
}

const BUNDLE_RE = /\.(aeb|ae\.json|ae|aegraph\.json)(\.gz)?$/i
/** Folders never worth descending into. */
const SKIP_DIR = /^(\.|node_modules$|dist$|build$|generators$|diagrams$)/
/** How deep to look: the folder itself, `demos/<id>/`, and one more for good measure. */
const MAX_DEPTH = 3

interface DemoMeta {
  title?: string
  description?: string
  bundle?: string
}

async function readDemoMeta(dir: DirHandle): Promise<DemoMeta | null> {
  try {
    const f = await (await dir.getFileHandle('demo.json')).getFile()
    const j = JSON.parse(await f.text()) as DemoMeta
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

async function walk(dir: DirHandle, prefix: string, depth: number, out: BundleFile[]) {
  if (!dir.values) return
  const meta = prefix ? await readDemoMeta(dir) : null
  const subdirs: DirHandle[] = []
  for await (const entry of dir.values()) {
    if (entry.kind === 'directory') {
      if (depth < MAX_DEPTH && !SKIP_DIR.test(entry.name)) subdirs.push(entry as DirHandle)
      continue
    }
    if (!BUNDLE_RE.test(entry.name)) continue
    const f = await (entry as FileSystemFileHandle).getFile()
    // A demo folder names its bundle; other bundles beside it are still listed, under their own names.
    const isTheDemo = !!meta && (meta.bundle ? meta.bundle === entry.name : true)
    const title = isTheDemo && meta?.title ? meta.title : prefix ? `${dir.name} / ${entry.name}` : entry.name
    out.push({
      path: prefix + entry.name,
      name: entry.name,
      title,
      description: isTheDemo ? meta?.description : undefined,
      bytes: f.size,
      modifiedAt: new Date(f.lastModified).toISOString(),
    })
  }
  for (const sub of subdirs) await walk(sub, `${prefix}${sub.name}/`, depth + 1, out)
}

/**
 * The bundles in the folder, newest first — including ones in subfolders
 * (a checkout of a demos repo keeps each under `demos/<id>/`, with a
 * `demo.json` naming it).
 */
export async function listBundlesInFolder(): Promise<BundleFile[]> {
  const h = await writable()
  return h ? listBundlesIn(h) : []
}

/** The same, for any directory handle (exported for tests). */
export async function listBundlesIn(dir: FileSystemDirectoryHandle): Promise<BundleFile[]> {
  const out: BundleFile[] = []
  await walk(dir as DirHandle, '', 0, out)
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

/** Read one bundle by its path inside the folder (as listed). */
export async function readBundleFromFolder(path: string): Promise<File | null> {
  const h = await writable()
  return h ? readBundleIn(h, path) : null
}

export async function readBundleIn(root: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  let dir = root as DirHandle
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) return null
  for (const part of parts) dir = (await dir.getDirectoryHandle(part)) as DirHandle
  return (await dir.getFileHandle(name)).getFile()
}

// ── The browser's own storage ──────────────────────────────────────────

export interface StorageInfo {
  origin: string
  database: string
  usedBytes?: number
  quotaBytes?: number
  /** Whether the browser has promised not to evict this origin's data under pressure. */
  persisted?: boolean
  /** Where the browser keeps IndexedDB for this origin on this OS — its own files, not ones to open. */
  onDisk: string
}

export async function storageInfo(): Promise<StorageInfo> {
  const origin = location.origin
  const est = await navigator.storage?.estimate?.().catch(() => undefined)
  const persisted = await navigator.storage?.persisted?.().catch(() => undefined)
  const ua = navigator.userAgent
  const mac = /Macintosh/.test(ua)
  const win = /Windows/.test(ua)
  const dir = origin.replace(/^(\w+):\/\//, '$1_').replace(/:(\d+)$/, '_$1') + '.indexeddb.leveldb'
  const profile = /Edg\//.test(ua) ? (mac ? '~/Library/Application Support/Microsoft Edge/<Profile>' : win ? '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\<Profile>' : '~/.config/microsoft-edge/<Profile>') : /Chrome\//.test(ua) ? (mac ? '~/Library/Application Support/Google/Chrome/<Profile>' : win ? '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\<Profile>' : '~/.config/google-chrome/<Profile>') : /Firefox\//.test(ua) ? (mac ? '~/Library/Application Support/Firefox/Profiles/<profile>/storage/default' : '<Firefox profile>/storage/default') : /Safari\//.test(ua) ? '~/Library/Safari/Databases' : '<browser profile>'
  const onDisk = /Chrome\/|Edg\//.test(ua) ? `${profile}/IndexedDB/${dir}` : profile
  return { origin, database: 'aegraph', usedBytes: est?.usage, quotaBytes: est?.quota, persisted, onDisk }
}

/** Ask the browser to keep this origin's data (no eviction under storage pressure). */
export async function requestPersistentStorage(): Promise<boolean> {
  return (await navigator.storage?.persist?.().catch(() => false)) ?? false
}
