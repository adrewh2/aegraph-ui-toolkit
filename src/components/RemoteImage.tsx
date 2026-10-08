import { type CSSProperties, type MouseEvent, type ReactEventHandler } from 'react'
import { imageKind } from '../lib/markdown'
import { allowRemoteImage, useImageGate, type ImageGate } from './imageGate'
import './RemoteImage.css'

interface ImgProps {
  alt?: string
  title?: string
  className?: string
  style?: CSSProperties
  loading?: 'lazy' | 'eager'
  decoding?: 'async' | 'sync' | 'auto'
  draggable?: boolean
  onLoad?: ReactEventHandler<HTMLImageElement>
  onError?: ReactEventHandler<HTMLImageElement>
  /** A thumbnail: the stand-in says "load" with the host in its tooltip, rather than the host in its text. */
  compact?: boolean
}

/** The stand-in for a picture not shown: a button that loads it, or — with Third-party services off — a note. */
export function ImageStandIn({ gate, alt = '', compact, className }: { gate: Extract<ImageGate, { status: 'ask' | 'off' }>; alt?: string; compact?: boolean; className?: string }) {
  const cls = `md-remote-img${compact ? ' md-remote-img--compact' : ''}${className ? ` ${className}` : ''}`
  if (gate.status === 'off') {
    const why = `Not loaded: the image is on ${gate.host}, and Third-party services is off in your account settings`
    return (
      <span className={`${cls} is-off`} title={why} role="img" aria-label={why}>
        {compact ? 'offline' : `image${alt ? ` “${alt}”` : ''} from ${gate.host} — Third-party services is off`}
      </span>
    )
  }
  const load = (e: MouseEvent) => {
    // In a table row or a card, the click is the image's, not the row's.
    e.stopPropagation()
    allowRemoteImage(gate.src)
  }
  return (
    <button type="button" className={cls} title={`Load ${gate.src}`} onClick={load}>
      {compact ? 'load image' : `image${alt ? ` “${alt}”` : ''} from ${gate.host} — load`}
    </button>
  )
}

function Img({ src, remote, alt = '', title, className, style, loading, decoding, draggable, onLoad, onError }: ImgProps & { src: string; remote: boolean }) {
  // A picture from another host is sent no referrer: the address of the page it sits on is the reader's, not its.
  return <img src={src} alt={alt} title={title} className={className} style={style} loading={loading} decoding={decoding} draggable={draggable} onLoad={onLoad} onError={onError} referrerPolicy={remote ? 'no-referrer' : undefined} />
}

/**
 * A picture from another host, named until the reader asks for it: loading it is a request to that host, carrying
 * whatever the URL carries — the way a text someone else wrote (a model's answer, an imported chat, a property value
 * in a bundle) would send data out with no click. With Third-party services off it is not loaded at all. Once asked
 * for, it is an ordinary `<img>` with the props given.
 */
export function RemoteImage({ src, ...img }: ImgProps & { src: string }) {
  const gate = useImageGate(src)
  if (!gate) return <span className="faint">{src}</span>
  if (gate.status !== 'show') return <ImageStandIn gate={gate} alt={img.alt} compact={img.compact} />
  return <Img src={gate.src} remote {...img} />
}

/**
 * An image whose URL came from data — an entity's image property, an image's `src`, a video's thumbnail, a still on
 * an annotation. A picture carried in the data or served by this origin shows at once; one on another host waits for
 * a click (`RemoteImage`), and none loads while Third-party services is off. With `providers`, a provider's own
 * thumbnail (`PROVIDER_IMAGE_HOSTS`) shows at once while the switch is on. Anything that is not an image URL shows
 * as its text.
 */
export function DataImage({ src, providers, ...img }: ImgProps & { src: unknown; providers?: boolean }) {
  const gate = useImageGate(src, { providers })
  if (!gate) return <span className="faint">{typeof src === 'string' && !img.compact ? src : ''}</span>
  if (gate.status !== 'show') return <ImageStandIn gate={gate} alt={img.alt} compact={img.compact} />
  return <Img src={gate.src} remote={imageKind(gate.src) === 'remote'} {...img} />
}
