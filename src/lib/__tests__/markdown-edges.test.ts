import { describe, expect, it } from 'vitest'
import { inlineText, outlineOf, parseInline, parseMarkdown, safeUrl, slugify, type MdBlock, type MdInline } from '../markdown'

/**
 * The Markdown parser at its edges: a fence left open, a fence and a
 * table inside a list item, lists with mixed markers and numbering,
 * tables ragged or without a separator, setext lines after a blank,
 * headings of punctuation only, links whose URL holds parentheses or
 * angle brackets, script-capable and data URLs through safeUrl, images
 * without alt, inline code of backticks, emphasis across lines, breaks
 * at the end, HTML in text, bare CR endings, and the time a 100 kB
 * document takes.
 */
const text = (v: string): MdInline => ({ t: 'text', v })
const para = (v: string): MdBlock => ({ t: 'paragraph', c: [text(v)] })

describe('markdown edges', () => {
  it('a fence left open runs to the end; a fence inside a list item stays inside it; a tilde fence is not closed by backticks; the info string stops at a space', () => {
    expect(parseMarkdown('```js\nlet a\n\nlet b')).toEqual([{ t: 'code', lang: 'js', v: 'let a\n\nlet b' }])
    expect(parseMarkdown('- item\n\n  ```\n  code\n  ```\n- next')).toEqual([{ t: 'list', ordered: false, start: undefined, items: [{ c: [para('item'), { t: 'code', lang: undefined, v: 'code' }], checked: undefined }, { c: [para('next')], checked: undefined }] }])
    expect(parseMarkdown('~~~\n```\nstill code\n~~~')).toEqual([{ t: 'code', lang: undefined, v: '```\nstill code' }])
    expect(parseMarkdown('````\n```\ninner\n```\n````')).toEqual([{ t: 'code', lang: undefined, v: '```\ninner\n```' }])
    expect(parseMarkdown('```python title=x\npass\n```')[0]).toMatchObject({ t: 'code', lang: 'python', v: 'pass' })
    expect(parseMarkdown('```\n```')).toEqual([{ t: 'code', lang: undefined, v: '' }])
  })

  it('lists: mixed bullet markers join, a switch between bullets and numbers splits, numbering starts where it starts, a nested list of the other kind sits inside its item, an empty item holds what follows it', () => {
    expect(parseMarkdown('- a\n* b\n+ c')).toMatchObject({ length: 1, 0: { t: 'list', ordered: false, items: [{ c: [para('a')] }, { c: [para('b')] }, { c: [para('c')] }] } })
    expect(parseMarkdown('- a\n1. b').map((b) => b.t)).toEqual(['list', 'list'])
    expect(parseMarkdown('3) x\n4) y')[0]).toMatchObject({ t: 'list', ordered: true, start: 3, items: [{ c: [para('x')] }, { c: [para('y')] }] })
    expect(parseMarkdown('0. zero')[0]).toMatchObject({ t: 'list', ordered: true, start: 0 })
    expect(parseMarkdown('1. one\n2) two')[0]).toMatchObject({ t: 'list', ordered: true, start: undefined, items: [{ c: [para('one')] }, { c: [para('two')] }] })
    const nested = parseMarkdown('- a\n  1. b\n  2. c\n- d')[0] as Extract<MdBlock, { t: 'list' }>
    expect(nested.items.length).toBe(2)
    expect(nested.items[0].c).toEqual([para('a'), { t: 'list', ordered: true, start: undefined, items: [{ c: [para('b')], checked: undefined }, { c: [para('c')], checked: undefined }] }])
    expect(parseMarkdown('-\n  after')[0]).toMatchObject({ t: 'list', items: [{ c: [para('after')] }] })
    expect(parseMarkdown('- [ ] todo\n- [X] done\n- [x]')[0]).toMatchObject({ items: [{ checked: false, c: [para('todo')] }, { checked: true, c: [para('done')] }, { checked: true, c: [] }] })
    // A number too long to be a marker is a paragraph.
    expect(parseMarkdown('1234567890. not a list')[0].t).toBe('paragraph')
  })

  it('tables: a ragged row is padded or cut to the header, a header wider than its separator is a paragraph, a pipe inside code splits the cell, a table inside a list item, and a row ends at a block start', () => {
    const t = parseMarkdown('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n\n')[0] as Extract<MdBlock, { t: 'table' }>
    expect(t.rows).toEqual([[[text('1')], []], [[text('1')], [text('2')]]])
    expect(parseMarkdown('| a | b | c |\n|---|---|')[0].t).toBe('paragraph')
    expect(parseMarkdown('a | b\n-|-\n`x|y` | z')[0]).toMatchObject({ t: 'table', rows: [[[{ t: 'text', v: '`x' }], [{ t: 'text', v: 'y`' }]]] })
    expect(parseMarkdown('- item\n\n  | a |\n  |---|\n  | 1 |')[0]).toMatchObject({ t: 'list', items: [{ c: [para('item'), { t: 'table', head: [[text('a')]], rows: [[[text('1')]]] }] }] })
    expect(parseMarkdown('| a |\n|---|\n| 1 |\n# heading').map((b) => b.t)).toEqual(['table', 'heading'])
    expect(parseMarkdown('|---|\n|---|')[0]).toMatchObject({ t: 'table', head: [[text('---')]], rows: [] })
  })

  it('setext lines after a blank are a paragraph or a rule, headings of punctuation only get an empty id, and trailing hashes and inline marks are stripped from the id', () => {
    expect(parseMarkdown('Text\n\n===')).toEqual([para('Text'), para('===')])
    expect(parseMarkdown('Text\n\n---')).toEqual([para('Text'), { t: 'hr' }])
    expect(parseMarkdown('Text\n---')).toEqual([{ t: 'heading', level: 2, id: 'text', c: [text('Text')] }])
    expect(parseMarkdown('# ???')).toEqual([{ t: 'heading', level: 1, id: '', c: [text('???')] }])
    expect(parseMarkdown('# ¿Qué? ###')).toEqual([{ t: 'heading', level: 1, id: 'qué', c: [text('¿Qué?')] }])
    expect(parseMarkdown('## *Em* & `code`_x_')[0]).toMatchObject({ id: 'em-codex' }) // marks are removed, not spaced
    expect(parseMarkdown('#hashtag')[0].t).toBe('paragraph')
    expect(parseMarkdown('####### seven')[0].t).toBe('paragraph')
    expect(parseMarkdown('#')[0]).toEqual({ t: 'heading', level: 1, id: '', c: [] })
    expect(outlineOf(parseMarkdown('# A\ntext\n## B\n```\n# not a heading\n```\n### C'))).toEqual([{ level: 1, id: 'a', text: 'A' }, { level: 2, id: 'b', text: 'B' }, { level: 3, id: 'c', text: 'C' }])
    expect(slugify('  Hello,   World!  ')).toBe('hello-world')
    expect(slugify('日本語 テスト')).toBe('日本語-テスト')
  })

  it('links: balanced parentheses stay in the URL, a space needs angle brackets, an empty URL is a link to nothing, nested brackets in the text, and titles in either quote', () => {
    expect(parseInline('[w](https://en.wikipedia.org/wiki/Graph_(mathematics))')).toEqual([{ t: 'link', href: 'https://en.wikipedia.org/wiki/Graph_(mathematics)', title: undefined, c: [text('w')] }])
    expect(parseInline('[x](<a b>)')).toEqual([text('[x](<a b>)')])
    expect(parseInline('[x](<a>)')).toEqual([{ t: 'link', href: 'a', title: undefined, c: [text('x')] }])
    expect(parseInline('[x]()')).toEqual([{ t: 'link', href: '', title: undefined, c: [text('x')] }])
    expect(parseInline("[a [b] c](u 'T')")).toEqual([{ t: 'link', href: 'u', title: 'T', c: [text('a [b] c')] }])
    expect(parseInline('[**x**](u)')).toEqual([{ t: 'link', href: 'u', title: undefined, c: [{ t: 'strong', c: [text('x')] }] }])
    expect(parseInline('![](x.png)')).toEqual([{ t: 'image', alt: '', src: 'x.png', title: undefined }])
    expect(parseInline('![a](x.png "t")')).toEqual([{ t: 'image', alt: 'a', src: 'x.png', title: 't' }])
    expect(parseInline('[x](javascript:alert(1))')).toEqual([{ t: 'link', href: 'javascript:alert(1)', title: undefined, c: [text('x')] }]) // the parser keeps it; the renderer drops it
    expect(parseInline('see https://a.b/c(d) and https://a.b/e).')).toEqual([text('see '), { t: 'link', href: 'https://a.b/c(d', c: [text('https://a.b/c(d')] }, text(') and '), { t: 'link', href: 'https://a.b/e', c: [text('https://a.b/e')] }, text(').')])
  })

  it('safeUrl: script-capable schemes go whatever their case or spacing, data URLs only for images of known types, relative paths, fragments and protocol-relative URLs pass', () => {
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:x', ' javascript:x', 'vbscript:x', 'data:text/html,<b>', 'data:image/svg+xml;base64,AAAA', 'file:///etc/passwd', 'blob:http://x/y', 'x-custom:thing']) expect(safeUrl(bad), bad).toBeUndefined()
    expect(safeUrl('data:image/png;base64,AAAA', { image: true })).toBe('data:image/png;base64,AAAA')
    expect(safeUrl('DATA:IMAGE/JPEG;base64,AAAA', { image: true })).toBe('DATA:IMAGE/JPEG;base64,AAAA')
    expect(safeUrl('data:image/svg+xml;base64,AAAA', { image: true })).toBe('data:image/svg+xml;base64,AAAA')
    expect(safeUrl('data:image/bmp;base64,AAAA', { image: true })).toBeUndefined()
    expect(safeUrl('data:image/png;base64,AAAA')).toBeUndefined()
    for (const ok of ['/docs/x', '#top', '../a?b=1', '//other.host/path', 'mailto:a@b.c', 'tel:+1', 'HTTPS://A.B']) expect(safeUrl(ok), ok).toBeDefined()
    expect(safeUrl('a:b')).toBeUndefined() // a single letter before the colon is still a scheme
    expect(safeUrl('   ')).toBeUndefined()
  })

  it('inline: code of backticks and spaces, emphasis across a line break, a hard break at the very end, HTML tags and entities as text, bare CR endings, and nothing', () => {
    expect(parseInline('``` `` ```')).toEqual([{ t: 'code', v: '``' }])
    expect(parseInline('` `')).toEqual([{ t: 'code', v: ' ' }])
    expect(parseInline('`  a  `')).toEqual([{ t: 'code', v: ' a ' }])
    expect(parseInline('*a\nb*')).toEqual([{ t: 'em', c: [text('a b')] }])
    expect(parseInline('**a\n\nb**')).toEqual([{ t: 'strong', c: [text('a  b')] }])
    expect(parseInline('a  ')).toEqual([text('a  ')])
    expect(parseInline('a\\')).toEqual([text('a\\')])
    expect(parseInline('<b>x</b> &amp; <script>y</script>')).toEqual([text('<b>x</b> &amp; <script>y</script>')])
    expect(parseInline('a*b*c')).toEqual([text('a'), { t: 'em', c: [text('b')] }, text('c')])
    expect(parseInline('* not em *')).toEqual([text('* not em *')])
    expect(parseInline('')).toEqual([])
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n  \n')).toEqual([])
    expect(parseMarkdown('a\rb\r\rc')).toEqual([para('a b'), para('c')])
    expect(inlineText(parseInline('a **b** `c` ![i](x) [l](u)  \nd'))).toBe('a b c i l\nd')
  })

  it('a quote holds a list and a fence, lazy lines join its paragraph, and a 100 kB document of everything parses in well under a second', () => {
    expect(parseMarkdown('> - a\n> - b\n>\n> ```\n> code\n> ```\nlazy')).toEqual([{ t: 'quote', c: [{ t: 'list', ordered: false, start: undefined, items: [{ c: [para('a')], checked: undefined }, { c: [para('b')], checked: undefined }] }, { t: 'code', lang: undefined, v: 'code' }, para('lazy')] }])
    expect(parseMarkdown('> a\nb\n\nc')).toEqual([{ t: 'quote', c: [para('a b')] }, para('c')])
    const chunk = '# Title\n\nSome *emphasis* and **strong** text with a [link](https://a.b/c) and `code`.\n\n- item one\n- item two\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1\n```\n\n> quoted\n\n---\n\n'
    const doc = chunk.repeat(Math.ceil(100_000 / chunk.length))
    expect(doc.length).toBeGreaterThan(100_000)
    const t0 = performance.now()
    const blocks = parseMarkdown(doc)
    const ms = performance.now() - t0
    expect(blocks.length).toBeGreaterThan(2000)
    expect(ms).toBeLessThan(1000)
  })
})
