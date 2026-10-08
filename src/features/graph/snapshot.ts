export interface SnapshotOptions {
  width?: number
  height?: number
  /** CSS colour; 'transparent' for none. */
  background?: string
}

/** PNG o itself: small enough to live in the entity (a JPEG data: URL, tens of kilobytes). */
export const PREVIEW_WIDTH = 320
export const PREVIEW_HEIGHT = 200

/** A PNG blob of any size drawn onto a canvas of the preview's size (cover, centred) over the page background, as a JPEG data: URL. */
export async function previewDataUrl(blob: Blob, width = PREVIEW_WIDTH, height = PREVIEW_HEIGHT, background = '#faf9f6'): Promise<string> {
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const ctx = c.getContext('2d')!
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)
  const scale = Math.max(width / bmp.width, height / bmp.height)
  const w = bmp.width * scale
  const h = bmp.height * scale
  ctx.drawImage(bmp, (width - w) / 2, (height - h) / 2, w, h)
  bmp.close?.()
  return c.toDataURL('image/jpeg', 0.85)
}
