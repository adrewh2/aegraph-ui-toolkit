import { FileText, Paperclip, Table2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Select } from '../../components/ui/Select'
import { DELIMITERS, previewDelimited, sniffDelimiter } from '../../core/datasets/files'
import { ATTACH_ACCEPT, attachmentKind, type PendingFile, type TextChoice } from './attachments'
import type { AttachmentTrayState } from './useAttachmentTray'
import './AssistantPanel.css'

/**
 * The files waiting to be sent — a thumbnail for an image, a table for a dataset, the name for a document, each
 * removable — the question a text file waits with, and the note on what was turned away.
 */
export function AttachmentTray({ tray }: { tray: AttachmentTrayState }) {
  const { files, note } = tray
  const previews = useMemo(() => files.map((p) => (attachmentKind(p.file) === 'image' ? URL.createObjectURL(p.file) : undefined)), [files])
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews])
  if (!files.length && !note) return null
  return (
    <>
      {files.length > 0 && (
        <div className="ai__attachments">
          {files.map((p, i) => {
            const kind = attachmentKind(p.file) === 'ask' ? p.choice?.as : attachmentKind(p.file)
            return (
              <span key={`${p.file.name}-${i}`} className="ai__attachment" title={p.file.name}>
                {previews[i] ? <img src={previews[i]} alt="" /> : kind === 'dataset' ? <Table2 size={14} /> : <FileText size={14} />}
                <span className="ai__attachment-name">{p.file.name}</span>
                <button className="ai__attachment-x" title={`Remove ${p.file.name}`} onClick={() => tray.remove(i)}>
                  <X size={11} />
                </button>
              </span>
            )
          })}
        </div>
      )}
      {files.map((p, i) => (attachmentKind(p.file) === 'ask' ? <TextFileQuestion key={`${p.file.name}-${i}-q`} pending={p} onChoose={(c) => tray.choose(i, c)} /> : null))}
      {note && (
        <div className="ai__attach-note" role="status">
          <span>{note}</span>
          <button className="btn btn--sm btn--icon btn--ghost" title="Dismiss" onClick={tray.dismiss}>
            <X size={12} />
          </button>
        </div>
      )}
    </>
  )
}

/** How much of a text file the question reads for its preview and its guess at the separator. */
const SAMPLE_BYTES = 64 * 1024
const OTHER = 'other'

/**
 * A text file's question, asked as it is attached: a document or a dataset — and for a dataset, what separates its
 * columns (guessed from the file, changeable: comma, tab, semicolon, pipe, spaces, or any other) and whether its first
 * row names them, with the first rows as that choice reads them. Nothing is read beyond the first 64 KB until send.
 */
export function TextFileQuestion({ pending, onChoose }: { pending: PendingFile; onChoose: (c: TextChoice) => void }) {
  const { file, choice } = pending
  const [sample, setSample] = useState<string | null>(null)
  const [custom, setCustom] = useState(false)
  useEffect(() => {
    let live = true
    file
      .slice(0, SAMPLE_BYTES)
      .text()
      .then((t) => live && setSample(t))
      .catch(() => live && setSample(''))
    return () => {
      live = false
    }
  }, [file])
  const guess = useMemo(() => (sample ? sniffDelimiter(sample) : ','), [sample])
  const dataset = choice?.as === 'dataset' ? choice : undefined
  const known = dataset && DELIMITERS.some((d) => d.value === dataset.delimiter)
  const selectValue = !dataset ? '' : custom || !known ? OTHER : dataset.delimiter
  const preview = useMemo(() => (dataset && dataset.delimiter && sample !== null ? previewDelimited(sample, dataset) : null), [dataset, sample])

  return (
    <div className="ai__textq" role="group" aria-label={`How to read ${file.name}`}>
      <div className="ai__textq-row">
        <span className="ai__textq-name" title={file.name}>
          {file.name}
        </span>
        <span className="faint">is a</span>
        <button className={`btn btn--sm ${choice?.as === 'document' ? 'btn--primary' : ''}`} aria-pressed={choice?.as === 'document'} onClick={() => onChoose({ as: 'document' })}>
          <FileText size={13} /> Document
        </button>
        <button className={`btn btn--sm ${dataset ? 'btn--primary' : ''}`} aria-pressed={!!dataset} onClick={() => !dataset && onChoose({ as: 'dataset', delimiter: guess, header: true })}>
          <Table2 size={13} /> Dataset
        </button>
      </div>
      {dataset && (
        <>
          <div className="ai__textq-row">
            <span className="faint">Columns separated by</span>
            <Select
              value={selectValue}
              aria-label="Separator"
              onChange={(e) => {
                const v = e.target.value
                setCustom(v === OTHER)
                onChoose({ ...dataset, delimiter: v === OTHER ? '' : v })
              }}
            >
              {DELIMITERS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
              <option value={OTHER}>Other…</option>
            </Select>
            {selectValue === OTHER && <input className="input ai__textq-custom" autoFocus value={dataset.delimiter} placeholder="e.g. ::" aria-label="Separator" onChange={(e) => onChoose({ ...dataset, delimiter: e.target.value.replace(/[\r\n"]/g, '') })} />}
            <label className="ai__textq-check">
              <input type="checkbox" checked={dataset.header} onChange={(e) => onChoose({ ...dataset, header: e.target.checked })} /> First row is the header
            </label>
          </div>
          {preview && preview.columns > 0 ? (
            <div className="ai__textq-preview">
              <table>
                <thead>
                  <tr>
                    {preview.headers.slice(0, 8).map((h, i) => (
                      <th key={i}>{h}</th>
                    ))}
                    {preview.columns > 8 && <th className="faint">+{preview.columns - 8}</th>}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r, i) => (
                    <tr key={i}>
                      {Array.from({ length: Math.min(8, preview.columns) }, (_, c) => (
                        <td key={c}>{r[c] ?? ''}</td>
                      ))}
                      {preview.columns > 8 && <td />}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            dataset.delimiter === '' && <div className="faint ai__textq-hint">Type the separator.</div>
          )}
        </>
      )}
    </div>
  )
}

/** The paperclip: a file picker for images, documents and data files. */
export function AttachButton({ tray, disabled, className = '' }: { tray: AttachmentTrayState; disabled?: boolean; className?: string }) {
  const pick = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={pick}
        type="file"
        multiple
        hidden
        accept={ATTACH_ACCEPT}
        onChange={(e) => {
          tray.add(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
      <button className={`btn btn--sm btn--icon btn--ghost ai__attach ${className}`} title="Attach images, documents or data files (CSV, TSV, Excel, Parquet) — they are added to the project when you send" disabled={disabled} onClick={() => pick.current?.click()}>
        <Paperclip size={14} />
      </button>
    </>
  )
}
