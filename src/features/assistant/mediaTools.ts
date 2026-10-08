import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import type { BetaImageBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { displayLabel } from '../../core/entity/entity'
import { annotateImage as annotateImageRegion, importImageUrl, isImage, normalizeBox, regionAnnotationsOf, type ImageEntity } from '../images/images'
import { annotateAudio as annotateAudioAt, importSpotify, isAudio, isTimed, timeAnnotationsOf as audioAnnotationsOf } from '../audio/audio'
import { getAudioPlayback, getAudioPlayerHandle } from '../audio/playback'
import { attachStill } from '../videos/capture'
import { getPlayback, getPlayerHandle } from '../videos/playback'
import { annotateVideo as annotateVideoAt, importYouTube, isVideo, normalizeFrameBox } from '../videos/videos'
import { approveHandedUrl, blobToBase64, json, requireEntity, summarize, openMade } from './toolkit'
import type { AppHost } from './tools'

/**
 * Images, videos and audio: view, annotate, create, capture frames, control playback.
 */

/** The formats the model reads as a picture. */
const MODEL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
/** The largest picture fetched to be looked at: the model takes about this much in one image. */
export const MAX_VIEW_IMAGE_BYTES = 5 * 1024 * 1024

type ViewBlock = BetaImageBlockParam | { type: 'text'; text: string }

/**
 * The image as a content block, always as its pixels — never as an address for whoever reads the result to fetch: the
 * Claude API, or the bridge on the developer's machine, would then reach a host from the data with no one asked, and
 * an image entity's address is anyone's to write (a bundle, a page the model read). Inline data is sent as it is; a
 * remote picture is fetched here, after the same question as any URL a tool is handed (`approveHandedUrl`: this site
 * goes straight through, another one needs Third-party services and the user's yes, naming the host). Declined,
 * unreadable or too big, it is described in words instead.
 */
async function imageBlock(host: Pick<AppHost, 'confirm'>, e: ImageEntity): Promise<ViewBlock> {
  const src = e.data.src
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i.exec(src)
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1].toLowerCase() as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: m[2] } }
  if (src.startsWith('data:')) {
    // Other inline formats (svg, avif) get rasterised to PNG through a canvas.
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('The image could not be decoded.'))
      i.src = src
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, 0, 0)
    return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: canvas.toDataURL('image/png').split(',')[1] } }
  }
  const notSeen = (why: string): ViewBlock => ({ type: 'text', text: `[The picture itself is not included: ${why} Its size and annotations above still hold.]` })
  let url: string
  try {
    url = await approveHandedUrl(host, src, 'Looking at an image')
  } catch (err) {
    return notSeen(err instanceof Error ? err.message : String(err))
  }
  let res: Response
  try {
    res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
  } catch {
    return notSeen(`${new URL(url).host} does not let the app read the picture (no CORS), so it is shown on the page but cannot be sent.`)
  }
  if (!res.ok) return notSeen(`fetching it answered ${res.status}.`)
  const declared = Number(res.headers.get('content-length'))
  if (declared > MAX_VIEW_IMAGE_BYTES) return notSeen(`it is ${Math.round(declared / 1048576)} MB, more than the ${MAX_VIEW_IMAGE_BYTES / 1048576} MB sent to look at.`)
  const blob = await res.blob()
  const type = (blob.type || res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!(MODEL_IMAGE_TYPES as readonly string[]).includes(type)) return notSeen(`it is ${type || 'of no stated type'}, not a PNG, JPEG, GIF or WebP.`)
  if (blob.size > MAX_VIEW_IMAGE_BYTES) return notSeen(`it is ${Math.round(blob.size / 1048576)} MB, more than the ${MAX_VIEW_IMAGE_BYTES / 1048576} MB sent to look at.`)
  return { type: 'image', source: { type: 'base64', media_type: type as (typeof MODEL_IMAGE_TYPES)[number], data: await blobToBase64(blob) } }
}


export function createMediaTools(host: AppHost) {
  const { store } = host

  const viewImage = betaTool({
    name: 'view_image',
    description: "Look at an image entity. Returns the picture itself plus its size and existing region annotations (boxes in pixel coordinates, origin top-left). Use it before annotate_image so boxes land on the right pixels. A picture kept by address on another site is fetched by the app only with Third-party services on and the user's yes to a question naming the host; declined, or when the host does not let the app read it, the result says so in words instead of the picture.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } as const,
    run: async ({ id }) => {
      const e = requireEntity(store, id)
      if (!isImage(e)) throw new Error(`Entity ${id} is a ${e.type}, not an image.`)
      const meta = {
        id: e.id,
        label: displayLabel(e),
        width: e.data.width,
        height: e.data.height,
        mimeType: e.data.mimeType,
        tags: e.tags,
        annotations: regionAnnotationsOf(store, e.id).map((a, i) => ({ n: i + 1, id: a.annotation.id, comment: a.annotation.data.comment, box: { x: a.region.x, y: a.region.y, width: a.region.width, height: a.region.height }, tags: a.annotation.tags })),
        note: 'Coordinates are pixels of the original image, origin top-left.',
      }
      return [{ type: 'text', text: json(meta) }, await imageBlock(host, e)]
    },
  })

  const annotateImage = betaTool({
    name: 'annotate_image',
    description: 'Draw a box on an image and attach a comment to it. Coordinates are pixels of the original image (see view_image for its size); the box is clamped to the image. Creates an annotation entity linked by an "annotates" relationship with a region selector.',
    inputSchema: {
      type: 'object',
      properties: {
        image_id: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        comment: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['image_id', 'x', 'y', 'width', 'height', 'comment'],
      additionalProperties: false,
    } as const,
    run: ({ image_id, x, y, width, height, comment, tags }) => {
      const e = requireEntity(store, image_id)
      if (!isImage(e)) throw new Error(`Entity ${image_id} is a ${e.type}, not an image.`)
      const w = e.data.width ?? Number.POSITIVE_INFINITY
      const h = e.data.height ?? Number.POSITIVE_INFINITY
      const box = normalizeBox({ x, y, width, height }, w, h)
      if (!box) throw new Error('The box is empty or entirely outside the image.')
      const a = annotateImageRegion(store, e, box, comment, tags ?? [], 'assistant')
      return json({ ...summarize(a), box })
    },
  })

  const createImage = betaTool({
    name: 'create_image',
    description:
      'Add an image to the project and open it: by URL (registered; size read if the host allows cross-origin loading), or the file itself as a data: URL (kept inline, as when the user attaches or drops an image in the chat; up to 10 MB). Loading an image is a request to its host, so a URL on another site needs Third-party services on and the user\'s yes to a question naming the host before anything is loaded; declined, nothing is created. Returns the new id.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) address of the image (another site is put to the user first), or data:image/…;base64,… for the picture itself' }, title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, open: { type: 'boolean', description: 'Navigate to it after creating (default true)' } },
      required: ['url'],
      additionalProperties: false,
    } as const,
    run: async ({ url, title, tags, open }) => {
      // The picture itself travels in the call; an address is a request to its host, asked about before any probe.
      const src = /^\s*data:/i.test(url) ? url : await approveHandedUrl(host, url, 'Adding an image')
      const e = await importImageUrl(store, src, title, { approved: true })
      if (tags?.length) store.update(e.id, { tags })
      if (open !== false) openMade(host, e.id, `/images/${e.id}`)
      return json(summarize(store.get(e.id) ?? e))
    },
  })

  const annotateVideoTool = betaTool({
    name: 'annotate_video',
    description:
      'Annotate a moment in a YouTube video (start in seconds, optional end for a span), optionally narrowed to a region of the frame given as fractions 0–1 of width/height. Use get_app_context for the current playhead when the user says "here" or "this moment". Creates an annotation entity linked by an "annotates" relationship with a time selector.',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: { type: 'string' },
        start: { type: 'number', description: 'Seconds' },
        end: { type: 'number', description: 'Seconds; omit for a single moment' },
        comment: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        region: {
          type: 'object',
          description: 'Part of the frame, as fractions of width/height from the top-left',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
      },
      required: ['video_id', 'start', 'comment'],
      additionalProperties: false,
    } as const,
    run: ({ video_id, start, end, comment, tags, region }) => {
      const e = requireEntity(store, video_id)
      if (!isVideo(e)) throw new Error(`Entity ${video_id} is a ${e.type}, not a video.`)
      const box = region ? normalizeFrameBox(region) : undefined
      if (region && !box) throw new Error('The region is empty or outside the frame; use fractions between 0 and 1.')
      const a = annotateVideoAt(store, e, { start, end, region: box ?? undefined }, comment, tags ?? [], 'assistant')
      return json({ ...summarize(a), selector: store.relationshipsOf(a.id, 'out')[0]?.target.selector })
    },
  })

  const captureVideoFrame = betaTool({
    name: 'capture_video_frame',
    description:
      'Save a still of the video open in the player at the current moment (or seek to `time` first) as an annotation, and return the picture so you can see it. Uses tab capture; the browser may ask the user to share the tab the first time.',
    inputSchema: {
      type: 'object',
      properties: { time: { type: 'number', description: 'Seconds to seek to before capturing; omit for the current playhead' }, comment: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    } as const,
    run: async ({ time, comment, tags }) => {
      const handle = getPlayerHandle()
      const pb = getPlayback()
      if (!handle || !pb) throw new Error('No video is open in the player. Use open with the video id first.')
      const video = store.get(pb.videoId)
      if (!isVideo(video)) throw new Error('The open video entity is missing.')
      if (time != null) {
        handle.seek(time)
        handle.pause()
        await new Promise((r) => setTimeout(r, 900))
      }
      const at = time ?? pb.currentTime
      const still = await handle.capture()
      if (!still) throw new Error('The frame could not be captured (tab capture declined or unsupported).')
      const a = annotateVideoAt(store, video, { start: at }, comment ?? '', tags ?? ['still'], 'assistant')
      attachStill(store, a.id, still)
      const m = /^data:(image\/jpeg|image\/png);base64,(.+)$/.exec(still.dataUrl)
      const blocks: (BetaImageBlockParam | { type: 'text'; text: string })[] = [{ type: 'text', text: json({ ...summarize(store.get(a.id) ?? a), time: at, still: { width: still.width, height: still.height } }) }]
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1] as 'image/jpeg' | 'image/png', data: m[2] } })
      return blocks
    },
  })

  const createVideo = betaTool({
    name: 'create_video',
    description: 'Register a YouTube video by URL (watch, share, shorts, or embed link) and open it. Title and channel come from oEmbed when available.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, open: { type: 'boolean', description: 'Navigate to it after creating (default true)' } },
      required: ['url'],
      additionalProperties: false,
    } as const,
    run: async ({ url, tags, open }) => {
      const { entity, existed } = await importYouTube(store, url, { tags, source: 'assistant' })
      if (open !== false) openMade(host, entity.id, `/videos/${entity.id}`)
      return json({ ...summarize(entity), existed })
    },
  })

  const createAudio = betaTool({
    name: 'create_audio',
    description: 'Register a Spotify track, album, playlist, episode, show, or artist by link (open.spotify.com URL or spotify: URI) and open it. Title, artist and artwork come from Spotify oEmbed when available. Only tracks and episodes have a timeline that annotate_audio can address.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, open: { type: 'boolean', description: 'Navigate to it after creating (default true)' } },
      required: ['url'],
      additionalProperties: false,
    } as const,
    run: async ({ url, tags, open }) => {
      const { entity, existed } = await importSpotify(store, url, { tags, source: 'assistant' })
      if (open !== false) openMade(host, entity.id, `/audio/${entity.id}`)
      return json({ ...summarize(entity), existed, spotifyType: entity.data.spotifyType, timed: isTimed(entity.data.spotifyType) })
    },
  })

  const annotateAudioTool = betaTool({
    name: 'annotate_audio',
    description:
      'Annotate a moment (start in seconds) or a range (start–end) of a Spotify track or podcast episode. Use get_app_context for the current playhead when the user says "here" or "this part". Creates an annotation entity linked by an "annotates" relationship with a time selector; it shows on the range timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        audio_id: { type: 'string' },
        start: { type: 'number', description: 'Seconds' },
        end: { type: 'number', description: 'Seconds; omit for a single moment' },
        comment: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['audio_id', 'start', 'comment'],
      additionalProperties: false,
    } as const,
    run: ({ audio_id, start, end, comment, tags }) => {
      const e = requireEntity(store, audio_id)
      if (!isAudio(e)) throw new Error(`Entity ${audio_id} is a ${e.type}, not audio.`)
      if (!isTimed(e.data.spotifyType)) throw new Error(`This is a Spotify ${e.data.spotifyType}, which has no single timeline. Annotate one of its tracks instead, or use create_relationship/create_entity for a note about the whole ${e.data.spotifyType}.`)
      const a = annotateAudioAt(store, e, { start, end }, comment, tags ?? [], 'assistant')
      return json({ ...summarize(a), selector: store.relationshipsOf(a.id, 'out')[0]?.target.selector, annotations: audioAnnotationsOf(store, e.id).length })
    },
  })

  const controlPlayback = betaTool({
    name: 'control_playback',
    description: 'Play, pause, or seek the video or audio open in the player. Picks whichever player is open; say which with `media` when both could be. Returns the playhead afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'seek', 'status'] },
        time: { type: 'number', description: 'Seconds, for seek (also plays from there if `play` is true)' },
        play: { type: 'boolean', description: 'With seek: start playing after seeking' },
        media: { type: 'string', enum: ['video', 'audio'] },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, time, play, media }) => {
      const video = getPlayerHandle() && getPlayback() ? { kind: 'video' as const, handle: getPlayerHandle()!, state: () => getPlayback() } : null
      const audio = getAudioPlayerHandle() && getAudioPlayback() ? { kind: 'audio' as const, handle: getAudioPlayerHandle()!, state: () => getAudioPlayback() } : null
      const target = media === 'video' ? video : media === 'audio' ? audio : (video ?? audio)
      if (!target) throw new Error('No video or audio is open in a player. Use open with the entity id first.')
      if (action === 'seek') {
        if (time == null) throw new Error('Provide `time` in seconds to seek.')
        target.handle.seek(Math.max(0, time))
        if (play) target.handle.play()
      } else if (action === 'play') target.handle.play()
      else if (action === 'pause') target.handle.pause()
      // Let the player report back before reading the playhead.
      if (action !== 'status') await new Promise((r) => setTimeout(r, 250))
      const st = target.state()
      return json({ media: target.kind, ...(st ?? {}), ...(action === 'seek' ? { seekedTo: Math.max(0, time ?? 0) } : {}) })
    },
  })

  return [viewImage, annotateImage, createImage, annotateVideoTool, captureVideoFrame, createVideo, createAudio, annotateAudioTool, controlPlayback]
}
