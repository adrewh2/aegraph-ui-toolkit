import { useRef } from 'react'
import { embedHeight, type AudioEntity } from './audio'
import { useSpotifyPlayer } from './spotify'
import './audio.css'

/** The Spotify embed, as on the audio page. */
export default function AudioEmbed({ audio }: { audio: AudioEntity }) {
  const host = useRef<HTMLDivElement>(null)
  const player = useSpotifyPlayer(host, audio.data.uri, embedHeight(audio.data.spotifyType))
  return (
    <div className="ae">
      <div className="mp__player-wrap">
        <div ref={host} className="mp__player" />
      </div>
      {player.error && <div className="muted" style={{ padding: 10, fontSize: 12 }}>{player.error}</div>}
    </div>
  )
}
