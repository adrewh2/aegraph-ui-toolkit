import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Where the headless engine may read and write on this machine.
 *
 * A path in a tool call is written by a model, and a model can be talked into
 * anything by the text it reads — so `import_file` and `export_file` are held
 * to one directory, the **root**: the workspace file's own directory, or
 * `--root <dir>`. A path is resolved against the root (a relative path means
 * "in the root"), symlinks are followed to where they really lead, and the
 * result must still be inside it. Without this, `import_file ~/.ssh/id_rsa`
 * reads a key into the store (and back out through any tool), and
 * `export_file ~/.zshrc` writes a file the shell runs, with text a label
 * chose.
 *
 * No path may pass through a name that starts with a dot, reading or
 * writing: the root is often a home directory, and `.ssh`, `.aws`, `.git`,
 * `.env`, `.zshrc` and `.config` are where credentials and code the machine
 * runs live — never a workspace's data. Writing is held tighter still: never
 * through a symlink (the link could be swapped after the check), and never
 * into a `.git` directory at any depth (a hook there is code git runs).
 */
export class PathRoot {
  readonly root: string

  constructor(root: string) {
    this.root = realpathSync(resolve(root))
  }

  /** The real path of an existing file to read, inside the root; throws a sentence otherwise. */
  forRead(path: string): string {
    const asked = resolve(this.root, path)
    let real: string
    try {
      real = realpathSync(asked)
    } catch {
      throw new Error(`No such file: ${path} (paths are read from ${this.root}).`)
    }
    this.inside(real, path)
    this.noDotNames(real, path)
    return real
  }

  /** The path to write, inside the root, not a symlink, not in `.git`, not a dotfile at the root; throws a sentence otherwise. */
  forWrite(path: string): string {
    const asked = resolve(this.root, path)
    let parent: string
    try {
      parent = realpathSync(dirname(asked))
    } catch {
      throw new Error(`The directory for ${path} does not exist (paths are written under ${this.root}).`)
    }
    const target = resolve(parent, basename(asked))
    this.inside(target, path)
    const rel = relative(this.root, target)
    if (rel.split(sep).includes('.git')) throw new Error(`Refused to write ${path}: it is inside a .git directory, where a file can be code git runs.`)
    this.noDotNames(target, path)
    let link = false
    try {
      link = lstatSync(target).isSymbolicLink()
    } catch {
      /* it does not exist yet: nothing to follow */
    }
    if (link) throw new Error(`Refused to write ${path}: it is a symbolic link, and the engine only writes files it can see.`)
    return target
  }

  /** Refuses a path with any segment under the root that starts with a dot (a dotfile or a dot-directory). */
  private noDotNames(real: string, asked: string) {
    if (relative(this.root, real).split(sep).some((s) => s.startsWith('.'))) throw new Error(`Refused ${asked}: a dotfile or dot-directory is configuration or credentials (.ssh, .git, .env…), never a workspace's data.`)
  }

  private inside(real: string, asked: string) {
    const rel = relative(this.root, real)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Refused ${asked}: the engine reads and writes only under ${this.root}. Start it with --root <dir> to choose another directory.`)
  }
}
