import { newEntityId } from './ids'
import type {
  AnyEntity,
  Entity,
  EntityData,
  EntityMeta,
  EntityRef,
  Relationship,
  Tag,
} from './types'

const now = () => new Date().toISOString()

export interface EntityInit<D extends EntityData = EntityData> {
  id?: string
  type?: string
  label?: string
  description?: string
  tags?: Iterable<Tag>
  data?: D
  meta?: Partial<EntityMeta>
}

export interface RelationshipInit<D extends EntityData = EntityData> extends EntityInit<D> {
  source: EntityRef | string
  target: EntityRef | string
  directed?: boolean
}

const toRef = (r: EntityRef | string): EntityRef => (typeof r === 'string' ? { id: r } : r)

function makeMeta(meta?: Partial<EntityMeta>): EntityMeta {
  const t = now()
  return { createdAt: t, updatedAt: t, ...meta }
}

/** The minimum entity: an id and some data. Everything else is optional. */
export function createEntity<D extends EntityData = EntityData>(init: EntityInit<D> = {}): Entity<D> {
  return {
    id: init.id ?? newEntityId(),
    kind: 'entity',
    type: init.type ?? 'entity',
    label: init.label,
    description: init.description,
    tags: uniqueTags(init.tags),
    data: (init.data ?? {}) as D,
    meta: makeMeta(init.meta),
  }
}

export function createRelationship<D extends EntityData = EntityData>(
  init: RelationshipInit<D>,
): Relationship<D> {
  return {
    id: init.id ?? newEntityId(),
    kind: 'relationship',
    type: init.type ?? 'related',
    label: init.label,
    description: init.description,
    tags: uniqueTags(init.tags),
    data: (init.data ?? {}) as D,
    meta: makeMeta(init.meta),
    source: toRef(init.source),
    target: toRef(init.target),
    directed: init.directed ?? true,
  }
}

export function uniqueTags(tags?: Iterable<Tag>): Tag[] {
  const out: Tag[] = []
  const seen = new Set<Tag>()
  for (const raw of tags ?? []) {
    const t = String(raw).trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/** Immutable update: returns a new entity with `updatedAt` bumped. */
export function patchEntity<E extends AnyEntity>(entity: E, patch: Partial<Omit<E, 'id' | 'kind' | 'meta'>>): E {
  const next = { ...entity, ...patch } as E
  if (patch.tags) next.tags = uniqueTags(patch.tags as Tag[])
  next.meta = { ...entity.meta, updatedAt: now() }
  return next
}

export function withTag<E extends AnyEntity>(entity: E, tag: Tag): E {
  return entity.tags.includes(tag) ? entity : patchEntity(entity, { tags: [...entity.tags, tag] } as Partial<E>)
}

export function withoutTag<E extends AnyEntity>(entity: E, tag: Tag): E {
  return entity.tags.includes(tag)
    ? patchEntity(entity, { tags: entity.tags.filter((t) => t !== tag) } as Partial<E>)
    : entity
}

export const displayLabel = (e: AnyEntity): string => e.label?.trim() || e.id

/**
 * A name from the data made safe to show inside a sentence of ours — a confirmation, a line of the assistant's
 * context: one line, no control characters, no direction overrides or isolates (U+202A–202E, U+2066–2069) that
 * would make the words after it read backwards, no zero-width or other invisible characters, at most `max`
 * characters (an ellipsis says it was cut). A label is anyone's text: a bundle can name an entity
 * "x” and 4,000 others? Yes deletes only the one" — unbounded and raw, it can rewrite the question it sits in.
 */
export function oneLineLabel(text: string, max = 80): string {
  const flat = String(text ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/[\p{Default_Ignorable_Code_Point}‪-‮⁦-⁩]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** `oneLineLabel` in quotation marks, for a question that names something; a quotation mark inside it is straightened so it cannot end the quote. */
export const quoteLabel = (text: string, max = 80): string => `“${oneLineLabel(text, max).replace(/[“”]/g, '"')}”`

/** Accepts tags as an array, JSON array string, or comma-separated string. */
export function parseTags(raw: unknown): Tag[] {
  if (Array.isArray(raw)) return uniqueTags(raw.map(String))
  if (typeof raw !== 'string') return []
  const s = raw.trim()
  if (!s) return []
  try {
    const parsed: unknown = JSON.parse(s)
    if (Array.isArray(parsed)) return uniqueTags(parsed.map(String))
  } catch {
    /* not JSON — fall through to CSV */
  }
  return uniqueTags(s.split(','))
}
