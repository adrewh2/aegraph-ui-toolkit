import type { ComponentType } from 'react'

/**
 * Categories group entity *types* by how their data is used. They are a
 * property of the type (via its definition or a `schema:type` entity), never
 * of the entity itself, so the wire format stays a bare `type` string.
 *
 * The test for placing a type is what opening one of its entities does:
 * read, watch or edit a body → `resource`; look up a record of something the
 * sources are about → `knowledge`; see an arrangement of other entities →
 * `project` (views); describe a type itself → `schema`. Each category's
 * `test` says this in a sentence for the places that let people choose.
 */
export type TypeCategory = 'resource' | 'knowledge' | 'project' | 'schema'

export interface CategoryInfo {
  id: TypeCategory
  label: string
  pluralLabel: string
  description: string
  /** The one-line rule for whether a type belongs here — the question to ask of one of its entities. */
  test: string
  /** Where instances of this category are browsed. */
  path: string
  icon?: ComponentType<{ size?: number }>
}

export const CATEGORIES: Record<TypeCategory, CategoryInfo> = {
  resource: {
    id: 'resource',
    label: 'Resource',
    pluralLabel: 'Resources',
    description: 'Artifacts people read, watch, and edit: webpages, documents, annotations, videos, notes.',
    test: 'Opening one shows a body to read, watch or edit — text, pixels, frames, audio, a map, a chat. The body is the truth; the fields describe it. Sources of evidence.',
    path: '/entities?category=resource',
  },
  knowledge: {
    id: 'knowledge',
    label: 'Knowledge',
    pluralLabel: 'Knowledge',
    description: 'Domain entities and their vocabulary: people, works, fields, concepts — whatever the data is about. Open-ended; unregistered types land here.',
    test: 'Opening one shows a record — fields and links, no body. It exists because sources are about it: a person, a topic, a claim, a place. Referents.',
    path: '/entities?category=knowledge',
  },
  project: {
    id: 'project',
    label: 'Project',
    pluralLabel: 'Project',
    description: 'What a project holds beyond its data: graph views and their filters, layouts and styles, scenes, plots, analyses, workstations, scripts — and the projects themselves. Views are data too.',
    test: 'Opening one arranges a screen — which entities, how filtered, placed, styled or charted. It says nothing about the world, only how to look at other entities.',
    path: '/entities?category=project',
  },
  schema: {
    id: 'schema',
    label: 'Schema',
    pluralLabel: 'Schema',
    description: 'Type definitions: a label, category, parent, and color per type, so vocabulary travels with the data.',
    test: 'It describes a type, not a thing: label, category, parent, colour, properties. Vocabulary.',
    path: '/entities?category=types',
  },
}

export const CATEGORY_ORDER: TypeCategory[] = ['resource', 'knowledge', 'project', 'schema']

/** The category `graph` was called before it was `project` (saved type definitions and older bundles still say so). */
export const LEGACY_CATEGORY: Record<string, TypeCategory> = { graph: 'project' }
export const normalizeCategory = (c: unknown): TypeCategory | undefined => (typeof c === 'string' ? (LEGACY_CATEGORY[c] ?? (c in CATEGORIES ? (c as TypeCategory) : undefined)) : undefined)

/** The entity type used to persist a type definition. */
export const SCHEMA_TYPE = 'schema:type'
export const schemaTypeId = (typeName: string) => `type:${typeName}`
