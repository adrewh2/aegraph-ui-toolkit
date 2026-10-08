/**
 * Make a rendered SVG safe to draw.
 *
 * A diagram's source is data: it arrives in a bundle someone sent, a demo, an
 * import, or from the model. What Graphviz and Mermaid make of it cannot be
 * trusted either: Graphviz turns DOT's `URL="…"` into a link and writes
 * `fontname` into `font-family` without escaping it, so a source can close the
 * attribute and write a `<style>` of its own; Mermaid lets a diagram carry
 * CSS. Mermaid is asked for `securityLevel: 'strict'` and the renderers'
 * inputs are checked (`features/diagrams/render.ts`), but everything drawn
 * goes through here first, and the app draws a picture as an image
 * (`<img src="data:image/svg+xml,…">`), never as markup in the page.
 *
 * The picture is **rebuilt**, not edited: the string is read tag by tag (the
 * same in a test as in the browser — no DOM needed) and written out again
 * from an allow-list, so what comes out is well-formed XML made only of
 * things that draw:
 *
 * - **elements** — the SVG shapes, text, groups, gradients, markers,
 *   patterns, clips, masks and filter primitives. Anything else goes with
 *   its contents: `<script>`, `<foreignObject>` (HTML), `<image>` and
 *   `<feImage>` (a fetch), the animation elements (which can set an `href`),
 *   anything that loads another document;
 * - **attributes** — by name: no `on…` handler, no `src`, `srcdoc`, `ping`,
 *   `action`, `xml:base`; a link only on `<a>` (a fragment, a relative path,
 *   `http(s):` or `mailto:`, judged with references decoded), every other
 *   `href` a fragment in the picture; no value that loads anything —
 *   `url(…)` other than `url(#id)`, `image-set()`, `@import` — CSS escapes
 *   decoded first;
 * - **styles** — `style="…"` keeps the declarations that load nothing;
 *   `<style>` loses every `@import` and every declaration or selector that
 *   would load something or is written with a CSS escape;
 * - comments, processing instructions (`<?xml-stylesheet?>`), doctypes and
 *   whatever sits outside the root `<svg>` are dropped; text and values are
 *   written back escaped.
 *
 * Then it **fails closed**: a document it cannot read (a tag or a comment
 * left open, a doctype with its own entities), or one where anything that
 * looks executable is still there, is refused rather than shown.
 */

/** A scheme a link in a picture may have. Anything else — `javascript:`, `data:`, `vbscript:`, `blob:` — is dropped. */
const SAFE_HREF = /^(?:#|\/(?![/\\])|\.{1,2}\/|https?:\/\/|mailto:)/i

/** The elements a picture may be made of, lower-cased → as SVG spells them. */
const ELEMENTS = new Map(
  [
    'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'switch', 'a', 'style',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath',
    'marker', 'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask',
    'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
  ].map((n) => [n.toLowerCase(), n]),
)
/** HTML's void elements: no end tag follows them, so one met in a picture must not swallow the rest of it. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
/** Attributes with a prefix a picture may keep; every other name is a plain one. */
const PREFIXED = new Set(['xlink:href', 'xlink:title', 'xml:space', 'xml:lang', 'xmlns', 'xmlns:xlink'])
/** Attributes that are never kept: they run something, load something, or change where links resolve. */
const DENIED = /^(?:on.*|src|srcdoc|ping|action|formaction|xml:base|attributename)$/i
const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

/** What must not survive the rebuild; the picture is refused if it does. Scheme checks also run with character references decoded. */
const EXECUTABLE = [/<\s*script/i, /<\s*foreignobject/i, /<\s*(?:iframe|embed|object|image|img|link|feimage)\b/i, /[\s/"']on[a-z]+\s*=/i, /[\s/"']srcdoc\s*=/i]
const EXECUTABLE_SCHEME = [/javascript\s*:/i, /vbscript\s*:/i, /data:\s*text\/html/i]

/** The named references that can spell a scheme or hide one (`&colon;`, `&Tab;`, `&NewLine;`); numeric ones are decoded whatever they are. */
const NAMED: Record<string, string> = { colon: ':', tab: '\t', newline: '\n', sol: '/', bsol: '\\', lpar: '(', rpar: ')', period: '.', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', num: '#' }
/** Named references a label is likely to carry, for the text written back (a no-break space stays one). */
const TEXT_NAMED: Record<string, string> = { ...NAMED, nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×', divide: '÷', deg: '°', plusmn: '±', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔' }

const decodeWith = (names: Record<string, string>) => (s: string) =>
  s.replace(/&(?:#x([0-9a-f]+);?|#(\d+);?|([a-z][a-z0-9]*);)/gi, (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex || dec) {
      const code = hex ? parseInt(hex, 16) : parseInt(dec!, 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�'
    }
    return names[name!.toLowerCase()] ?? m
  })

/**
 * Character references decoded as the HTML parser decodes an attribute: numeric ones with or without their `;`,
 * named ones (those that matter here) with it. `jav&#x61;script:` is `javascript:` to the browser, so it is to the
 * scheme check. A reference not decoded here stays as it is, which starts no safe scheme — it fails closed.
 */
export const decodeReferences = decodeWith(NAMED)
const decodeText = decodeWith(TEXT_NAMED)

/** A value as the browser will read it for a scheme: references decoded, then whitespace and control characters (how `java\nscript:` got past a scheme check) gone. */
// eslint-disable-next-line no-control-regex
const schemeOf = (v: string) => decodeReferences(v).trim().replace(/[\s\u0000-\u001f\u007f-\u009f ]/g, '')

/** CSS escapes decoded (`\75 rl(` is `url(`), comments and whitespace gone, lower-cased: a value as CSS will tokenise it, for the checks. */
const cssText = (v: string) =>
  v
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_m, hex: string) => {
      const code = parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�'
    })
    .replace(/\\(.)/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '')
    .toLowerCase()

/** Whether this text, read as CSS, asks for something from elsewhere: `url(…)` other than `url(#id)`, `image-set()`, `src()`, `@import` — CSS escapes decoded first. */
export function cssFetches(v: string): boolean {
  const t = cssText(v)
  return /url\((?!['"]?#)/.test(t) || /image-set\(|src\(|@import/.test(t)
}

/** Whether CSS (or a presentation attribute, which is CSS) would load or run anything for this value: `cssFetches`, and the functions and properties that reach outside a picture another way. */
export function cssLoads(v: string): boolean {
  return cssFetches(v) || /image\(|cross-fade\(|element\(|expression\(|-moz-binding|behavior:/.test(cssText(v))
}

/** A `style="…"` as its declarations; with `safe`, only those that are a property and a value that loads nothing. */
const declarations = (v: string, safe: boolean) =>
  v
    .split(';')
    .map((d) => d.trim())
    .filter((d) => {
      if (!d) return false
      if (!safe) return true
      const m = /^(-?[a-z][a-z0-9-]*)\s*:([\s\S]*)$/i.exec(d)
      return !!m && !d.includes('\\') && !cssLoads(m[2])
    })
    .join('; ')
/** A `style="…"` with the declarations that load nothing; `''` when none is left. `.all` is the same without the check, to see whether anything went. */
const cleanStyleAttr = Object.assign((v: string) => declarations(v, true), { all: (v: string) => declarations(v, false) })

/** A stylesheet with every `@import`, and every selector or declaration that loads something or hides behind an escape, taken out. */
function cleanStylesheet(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@(?:import|namespace)\b[^;{}]*;?/gi, '')
    .replace(/[^{};]+/g, (seg) => (seg.includes('\\') || cssLoads(seg) ? '' : seg))
}

/**
 * The rules of a stylesheet that style this picture and nothing else: a selector must start with the root's id
 * (Mermaid scopes every rule so), `:root` may set custom properties only, `@keyframes` stay, `@media` and
 * `@supports` are scoped the same way inside. A picture is drawn as an image, where a stylesheet reaches nothing
 * else anyway; this is so that one mounted as markup by mistake still could not restyle the page around it.
 */
function scopeStylesheet(css: string, rootId: string | undefined): string {
  const out: string[] = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const prelude = css.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
    }
    const body = css.slice(open + 1, j - 1)
    i = j
    if (/^@(?:-webkit-)?keyframes\b/i.test(prelude)) out.push(`${prelude}{${body}}`)
    else if (/^@(?:media|supports)\b/i.test(prelude)) {
      const inner = scopeStylesheet(body, rootId)
      if (inner) out.push(`${prelude}{${inner}}`)
    } else if (prelude.startsWith('@')) continue
    else if (prelude === ':root') {
      const vars = body.split(';').filter((d) => /^\s*--[\w-]+\s*:/.test(d))
      if (vars.length) out.push(`:root{${vars.join(';')}}`)
    } else if (rootId) {
      const scoped = prelude.split(',').map((sel) => sel.trim()).filter((sel) => sel.startsWith(`#${rootId}`) && !/^[\w-]/.test(sel.slice(rootId.length + 1)))
      if (scoped.length) out.push(`${scoped.join(',')}{${body}}`)
    }
  }
  return out.join('')
}

// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
const escText = (s: string) => s.replace(NOT_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;')

export interface SafeSvg {
  /** The picture to draw, or `''` when it could not be made safe. */
  svg: string
  /** What was taken out, for the note the view shows and for a test to assert on. Empty when nothing was. */
  removed: string[]
  /** True when the whole picture was refused: it could not be read, or something executable survived. */
  refused: boolean
}

interface Tag {
  name: string
  attrs: [string, string][]
  selfClosing: boolean
}

class Unreadable extends Error {}

/** Read one start tag at `at` (the `<`); returns the tag and where it ends. */
function readTag(s: string, at: number): { tag: Tag; end: number } {
  let i = at + 1
  const nameMatch = /^[^\s/>]+/.exec(s.slice(i, i + 200))!
  const name = nameMatch[0]
  i += name.length
  const attrs: [string, string][] = []
  let selfClosing = false
  for (;;) {
    while (i < s.length && /[\s/]/.test(s[i])) {
      selfClosing = s[i] === '/'
      i++
    }
    if (i >= s.length) throw new Unreadable(`<${name}> is never closed`)
    if (s[i] === '>') return { tag: { name, attrs, selfClosing }, end: i + 1 }
    selfClosing = false
    // An attribute's name runs to whitespace, `/`, `>` or `=` — as the HTML parser reads it.
    const start = i
    i++
    while (i < s.length && !/[\s/>=]/.test(s[i])) i++
    const attr = s.slice(start, i)
    while (i < s.length && /\s/.test(s[i])) i++
    let value = ''
    if (s[i] === '=') {
      i++
      while (i < s.length && /\s/.test(s[i])) i++
      const q = s[i]
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, i + 1)
        if (close < 0) throw new Unreadable(`a value in <${name}> is never closed`)
        value = s.slice(i + 1, close)
        i = close + 1
      } else {
        const startV = i
        while (i < s.length && !/[\s>]/.test(s[i])) i++
        value = s.slice(startV, i)
      }
    }
    attrs.push([attr, decodeText(value)])
  }
}

/** The sanitised picture. `svg` is `''` when it was refused; `removed` names what went, in the order it was found. */
export function sanitizeSvg(svg: string): SafeSvg {
  if (!svg.trim()) return { svg: '', removed: [], refused: false }
  const removed: string[] = []
  const note = (what: string) => {
    if (!removed.includes(what)) removed.push(what)
  }
  const refuse = (why: string): SafeSvg => ({ svg: '', removed: [...removed, `refused: ${why}`], refused: true })

  const out: string[] = []
  /** Open elements, as written out. */
  const stack: string[] = []
  /** The element being dropped with its contents, and how many of its name are open inside it; 0 when writing. */
  let dropName = ''
  let dropping = 0
  let rootDone = false
  /** The root's id, which a stylesheet's selectors must start with. */
  let rootId: string | undefined
  const inStyle = () => stack[stack.length - 1] === 'style'
  const isOpen = (lower: string) => stack.some((n) => n.toLowerCase() === lower)

  const cleanCss = (css: string) => {
    const c = cleanStylesheet(css)
    if (c !== css.replace(/\/\*[\s\S]*?\*\//g, '')) note('style: what loads something')
    const scoped = scopeStylesheet(c, rootId)
    if (scoped.replace(/\s+/g, '') !== c.replace(/\s+/g, '')) note('style: rules outside the picture')
    return scoped
  }
  const writeText = (raw: string) => {
    if (dropping || !stack.length || rootDone) return
    const text = decodeText(raw)
    out.push(escText(inStyle() ? cleanCss(text) : text))
  }

  const open = (tag: Tag) => {
    const lower = tag.name.toLowerCase()
    const leaf = tag.selfClosing || VOID.has(lower)
    if (dropping) {
      if (lower === dropName && !leaf) dropping++
      return
    }
    const name = ELEMENTS.get(lower)
    if (rootDone || !name || (!stack.length && lower !== 'svg')) {
      note(`<${lower}>`)
      if (!leaf) {
        dropName = lower
        dropping = 1
      }
      return
    }
    const parts: string[] = [name]
    if (lower === 'svg') parts.push(`xmlns="${SVG_NS}"`)
    if (!stack.length) rootId = tag.attrs.find(([n]) => n.toLowerCase() === 'id')?.[1].trim() || undefined
    const seen = new Set<string>()
    for (const [rawName, value] of tag.attrs) {
      const attr = rawName.toLowerCase()
      if (seen.has(attr)) continue
      seen.add(attr)
      if (!(PREFIXED.has(attr) || /^[a-z_][a-z0-9_.-]*$/i.test(rawName)) || DENIED.test(attr)) {
        note(`${attr}=`)
        continue
      }
      // Written by the rebuild, with the only values they may have.
      if (attr === 'xmlns' || attr === 'xmlns:xlink') continue
      let v = value
      if (attr === 'href' || attr === 'xlink:href') {
        const scheme = schemeOf(v)
        if (!(lower === 'a' ? SAFE_HREF.test(scheme) : scheme.startsWith('#'))) {
          note(`${attr}=${scheme.slice(0, 40)}`)
          continue
        }
      } else if (attr === 'style') {
        const kept = cleanStyleAttr(v)
        if (kept !== cleanStyleAttr.all(v)) {
          note('style: what loads something')
          if (!kept) continue
          v = kept
        }
      } else if (cssLoads(v)) {
        note(`${attr}=${v.slice(0, 40)}`)
        continue
      }
      parts.push(`${rawName}="${escAttr(v)}"`)
    }
    if (leaf) {
      out.push(`<${parts.join(' ')}/>`)
      if (!stack.length) rootDone = true
      return
    }
    out.push(`<${parts.join(' ')}>`)
    stack.push(name)
  }

  const close = (rawName: string) => {
    const lower = rawName.toLowerCase()
    if (dropping) {
      // The end of the dropped element, or of something it sat in (a `<p>` left open inside the picture ends there).
      if (!isOpen(lower)) {
        if (lower === dropName) dropping--
        return
      }
      dropping = 0
    }
    if (!isOpen(lower)) return
    let top: string | undefined
    do {
      top = stack.pop()!
      out.push(`</${top}>`)
    } while (top.toLowerCase() !== lower)
    if (!stack.length) rootDone = true
  }

  try {
    let i = 0
    while (i < svg.length) {
      const lt = svg.indexOf('<', i)
      writeText(svg.slice(i, lt < 0 ? svg.length : lt))
      if (lt < 0) break
      const next = svg[lt + 1]
      if (svg.startsWith('<!--', lt)) {
        const end = svg.indexOf('-->', lt + 4)
        if (end < 0) throw new Unreadable('a comment is never closed')
        i = end + 3
      } else if (svg.startsWith('<![CDATA[', lt)) {
        const end = svg.indexOf(']]>', lt + 9)
        if (end < 0) throw new Unreadable('a CDATA section is never closed')
        // Character data is text as written: escaped, so the decode in writeText gives it back unchanged.
        writeText(svg.slice(lt + 9, end).replace(/&/g, '&amp;'))
        i = end + 3
      } else if (next === '!' || next === '?') {
        // A doctype or a processing instruction (`<?xml-stylesheet href=…?>` among them): dropped. A doctype that
        // declares entities of its own is not something to guess at.
        const end = svg.indexOf(next === '?' ? '?>' : '>', lt + 2)
        if (end < 0) throw new Unreadable('a declaration is never closed')
        if (next === '!' && svg.slice(lt, end).includes('[')) throw new Unreadable('a doctype declares entities')
        if (next === '?' && !/^<\?xml\s/i.test(svg.slice(lt, lt + 6))) note('<?…?>')
        i = end + (next === '?' ? 2 : 1)
      } else if (next === '/') {
        const end = svg.indexOf('>', lt)
        if (end < 0) throw new Unreadable('an end tag is never closed')
        const name = /^<\/\s*([^\s/>]*)/.exec(svg.slice(lt, end + 1))?.[1] ?? ''
        if (name) close(name)
        i = end + 1
      } else if (next && /[a-z]/i.test(next)) {
        const { tag, end } = readTag(svg, lt)
        open(tag)
        i = end
      } else {
        writeText('&lt;')
        i = lt + 1
      }
    }
  } catch (e) {
    if (e instanceof Unreadable) return refuse(e.message)
    throw e
  }
  while (stack.length) out.push(`</${stack.pop()}>`)

  let result = out.join('')
  if (/\sxlink:/.test(result)) result = result.replace(/^<svg\b/, `<svg xmlns:xlink="${XLINK_NS}"`)
  // Text is only ever text once rebuilt, so the last look is at the tags: their names and values, decoded too.
  const tags = (result.match(/<[^>]*>/g) ?? []).join('')
  const decoded = decodeReferences(tags)
  const names = tags.replace(/"[^"]*"/g, '""')
  const survived = EXECUTABLE.find((re) => re.test(names)) ?? EXECUTABLE_SCHEME.find((re) => re.test(tags) || re.test(decoded))
  if (survived) return refuse(String(survived))
  return { svg: result, removed, refused: false }
}

/**
 * A sanitised picture as something an `<img>` (or an SVG `<image>`) can show: a `data:` URL. Drawn as an image, an
 * SVG cannot run script, fetch anything, or style the page around it — whatever got past the rebuild stays inside
 * the picture.
 */
export const svgDataUrl = (svg: string): string => (svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : '')
