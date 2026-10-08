import { useEffect, useState } from 'react'
import { cssImageUrl, useImageGate } from '../../components/imageGate'
import type { Box, ImageEntity } from './images'
import './images.css'

const probed = new Map<string, { width: number; height: number }>()

/** Natural size for images whose entity doesn't record one yet (URL imports that couldn't be probed cross-origin). */
function useNaturalSize(src: string, known: { width?: number; height?: number }) {
  const [size, setSize] = useState(() => (known.width && known.height ? { width: known.width, height: known.height } : probed.get(src)))
  useEffect(() => {
    if (size || !src) return
    const img = new Image()
    img.onload = () => {
      const s = { width: img.naturalWidth, height: img.naturalHeight }
      probed.set(src, s)
      setSize(s)
    }
    img.referrerPolicy = 'no-referrer'
    img.src = src
    return () => {
      img.onload = null
    }
  }, [src, size])
  return size
}

/** A thumbnail of one region of an image, cropped with CSS from the full image. */
export function Crop({ image, box, size = 56 }: { image: ImageEntity; box: Box; size?: number }) {
  // The image's address is data: drawn only where `useImageGate` would show it (another host waits for the viewer's click).
  const gate = useImageGate(image.data.src, { providers: true })
  const src = gate?.status === 'show' ? gate.src : ''
  const dims = useNaturalSize(src, image.data)
  const w = dims?.width
  const h = dims?.height
  if (!src) return <span className="ip__crop ip__crop--empty" title={gate?.status === 'off' ? 'Not loaded: Third-party services is off' : `The image is on ${gate?.status === 'ask' ? gate.host : 'no address that can be shown'} — load it in its viewer`} />
  if (!w || !h) return <span className="ip__crop ip__crop--empty" title="Loading image…" />
  const k = Math.min(size / box.width, size / box.height)
  return (
    <span
      className="ip__crop"
      style={{
        width: Math.max(8, box.width * k),
        height: Math.max(8, box.height * k),
        backgroundImage: cssImageUrl(src),
        backgroundSize: `${w * k}px ${h * k}px`,
        backgroundPosition: `-${box.x * k}px -${box.y * k}px`,
      }}
    />
  )
}

