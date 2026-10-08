import { X } from 'lucide-react'
import { contrastText, hashColor } from '../../lib/format'
import './ui.css'

export function TagChip({ tag, color, onRemove }: { tag: string; color?: string; onRemove?: () => void }) {
  const bg = color || hashColor(tag)
  return (
    <span className="chip" style={{ background: bg, color: contrastText(bg) }} title={tag}>
      {tag}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${tag}`}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          style={{ border: 0, background: 'transparent', padding: 0, display: 'inline-flex', cursor: 'pointer', opacity: 0.7 }}
        >
          <X size={11} />
        </button>
      )}
    </span>
  )
}
