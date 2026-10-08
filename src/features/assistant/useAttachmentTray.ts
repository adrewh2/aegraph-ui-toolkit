import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { useEntityStore } from '../../core/entity/hooks'
import { attachmentKind, dragHasFiles, importAttachments, type Attachment, type PendingFile, type TextChoice } from './attachments'

/**
 * A composer's attachments: the files waiting to go with the next message — picked with the paperclip, dropped on
 * whatever `dropProps` is spread over, or pasted — and, when it is sent, those files made entities in the open
 * project (`take`). A text file waits with a question (document or dataset, and for a dataset its separator), which
 * `choose` answers; the message does not go until every one is answered. The chat thread and the Chats landing both
 * compose with it, so a file goes in the same way wherever a message starts.
 */
export function useAttachmentTray({ enabled, onAdded }: { enabled: boolean; onAdded?: () => void }) {
  const store = useEntityStore()
  const [files, setFiles] = useState<PendingFile[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [attaching, setAttaching] = useState(false)
  const [dropping, setDropping] = useState(false)
  const dropTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (dropTimer.current) clearTimeout(dropTimer.current)
  }, [])

  /** Images, documents and data files are kept; anything else is named and turned away. */
  const add = useCallback(
    (list: readonly File[]) => {
      const taken = list.filter((f) => attachmentKind(f))
      const turned = list.filter((f) => !attachmentKind(f))
      if (taken.length) setFiles((cur) => [...cur, ...taken.map((file) => ({ file }))])
      setNote(turned.length ? `${turned.map((f) => f.name).join(', ')} ${turned.length === 1 ? 'is' : 'are'} not something the chat takes — it takes images, Markdown, text and PDF files, and tables as CSV, TSV, Excel (.xlsx) or Parquet.` : null)
      onAdded?.()
    },
    [onAdded],
  )

  /** The answer for a text file: a document, or a dataset with its separator and header. */
  const choose = useCallback((i: number, choice: TextChoice) => setFiles((cur) => cur.map((p, j) => (j === i ? { ...p, choice } : p))), [])

  // `dragover` repeats while a drag is over the target, so the highlight lapses by itself once it leaves.
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!enabled || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDropping(true)
      if (dropTimer.current) clearTimeout(dropTimer.current)
      dropTimer.current = setTimeout(() => setDropping(false), 150)
    },
    onDrop: (e: DragEvent) => {
      if (!enabled || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      setDropping(false)
      add(Array.from(e.dataTransfer.files))
    },
  }

  /** For the composer's text box: a pasted image (a screenshot) is attached rather than dropped as nothing. */
  const onPaste = (e: ClipboardEvent) => {
    if (!enabled) return
    const pasted = Array.from(e.clipboardData.files)
    if (!pasted.length) return
    e.preventDefault()
    add(pasted)
  }

  /**
   * The waiting files as entities, in order, and the tray emptied; what could not be added is said in the note.
   * `null` when the message should not go: a text file still waits for its answer (the files stay), or files were
   * waiting and none of them could be added.
   */
  const take = async (): Promise<Attachment[] | null> => {
    if (!files.length) return []
    const unanswered = unansweredOf(files)
    if (unanswered) {
      setNote(unanswered)
      return null
    }
    setAttaching(true)
    try {
      const r = await importAttachments(store, files)
      setFiles([])
      setNote(r.failed.length ? r.failed.join(' ') : null)
      return r.attached.length ? r.attached : null
    } finally {
      setAttaching(false)
    }
  }

  return { files, note, attaching, dropping, dropProps, onPaste, add, choose, take, remove: (i: number) => setFiles((cur) => cur.filter((_, j) => j !== i)), dismiss: () => setNote(null) }
}

/** What still has to be said before the files can go — a text file nobody has called a document or a dataset, a separator left blank — or nothing. */
export function unansweredOf(files: readonly PendingFile[]): string | null {
  for (const p of files) {
    if (attachmentKind(p.file) !== 'ask') continue
    if (!p.choice) return `Is ${p.file.name} a document or a dataset? Choose above the message, then send.`
    if (p.choice.as === 'dataset' && !p.choice.delimiter) return `Say what separates the columns of ${p.file.name}, then send.`
  }
  return null
}

export type AttachmentTrayState = ReturnType<typeof useAttachmentTray>
