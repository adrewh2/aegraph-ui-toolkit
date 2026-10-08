import { useEffect, useRef, useState, type RefObject } from 'react'
import { useViewActiveRef } from '../../workstation/paneContext'
import { useToast } from '../../../components/ui/useToast'
import { useEntityStore } from '../../../core/entity/hooks'
import { contentOf, quoteContext, type DocumentEntity } from '../documents'
import type { PendingQuote, SaveState } from './types'

const SAVE_DELAY = 600

interface Props {
  doc: DocumentEntity
  onSaveStateChange: (s: SaveState) => void
  onAnnotate: (q: PendingQuote) => void
  onSelectionChange: (hasSelection: boolean) => void
  /** The page's toolbar calls this to annotate the current selection. */
  annotateRef: RefObject<(() => void) | null>
}

/** Plain-text documents get a plain textarea: no formatting, just autosave and annotate-selection. */
export function PlainEditor({ doc, onSaveStateChange, onAnnotate, onSelectionChange, annotateRef }: Props) {
  const store = useEntityStore()
  const toast = useToast()
  const docId = doc.id
  const ta = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState(() => contentOf(doc))
  const draftRef = useRef(draft)
  draftRef.current = draft
  const saved = useRef(contentOf(doc))
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const flush = () => {
    clearTimeout(timer.current)
    const current = store.get(docId)
    if (!current || draftRef.current === saved.current) return
    saved.current = draftRef.current
    store.update(docId, { data: { ...current.data, content: draftRef.current } })
    onSaveStateChange('saved')
  }

  useEffect(() => {
    const initial = contentOf(store.get(docId) ?? doc)
    saved.current = initial
    setDraft(initial)
    onSaveStateChange('saved')
    return () => {
      clearTimeout(timer.current)
      const current = store.get(docId)
      if (current && draftRef.current !== saved.current) store.update(docId, { data: { ...current.data, content: draftRef.current } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  useEffect(() => {
    const external = contentOf(doc)
    if (external !== saved.current && draftRef.current === saved.current) {
      saved.current = external
      setDraft(external)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.data.content])

  const viewActive = useViewActiveRef()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (!viewActive.current) return // a page or tab behind the front one sits shortcuts out
        e.preventDefault()
        flush()
        toast('Saved')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const readSelection = () => {
    const el = ta.current
    if (el) onSelectionChange(el.selectionStart !== el.selectionEnd)
  }

  useEffect(() => {
    annotateRef.current = () => {
      const el = ta.current
      if (!el || el.selectionStart === el.selectionEnd) return
      const q = quoteContext(draftRef.current, el.selectionStart, el.selectionEnd)
      if (q.exact.trim()) onAnnotate(q)
    }
    return () => {
      annotateRef.current = null
    }
  }, [annotateRef, onAnnotate])

  return (
    <>
      <textarea
        ref={ta}
        className="dp__plain"
        value={draft}
        placeholder="Start writing…"
        spellCheck
        onChange={(e) => {
          setDraft(e.target.value)
          onSaveStateChange('dirty')
          clearTimeout(timer.current)
          timer.current = setTimeout(flush, SAVE_DELAY)
        }}
        onSelect={readSelection}
        onKeyUp={readSelection}
        onMouseUp={readSelection}
        onBlur={() => setTimeout(readSelection, 0)}
      />
    </>
  )
}
