import { describe, expect, it } from 'vitest'
import { inlineText, outlineOf, parseInline, parseMarkdown, safeUrl, slugify, type MdBlock } from '../markdown'

const text = (v: string) => ({ t: 'text', v })

describe('parseInline', () => {
  it('parses emphasis, strong, code, and strikethrough', () => {
    expect(parseInline('a **b** *c* `d` ~~e~~')).toEqual([
      text('a '),
      { t: 'strong', c: [text('b')] },
      text(' '),
      { t: 'em', c: [text('c')] },
      text(' '),
      { t: 'code', v: 'd' },
      text(' '),
      { t: 'del', c: [text('e')] },
    ])
  })

  it('does not treat intra-word underscores as emphasis', () => {
    expect(parseInline('snake_case_name')).toEqual([text('snake_case_name')])
  })

  it('parses links, images, autolinks, and bare urls', () => {
    expect(parseInline('[x](https://a.b "t")')).toEqual([{ t: 'link', href: 'https://a.b', title: 't', c: [text('x')] }])
    expect(parseInline('![alt](img.png)')).toEqual([{ t: 'image', alt: 'alt', src: 'img.png', title: undefined }])
    expect(parseInline('<https://a.b>')).toEqual([{ t: 'link', href: 'https://a.b', c: [text('https://a.b')] }])
    expect(parseInline('see https://a.b/c. now')).toEqual([text('see '), { t: 'link', href: 'https://a.b/c', c: [text('https://a.b/c')] }, text('. now')])
  })

  it('handles escapes, hard breaks, and soft breaks', () => {
    expect(parseInline('\\*not em\\*')).toEqual([text('*not em*')])
    expect(parseInline('a  \nb')).toEqual([text('a'), { t: 'br' }, text('b')])
    expect(parseInline('a\\\nb')).toEqual([text('a'), { t: 'br' }, text('b')])
    expect(parseInline('a\nb')).toEqual([text('a b')])
  })

  it('leaves unmatched delimiters as text', () => {
    expect(parseInline('a * b ** c `d')).toEqual([text('a * b ** c `d')])
  })

  it('keeps backticks inside longer code fences', () => {
    expect(parseInline('`` a`b ``')).toEqual([{ t: 'code', v: 'a`b' }])
  })
})

describe('parseMarkdown', () => {
  it('parses headings with ids', () => {
    const [h1, h2, h3] = parseMarkdown('# Hello World\n\nSetext\n===\n\n## Sub `code` ##')
    expect(h1).toEqual({ t: 'heading', level: 1, id: 'hello-world', c: [text('Hello World')] })
    expect(h2).toMatchObject({ t: 'heading', level: 1, id: 'setext' })
    expect(h3).toMatchObject({ t: 'heading', level: 2, id: 'sub-code' })
  })

  it('joins paragraph lines and separates on blank lines', () => {
    expect(parseMarkdown('a\nb\n\nc')).toEqual([{ t: 'paragraph', c: [text('a b')] }, { t: 'paragraph', c: [text('c')] }])
  })

  it('parses fenced code without touching its contents', () => {
    const [b] = parseMarkdown('```ts\nconst *x* = `1`\n\n# not heading\n```\nafter')
    expect(b).toEqual({ t: 'code', lang: 'ts', v: 'const *x* = `1`\n\n# not heading' })
    expect(parseMarkdown('~~~\nx\n~~~')).toEqual([{ t: 'code', lang: undefined, v: 'x' }])
  })

  it('parses hr vs setext heading correctly', () => {
    expect(parseMarkdown('---')).toEqual([{ t: 'hr' }])
    expect(parseMarkdown('* * *')).toEqual([{ t: 'hr' }])
    expect(parseMarkdown('Title\n---')).toMatchObject([{ t: 'heading', level: 2 }])
  })

  it('parses nested lists and task items', () => {
    const [list] = parseMarkdown('- a\n- b\n  - b1\n  - b2\n- [x] done\n- [ ] todo') as [Extract<MdBlock, { t: 'list' }>]
    expect(list.t).toBe('list')
    expect(list.ordered).toBe(false)
    expect(list.items).toHaveLength(4)
    expect(list.items[1].c).toMatchObject([{ t: 'paragraph' }, { t: 'list', items: [{}, {}] }])
    expect(list.items[2].checked).toBe(true)
    expect(list.items[3].checked).toBe(false)
    expect(list.items[0].checked).toBeUndefined()
  })

  it('parses ordered lists with a start number and lazy continuation', () => {
    const [list] = parseMarkdown('3. one\ncontinued\n4. two') as [Extract<MdBlock, { t: 'list' }>]
    expect(list).toMatchObject({ t: 'list', ordered: true, start: 3 })
    expect(list.items[0].c).toEqual([{ t: 'paragraph', c: [text('one continued')] }])
    expect(list.items).toHaveLength(2)
  })

  it('splits adjacent lists of different kinds', () => {
    expect(parseMarkdown('- a\n1. b')).toMatchObject([{ t: 'list', ordered: false }, { t: 'list', ordered: true }])
  })

  it('parses blockquotes recursively', () => {
    expect(parseMarkdown('> # h\n> text\n> more')).toEqual([
      { t: 'quote', c: [{ t: 'heading', level: 1, id: 'h', c: [text('h')] }, { t: 'paragraph', c: [text('text more')] }] },
    ])
  })

  it('parses tables with alignment and escaped pipes', () => {
    const [t] = parseMarkdown('| a | b | c |\n|:--|:-:|--:|\n| 1 | x\\|y | 3 |\n| 4 |') as [Extract<MdBlock, { t: 'table' }>]
    expect(t.t).toBe('table')
    expect(t.align).toEqual(['left', 'center', 'right'])
    expect(t.head.map(inlineText)).toEqual(['a', 'b', 'c'])
    expect(t.rows.map((r) => r.map(inlineText))).toEqual([
      ['1', 'x|y', '3'],
      ['4', '', ''],
    ])
  })

  it('treats a lone pipe line without separator as a paragraph', () => {
    expect(parseMarkdown('a | b')).toEqual([{ t: 'paragraph', c: [text('a | b')] }])
  })

  it('interrupts paragraphs with block starts', () => {
    expect(parseMarkdown('para\n# h\n- li')).toMatchObject([{ t: 'paragraph' }, { t: 'heading' }, { t: 'list' }])
  })

  it('treats raw html as text', () => {
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([{ t: 'paragraph', c: [text('<script>alert(1)</script>')] }])
  })

  it('normalises CRLF', () => {
    expect(parseMarkdown('a\r\n\r\nb')).toHaveLength(2)
  })
})

describe('helpers', () => {
  it('slugify', () => {
    expect(slugify('Hello, World! `x`')).toBe('hello-world-x')
    expect(slugify('Ünïcode ok')).toBe('ünïcode-ok')
  })

  it('outlineOf', () => {
    expect(outlineOf(parseMarkdown('# A\ntext\n## B\n### C'))).toEqual([
      { level: 1, id: 'a', text: 'A' },
      { level: 2, id: 'b', text: 'B' },
      { level: 3, id: 'c', text: 'C' },
    ])
  })

  it('safeUrl rejects script-capable schemes', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeUrl('JAVASCRIPT:alert(1)')).toBeUndefined()
    expect(safeUrl('vbscript:x')).toBeUndefined()
    expect(safeUrl('data:text/html,x', { image: true })).toBeUndefined()
    expect(safeUrl('data:image/png;base64,AAA', { image: true })).toBe('data:image/png;base64,AAA')
    expect(safeUrl('data:image/png;base64,AAA')).toBeUndefined()
    expect(safeUrl('https://a.b')).toBe('https://a.b')
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(safeUrl('#frag')).toBe('#frag')
    expect(safeUrl('/rel/path')).toBe('/rel/path')
    expect(safeUrl('')).toBeUndefined()
  })
})
