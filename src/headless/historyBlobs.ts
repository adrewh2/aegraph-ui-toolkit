import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { EntityId } from '../core/entity/types'
import type { BlobStore } from '../core/projects/historyBlobs'
import type { CommitBlob } from '../core/projects/versioning'

/**
 * Commit content on disk, beside the workspace file.
 *
 * In the browser this lives in its own IndexedDB database so a long history
 * costs the Library no memory; headless the same reasoning gives a folder —
 * `<workspace>.history/<commit>.json.gz`, one file per commit, read only
 * when a diff is viewed or a commit restored. Without it the in-memory
 * fallback would lose every commit's content when the process stops, and
 * `project_restore` would have nothing to restore from.
 */
export class FileBlobs implements BlobStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  private path(id: EntityId) {
    // Commit ids carry a project id and a timestamp; anything but a plain name would escape the folder.
    return join(this.dir, `${encodeURIComponent(id)}.json.gz`)
  }

  async get(id: EntityId): Promise<CommitBlob | undefined> {
    const file = this.path(id)
    if (!existsSync(file)) return undefined
    return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as CommitBlob
  }

  async put(blob: CommitBlob): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    const file = this.path(blob.id)
    const tmp = `${file}.writing`
    writeFileSync(tmp, gzipSync(JSON.stringify(blob), { level: 9 }))
    renameSync(tmp, file)
  }

  async delete(ids: EntityId[]): Promise<void> {
    for (const id of ids) rmSync(this.path(id), { force: true })
  }

  async keys(): Promise<EntityId[]> {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json.gz'))
      .map((f) => decodeURIComponent(f.slice(0, -'.json.gz'.length)))
  }
}
