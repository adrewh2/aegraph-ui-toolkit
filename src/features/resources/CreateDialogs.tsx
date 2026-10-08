import { useMemo, useState } from 'react'
import { Dialog } from '../../components/ui/Dialog'
import { importImageUrl } from '../images/images'
import { importYouTube } from '../videos/videos'
import { useToast } from '../../components/ui/useToast'
import { createEntity, createRelationship, parseTags } from '../../core/entity/entity'
import { EntityPicker } from '../../components/ui/EntityPicker'
import { PropertyInput } from '../../components/ui/PropertyInput'
import { fieldPatch, inferFieldsFromEntities, type FieldDef } from '../../core/entity/schema'
import { AnnotateDialog } from './AnnotateDialog'
import { useEntityStore } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import {
  RELATIONSHIP_TYPES,
  RESOURCE_TYPES,
  type DocumentData,
  type WebpageData,
} from '../../core/resources/types'
import { useTypeRegistry } from '../../core/entity/hooks'
import { GRAPH_TYPES, type LayoutData, type ViewData } from '../../core/graph/types'
import { Select } from '../../components/ui/Select'
import { NewTypeDialog } from '../ontology/TypeEditor'

export type CreateKind = 'note' | 'webpage' | 'annotation' | 'document' | 'pdf' | 'image' | 'video' | 'relationship' | 'entity' | 'type' | 'tag' | 'layout' | 'view'

interface Props {
  kind: CreateKind | null
  onClose: () => void
  onCreated: (entity: AnyEntity) => void
  /** Pre-select a target for annotations / relationships. */
  targetId?: EntityId
  /** Pre-select a type for generic entities. */
  defaultType?: string
}

export function CreateDialog({ kind, onClose, onCreated, targetId, defaultType }: Props) {
  if (!kind) return null
  const common = { onClose, onCreated }
  switch (kind) {
    case 'entity':
      return <EntityDialog {...common} defaultType={defaultType} />
    case 'type':
      return <NewTypeDialog onClose={onClose} onCreated={onCreated} />
    case 'tag':
      return <TagDialog {...common} />
    case 'layout':
      return <GraphDialog {...common} kind="layout" />
    case 'view':
      return <GraphDialog {...common} kind="view" />
    case 'note':
      return <NoteDialog {...common} />
    case 'webpage':
      return <WebpageDialog {...common} />
    case 'annotation':
      return <AnnotationDialog {...common} targetId={targetId} />
    case 'document':
      return <DocumentDialog {...common} />
    case 'pdf':
      return <PdfDialog {...common} />
    case 'image':
      return <ImageDialog {...common} />
    case 'video':
      return <VideoDialog {...common} />
    case 'relationship':
      return <RelationshipDialog {...common} sourceId={targetId} />
  }
}

type DialogProps = { onClose: () => void; onCreated: (e: AnyEntity) => void }

function Footer({ onClose, onSubmit, label, busy, disabled }: { onClose: () => void; onSubmit: () => void; label: string; busy?: boolean; disabled?: boolean }) {
  return (
    <>
      <button className="btn" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button className="btn btn--primary" onClick={onSubmit} disabled={busy || disabled}>
        {busy ? 'Working…' : label}
      </button>
    </>
  )
}

function TagsField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label>Tags (comma separated)</label>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder="research, todo" />
    </div>
  )
}

function NoteDialog({ onClose, onCreated }: DialogProps) {
  const store = useEntityStore()
  const [label, setLabel] = useState('')
  const [text, setText] = useState('')
  const [tags, setTags] = useState('')
  const submit = () => {
    const e = createEntity({ type: RESOURCE_TYPES.note, label: label.trim() || 'Untitled note', tags: parseTags(tags), data: { text }, meta: { source: 'user' } })
    store.upsert(e)
    onCreated(e)
  }
  return (
    <Dialog open title="New note" description="The simplest entity: a label and some text." onClose={onClose} footer={<Footer onClose={onClose} onSubmit={submit} label="Create" />}>
      <div className="field">
        <label>Label</label>
        <input className="input" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <div className="field">
        <label>Text</label>
        <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <TagsField value={tags} onChange={setTags} />
    </Dialog>
  )
}

function WebpageDialog({ onClose, onCreated }: DialogProps) {
  const store = useEntityStore()
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      setError('Enter a valid URL, including https://')
      return
    }
    const e = createEntity<WebpageData>({
      type: RESOURCE_TYPES.webpage,
      label: title.trim() || parsed.hostname + parsed.pathname,
      tags: parseTags(tags),
      data: { url: parsed.toString(), hasHtml: false, hasScreenshot: false },
      meta: { source: 'user' },
    })
    store.upsert(e)
    onCreated(e)
  }
  return (
    <Dialog open title="Save webpage" description="Captured HTML and screenshots arrive via the browser extension; here we just record the reference." onClose={onClose} footer={<Footer onClose={onClose} onSubmit={submit} label="Save" disabled={!url.trim()} />}>
      <div className="field">
        <label>URL</label>
        <input className="input" autoFocus type="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <div className="field">
        <label>Title (optional)</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <TagsField value={tags} onChange={setTags} />
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  )
}

function AnnotationDialog({ onClose, onCreated, targetId }: DialogProps & { targetId?: EntityId }) {
  return <AnnotateDialog targetId={targetId} onClose={onClose} onCreated={onCreated} />
}

function DocumentDialog({ onClose, onCreated }: DialogProps) {
  const store = useEntityStore()
  const [title, setTitle] = useState('Untitled')
  const [ext, setExt] = useState<'md' | 'txt'>('md')
  const [tags, setTags] = useState('')
  const submit = () => {
    const e = createEntity<DocumentData>({
      type: RESOURCE_TYPES.document,
      label: title.trim() || 'Untitled',
      tags: parseTags(tags),
      data: { extension: ext, content: ext === 'md' ? `# ${title.trim() || 'Untitled'}\n` : '' },
      meta: { source: 'user' },
    })
    store.upsert(e)
    onCreated(e)
  }
  return (
    <Dialog open title="New document" onClose={onClose} footer={<Footer onClose={onClose} onSubmit={submit} label="Create" />}>
      <div className="field">
        <label>Title</label>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onFocus={(e) => e.target.select()} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <div className="field">
        <label>Format</label>
        <Select className="input" value={ext} onChange={(e) => setExt(e.target.value as 'md' | 'txt')}>
          <option value="md">Markdown (.md)</option>
          <option value="txt">Plain text (.txt)</option>
        </Select>
      </div>
      <TagsField value={tags} onChange={setTags} />
    </Dialog>
  )
}

function PdfDialog({ onClose, onCreated }: DialogProps) {
  const store = useEntityStore()
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      setError('Enter a valid URL')
      return
    }
    const file = (parsed.pathname.split('/').pop() || '').replace(/\.pdf$/i, '')
    const e = createEntity<DocumentData>({
      type: RESOURCE_TYPES.document,
      label: title.trim() || file || `PDF ${new Date().toISOString().slice(0, 10)}`,
      data: { extension: 'pdf', sourceUrl: parsed.toString() },
      meta: { source: 'import:url' },
    })
    store.upsert(e)
    onCreated(e)
  }
  return (
    <Dialog open title="PDF from URL" description="Registers the PDF as a document entity. Fetching and storing the bytes is a backend concern and will be wired later." onClose={onClose} footer={<Footer onClose={onClose} onSubmit={submit} label="Create" disabled={!url.trim()} />}>
      <div className="field">
        <label>PDF URL</label>
        <input className="input" autoFocus type="url" placeholder="https://example.com/file.pdf" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <div className="field">
        <label>Title (optional)</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  )
}

function ImageDialog({ onClose, onCreated }: DialogProps) {
  const store = useEntityStore()
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    try {
      const e = await importImageUrl(store, url, title.trim() || undefined, { approved: true })
      onCreated(e)
    } catch {
      setError('Enter a valid image URL, including https://')
      setBusy(false)
    }
  }
  return (
    <Dialog open title="Image from URL" description="Registers the image as an entity; open it in Images to draw and annotate regions." onClose={onClose} footer={<Footer onClose={onClose} onSubmit={submit} label="Add" busy={busy} disabled={!url.trim()} />}>
      <div className="field">
        <label>Image URL</label>
        <input className="input" autoFocus type="url" placeholder="https://…/picture.png" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <div className="field">
        <label>Title (optional)</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  )
}

function VideoDialog({ onClose, onCreated }: DialogProps) {
  const store = useEntityStore()
  const toast = useToast()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    try {
      const { entity, existed, metadata } = await importYouTube(store, url)
      if (existed) toast('Already in the Library')
      else if (!metadata) toast('Imported without metadata (oEmbed unavailable)')
      onCreated(entity)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <Dialog open title="Import video" description="Paste a YouTube URL. Title and channel are fetched from the public oEmbed endpoint when available." onClose={onClose} footer={<Footer onClose={onClose} onSubmit={submit} label="Import" busy={busy} disabled={!url.trim()} />}>
      <div className="field">
        <label>YouTube URL</label>
        <input className="input" autoFocus type="url" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  )
}

function RelationshipDialog({ onClose, onCreated, sourceId }: DialogProps & { sourceId?: EntityId }) {
  const store = useEntityStore()
  const [source, setSource] = useState<EntityId | undefined>(sourceId)
  const [target, setTarget] = useState<EntityId | undefined>()
  const [type, setType] = useState<string>(RELATIONSHIP_TYPES.references)
  const [directed, setDirected] = useState(true)
  const [tags, setTags] = useState('')
  const submit = () => {
    if (!source || !target) return
    const r = createRelationship({ type: type.trim() || 'related', source, target, directed, tags: parseTags(tags), meta: { source: 'user' } })
    store.upsert(r)
    onCreated(r)
  }
  const types = [...new Set([...Object.values(RELATIONSHIP_TYPES), ...store.relationships().map((r) => r.type)])]
  return (
    <Dialog open title="New relationship" description="Relationships are entities: they carry a type, tags, and data of their own." onClose={onClose} footer={<Footer onClose={onClose} onSubmit={submit} label="Create" disabled={!source || !target} />}>
      <div className="field">
        <label>Source</label>
        <EntityPicker value={source} onChange={setSource} exclude={target} />
      </div>
      <div className="field">
        <label>Type</label>
        <input className="input" list="rel-types-dialog" value={type} onChange={(e) => setType(e.target.value)} />
        <datalist id="rel-types-dialog">
          {types.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
      <div className="field">
        <label>Target</label>
        <EntityPicker value={target} onChange={setTarget} exclude={source} />
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <input type="checkbox" checked={directed} onChange={(e) => setDirected(e.target.checked)} /> Directed (source → target)
      </label>
      <TagsField value={tags} onChange={setTags} />
    </Dialog>
  )
}

/** A knowledge entity of any type: label, type (existing or new), description, tags. */
const BASE_KEYS = new Set(['label', 'type', 'tags', 'description', 'id'])
const isBlank = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0)

function EntityDialog({ onClose, onCreated, defaultType }: DialogProps & { defaultType?: string }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const [label, setLabel] = useState('')
  const [type, setType] = useState(defaultType ?? '')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState('')
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [touched, setTouched] = useState(false)
  const known = registry.inCategory('knowledge')
  const t = type.trim()
  // Every field the type has so far: declared (code, parents, the data's own definitions) first, then any other
  // data.* key its existing entities carry — so a type that only exists in imported data still offers its fields.
  const fields = useMemo<FieldDef[]>(() => {
    if (!t) return []
    const declared = registry.fieldsFor(t).filter((f) => !BASE_KEYS.has(f.key) && !f.key.startsWith('meta.') && f.editable !== false)
    const known = new Set(declared.map((f) => f.key))
    const inferred = inferFieldsFromEntities(store.ofType(t)).filter((f) => !known.has(f.key) && f.kind !== 'json' && f.kind !== 'tags')
    return [...declared, ...inferred]
  }, [registry, store, t])
  const declaredCount = useMemo(() => (t ? registry.fieldsFor(t).filter((f) => !BASE_KEYS.has(f.key) && !f.key.startsWith('meta.') && f.editable !== false).length : 0), [registry, t])
  const missing = [...(label.trim() ? [] : ['label']), ...fields.filter((f) => f.required && isBlank(values[f.key])).map((f) => f.key)]
  const submit = () => {
    setTouched(true)
    if (missing.length) return
    const typeName = t || 'entity'
    let e = createEntity({ type: typeName, label: label.trim(), description: description.trim() || undefined, tags: parseTags(tags), meta: { source: 'user' } })
    for (const f of fields) if (!isBlank(values[f.key])) e = { ...e, ...fieldPatch(e, f.key, values[f.key]) } as typeof e
    store.upsert(e)
    onCreated(e)
  }
  const invalid = (key: string) => touched && missing.includes(key)
  return (
    <Dialog
      open
      wide={fields.length > 3}
      title={t ? `New ${registry.get(t).label.toLowerCase()}` : 'New entity'}
      description="Pick a type — or name a new one — and fill in its fields. Required fields are marked; the rest can be left for later."
      onClose={onClose}
      footer={<Footer onClose={onClose} onSubmit={submit} label="Create" disabled={touched && missing.length > 0} />}
    >
      <div className="field">
        <label>Type</label>
        <input className="input" list="entity-types" autoFocus={!defaultType} value={type} onChange={(e) => (setType(e.target.value), setValues({}))} placeholder="person, concept, field…" />
        <datalist id="entity-types">
          {known.map((k) => (
            <option key={k.type} value={k.type}>
              {k.label}
            </option>
          ))}
        </datalist>
      </div>
      <div className={`field ${invalid('label') ? 'is-invalid' : ''}`}>
        <label>
          Label <span className="field__req">required</span>
        </label>
        <input className="input" autoFocus={!!defaultType} value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {invalid('label') && <span className="error-text">A label is required.</span>}
      </div>
      {fields.length > 0 && (
        <div className="cd__fields">
          <div className="cd__fields-head muted">
            {registry.get(t).label} fields · {fields.filter((f) => f.required).length} required
            {fields.length > declaredCount ? ` · ${fields.length - declaredCount} seen on existing ${registry.get(t).pluralLabel.toLowerCase()}` : ''}
          </div>
          {fields.map((f) => (
            <div key={f.key} className={`field ${invalid(f.key) ? 'is-invalid' : ''}`}>
              <label>
                {f.label} <span className={f.required ? 'field__req' : 'field__opt'}>{f.required ? 'required' : 'optional'}</span>
              </label>
              <PropertyInput kind={f.kind} options={f.options} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} onEnter={submit} rows={3} />
              {invalid(f.key) && <span className="error-text">{f.label} is required.</span>}
            </div>
          ))}
        </div>
      )}
      <div className="field">
        <label>
          Description <span className="field__opt">optional</span>
        </label>
        <textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <TagsField value={tags} onChange={setTags} />
    </Dialog>
  )
}

/** A tag with colour and description. Tags are strings on entities; this records the metadata so the tag exists before anything carries it. */
function TagDialog({ onClose, onCreated }: DialogProps) {
  const store = useEntityStore()
  const [name, setName] = useState('')
  const [color, setColor] = useState('')
  const [description, setDescription] = useState('')
  const tag = name.trim()
  const submit = () => {
    if (!tag) return
    store.setTagInfo(tag, { ...(color ? { color } : {}), ...(description.trim() ? { description: description.trim() } : {}) })
    // Not an entity — hand back a stand-in the caller can name in its toast.
    onCreated({ id: `tag:${tag}`, kind: 'entity', type: 'tag', label: tag, tags: [], data: { tag }, meta: { createdAt: '', updatedAt: '' } })
  }
  return (
    <Dialog open title="New tag" onClose={onClose} footer={<Footer onClose={onClose} onSubmit={submit} label="Create" disabled={!tag} />}>
      <div className="field">
        <label>Tag</label>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. to-read, key-source" onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <div className="and__row">
        <div className="field">
          <label>Colour (optional)</label>
          <input className="input" type="color" value={color || '#dbe6f7'} onChange={(e) => setColor(e.target.value)} style={{ padding: 2, width: 60 }} />
        </div>
        <div className="field">
          <label>Description (optional)</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
    </Dialog>
  )
}

/** An empty layout or view; contents are filled in by graph tools. */
function GraphDialog({ onClose, onCreated, kind }: DialogProps & { kind: 'layout' | 'view' }) {
  const store = useEntityStore()
  const [label, setLabel] = useState('')
  const [tags, setTags] = useState('')
  const submit = () => {
    const e =
      kind === 'layout'
        ? createEntity<LayoutData>({ type: GRAPH_TYPES.layout, label: label.trim() || 'Untitled layout', tags: parseTags(tags), data: { positions: {}, algorithm: 'manual', dimensions: 2 }, meta: { source: 'user' } })
        : createEntity<ViewData>({ type: GRAPH_TYPES.view, label: label.trim() || 'Untitled view', tags: parseTags(tags), data: { renderer: 'force-2d', members: [] }, meta: { source: 'user' } })
    store.upsert(e)
    onCreated(e)
  }
  return (
    <Dialog open title={kind === 'layout' ? 'New layout' : 'New view'} description={kind === 'layout' ? 'A named set of positions. Entities get placed as you arrange them in a graph view.' : 'A saved arrangement of entities, layout, and rendering.'} onClose={onClose} footer={<Footer onClose={onClose} onSubmit={submit} label="Create" />}>
      <div className="field">
        <label>Label</label>
        <input className="input" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <TagsField value={tags} onChange={setTags} />
    </Dialog>
  )
}
