import { Fragment, memo, useMemo, type ReactNode } from 'react'
import { imageKind, parseMarkdown, safeUrl, type MdBlock, type MdInline } from '../lib/markdown'
import { RemoteImage } from './RemoteImage'
import './Markdown.css'

/** A passage to mark in the rendered output — e.g. an annotation's quoted text. */
export interface Highlight {
  id: string
  exact: string
  color?: string
  title?: string
}

interface Props {
  source: string
  highlights?: Highlight[]
  onHighlightClick?: (id: string) => void
  className?: string
  /**
   * Load images from other hosts straight away. Only for text the app itself
   * wrote (the docs pages): an image URL is a request someone else chose,
   * carrying whatever they put in it, so by default a remote image waits for
   * a click.
   */
  remoteImages?: boolean
}

/**
 * Renders Markdown as React elements straight from the AST. No HTML string
 * is ever built, so untrusted documents can't inject markup; URLs are
 * filtered through `safeUrl`, and a remote image loads only when clicked
 * (`imageKind`).
 */
export const Markdown = memo(function Markdown({ source, highlights, onHighlightClick, className, remoteImages = false }: Props) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  const ctx: Ctx = { highlights: (highlights ?? []).filter((h) => h.exact), onHighlightClick, remoteImages }
  return <div className={`md ${className ?? ''}`}>{blocks.map((b, i) => renderBlock(b, i, ctx))}</div>
})

interface Ctx {
  highlights: Highlight[]
  onHighlightClick?: (id: string) => void
  remoteImages: boolean
}

function renderBlock(b: MdBlock, key: number, ctx: Ctx): ReactNode {
  switch (b.t) {
    case 'heading': {
      const Tag = `h${b.level}` as 'h1'
      return (
        <Tag key={key} id={b.id}>
          {renderInlines(b.c, ctx)}
        </Tag>
      )
    }
    case 'paragraph':
      return <p key={key}>{renderInlines(b.c, ctx)}</p>
    case 'code':
      return (
        <pre key={key} data-lang={b.lang}>
          <code className={b.lang ? `language-${b.lang}` : undefined}>{renderText(b.v, ctx)}</code>
        </pre>
      )
    case 'quote':
      return <blockquote key={key}>{b.c.map((c, i) => renderBlock(c, i, ctx))}</blockquote>
    case 'hr':
      return <hr key={key} />
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul'
      return (
        <Tag key={key} start={b.start}>
          {b.items.map((it, i) => (
            <li key={i} className={it.checked !== undefined ? 'md-task' : undefined}>
              {it.checked !== undefined && <input type="checkbox" checked={it.checked} readOnly tabIndex={-1} />}
              {renderItemBody(it.c, ctx)}
            </li>
          ))}
        </Tag>
      )
    }
    case 'table':
      return (
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} style={b.align[i] ? { textAlign: b.align[i] } : undefined}>
                    {renderInlines(c, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={b.align[ci] ? { textAlign: b.align[ci] } : undefined}>
                      {renderInlines(c, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

/** A list item that holds only one paragraph renders it inline (tight list). */
function renderItemBody(blocks: MdBlock[], ctx: Ctx): ReactNode {
  if (blocks.length === 0) return null
  const [first, ...rest] = blocks
  if (first.t === 'paragraph') {
    return (
      <>
        {renderInlines(first.c, ctx)}
        {rest.map((b, i) => renderBlock(b, i + 1, ctx))}
      </>
    )
  }
  return blocks.map((b, i) => renderBlock(b, i, ctx))
}

function renderInlines(nodes: MdInline[], ctx: Ctx): ReactNode {
  return nodes.map((n, i) => renderInline(n, i, ctx))
}

function renderInline(n: MdInline, key: number, ctx: Ctx): ReactNode {
  switch (n.t) {
    case 'text':
      return <Fragment key={key}>{renderText(n.v, ctx)}</Fragment>
    case 'code':
      return <code key={key}>{renderText(n.v, ctx)}</code>
    case 'strong':
      return <strong key={key}>{renderInlines(n.c, ctx)}</strong>
    case 'em':
      return <em key={key}>{renderInlines(n.c, ctx)}</em>
    case 'del':
      return <del key={key}>{renderInlines(n.c, ctx)}</del>
    case 'br':
      return <br key={key} />
    case 'link': {
      const href = safeUrl(n.href)
      if (!href) return <span key={key}>{renderInlines(n.c, ctx)}</span>
      const external = /^(https?|mailto|tel):/i.test(href)
      return (
        <a key={key} href={href} title={n.title} target={external ? '_blank' : undefined} rel={external ? 'noreferrer noopener' : undefined}>
          {renderInlines(n.c, ctx)}
        </a>
      )
    }
    case 'image': {
      const src = safeUrl(n.src, { image: true })
      if (!src) return <span key={key}>[{n.alt}]</span>
      if (!ctx.remoteImages && imageKind(src) === 'remote') return <RemoteImage key={key} src={src} alt={n.alt} title={n.title} />
      return <img key={key} src={src} alt={n.alt} title={n.title} loading="lazy" />
    }
  }
}

/** Splits a text run around highlighted passages. */
function renderText(v: string, ctx: Ctx): ReactNode {
  if (ctx.highlights.length === 0 || !v) return v
  const parts: ReactNode[] = []
  let pos = 0
  let k = 0
  while (pos < v.length) {
    let best: { h: Highlight; at: number } | undefined
    for (const h of ctx.highlights) {
      const at = v.indexOf(h.exact, pos)
      if (at >= 0 && (!best || at < best.at)) best = { h, at }
    }
    if (!best) break
    if (best.at > pos) parts.push(v.slice(pos, best.at))
    const { h } = best
    parts.push(
      <mark
        key={k++}
        className="md-hl"
        data-highlight={h.id}
        title={h.title}
        style={h.color ? { background: h.color } : undefined}
        onClick={ctx.onHighlightClick ? () => ctx.onHighlightClick!(h.id) : undefined}
        role={ctx.onHighlightClick ? 'button' : undefined}
      >
        {v.slice(best.at, best.at + h.exact.length)}
      </mark>,
    )
    pos = best.at + h.exact.length
  }
  if (parts.length === 0) return v
  if (pos < v.length) parts.push(v.slice(pos))
  return parts
}
