import { columnLabel, datasetEntity, inferColumnKind, isDataset } from '../../core/datasets/dataset'
import { DATASET_ACCEPT, datasetFileFormat, readDatasetFile, type Delimiter } from '../../core/datasets/files'
import { displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import type { EntityId } from '../../core/entity/types'
import { IMPORT_ACCEPT, importFile as importDocumentFile } from '../documents/documents'
import { IMAGE_ACCEPT, importImageFile } from '../images/images'

/**
 * Files put into a chat — picked, dropped or pasted into the composer. Each becomes an entity in the open project
 * when the message is sent, through the same importers the pages use: an image is an `image` (inline, as a data:
 * URL), a Markdown or PDF file a `document`, and a table — CSV, TSV, Excel, Parquet — a `dataset` (a workbook a
 * dataset per sheet), read by `core/datasets/files.ts` with its bounds. A text file is either: the composer asks,
 * when it is attached, whether it is a document or a dataset and, for a dataset, how its columns are separated. The
 * message then names what was made for the model by id, so it reaches each with its tools like anything else in the
 * project. Anything else is turned away before it is sent.
 */

export type AttachmentKind = 'image' | 'document' | 'dataset'

/** What a user message keeps of an attachment: the entity it became. The file itself stays in the entity. */
export interface Attachment {
  id: EntityId
  kind: AttachmentKind
  label: string
}

/** What a text file is taken as, once the person has said: a document, or a dataset split on a separator. */
export type TextChoice = { as: 'document' } | { as: 'dataset'; delimiter: Delimiter; header: boolean }

/** A file waiting to go with the next message; a text file carries the answer to "document or dataset?". */
export interface PendingFile {
  file: File
  choice?: TextChoice
}

/** The file picker's filter: what the chat takes. */
export const ATTACH_ACCEPT = `${IMAGE_ACCEPT},${IMPORT_ACCEPT},${DATASET_ACCEPT}`

const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'pdf'])

/**
 * Which kind of entity a file would become — `ask` for a text file, which may be either — or nothing when the chat
 * does not take it.
 */
export function attachmentKind(file: Pick<File, 'name' | 'type'>): AttachmentKind | 'ask' | undefined {
  if (file.type.startsWith('image/')) return 'image'
  const format = datasetFileFormat(file)
  if (format === 'txt') return 'ask'
  if (format) return 'dataset'
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (DOCUMENT_EXTENSIONS.has(ext) || file.type === 'application/pdf' || file.type === 'text/markdown' || file.type === 'text/plain') return 'document'
  return undefined
}

/** Whether a drag carries files (and not, say, a tab being moved between panes). */
export const dragHasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files')

export interface ImportedAttachments {
  attached: Attachment[]
  /** A sentence per file that could not be added (too large, unreadable, a text file nobody said how to read). */
  failed: string[]
}

const pendingOf = (f: File | PendingFile): PendingFile => (f instanceof File || !('file' in f) ? { file: f as File } : f)

/** The files as entities in the store (the open project), in order; a file that fails is reported, not fatal. */
export async function importAttachments(store: EntityStore, files: readonly (File | PendingFile)[]): Promise<ImportedAttachments> {
  const attached: Attachment[] = []
  const failed: string[] = []
  for (const item of files) {
    const { file, choice } = pendingOf(item)
    const found = attachmentKind(file)
    const kind = found === 'ask' ? (choice?.as ?? 'ask') : found
    if (!kind) {
      failed.push(`${file.name} is not an image, a document or a dataset.`)
      continue
    }
    if (kind === 'ask') {
      failed.push(`Say whether ${file.name} is a document or a dataset, then send it again.`)
      continue
    }
    try {
      if (kind === 'dataset') {
        const opts = choice?.as === 'dataset' ? { delimiter: choice.delimiter, header: choice.header } : {}
        const read = await readDatasetFile(file, opts)
        const made = read.map((r) => datasetEntity({ ...r.data, source: r.source }, { label: r.label }))
        store.transaction(() => made.forEach((e) => store.upsert(e)))
        for (const e of made) attached.push({ id: e.id, kind, label: displayLabel(e) })
        continue
      }
      const e = kind === 'image' ? await importImageFile(store, file) : await importDocumentFile(store, file)
      attached.push({ id: e.id, kind, label: displayLabel(e) })
    } catch (err) {
      failed.push(err instanceof Error ? err.message : `${file.name} could not be added.`)
    }
  }
  return { attached, failed }
}

/** Where an attachment opens in the app. */
export const attachmentPath = (a: Attachment) => (a.kind === 'image' ? `/images/${a.id}` : a.kind === 'dataset' ? `/analytics/datasets?id=${encodeURIComponent(a.id)}` : `/documents/${a.id}`)

/** Text from a file, quoted for the note: JSON-escaped, and never able to close the block it sits in. */
const quoted = (s: string, max = 80) => JSON.stringify(s.length > max ? `${s.slice(0, max - 1)}…` : s).replace(/</g, '\\u003c')

/** The note that goes to the model with the message: what was attached, as entities it can reach with its tools. */
export function attachmentsBlock(attached: readonly Attachment[], store?: Pick<EntityStore, 'get'>): string {
  if (!attached.length) return ''
  const lines = attached.map((a) => {
    const e = store?.get(a.id)
    let detail: string
    if (a.kind === 'dataset' && isDataset(e)) {
      // The shape and the columns, so the model knows what it holds before it reads a row. Headers are the file's words: quoted.
      const cols = e.data.columns.slice(0, 40).map((c, i) => `${quoted(columnLabel(c), 60)} ${c.kind ?? inferColumnKind(e.data, i, 1000)}`)
      const more = e.data.columns.length > 40 ? `, … ${e.data.columns.length - 40} more` : ''
      const s = e.data.source
      detail = `${e.data.rows.length.toLocaleString('en-US')} rows × ${e.data.columns.length} columns${s?.kind === 'file' ? `, from ${quoted(s.filename)}${s.sheet ? ` sheet ${quoted(s.sheet)}` : ''}` : ''}; columns: ${cols.join(', ')}${more}`
    } else {
      const d = (e?.data ?? {}) as { width?: number; height?: number; mimeType?: string; extension?: string }
      detail = a.kind === 'image' ? [d.mimeType, d.width && d.height ? `${d.width}×${d.height}` : ''].filter(Boolean).join(', ') : (d.extension ?? '')
    }
    return `- ${a.kind} ${quoted(a.label, 200)} id=${a.id}${detail ? ` (${detail})` : ''}`
  })
  return [
    '<attachments>',
    'The user attached these files to this message. Each is now an entity in the open project: look at an image with view_image, read a document with read_document, read a dataset\'s rows with dataset {action:"get", id}, open any of them with open.',
    ...lines,
    '</attachments>',
  ].join('\n')
}
