import { Image } from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import { Bold, Highlighter, Italic, Strikethrough, Underline } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useViewActiveRef } from '../../workstation/paneContext'
import type { Highlight } from '../../../components/Markdown'
import { useToast } from '../../../components/ui/useToast'
import { useEntityStore, useStoreVersion } from '../../../core/entity/hooks'
import type { EntityId } from '../../../core/entity/types'
import { annotationsOf, contentOf, quoteContext, stripTitleHeading, type DocumentEntity } from '../documents'
import { AnnotationHighlights, highlightsKey } from './highlights'
import { outlineOf, type OutlineEntry } from './outline'
import type { PendingQuote, SaveState } from './types'
import { scrollBehavior } from '../../../lib/motion'

interface Props {
  doc: DocumentEntity
  onReady: (editor: Editor | null) => void
  onSaveStateChange: (s: SaveState) => void
  onOutlineChange: (o: OutlineEntry[]) => void
  onAnnotate: (q: PendingQuote) => void
  onOpenEntity: (id: EntityId) => void
  /** Scroll to this annotation's highlight when it changes. */
  revealAnnotationId?: EntityId | null
}

const SAVE_DELAY = 600

/**
 * WYSIWYG editor for Markdown documents. The document is stored as
 * Markdown (so every tool, export, and annotation keeps working); TipTap
 * parses it on load and serializes it back on save.
 */
export function RichEditor({ doc, onReady, onSaveStateChange, onOutlineChange, onAnnotate, onOpenEntity, revealAnnotationId }: Props) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const toast = useToast()
  const docId = doc.id

  const saved = useRef(contentOf(doc))
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const highlightsRef = useRef<Highlight[]>([])
  const onOpenRef = useRef(onOpenEntity)
  onOpenRef.current = onOpenEntity

  const extensions = useMemo(
    () => [
      StarterKit.configure({ link: { openOnClick: false, autolink: true }, heading: { levels: [1, 2, 3, 4] } }),
      Markdown,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ inline: false }),
      Placeholder.configure({ placeholder: 'Start writing, or ask the assistant…' }),
      AnnotationHighlights.configure({ getHighlights: () => highlightsRef.current, onClick: (id) => onOpenRef.current(id) }),
    ],
    [],
  )

  const editor = useEditor(
    {
      extensions,
      content: stripTitleHeading(contentOf(doc), doc.label),
      contentType: 'markdown',
      editorProps: { attributes: { class: 'md dp__prose', spellcheck: 'true' } },
      onUpdate: ({ editor }) => {
        dirty.current = true
        onSaveStateChange('dirty')
        clearTimeout(timer.current)
        timer.current = setTimeout(() => flush(editor), SAVE_DELAY)
        onOutlineChange(outlineOf(editor))
      },
    },
    [docId],
  )

  const flush = (ed: Editor) => {
    clearTimeout(timer.current)
    timer.current = undefined
    if (!dirty.current || ed.isDestroyed) return
    const md = ed.getMarkdown()
    dirty.current = false
    if (md === saved.current) {
      onSaveStateChange('saved')
      return
    }
    saved.current = md
    const current = store.get(docId)
    if (current) store.update(docId, { data: { ...current.data, content: md } })
    onSaveStateChange('saved')
  }

  useEffect(() => {
    onReady(editor)
    if (editor) onOutlineChange(outlineOf(editor))
    return () => onReady(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Flush on unmount / document switch.
  useEffect(() => {
    saved.current = contentOf(store.get(docId) ?? doc)
    dirty.current = false
    onSaveStateChange('saved')
    return () => {
      if (editor && dirty.current) flush(editor)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, editor])

  // Someone else (assistant, inspector, another tab) changed the text: adopt it unless we're mid-edit.
  useEffect(() => {
    if (!editor) return
    const external = contentOf(doc)
    if (external !== saved.current && !dirty.current) {
      saved.current = external
      editor.commands.setContent(stripTitleHeading(external, doc.label), { contentType: 'markdown', emitUpdate: false })
      onOutlineChange(outlineOf(editor))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.data.content, editor])

  // ⌘S saves now.
  const viewActive = useViewActiveRef()
  useEffect(() => {
    if (!editor) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (!viewActive.current) return // a page or tab behind the front one sits shortcuts out
        e.preventDefault()
        flush(editor)
        toast('Saved')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Annotations → highlight decorations.
  const highlights = useMemo(
    () =>
      annotationsOf(store, docId)
        .filter((a) => a.exact)
        .map((a) => ({ id: a.annotation.id, exact: a.exact!, title: String(a.annotation.data.comment ?? ''), color: a.annotation.tags.map((t) => store.getTagInfo(t).color).find(Boolean) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, docId, version],
  )
  useEffect(() => {
    highlightsRef.current = highlights
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(highlightsKey, true))
  }, [highlights, editor])

  useEffect(() => {
    if (!revealAnnotationId || !editor) return
    const el = editor.view.dom.querySelector<HTMLElement>(`[data-highlight="${CSS.escape(revealAnnotationId)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
    el.classList.add('is-flash')
    const t = setTimeout(() => el.classList.remove('is-flash'), 1200)
    return () => clearTimeout(t)
  }, [revealAnnotationId, editor])

  const [hasSelection, setHasSelection] = useState(false)
  useEffect(() => {
    if (!editor) return
    const update = () => setHasSelection(!editor.state.selection.empty)
    editor.on('selectionUpdate', update)
    editor.on('blur', update)
    return () => {
      editor.off('selectionUpdate', update)
      editor.off('blur', update)
    }
  }, [editor])

  const annotateSelection = () => {
    if (!editor) return
    const { from, to } = editor.state.selection
    const exact = editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim()
    if (!exact) return
    const md = editor.getMarkdown()
    const at = md.indexOf(exact)
    onAnnotate(at >= 0 ? quoteContext(md, at, at + exact.length) : { exact })
    editor.commands.setTextSelection(to)
  }

  if (!editor) return null
  return (
    <>
      <EditorContent editor={editor} className="dp__editor" />
      <BubbleMenu editor={editor} shouldShow={({ editor, state }) => editor.isEditable && !state.selection.empty && hasSelection}>
        <div className="dp__bubble">
          <button className={`dp__bubble-btn ${editor.isActive('bold') ? 'is-active' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
            <Bold size={13} />
          </button>
          <button className={`dp__bubble-btn ${editor.isActive('italic') ? 'is-active' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
            <Italic size={13} />
          </button>
          <button className={`dp__bubble-btn ${editor.isActive('underline') ? 'is-active' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline">
            <Underline size={13} />
          </button>
          <button className={`dp__bubble-btn ${editor.isActive('strike') ? 'is-active' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleStrike().run()} title="Strikethrough">
            <Strikethrough size={13} />
          </button>
          <span className="dp__bubble-sep" />
          <button className="dp__bubble-btn dp__bubble-btn--annotate" onMouseDown={(e) => e.preventDefault()} onClick={annotateSelection} title="Annotate this passage">
            <Highlighter size={13} /> Annotate
          </button>
        </div>
      </BubbleMenu>
    </>
  )
}
