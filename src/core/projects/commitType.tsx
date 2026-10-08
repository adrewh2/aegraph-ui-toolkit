import { GitCommitHorizontal } from 'lucide-react'
import { defineEntityType, type EntityTypeDef } from '../entity/schema'
import { COMMIT_TYPE } from './versioning'

/** The `project:commit` type: a point in a project's history (see `versioning.ts`). Registered by importing this module. */
export const commitType: EntityTypeDef = defineEntityType({
  type: COMMIT_TYPE,
  label: 'Commit',
  pluralLabel: 'Commits',
  category: 'project',
  icon: GitCommitHorizontal,
  color: '#6b7280',
  description: "A point in a project's history: a message, the commit before it, and what changed — the entities added, modified and removed, kept as content in the browser's history store. The newest is the project's HEAD; the difference between HEAD and the project is its unsaved changes.",
  fields: [
    { key: 'data.message', label: 'Message', kind: 'text', width: 320 },
    { key: 'data.project', label: 'Project', kind: 'ref', width: 160 },
    { key: 'data.parent', label: 'Parent', kind: 'ref', width: 160 },
    { key: 'data.at', label: 'When', kind: 'datetime', width: 150 },
    { key: 'data.size', label: 'Entities', kind: 'number', width: 90 },
    { key: 'data.stats', label: 'Changes', kind: 'json', width: 160, format: (v) => (v && typeof v === 'object' ? `+${(v as { added: number }).added} ~${(v as { modified: number }).modified} −${(v as { removed: number }).removed}` : '') },
    { key: 'data.auto', label: 'Autosave', kind: 'boolean', width: 80 },
  ],
})
