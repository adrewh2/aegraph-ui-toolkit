import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type Entity, type EntityId } from '../../core/entity/types'
import type { AnnotationData } from '../../core/resources/types'

/**
 * Frame stills. A YouTube iframe is cross-origin, so its pixels can't be
 * read from a canvas; the only in-browser route is tab capture. One share
 * prompt opens a stream that stays alive for the page session, so later
 * captures are instant.
 */

export const captureSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

export interface Still {
  dataUrl: string
  width: number
  height: number
}

export class FrameCapturer {
  private stream: MediaStream | null = null
  private video: HTMLVideoElement | null = null
  /** Bumped by `stop`, so a share that is granted after it (the page left while the picker was open) is ended, not kept. */
  private gen = 0

  get active() {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live')
  }

  /** Ask once for this tab; reuse afterwards. */
  private async ensure(): Promise<HTMLVideoElement> {
    if (this.video && this.active) return this.video
    this.stop()
    if (!captureSupported()) throw new Error('Screen capture is not available in this browser.')
    const gen = this.gen
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: 30 },
      audio: false,
      // Chrome: preselect this tab in the picker and keep the page from being listed twice.
      ...({ preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' } as object),
    })
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    const ended = () => {
      stream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
      return new Error('Frame capture was stopped.')
    }
    if (gen !== this.gen) throw ended()
    await video.play()
    if (gen !== this.gen) throw ended()
    stream.getVideoTracks()[0].addEventListener('ended', () => this.stop())
    this.stream = stream
    this.video = video
    return video
  }

  /** Grab what's currently on screen inside `el`, as a JPEG data URL. */
  async capture(el: HTMLElement, quality = 0.92): Promise<Still> {
    const video = await this.ensure()
    // Give the compositor a moment so the capture reflects the current paint.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }))
    const rect = el.getBoundingClientRect()
    const sx = video.videoWidth / window.innerWidth
    const sy = video.videoHeight / window.innerHeight
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(rect.width * sx))
    canvas.height = Math.max(1, Math.round(rect.height * sy))
    canvas.getContext('2d')!.drawImage(video, rect.left * sx, rect.top * sy, rect.width * sx, rect.height * sy, 0, 0, canvas.width, canvas.height)
    return { dataUrl: canvas.toDataURL('image/jpeg', quality), width: canvas.width, height: canvas.height }
  }

  stop() {
    this.gen++
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    if (this.video) {
      this.video.srcObject = null
      this.video = null
    }
  }
}

/** Attach a still to an annotation: the frame, plus its size so regions can be cropped later. */
export function attachStill(store: EntityStore, annotationId: EntityId, still: Still): Entity<AnnotationData> | undefined {
  const a = store.get(annotationId)
  if (!a || isRelationship(a)) return undefined
  return store.update<Entity<AnnotationData>>(annotationId, { data: { ...(a.data as AnnotationData), imageUrl: still.dataUrl, imageWidth: still.width, imageHeight: still.height } })
}

/** The still saved with an annotation, if any. */
export function stillOf(a: Entity<AnnotationData>): (Still & { region?: { x: number; y: number; width: number; height: number } }) | undefined {
  const { imageUrl, imageWidth, imageHeight } = a.data
  if (typeof imageUrl !== 'string' || !imageUrl || typeof imageWidth !== 'number' || typeof imageHeight !== 'number') return undefined
  return { dataUrl: imageUrl, width: imageWidth, height: imageHeight }
}
