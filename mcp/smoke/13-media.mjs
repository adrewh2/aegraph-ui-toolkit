/**
 * Use case 2, "Review media and pin moments", the half that needs no
 * player: a video registered from a YouTube link and annotated at a moment
 * and over a range with a region of the frame; a Spotify track annotated
 * over a range; an image registered by a same-origin URL and annotated
 * with a box; every annotation carrying its selector on the `annotates`
 * relationship, listed on the entity, in the Library and in the inspector.
 * Playback control and frame capture need a real player and are left out.
 * oEmbed lookups may fail headless and are allowed to. Needs GL=1.
 * It needs no declared starting state (b35): every check is about the
 * video, track and image it registered and the annotations it made, and
 * even the Library's annotation rows are narrowed to its own four before
 * they are counted. Run under a profile dirtied on purpose — a project
 * left open and a filter matching nothing — it is 14 of 14 with nothing
 * declared.
 *   GL=1 node mcp/drive.mjs mcp/smoke/13-media.mjs
 * or `npm run smoke:media`.
 */
import { check, counted, tidied } from './lib.mjs'

export default async ({ call, evaluate, sleep }) => {
  const wasHolding = await counted(evaluate)
  // Video: any YouTube link form; the id is what matters.
  const video = await call('create_video', { url: 'https://youtu.be/dQw4w9WgXcQ', tags: ['smoke-media'], open: false })
  check('a video is registered from a YouTube link', video.type === 'video' && !!video.id && video.existed === false, JSON.stringify(video).slice(0, 140))
  const full = await call('get_entity', { id: video.id })
  check('its id and watch link are on the entity', full.data.videoId === 'dQw4w9WgXcQ' && /watch\?v=dQw4w9WgXcQ/.test(full.data.url), `${full.label} · ${full.data.url}`)
  const moment = await call('annotate_video', { video_id: video.id, start: 42, comment: 'The chorus starts', tags: ['moment'] })
  const range = await call('annotate_video', { video_id: video.id, start: 60.5, end: 75, comment: 'Dance break', region: { x: 0.25, y: 0.1, width: 0.5, height: 0.6 } })
  check('a moment and a ranged region are pinned on the video', moment.selector?.kind === 'time' && moment.selector.start === 42 && moment.selector.end === undefined && range.selector?.kind === 'time' && range.selector.start === 60.5 && range.selector.end === 75 && !!range.selector.region, `${JSON.stringify(moment.selector)} / ${JSON.stringify(range.selector)}`)
  const bad = await call('annotate_video', { video_id: video.id, start: 1, comment: 'x', region: { x: 2, y: 2, width: 1, height: 1 } }).then(() => null, (e) => e.message)
  check('a region outside the frame is refused', /outside the frame/.test(String(bad)), String(bad).slice(0, 80))

  // Audio: a Spotify track has a timeline; an artist does not.
  const track = await call('create_audio', { url: 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp', tags: ['smoke-media'], open: false })
  check('a Spotify track is registered and timed', track.type === 'audio' && track.spotifyType === 'track' && track.timed === true, JSON.stringify(track).slice(0, 140))
  const clip = await call('annotate_audio', { audio_id: track.id, start: 30, end: 45, comment: 'Bridge', tags: ['clip'] })
  check('a range is pinned on the track', clip.selector?.kind === 'time' && clip.selector.start === 30 && clip.selector.end === 45 && clip.annotations === 1, JSON.stringify(clip.selector))
  const artist = await call('create_audio', { url: 'spotify:artist:0OdUWJ0sBjDrqHygGUXeCF', open: false })
  const untimed = await call('annotate_audio', { audio_id: artist.id, start: 1, comment: 'x' }).then(() => null, (e) => e.message)
  check('an artist has no timeline to pin on', artist.timed === false && /no single timeline/.test(String(untimed)), String(untimed).slice(0, 80))

  // Image: a same-origin file, so the browser can read its size; a box in its pixels.
  const image = await call('create_image', { url: `${await evaluate('location.origin')}/favicon.svg`, title: 'Smoke favicon', open: false })
  const looked = await call('view_image', { id: image.id })
  const size = Array.isArray(looked) ? JSON.parse(looked.find((b) => b.type === 'text')?.text ?? '{}') : looked
  check('an image is registered and its size read', image.type === 'image' && (size.width ?? 0) > 0 && (size.height ?? 0) > 0, JSON.stringify({ w: size.width, h: size.height }))
  const box = await call('annotate_image', { image_id: image.id, x: 2, y: 2, width: 10_000, height: 10_000, comment: 'Most of it', tags: ['region'] })
  check('a box is clamped to the image and kept as a region selector', box.box && box.box.x === 2 && box.box.width <= size.width - 2 && box.box.height <= size.height - 2, JSON.stringify(box.box))

  // Every annotation, three ways: on the entity, in the Library, in the inspector.
  const onVideo = (await call('get_entity', { id: video.id })).relationships.filter((r) => r.type === 'annotates')
  check('the video lists its two annotations with their selectors', onVideo.length === 2 && onVideo.every((r) => r.selector?.kind === 'time' && r.direction === 'in'), onVideo.map((r) => `${r.direction} ${JSON.stringify(r.selector)}`).join(', '))
  const rows = await call('search_entities', { type: 'annotation', library: true, limit: 50 })
  const mine = rows.results.filter((a) => [moment.id, range.id, clip.id, box.id].includes(a.id))
  check("the Library's annotation rows hold all four", mine.length === 4, `${mine.length} of ${rows.results.length} annotation rows`)
  await call('inspect', { id: video.id, tab: 'annotations' })
  await sleep(1200)
  const shown = await evaluate(`JSON.stringify({ rows: document.querySelectorAll('.antab .antab__where, .antab').length, text: (document.querySelector('.antab')?.textContent ?? '').includes('Dance break') })`).then(JSON.parse)
  check("the inspector's Annotations tab shows them", shown.rows > 0 && shown.text === true, `${JSON.stringify(shown)} at ${await evaluate('location.pathname + location.search')}`)

  const made = [moment.id, range.id, clip.id, box.id, video.id, track.id, artist.id, image.id]
  await call('delete_entities', { ids: made })
  await tidied(evaluate, made, wasHolding)
}
