import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { displayLabel, oneLineLabel, quoteLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import { type AnyEntity, type EntityId } from '../../core/entity/types'
import { allDocuments, ancestorsOf, annotationsOf, buildTree, contentOf, createDocument, extOf, isDocument, isFolder, isTextDocument, MAX_INLINE_PDF_BYTES, moveDocument, type DocNode, type DocumentEntity } from '../documents/documents'
import { dataUrlBytes } from '../images/images'
import { isOwnMemory } from './memory'
import { MAX_CONTENT_CHARS, json, requireEntity, summarize, openMade } from './toolkit'
import type { AppHost } from './tools'

/**
 * Documents: list, read, create, write, edit, move.
 */

function requireDocument(store: EntityStore, id: string): DocumentEntity {
  const e = requireEntity(store, id)
  if (!isDocument(e)) throw new Error(`Entity ${id} is a ${e.type}, not a document.`)
  return e
}

export function requireTextDocument(store: EntityStore, id: string): DocumentEntity {
  const d = requireDocument(store, id)
  if (!isTextDocument(d)) throw new Error(`Document ${id} is a .${extOf(d)}; only .md and .txt documents have editable text.`)
  return d
}

function pathOf(store: EntityStore, id: EntityId): string[] {
  return ancestorsOf(store, id)
    .reverse()
    .map((a) => displayLabel(store.get(a) ?? ({ id: a } as AnyEntity)))
}

function treeLines(nodes: DocNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    const e = n.entity
    out.push(`${'  '.repeat(n.depth)}${isFolder(e) ? '📁' : '📄'} ${displayLabel(e)}${isFolder(e) ? '/' : `.${extOf(e)}`}  [${e.id}]${e.tags.length ? `  #${e.tags.join(' #')}` : ''}`)
    treeLines(n.children, out)
  }
  return out
}


export function createDocumentTools(host: AppHost) {
  const { store } = host

  const listDocuments = betaTool({
    name: 'list_documents',
    description: 'List every document and folder as an indented tree with ids. Folders end with "/".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as const,
    run: () => {
      const docs = allDocuments(store)
      if (docs.length === 0) return 'No documents yet.'
      return treeLines(buildTree(docs)).join('\n')
    },
  })

  const readDocument = betaTool({
    name: 'read_document',
    description: 'Read a document: its metadata, full text (for .md/.txt), and any annotations on it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Document entity id' } },
      required: ['id'],
      additionalProperties: false,
    } as const,
    run: ({ id }) => {
      const d = requireDocument(store, id)
      const content = contentOf(d)
      const truncated = content.length > MAX_CONTENT_CHARS
      return json({
        ...summarize(d),
        description: d.description,
        folderPath: pathOf(store, d.id),
        sourceUrl: d.data.sourceUrl,
        content: truncated ? content.slice(0, MAX_CONTENT_CHARS) : content,
        ...(truncated ? { note: `Content truncated to ${MAX_CONTENT_CHARS} of ${content.length} characters.` } : {}),
        annotations: annotationsOf(store, d.id).map((a) => ({ id: a.annotation.id, quote: a.exact, comment: a.annotation.data.comment, tags: a.annotation.tags })),
      })
    },
  })

  const createDoc = betaTool({
    name: 'create_document',
    description: 'Create a new Markdown or plain-text document, a folder, or a PDF (extension "pdf" with `url`: an http(s) address registers it and the bytes stay there; a data:application/pdf;base64,… URL is the file itself, kept inline as when the user attaches a PDF in the chat, up to 15 MB) and open it. Returns the new id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        extension: { type: 'string', enum: ['md', 'txt', 'folder', 'pdf'], description: 'Defaults to md' },
        content: { type: 'string', description: 'Initial text. Ignored for folders and PDFs.' },
        url: { type: 'string', description: 'pdf: where the PDF is (http/https), or the PDF itself as data:application/pdf;base64,…' },
        folder_id: { type: 'string', description: 'Parent folder id; omit for top level' },
        tags: { type: 'array', items: { type: 'string' } },
        open: { type: 'boolean', description: 'Navigate to it after creating (default true)' },
      },
      required: ['title'],
      additionalProperties: false,
    } as const,
    run: ({ title, extension, content, url, folder_id, tags, open }) => {
      if (folder_id) {
        const f = requireDocument(store, folder_id)
        if (!isFolder(f)) throw new Error(`${folder_id} is not a folder.`)
      }
      let sourceUrl: string | undefined
      if (extension === 'pdf' && url && /^data:/i.test(url.trim())) {
        const dataUrl = url.trim()
        if (!/^data:application\/pdf;base64,/i.test(dataUrl)) throw new Error('A data: URL here must hold a PDF (data:application/pdf;base64,…).')
        const bytes = dataUrlBytes(dataUrl)
        if (bytes > MAX_INLINE_PDF_BYTES) throw new Error(`The PDF is ${(bytes / 1024 / 1024).toFixed(1)} MB; inline PDFs are capped at ${MAX_INLINE_PDF_BYTES / 1024 / 1024} MB. Give its http(s) address instead.`)
        const e = createDocument(store, { label: title, extension: 'pdf', parentId: folder_id, tags, data: { dataUrl }, source: 'import:file' })
        if (open !== false) openMade(host, e.id, `/documents/${e.id}`)
        return json(summarize(e))
      }
      if (extension === 'pdf') {
        if (!url) throw new Error('A PDF needs a `url`.')
        try {
          sourceUrl = new URL(url).toString()
        } catch {
          throw new Error(`Not a valid URL: ${url}`)
        }
      }
      const e = createDocument(store, { label: title, extension: extension ?? 'md', content, parentId: folder_id, tags, source: sourceUrl ? 'import:url' : 'assistant', ...(sourceUrl ? { data: { sourceUrl } } : {}) })
      if (open !== false) openMade(host, e.id, `/documents/${e.id}`)
      return json(summarize(e))
    },
  })

  const writeDocument = betaTool({
    name: 'write_document',
    description: 'Replace the entire text of a .md/.txt document. Prefer edit_document for small changes so the rest of the text is untouched. A rewrite that drops most of an existing text is put to the user to confirm first.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, content: { type: 'string' } },
      required: ['id', 'content'],
      additionalProperties: false,
    } as const,
    run: async ({ id, content }) => {
      const d = requireTextDocument(store, id)
      const before = contentOf(d).length
      // The assistant's memory is read into every turn as its own words: any change to it is shown first, as the memory tool's rewrite is.
      if (isOwnMemory(d)) await confirmMemoryChange(host, contentOf(d), content)
      // A rewrite that keeps most of the text is an edit; one that throws most of it away is put to the user first.
      else if (before > 200 && keptShare(contentOf(d), content) < 0.5 && !(await host.confirm(`Rewrite ${quoteLabel(displayLabel(d))}? The new text drops most of what it says now (${before} characters → ${content.length}).`, { yes: 'Rewrite', danger: true })))
        throw new Error('The user kept the document as it was; use edit_document for a targeted change.')
      store.update(d.id, { data: { ...d.data, content } })
      host.notify?.(`Rewrote “${displayLabel(d)}”`)
      return json({ id, chars: { before, after: content.length } })
    },
  })

  const editDocument = betaTool({
    name: 'edit_document',
    description:
      'Edit a .md/.txt document by replacing an exact substring. `old_text` must occur exactly once (or set replace_all). Use an empty old_text with `append: true` to add text at the end.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to find, including whitespace' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean' },
        append: { type: 'boolean', description: 'Append new_text to the end instead of replacing' },
      },
      required: ['id', 'new_text'],
      additionalProperties: false,
    } as const,
    run: async ({ id, old_text, new_text, replace_all, append }) => {
      const d = requireTextDocument(store, id)
      const content = contentOf(d)
      let next: string
      let count = 1
      if (append) {
        next = content + (content && !content.endsWith('\n') ? '\n' : '') + new_text
      } else {
        if (!old_text) throw new Error('old_text is required unless append is true.')
        const first = content.indexOf(old_text)
        if (first === -1) throw new Error('old_text was not found in the document. Read it again and copy the text exactly.')
        count = content.split(old_text).length - 1
        if (count > 1 && !replace_all) throw new Error(`old_text occurs ${count} times; include more surrounding text to make it unique, or set replace_all.`)
        next = replace_all ? content.split(old_text).join(new_text) : content.slice(0, first) + new_text + content.slice(first + old_text.length)
      }
      if (isOwnMemory(d)) await confirmMemoryChange(host, content, next)
      store.update(d.id, { data: { ...d.data, content: next } })
      host.notify?.(`Edited “${displayLabel(d)}”`)
      return json({ id, replacements: append ? 0 : count, appended: !!append, chars: next.length })
    },
  })

  const moveDoc = betaTool({
    name: 'move_document',
    description: 'Move a document or folder into another folder, or to the top level.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, folder_id: { type: 'string', description: 'Destination folder id; omit for top level' } },
      required: ['id'],
      additionalProperties: false,
    } as const,
    run: ({ id, folder_id }) => {
      requireDocument(store, id)
      if (!moveDocument(store, id, folder_id || undefined)) throw new Error('Move refused: destination must be a folder and not inside the item being moved.')
      return json({ id, folderPath: pathOf(store, id) })
    },
  })

  return [listDocuments, readDocument, createDoc, writeDocument, editDocument, moveDoc]
}

/** A change to the assistant's memory document by a document tool: the user sees it before and after, as with `memory {rewrite}`. */
async function confirmMemoryChange(host: Pick<AppHost, 'confirm'>, before: string, after: string): Promise<void> {
  // What changes, line by line — an addition at the end of a long memory is what matters, and would be cut from a preview of the whole.
  const lines = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean)
  const [was, now] = [lines(before), lines(after)]
  const list = (ls: string[], mark: string) => ls.slice(0, 12).map((l) => `${mark} ${oneLineLabel(l, 160)}`).join('\n') + (ls.length > 12 ? `\n…and ${ls.length - 12} more` : '')
  const gone = was.filter((l) => !now.includes(l))
  const added = now.filter((l) => !was.includes(l))
  const what = [gone.length ? `Removed:\n${list(gone, '−')}` : '', added.length ? `Added:\n${list(added, '+')}` : ''].filter(Boolean).join('\n\n') || 'Only spacing changes.'
  if (!(await host.confirm(`Change the assistant's memory for this project? It is read into every turn.\n\n${what}`, { yes: 'Change', danger: true }))) throw new Error('The user kept the memory as it was.')
}

/** How much of the old text's lines the new text still has, 0..1 — a cheap measure of whether a rewrite is an edit. */
function keptShare(before: string, after: string): number {
  const lines = before.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return 1
  const now = new Set(after.split('\n').map((l) => l.trim()))
  return lines.filter((l) => now.has(l)).length / lines.length
}
