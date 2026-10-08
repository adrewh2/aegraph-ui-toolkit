import { Image } from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useMemo, useRef } from 'react'
import type { Highlight } from '../../../components/Markdown'
import { useEntityStore, useStoreVersion } from '../../../core/entity/hooks'
import type { EntityId } from '../../../core/entity/types'
import { annotationsOf, contentOf, quoteContext, stripTitleHeading, type DocumentEntity } from '../documents'
import { AnnotationHighlights, highlightsKey } from './highlights'
import type { PendingQuote } from './types'

/**
 * The document rendered exactly as the editor renders it — same extensions,
 * same prose styles, existing annotations highlighted — but read-only, and
 * reporting the current text selection as a quote (with prefix/suffix
 * taken from the stored Markdown so it can re-anchor later).
 */
export function RichReader({ doc, onSelect, onOpenEntity }: { doc: DocumentEntity; onSelect: (q: PendingQuote | null) => void; onOpenEntity?: (id: EntityId) => void }) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const highlightsRef = useRef<Highlight[]>([])
  const onOpenRef = useRef(onOpenEntity)
  const onSelectRef = useRef(onSelect)
  useEffect(() => {
    onOpenRef.current = onOpenEntity
    onSelectRef.current = onSelect
  })

  const extensions = useMemo(
    () => [
      StarterKit.configure({ link: { openOnClick: false, autolink: true }, heading: { levels: [1, 2, 3, 4] } }),
      Markdown,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ inline: false }),
      AnnotationHighlights.configure({ getHighlights: () => highlightsRef.current, onClick: (id) => onOpenRef.current?.(id) }),
    ],
    [],
  )

  const editor = useEditor(
    {
      extensions,
      editable: false,
      content: stripTitleHeading(contentOf(doc), doc.label),
      contentType: 'markdown',
      editorProps: { attributes: { class: 'md dp__prose dp__prose--reader' } },
    },
    [doc.id],
  )

  // Existing annotations as highlights.
  const highlights = useMemo(
    () =>
      annotationsOf(store, doc.id)
        .filter((a) => a.exact)
        .map((a) => ({ id: a.annotation.id, exact: a.exact!, title: String(a.annotation.data.comment ?? ''), color: a.annotation.tags.map((t) => store.getTagInfo(t).color).find(Boolean) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, doc.id, version],
  )
  useEffect(() => {
    highlightsRef.current = highlights
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(highlightsKey, true))
  }, [highlights, editor])

  // Selection → quote against the stored Markdown.
  useEffect(() => {
    if (!editor) return
    const update = () => {
      const { from, to } = editor.state.selection
      const exact = editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim()
      if (!exact) return onSelectRef.current(null)
      const md = contentOf(doc)
      const at = md.indexOf(exact)
      onSelectRef.current(at >= 0 ? quoteContext(md, at, at + exact.length) : { exact })
    }
    editor.on('selectionUpdate', update)
    return () => {
      editor.off('selectionUpdate', update)
    }
  }, [editor, doc])

  if (!editor) return null
  return <EditorContent editor={editor} className="dp__editor dp__editor--reader" />
}
