import { Pause, Play, RotateCcw, RotateCw, StickyNote } from 'lucide-react'
import { useCallback, useMemo, useRef } from 'react'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import { clock, embedHeight, isActiveAt, isTimed, timeAnnotationsOf, type AudioAnnotation, type AudioEntity, type TimeRange } from './audio'
import { RangeEditor } from './RangeEditor'
import { RangeTimeline } from './RangeTimeline'
import { useSpotifyPlayer } from './spotify'
import './audio.css'

const DEFAULT_COLOR = '#1db954'

/**
 * The audio page's tools, as a picker: the real Spotify embed, transport,
 * the lane timeline with a draggable in/out range, "Note at" for a moment,
 * and the range editor for exact times. Reports the range; the caller
 * creates the annotation.
 */
export function AudioPicker({ audio, value, disabled, onChange }: { audio: AudioEntity; value: TimeRange | null; disabled?: boolean; onChange: (r: TimeRange | null) => void }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const host = useRef<HTMLDivElement>(null)
  const player = useSpotifyPlayer(host, audio.data.uri, embedHeight(audio.data.spotifyType), value?.start)
  const t = player.currentTime
  const duration = player.duration || audio.data.duration || 0
  const timed = isTimed(audio.data.spotifyType)
  const annotations = useMemo(() => timeAnnotationsOf(store, audio.id), [store, audio.id])
  const active = annotations.filter((a) => isActiveAt(a, t))
  const colorOf = useCallback((a: AudioAnnotation) => a.annotation.tags.map((x) => store.getTagInfo(x).color).find(Boolean) ?? DEFAULT_COLOR, [store])

  const markIn = () => onChange({ start: t, end: value?.end != null && value.end > t ? value.end : undefined })
  const markOut = () => onChange(value && value.start < t ? { start: value.start, end: t } : { start: Math.max(0, t - 10), end: t })

  return (
    <div className={`apk ${disabled ? 'is-disabled' : ''}`}>
      <div className="vpk__bar">
        <button className="tb__btn" title={player.playing ? 'Pause' : 'Play'} disabled={!player.ready} onClick={player.toggle}>
          {player.playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className="tb__btn" title="Back 5s" disabled={!player.ready} onClick={() => player.seek(t - 5)}>
          <RotateCcw size={13} />
        </button>
        <button className="tb__btn" title="Forward 5s" disabled={!player.ready} onClick={() => player.seek(t + 5)}>
          <RotateCw size={13} />
        </button>
        <span className="vp__clock">
          {clock(t)} <span className="faint">/ {duration ? clock(duration) : '–:––'}</span>
        </span>
        {timed && (
          <>
            <span className="tb__sep" />
            <button
              className="btn btn--sm"
              onClick={() => {
                player.pause()
                onChange({ start: t })
              }}
              title="Annotate this moment"
            >
              <StickyNote size={13} /> Note at {clock(t)}
            </button>
            <button className={`btn btn--sm ${value && value.end == null ? 'is-on' : ''}`} onClick={markIn} title="Set the range start at the playhead">
              <span className="mp__io">I</span> In
            </button>
            <button className="btn btn--sm" onClick={markOut} title="Set the range end at the playhead">
              <span className="mp__io">O</span> Out
            </button>
          </>
        )}
        <span className="spacer" />
        <span className="muted vpk__status">{!timed ? 'collection — annotated as a whole' : active.length ? `${active.length} annotation${active.length === 1 ? '' : 's'} here` : ''}</span>
      </div>
      <div className="apk__stage">
        <div className="mp__player-wrap" style={{ minHeight: embedHeight(audio.data.spotifyType) }}>
          <div ref={host} className="mp__player" />
          {player.error && <div className="vp__error">{player.error}</div>}
          {!player.ready && !player.error && <div className="vp__loading muted">Loading Spotify…</div>}
        </div>
        {timed && (
          <>
            <RangeTimeline duration={duration} current={t} annotations={annotations} selected={null} pending={value} colorOf={colorOf} onSeek={player.seek} onPick={(a) => player.seek(a.time.start)} onPendingChange={onChange} onRetime={() => {}} />
            {value && (
              <div className="apk__editor">
                <RangeEditor value={value} duration={duration} playhead={t} onChange={onChange} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
