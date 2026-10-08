import { ChevronDown, Plus } from 'lucide-react'
import { useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { isRelationship } from '../../core/entity/types'
import { CreateDialog, type CreateKind } from '../resources/CreateDialogs'
import { categoryHref, typeHref } from '../../app/routes'
import { browserHref } from '../../app/openIn'
import { CATEGORY_ORDER, type TypeCategory } from '../../core/entity/categories'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { TypesView, useTypeCounts } from '../knowledge/TypesView'
import { GRAPH_CAPABILITIES, RESOURCE_CAPABILITIES } from '../resources/capabilities'
import { EntityBrowser } from '../resources/EntityBrowser'
import { TagsView } from '../resources/TagsView'
import { CategoryRail, sectionFromParam, type Section } from './CategoryRail'
import '../resources/ResourcesView.css'
import './EntitiesView.css'

/**
 * `/entities` — everything in the store on one page. The rail's sections
 * pick what the table shows: every entity (by category and type), the
 * relationships between them, the types they use, or the tags on them.
 * `?category=` names the section; nothing here is a separate route.
 */

const RESOURCE_ACTIONS = [
  { label: 'Note', kind: 'note' as const },
  { label: 'Webpage', kind: 'webpage' as const },
  { label: 'Annotation', kind: 'annotation' as const },
  { label: 'Document (.md / .txt)', kind: 'document' as const },
  { label: 'PDF from URL', kind: 'pdf' as const },
  { label: 'Image from URL', kind: 'image' as const },
  { label: 'Video from URL', kind: 'video' as const },
]
const ENTITY_ACTION = { label: 'Entity', kind: 'entity' as const }

/** One line under the title, specific to the section in view. */
const SUBTITLES: Record<Section, string> = {
  all: 'Everything in the workspace, by category and type.',
  resource: 'What people read, watch, annotate and edit: documents, images, videos, audio, webpages, notes.',
  knowledge: 'What the resources are about: people, organizations, concepts, claims — any type, defined or emergent.',
  project: 'What a project holds beyond its data: graph views and their filters, layouts and styles, scenes, plots, analyses, workstations, scripts — and the projects themselves.',
  relationships: 'Every link in the workspace. A relationship is itself an entity — it can carry a type, tags and data.',
  types: 'The vocabulary: every type in use or defined, with its category, parent and colour.',
  tags: 'Flat labels on any entity, across every category.',
  schema: 'The vocabulary: every type in use or defined, with its category, parent and colour.',
}

export function EntitiesView() {
  const [params] = useSearchParams()
  const section = sectionFromParam(params.get('category'))
  if (section === 'types') return <TypesSection />
  if (section === 'tags')
    return (
      <Framed section="tags" subtitle={SUBTITLES.tags} note="Colour and description are optional metadata. Open a tag to see everything carrying it.">
        <TagsSection />
      </Framed>
    )
  return (
    <EntityBrowser
      category="all"
      categorySwitch
      layout="facets"
      basePath="/entities"
      title="Entities"
      subtitle={SUBTITLES[section]}
      newActions={[ENTITY_ACTION, ...RESOURCE_ACTIONS]}
      newActionsByCategory={{ resource: RESOURCE_ACTIONS, knowledge: [ENTITY_ACTION], project: [], all: section === 'relationships' ? [] : [ENTITY_ACTION, ...RESOURCE_ACTIONS] }}
      capabilities={{ ...RESOURCE_CAPABILITIES, ...GRAPH_CAPABILITIES }}
    />
  )
}

/** The page frame the browser draws, for the sections that aren't the entity table: same head, same rail, another table. */
function TypesSection() {
  const counts = useTypeCounts()
  return (
    <Framed section="types" subtitle={SUBTITLES.types} note={`${counts.entity} entity types, ${counts.relationship} relationship types; ${counts.builtIn} are built into aegraph-ui (see “Defined by”) and can be customised but not removed. Definitions are entities too, so they export with the data.`}>
      <TypesView embedded />
    </Framed>
  )
}

function Framed({ section, subtitle, note, children }: { section: 'types' | 'tags'; subtitle: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="res">
      <div className="res__head">
        <div>
          <h1 className="page-title">Entities</h1>
          <p className="page-subtitle">{note ?? subtitle}</p>
        </div>
        <div className="res__head-actions">
          <NewButton first={section === 'types' ? 'type' : 'tag'} />
        </div>
      </div>
      <div className="res__body">
        <aside className="res__facets">
          <CategoryRail current={section} />
        </aside>
        <div className="res__table ent__section">{children}</div>
      </div>
    </div>
  )
}

function TagsSection() {
  const navigate = useNavigate()
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  /** Tags span categories; open the table on whichever category holds most of the tagged entities. */
  const bestCategory = (tag: string): TypeCategory => {
    const counts = new Map<TypeCategory, number>()
    for (const e of store.withTag(tag)) {
      if (e.kind !== 'entity') continue
      const c = registry.categoryOf(e.type)
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    return CATEGORY_ORDER.reduce((best, c) => ((counts.get(c) ?? 0) > (counts.get(best) ?? 0) ? c : best), 'knowledge' as TypeCategory)
  }
  return (
    <>
      <TagsView onFilter={(t) => navigate(`${categoryHref(bestCategory(t))}&tag=${encodeURIComponent(t)}`)} onAdd={() => setAdding(true)} />
      <CreateDialog
        kind={adding ? 'tag' : null}
        onClose={() => setAdding(false)}
        onCreated={(e) => {
          setAdding(false)
          toast(`Created tag “${e.label}”`)
        }}
      />
    </>
  )
}

/** Old URLs: `/resources[/:type]`, `/knowledge[/relationships|/types]`, `/tags`, and the short-lived `/entities/<section>`. */
export function LegacyBrowserRedirect({ category, section }: { category?: TypeCategory; section?: 'relationships' | 'types' | 'tags' }) {
  const { tab } = useParams()
  const [params] = useSearchParams()
  const registry = useTypeRegistry()
  const rest = new URLSearchParams(params)
  const type = tab && tab !== 'all' ? tab : (rest.get('type') ?? undefined)
  rest.delete('type')
  const want = section ?? (type === 'relationships' ? 'relationships' : type === 'tags' ? 'tags' : undefined)
  if (want) {
    rest.set('category', want)
    if (section && type) rest.set('type', type)
    return <Navigate to={`/entities?${rest}`} replace />
  }
  const cat = type ? registry.categoryOf(type) : (category ?? 'knowledge')
  const base = type ? typeHref(type, cat) : categoryHref(category ?? 'all')
  const tail = rest.toString() ? (base.includes('?') ? `&${rest}` : `?${rest}`) : ''
  return <Navigate to={base + tail} replace />
}

const SIMPLE_KINDS: { kind: CreateKind; label: string }[] = [
  { kind: 'entity', label: 'Knowledge entity…' },
  { kind: 'type', label: 'Type…' },
  { kind: 'tag', label: 'Tag…' },
  { kind: 'relationship', label: 'Relationship…' },
]

/** The New menu for the Types and Tags sections: what fits the section first, then everything else. */
function NewButton({ first }: { first: CreateKind }) {
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  const [creating, setCreating] = useState<CreateKind | null>(null)
  const navigate = useNavigate()
  const toast = useToast()
  const registry = useTypeRegistry()
  const items: MenuItem[] = [
    ...SIMPLE_KINDS.filter((k) => k.kind === first).map<MenuItem>((k) => ({ kind: 'item', label: k.label, onSelect: () => setCreating(k.kind) })),
    { kind: 'sep' },
    ...SIMPLE_KINDS.filter((k) => k.kind !== first).map<MenuItem>((k) => ({ kind: 'item', label: k.label, onSelect: () => setCreating(k.kind) })),
    { kind: 'sep' },
    { kind: 'label', label: 'Resources' },
    ...RESOURCE_ACTIONS.map<MenuItem>((a) => ({ kind: 'item', label: a.label, onSelect: () => setCreating(a.kind) })),
  ]
  return (
    <>
      <button className="btn btn--primary" onClick={(e) => setMenu(menu ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget })}>
        <Plus size={14} /> New <ChevronDown size={13} />
      </button>
      {menu && <Menu x={menu.x} y={menu.y} items={items} anchor={menu.anchor} onClose={() => setMenu(null)} />}
      <CreateDialog
        kind={creating}
        onClose={() => setCreating(null)}
        onCreated={(e) => {
          setCreating(null)
          if (e.type === 'tag') toast(`Created tag “${e.label}”`)
          else if (e.type === 'schema:type') {
            toast(`Defined type “${e.label}”`)
            navigate(`/entities?category=types&type=${encodeURIComponent(String(e.data.name))}`)
          } else {
            toast(`Created ${isRelationship(e) ? 'relationship' : registry.get(e.type).label.toLowerCase()}`)
            navigate(browserHref(e, registry))
          }
        }}
      />
    </>
  )
}
