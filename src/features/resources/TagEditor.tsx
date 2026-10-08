import { useState } from 'react'
import { TagChip } from '../../components/ui/TagChip'
import { contrastText, hashColor } from '../../lib/format'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import { uniqueTags } from '../../core/entity/entity'

export function TagEditor({
  value,
  onChange,
  onDone,
  autoFocus = true,
}: {
  value: string[]
  onChange: (tags: string[]) => void
  onDone?: () => void
  autoFocus?: boolean
}) {
  const store = useEntityStore()
  useStoreVersion(store)
  const [draft, setDraft] = useState('')
  const all = store.tags()
  const q = draft.trim().toLowerCase()
  const suggestions = all.filter((t) => !value.includes(t) && (!q || t.toLowerCase().includes(q))).slice(0, 30)

  const add = (t: string) => {
    const next = uniqueTags([...value, t])
    if (next.length !== value.length) onChange(next)
    setDraft('')
  }

  return (
    <div className="tag-editor">
      <div className="tag-editor__chips">
        {value.length === 0 && <span className="faint" style={{ fontSize: 12 }}>No tags</span>}
        {value.map((t) => (
          <TagChip key={t} tag={t} color={store.getTagInfo(t).color} onRemove={() => onChange(value.filter((x) => x !== t))} />
        ))}
      </div>
      <input
        className="input"
        autoFocus={autoFocus}
        placeholder="Add tag… (Enter)"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            e.preventDefault()
            add(draft)
          } else if (e.key === 'Enter' && !draft.trim()) {
            onDone?.()
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1))
          } else if (e.key === ',' ) {
            e.preventDefault()
            if (draft.trim()) add(draft)
          }
        }}
      />
      {suggestions.length > 0 && (
        <div className="tag-editor__suggest">
          {suggestions.map((t) => (
            <span key={t} className="chip" style={{ background: store.getTagInfo(t).color ?? hashColor(t), color: contrastText(store.getTagInfo(t).color ?? hashColor(t)) }} onClick={() => add(t)}>
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
