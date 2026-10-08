import { LocateFixed } from 'lucide-react'
import { useState } from 'react'
import { clock, normalizeRange, parseClock, type TimeRange } from './audio'

/**
 * Start/end editor: dual-thumb slider over the whole track plus typed
 * clocks, with "use playhead" shortcuts. Used in the annotate dialog.
 */
export function RangeEditor({ value, duration, playhead, onChange }: { value: TimeRange; duration: number; playhead?: number; onChange: (r: TimeRange) => void }) {
  const [startText, setStartText] = useState(clock(value.start))
  const [endText, setEndText] = useState(value.end != null ? clock(value.end) : '')
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setStartText(clock(value.start))
    setEndText(value.end != null ? clock(value.end) : '')
  }
  const max = Math.max(duration || 0, value.end ?? value.start, 1)
  const pct = (t: number) => `${(t / max) * 100}%`
  const commit = (r: TimeRange) => onChange(normalizeRange(r, duration || undefined))
  const applyText = () => {
    const s = parseClock(startText)
    const e = endText.trim() ? parseClock(endText) : undefined
    if (s == null || (endText.trim() && e == null)) return
    commit({ start: s, end: e })
  }

  return (
    <div className="re">
      <div className="re__slider">
        <div className="re__rail" />
        <div className="re__fill" style={{ left: pct(value.start), width: value.end != null ? `calc(${pct(value.end)} - ${pct(value.start)})` : 2 }} />
        {playhead != null && <div className="re__playhead" style={{ left: pct(Math.min(playhead, max)) }} title={`Playhead ${clock(playhead)}`} />}
        <input type="range" className="re__thumb" min={0} max={max} step={0.1} value={value.start} aria-label="Start" onChange={(e) => commit({ start: Number(e.target.value), end: value.end != null ? Math.max(value.end, Number(e.target.value) + 0.2) : undefined })} />
        <input type="range" className="re__thumb" min={0} max={max} step={0.1} value={value.end ?? value.start} aria-label="End" onChange={(e) => commit({ start: Math.min(value.start, Number(e.target.value) - 0.2), end: Number(e.target.value) })} />
      </div>
      <div className="re__fields">
        <label className="field">
          <span>Start</span>
          <span className="re__input">
            <input className="input mono" value={startText} onChange={(e) => setStartText(e.target.value)} onBlur={applyText} onKeyDown={(e) => e.key === 'Enter' && applyText()} />
            {playhead != null && (
              <button type="button" className="btn btn--sm btn--icon btn--ghost" title="Use playhead" onClick={() => commit({ start: playhead, end: value.end })}>
                <LocateFixed size={13} />
              </button>
            )}
          </span>
        </label>
        <label className="field">
          <span>End</span>
          <span className="re__input">
            <input className="input mono" placeholder="— (moment)" value={endText} onChange={(e) => setEndText(e.target.value)} onBlur={applyText} onKeyDown={(e) => e.key === 'Enter' && applyText()} />
            {playhead != null && (
              <button type="button" className="btn btn--sm btn--icon btn--ghost" title="Use playhead" onClick={() => commit({ start: value.start, end: playhead })}>
                <LocateFixed size={13} />
              </button>
            )}
          </span>
        </label>
        <div className="re__len muted">
          {value.end != null ? `${(value.end - value.start).toFixed(1)}s` : 'moment'}
          {value.end != null && (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => commit({ start: value.start })}>
              make it a moment
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
