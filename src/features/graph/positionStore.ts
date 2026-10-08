import type { Positions } from '../../core/graph/layouts'
import type { Position } from '../../core/graph/types'
import type { EntityId } from '../../core/entity/types'

/** The mover a running simulation names itself by (see `movedSince`, `quietVersion`). */
export const PHYSICS_TAG = 'physics'

/** Each underlying Map gets a number, so a cache can tell "the same positions, moved" from "another layout". */
let nextStoreId = 1

/** How many recent changes the journal remembers, and the largest one it bothers to list. */
const JOURNAL = 24
const JOURNAL_MAX = 200_000

/**
 * The session's working layout: where the nodes are, as the person has left
 * them. A scene or a saved layout is the committed copy; this is the working
 * one, and moving a node changes this rather than the entity (the explorer
 * marks the layout dirty and only Save writes it back).
 *
 * It exists because the working copy is held across filters on purpose —
 * `saveLayout` merges everything held, visible or not, so a saved layout
 * reproduces what was looked at — and so it grows to whatever a session has
 * laid out, which can be hundreds of thousands of nodes. Held as a plain
 * object, every node moved cost a copy of the whole thing: measured at a
 * drag release, 840ms in the reducer and 111ms more counting the keys, of a
 * second that the person felt as a freeze. A Map behind a version counter
 * makes the move O(1) and the count free; the plain object the rest of the
 * app speaks is materialised only where one is really needed, and cached
 * until the next change.
 *
 * `moved` mutates the Map in place and hands back a new wrapper, which is
 * what makes it O(1): React sees a new object and re-renders, while nothing
 * pays to copy the old one. Applying the same move twice lands in the same
 * place, so StrictMode's double invocation is harmless. What it costs is
 * that an older wrapper is no longer a picture of the past: every wrapper
 * over the same Map reads the newest positions. The one reader that needs
 * the past — the simulation handing its positions back, which must not undo
 * what the person moved while it ran — asks `movedSince` instead, and the
 * store keeps a short journal of recent changes to answer it.
 */
export class PositionStore {
  private readonly map: Map<EntityId, Position>
  /**
   * The last `JOURNAL` changes, oldest first; `ids` absent means "too many to list", `tag` names who made it.
   * Shared with every wrapper over the same Map.
   */
  private readonly journal: { version: number; ids?: EntityId[]; tag?: string }[]
  /** Bumped on every change; memos and caches key off this rather than object identity. */
  readonly version: number
  /**
   * The same, counting only the changes a live simulation did not make (`tag` other than `physics`). A running
   * simulation hands its positions over every few seconds, and the picture on screen is the engine's own; a cache
   * that would only be rebuilt to say what the renderer is already drawing follows this instead, and is spared.
   */
  readonly quietVersion: number
  /** Which set of positions this is: preserved as it is moved, new when another layout replaces it. */
  readonly id: number
  private object: Positions | undefined
  private objectAt = -1

  private constructor(map: Map<EntityId, Position>, version: number, journal: { version: number; ids?: EntityId[]; tag?: string }[] = [], quietVersion = version, id = nextStoreId++) {
    this.map = map
    this.version = version
    this.journal = journal
    this.quietVersion = quietVersion
    this.id = id
  }

  /** Record a change and hand back the wrapper that stands for it. */
  private noted(ids: EntityId[] | undefined, tag: string | undefined): PositionStore {
    const version = this.version + 1
    this.journal.push({ version, ids: ids && ids.length <= JOURNAL_MAX ? ids : undefined, tag })
    if (this.journal.length > JOURNAL) this.journal.splice(0, this.journal.length - JOURNAL)
    return new PositionStore(this.map, version, this.journal, tag === PHYSICS_TAG ? this.quietVersion : version, this.id)
  }

  /**
   * The nodes that moved since `version`, or undefined when the journal no longer reaches back that far (or a
   * change was too large to list) — the caller then knows only that it cannot tell.
   *
   * `ignore` drops the changes made under that tag, which is how a writer asks "what did anyone *else* move
   * while I was running": a reducer runs twice under StrictMode and a dispatch lands a tick after it is made,
   * so counting versions to recognise one's own changes is wrong in both directions. Naming them is not.
   */
  movedSince(version: number, opts?: { ignore?: string }): EntityId[] | undefined {
    if (version > this.version) return undefined
    const out: EntityId[] = []
    let reaches = version === this.version
    for (const step of this.journal) {
      if (step.version <= version) continue
      if (step.version === version + 1) reaches = true
      if (opts?.ignore !== undefined && step.tag === opts.ignore) continue
      if (!step.ids) return undefined
      for (const id of step.ids) out.push(id)
    }
    return reaches ? out : undefined
  }

  static empty(): PositionStore {
    return new PositionStore(new Map(), 0)
  }

  /** From the plain object the rest of the app speaks (a loaded layout, a restore, a worker's result). */
  static from(positions: Positions | undefined): PositionStore {
    const m = new Map<EntityId, Position>()
    if (positions) for (const id in positions) m.set(id, positions[id])
    return new PositionStore(m, 0)
  }

  get size(): number {
    return this.map.size
  }

  get(id: EntityId): Position | undefined {
    return this.map.get(id)
  }

  has(id: EntityId): boolean {
    return this.map.has(id)
  }

  /** The nodes moved, in place: the cost follows the move, not the graph. `tag` names the mover, for `movedSince`. */
  moved(patch: Positions, tag?: string): PositionStore {
    const ids: EntityId[] = []
    for (const id in patch) {
      this.map.set(id, patch[id])
      ids.push(id)
    }
    return this.noted(ids, tag)
  }

  /**
   * The same from the packed form (ids and a column of x, y, z): how a live simulation hands every node back. From a
   * plain object of a million keys this was the settle's freeze — building it, walking it with `for…in`, collecting
   * it — about a second at a million nodes.
   */
  movedPacked(p: { ids: readonly EntityId[]; xyz: Float32Array | Float64Array; dims: 2 | 3 }, tag?: string): PositionStore {
    const three = p.dims === 3
    const { ids, xyz } = p
    for (let i = 0; i < ids.length; i++) this.map.set(ids[i], three ? { x: xyz[i * 3], y: xyz[i * 3 + 1], z: xyz[i * 3 + 2] } : { x: xyz[i * 3], y: xyz[i * 3 + 1] })
    return this.noted(ids.length <= JOURNAL_MAX ? ids.slice() : undefined, tag)
  }

  /** One node, the drag's own path. */
  movedOne(id: EntityId, position: Position, tag?: string): PositionStore {
    this.map.set(id, position)
    return this.noted([id], tag)
  }

  /** A different layout altogether: a fresh Map, so the old one is not disturbed. */
  /**
   * Straight from the packed form a big view's positions are stored in (ids and a column of x, y, z): one pass, and
   * no plain object of a million keys on the way — which the restore of a big view used to build, then copy.
   */
  static fromPacked(p: { ids: readonly string[]; xyz: Float32Array | Float64Array; dims: 2 | 3 }): PositionStore {
    const m = new Map<EntityId, Position>()
    const three = p.dims === 3
    for (let i = 0; i < p.ids.length; i++) m.set(p.ids[i], three ? { x: p.xyz[i * 3], y: p.xyz[i * 3 + 1], z: p.xyz[i * 3 + 2] } : { x: p.xyz[i * 3], y: p.xyz[i * 3 + 1] })
    return new PositionStore(m, 0)
  }

  static replace(positions: Positions | undefined): PositionStore {
    return PositionStore.from(positions)
  }

  /**
   * The plain object, for the places that genuinely need one: saving a layout or a scene, the tools, a bundle.
   * Built once per change — call it at a boundary, never in a loop or a render that runs on every move.
   */
  asObject(): Positions {
    if (this.object && this.objectAt === this.version) return this.object
    const out: Positions = {}
    for (const [id, p] of this.map) out[id] = p
    this.object = out
    this.objectAt = this.version
    return out
  }

  entries(): IterableIterator<[EntityId, Position]> {
    return this.map.entries()
  }
}
