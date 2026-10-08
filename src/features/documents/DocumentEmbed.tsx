import { useRef, useState } from 'react'
import { useToast } from '../../components/ui/useToast'
import { useEntityStore } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { AnnotateDialog } from './dialogs'
import { annotateDocument, isFolder, isPdf, isTextDocument, type DocumentEntity } from './documents'
import type { PendingQuote, SaveState } from './editor/types'
import { PlainEditor } from './editor/PlainEditor'
import { RichEditor } from './editor/RichEditor'
import { PdfViewer } from './PdfViewer'
import { FolderEmbed } from './FolderEmbed'
import './DocumentsView.css'

/** The document itself — the same editor / PDF viewer as the page, minus the page chrome. */
export default function DocumentEmbed({ doc, onOpen }: { doc: DocumentEntity; onOpen: (id: EntityId) => void }) {
  const store = useEntityStore()
  const toast = useToast()
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [quote, setQuote] = useState<PendingQuote | null>(null)
  const annotateRef = useRef<(() => void) | null>(null)
  const [plainSelection, setPlainSelection] = useState(false)

  if (isFolder(doc)) return <FolderEmbed folder={doc} onOpen={onOpen} />
  if (isPdf(doc)) return <PdfViewer key={doc.id} doc={doc} />

  return (
    <div className="dp__embed">
      <div className="dp__embed-bar muted">
        <span>{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Unsaved changes'}</span>
        {!isTextDocument(doc) || doc.data.extension === 'md' ? <span>Select text and use the bubble to annotate.</span> : (
          <button className="btn btn--sm" disabled={!plainSelection} onMouseDown={(e) => e.preventDefault()} onClick={() => annotateRef.current?.()}>
            Annotate selection
          </button>
        )}
      </div>
      <div className="dp__column dp__column--embed">
        {doc.data.extension === 'md' ? (
          <RichEditor key={doc.id} doc={doc} onReady={() => {}} onSaveStateChange={setSaveState} onOutlineChange={() => {}} onAnnotate={setQuote} onOpenEntity={onOpen} />
        ) : (
          <PlainEditor key={doc.id} doc={doc} onSaveStateChange={setSaveState} onAnnotate={setQuote} onSelectionChange={setPlainSelection} annotateRef={annotateRef} />
        )}
      </div>
      {quote && (
        <AnnotateDialog
          quote={quote}
          onClose={() => setQuote(null)}
          onSubmit={(comment, tags) => {
            annotateDocument(store, doc, quote, comment, tags)
            setQuote(null)
            toast('Annotation created')
          }}
        />
      )}
    </div>
  )
}
