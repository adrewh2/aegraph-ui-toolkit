import { createEntity, displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type AnyEntity, type Entity, type EntityId } from '../../core/entity/types'
import { annotationsOf, createAnnotation, type TargetAnnotation } from '../../core/resources/annotations'
import { RESOURCE_TYPES, type AnnotationData, type DocumentData } from '../../core/resources/types'
import { downloadText } from '../../lib/download'
import { isOwnFunction, isRemoteUrl } from '../../lib/markdown'

/**
 * Document helpers shared by the Documents view. Documents are ordinary
 * entities of type `document`; folders are documents whose extension is
 * `folder`. Hierarchy is `data.parentId` — a plain id, kept on the child.
 */

export type DocumentEntity = Entity<DocumentData>

export const FOLDER = 'folder'
export const TEXT_EXTENSIONS = ['md', 'txt'] as const
export type TextExtension = (typeof TEXT_EXTENSIONS)[number]

export const isDocument = (e: AnyEntity | undefined): e is DocumentEntity => !!e && !isRelationship(e) && e.type === RESOURCE_TYPES.document
export const extOf = (e: AnyEntity): string => String(e.data.extension ?? '')
export const isFolder = (e: AnyEntity): boolean => isDocument(e) && extOf(e) === FOLDER
export const isTextDocument = (e: AnyEntity): boolean => (TEXT_EXTENSIONS as readonly string[]).includes(extOf(e))
export const isPdf = (e: AnyEntity): boolean => extOf(e) === 'pdf'
export const parentOf = (e: AnyEntity): EntityId | undefined => (typeof e.data.parentId === 'string' && e.data.parentId ? e.data.parentId : undefined)
export const contentOf = (e: AnyEntity): string => (typeof e.data.content === 'string' ? e.data.content : '')

export const allDocuments = (store: EntityStore): DocumentEntity[] => store.ofType(RESOURCE_TYPES.document).filter(isDocument)

export function filenameOf(e: AnyEntity): string {
  // Reserved characters become dashes; a label made only of them (or of nothing) is "untitled".
  const base = displayLabel(e).replace(/[\\/:*?"<>|]+/g, '-').trim().replace(/^-+$/, '') || 'untitled'
  const ext = extOf(e)
  return ext && ext !== FOLDER && !base.toLowerCase().endsWith(`.${ext}`) ? `${base}.${ext}` : base
}

// ── Tree ───────────────────────────────────────────────────────────────

export interface DocNode {
  entity: DocumentEntity
  children: DocNode[]
  depth: number
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export const compareDocs = (a: AnyEntity, b: AnyEntity) => {
  const fa = isFolder(a) ? 0 : 1
  const fb = isFolder(b) ? 0 : 1
  return fa - fb || collator.compare(displayLabel(a), displayLabel(b))
}

/** Folders first, then by label. Children whose parent is missing become roots. */
export function buildTree(docs: DocumentEntity[]): DocNode[] {
  const ids = new Set(docs.map((d) => d.id))
  const byParent = new Map<EntityId | undefined, DocumentEntity[]>()
  for (const d of docs) {
    const p = parentOf(d)
    const key = p && ids.has(p) && p !== d.id ? p : undefined
    let list = byParent.get(key)
    if (!list) byParent.set(key, (list = []))
    list.push(d)
  }
  const seen = new Set<EntityId>()
  const build = (parent: EntityId | undefined, depth: number): DocNode[] =>
    (byParent.get(parent) ?? [])
      .filter((d) => !seen.has(d.id) && seen.add(d.id))
      .sort(compareDocs)
      .map((entity) => ({ entity, depth, children: isFolder(entity) ? build(entity.id, depth + 1) : [] }))
  const roots = build(undefined, 0)
  // Anything unreachable (a cycle of parentIds) still shows up at the root.
  for (const d of docs) {
    if (seen.has(d.id)) continue
    seen.add(d.id)
    roots.push({ entity: d, depth: 0, children: [] })
  }
  return roots
}

export function flatten(nodes: DocNode[], expanded: (id: EntityId) => boolean): DocNode[] {
  const out: DocNode[] = []
  const walk = (list: DocNode[]) => {
    for (const n of list) {
      out.push(n)
      if (n.children.length && expanded(n.entity.id)) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/** Ids of every folder above `id`, nearest first. Stops on cycles. */
export function ancestorsOf(store: EntityStore, id: EntityId): EntityId[] {
  const out: EntityId[] = []
  const seen = new Set<EntityId>([id])
  let cur = store.get(id)
  while (cur) {
    const p = parentOf(cur)
    if (!p || seen.has(p)) break
    seen.add(p)
    out.push(p)
    cur = store.get(p)
  }
  return out
}

/** Every document nested under `id`, at any depth. */
export function descendantsOf(store: EntityStore, id: EntityId): DocumentEntity[] {
  const out: DocumentEntity[] = []
  const seen = new Set<EntityId>([id])
  const docs = allDocuments(store)
  const walk = (parent: EntityId) => {
    for (const d of docs) {
      if (parentOf(d) === parent && !seen.has(d.id)) {
        seen.add(d.id)
        out.push(d)
        if (isFolder(d)) walk(d.id)
      }
    }
  }
  walk(id)
  return out
}

/** The name a document gets until it is given one; the editor shows it as the title field's placeholder, not as text to delete. */
export const UNTITLED = 'Untitled'

// ── Mutations ──────────────────────────────────────────────────────────

export function createDocument(
  store: EntityStore,
  init: { label?: string; extension?: string; parentId?: EntityId; content?: string; tags?: string[]; data?: Partial<DocumentData>; source?: string },
): DocumentEntity {
  const extension = init.extension ?? 'md'
  const label = init.label?.trim() || (extension === FOLDER ? 'New folder' : UNTITLED)
  const e = createEntity<DocumentData>({
    type: RESOURCE_TYPES.document,
    label,
    tags: init.tags,
    data: {
      extension,
      ...(extension === FOLDER || extension === 'pdf' ? {} : { content: init.content ?? '' }),
      ...(init.parentId ? { parentId: init.parentId } : {}),
      ...init.data,
    },
    meta: { source: init.source ?? 'user', accessedAt: new Date().toISOString() },
  })
  store.upsert(e)
  return e
}

export function duplicateDocument(store: EntityStore, e: DocumentEntity): DocumentEntity {
  const copy = createEntity<DocumentData>({
    type: RESOURCE_TYPES.document,
    label: `${displayLabel(e)} (copy)`,
    description: e.description,
    tags: e.tags,
    data: { ...e.data },
    meta: { source: 'user', derivedFrom: { id: e.id } },
  })
  store.upsert(copy)
  if (isFolder(e)) {
    // Copy the subtree too, remapping parent ids.
    const map = new Map<EntityId, EntityId>([[e.id, copy.id]])
    const batch: AnyEntity[] = []
    const walk = (from: EntityId) => {
      for (const child of allDocuments(store).filter((d) => parentOf(d) === from).sort(compareDocs)) {
        const c = createEntity<DocumentData>({ type: RESOURCE_TYPES.document, label: child.label, tags: child.tags, data: { ...child.data, parentId: map.get(from)! }, meta: { source: 'user', derivedFrom: { id: child.id } } })
        map.set(child.id, c.id)
        batch.push(c)
        if (isFolder(child)) walk(child.id)
      }
    }
    walk(e.id)
    store.upsertMany(batch)
  }
  return copy
}

/** Returns false (and does nothing) when the move would create a cycle. */
export function moveDocument(store: EntityStore, id: EntityId, parentId: EntityId | undefined): boolean {
  const e = store.get(id)
  if (!isDocument(e)) return false
  if (parentId) {
    if (parentId === id) return false
    const target = store.get(parentId)
    if (!target || !isFolder(target)) return false
    if (ancestorsOf(store, parentId).includes(id)) return false
  }
  if (parentOf(e) === parentId) return true
  const data = { ...e.data }
  if (parentId) data.parentId = parentId
  else delete data.parentId
  store.update(id, { data })
  return true
}

/** Deletes a document; folders take their contents with them. Returns removed ids. */
export function deleteDocument(store: EntityStore, id: EntityId): EntityId[] {
  const ids = [id, ...descendantsOf(store, id).map((d) => d.id)]
  store.remove(ids)
  return ids
}

// ── Import / export ────────────────────────────────────────────────────

export const IMPORT_ACCEPT = '.md,.markdown,.txt,.text,.pdf,text/markdown,text/plain,application/pdf'
/** Inline PDFs are stored as data: URLs, so cap them to keep the store (and JSON exports) sane. */
export const MAX_INLINE_PDF_BYTES = 15 * 1024 * 1024

export async function importFile(store: EntityStore, file: File, parentId?: EntityId): Promise<DocumentEntity> {
  const name = file.name
  const dot = name.lastIndexOf('.')
  const rawExt = (dot >= 0 ? name.slice(dot + 1) : '').toLowerCase()
  const label = dot > 0 ? name.slice(0, dot) : name
  if (rawExt === 'pdf' || file.type === 'application/pdf') {
    if (file.size > MAX_INLINE_PDF_BYTES) throw new Error(`PDF is ${(file.size / 1024 / 1024).toFixed(1)} MB; inline PDFs are capped at ${MAX_INLINE_PDF_BYTES / 1024 / 1024} MB. Register it by URL instead.`)
    const dataUrl = await readAsDataUrl(file)
    return createDocument(store, { label, extension: 'pdf', parentId, data: { dataUrl }, source: 'import:file' })
  }
  const extension = rawExt === 'markdown' || rawExt === 'md' ? 'md' : 'txt'
  const content = await file.text()
  return createDocument(store, { label, extension, parentId, content, source: 'import:file' })
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('Could not read file'))
    r.readAsDataURL(file)
  })
}

export function downloadDocument(e: DocumentEntity) {
  if (isPdf(e)) {
    const url = pdfUrl(e)
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = filenameOf(e)
    a.target = '_blank'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    return
  }
  downloadText(filenameOf(e), contentOf(e), extOf(e) === 'md' ? 'text/markdown' : 'text/plain')
}

/**
 * Where a PDF's bytes are, when they can be shown: the PDF itself inline (`data:application/pdf`), a `blob:`, a path
 * on this origin ending in `.pdf`, or an http(s) URL. The address is data — it arrives in a bundle or from a tool —
 * and it is loaded into a frame that cannot be sandboxed (the browser's PDF viewer refuses a sandboxed frame), so
 * anything else, `data:text/html` or `javascript:` above all, is not a PDF here. A file read with no type is
 * `data:application/octet-stream`, which a frame downloads rather than renders — whatever it holds: it is taken
 * only when its bytes start as a PDF does (`%PDF-`), and given back typed as one. The site's own functions
 * (`/api/…`, `isOwnFunction`) are never a PDF's address: `/api/fetch.pdf?url=…` would have the dev server fetch
 * any address the moment the document opened.
 */
export function pdfSrc(u: unknown): string | undefined {
  if (typeof u !== 'string') return undefined
  const s = u.trim()
  if (/^data:application\/pdf[;,]/i.test(s) || /^blob:/i.test(s)) return s
  // `JVBERi0` is `%PDF-` in base64.
  const untyped = /^data:application\/octet-stream(;[^,]*)?;base64,(?=JVBERi0)/i.exec(s)
  if (untyped) return `data:application/pdf;base64,${s.slice(untyped[0].length)}`
  if (/^https?:\/\//i.test(s)) return isOwnFunction(s) ? undefined : s
  // A path on this origin: no backslash or whitespace, which the URL parser would read as `//another.host`.
  if (/^\/(?!\/)[^?#\\\s]*\.pdf([?#].*)?$/i.test(s) && !isOwnFunction(s)) return s
  return undefined
}

export const pdfUrl = (e: AnyEntity): string | undefined => pdfSrc(e.data.dataUrl) ?? pdfSrc(e.data.sourceUrl)

/**
 * Whether a PDF may be framed as soon as its document opens: the PDF itself (`data:`), a `blob:` of this page, or a
 * file on this origin. One on another host waits for a click naming the host (`PdfViewer`): its frame cannot be
 * sandboxed — Chrome's and Firefox's PDF viewers refuse to render inside one — and loading it tells that host the
 * document was opened, with whatever its URL carries.
 */
export const pdfFramesAtOnce = (src: string): boolean => !isRemoteUrl(src)

// ── Annotations ────────────────────────────────────────────────────────

export type DocAnnotation = TargetAnnotation
export { annotationsOf }

/** Creates an annotation entity plus the `annotates` relationship with a text-quote selector. */
export function annotateDocument(
  store: EntityStore,
  doc: DocumentEntity,
  sel: { exact: string; prefix?: string; suffix?: string },
  comment: string,
  tags: string[] = [],
): Entity<AnnotationData> {
  const exact = sel.exact
  return createAnnotation(
    store,
    doc.id,
    { kind: 'text', exact, ...(sel.prefix ? { prefix: sel.prefix } : {}), ...(sel.suffix ? { suffix: sel.suffix } : {}) },
    { comment, tags, label: comment.trim().slice(0, 60) || exact.slice(0, 60), annotationType: 'text', data: { selectedText: exact } },
  )
}

/** Context around a selection so the quote can be re-anchored if the text moves. */
export function quoteContext(text: string, start: number, end: number, span = 32): { exact: string; prefix?: string; suffix?: string } {
  return {
    exact: text.slice(start, end),
    prefix: start > 0 ? text.slice(Math.max(0, start - span), start) : undefined,
    suffix: end < text.length ? text.slice(end, Math.min(text.length, end + span)) : undefined,
  }
}

// ── Stats ──────────────────────────────────────────────────────────────

export function textStats(text: string) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const chars = text.length
  const lines = text ? text.split('\n').length : 0
  const minutes = Math.max(1, Math.round(words / 220))
  return { words, chars, lines, minutes }
}

/**
 * The title is its own field on the document page, so a leading `# Title`
 * that just repeats it is dropped from the body on load (older documents
 * were seeded that way).
 */
export function stripTitleHeading(md: string, label: string | undefined): string {
  const m = /^#\s+(.+?)\s*\n+/.exec(md)
  return m && label && m[1].trim() === label.trim() ? md.slice(m[0].length) : md
}
