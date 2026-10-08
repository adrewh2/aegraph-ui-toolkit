/**
 * Aegraph entity model.
 *
 * Everything begins as information. An entity is the general-purpose unit:
 * an id, arbitrary data, and optional progressive structure (tags → type →
 * relationships → schema). Relationships are entities too, so a link can be
 * described, attributed, and annotated like anything else.
 *
 * The model is plain, serializable data. Presentation (positions, colors,
 * layouts) is deliberately absent — those belong to views.
 */

export type EntityId = string
export type Tag = string
export type ISODate = string

/** Structural role an entity plays. Semantic meaning lives in `type`. */
export type EntityKind = 'entity' | 'relationship'

/**
 * Addresses a whole entity, or a region inside it. Selectors make paragraphs,
 * text ranges, image regions, and time ranges addressable without minting a
 * new entity for each.
 */
export type Selector =
  | { kind: 'text'; exact: string; prefix?: string; suffix?: string }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'region'; x: number; y: number; width: number; height: number }
  /** Seconds into a timed medium; `region` narrows it to part of the frame, in fractions (0–1) of width/height. */
  | { kind: 'time'; start: number; end?: number; region?: { x: number; y: number; width: number; height: number } }
  /** A place on a map: a point (with an optional radius in metres), optionally at a moment or over a span (ISO times). */
  | { kind: 'geo'; lat: number; lng: number; radius?: number; at?: string; until?: string }
  | { kind: 'fragment'; value: string }

export interface EntityRef {
  id: EntityId
  selector?: Selector
}

/** Who/what produced this entity and when. */
export interface EntityMeta {
  createdAt: ISODate
  updatedAt: ISODate
  accessedAt?: ISODate
  createdBy?: string
  /** Origin of the information: 'user', 'extension', 'import:youtube', an agent name, … */
  source?: string
  /** Optional lineage: the entity this one was derived from. */
  derivedFrom?: EntityRef
  /** Projects this entity belongs to (ids of `project` entities). Absent = Library only. */
  projects?: EntityId[]
}

export type EntityData = Record<string, unknown>

export interface EntityBase<D extends EntityData = EntityData> {
  id: EntityId
  kind: EntityKind
  /** Single-valued semantic type. Defaults to 'entity'. */
  type: string
  label?: string
  description?: string
  /** Flat, many-to-many labels. */
  tags: Tag[]
  /** Arbitrary, application-defined attributes. */
  data: D
  meta: EntityMeta
}

export interface Entity<D extends EntityData = EntityData> extends EntityBase<D> {
  kind: 'entity'
}

export interface Relationship<D extends EntityData = EntityData> extends EntityBase<D> {
  kind: 'relationship'
  source: EntityRef
  target: EntityRef
  /** Whether the relationship reads the same in both directions. */
  directed: boolean
}

export type AnyEntity<D extends EntityData = EntityData> = Entity<D> | Relationship<D>

export const isRelationship = (e: AnyEntity): e is Relationship => e.kind === 'relationship'

/** Per-tag presentation/metadata. Tags stay plain strings on entities. */
export interface TagInfo {
  tag: Tag
  color?: string
  description?: string
}

/** Serialized form of a whole store — the exchange document. */
export interface AegraphDocument {
  $schema: 'aegraph/v1'
  exportedAt: ISODate
  entities: AnyEntity[]
  tags?: TagInfo[]
  /** A project bundle: the id (in `entities`) of the project this file is. Absent for a Library snapshot. */
  project?: EntityId
  /** How to reopen the file on the same screen: a route and the per-project UI state (explorer, workstation, …) keyed by storage key. */
  state?: { route?: string; ui?: Record<string, string> }
}
