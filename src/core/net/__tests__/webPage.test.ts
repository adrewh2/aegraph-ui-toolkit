import { describe, expect, it } from 'vitest'
import { decodeEntities, findIn, isHtml, isTextual, readPage } from '../webPage'

/** An app page as they come: an empty shell, its scripts, its data named in inline JSON and attributes. */
const PAGE = `<!doctype html><html><head>
<title>arXiv Map &mdash; Cosmograph</title>
<meta name="description" content="100K papers &amp; their clusters">
<script src="/_next/static/chunks/main.js"></script>
<script defer src="https://cdn.example.com/lib.js"></script>
<style>body { color: red }</style>
</head><body>
<nav><a href="/about">About <b>us</b></a> <a href="https://other.example/x">Other</a> <a href="/about">About again</a> <a href="javascript:alert(1)">bad</a></nav>
<main><h1>Papers</h1><p>First&nbsp;paragraph.</p><p>Second<br>line.</p>
<table><tr><td>a</td><td>b</td></tr></table></main>
<a href="/files/nodes.csv">nodes</a>
<script id="__NEXT_DATA__" type="application/json">{"props":{"file":"https:\\/\\/data.example\\/arxiv.parquet","api":"/api/trpc/project.get"}}</script>
<script>fetch("/api/v2/points?limit=10")</script>
</body></html>`

describe('reading a web page without a DOM', () => {
  const p = readPage(PAGE, 'https://run.example.app/public/abc')

  it('keeps the title, the description and the visible text — no scripts, no styles, no markup', () => {
    expect(p.title).toBe('arXiv Map — Cosmograph')
    expect(p.description).toBe('100K papers & their clusters')
    expect(p.text).toContain('Papers\n')
    expect(p.text).toContain('First paragraph.')
    expect(p.text).toContain('Second\nline.')
    expect(p.text).not.toMatch(/color: red|fetch\(|__NEXT_DATA__|props/)
    // <main> marks the content: the navigation around it is left out of the text (its links are still listed).
    expect(p.text).not.toContain('About us')
    expect(readPage('<nav>Menu</nav><p>Body</p>', 'https://x.example/').text).toBe('Menu\n\nBody')
  })

  it('lists links once each, made absolute, http(s) only', () => {
    expect(p.links).toEqual([
      { href: 'https://run.example.app/about', text: 'About us' },
      { href: 'https://other.example/x', text: 'Other' },
      { href: 'https://run.example.app/files/nodes.csv', text: 'nodes' },
    ])
  })

  it('names the scripts it loads, and the data and APIs it mentions anywhere — inline JSON and scripts included', () => {
    expect(p.scripts).toEqual(['https://run.example.app/_next/static/chunks/main.js', 'https://cdn.example.com/lib.js'])
    expect(p.data).toEqual(expect.arrayContaining(['https://run.example.app/files/nodes.csv', 'https://data.example/arxiv.parquet', 'https://run.example.app/api/trpc/project.get', 'https://run.example.app/api/v2/points?limit=10']))
    expect(p.json).toEqual([{ id: '__NEXT_DATA__', type: 'application/json', text: expect.stringContaining('arxiv.parquet') }])
  })

  it('finds plain substrings with the text around them, never as patterns', () => {
    const hits = findIn(PAGE, ['FETCH(', '.*'])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ term: 'FETCH(' })
    expect(hits[0].snippet).toContain('fetch("/api/v2/points')
    expect(findIn('aaaa', ['a'], { limit: 3 })).toHaveLength(3)
  })

  it('decodes entities, and tells pages and text from binary', () => {
    expect(decodeEntities('&lt;a&gt; &#233; &#x1F600; &bogus;')).toBe('<a> é 😀 &bogus;')
    expect(isHtml('text/html; charset=utf-8', '')).toBe(true)
    expect(isHtml('', '  <!DOCTYPE html><html>')).toBe(true)
    expect(isHtml('application/json', '{}')).toBe(false)
    for (const t of ['text/csv', 'application/json', 'application/ld+json', 'text/turtle', 'application/javascript', 'image/svg+xml', '']) expect(isTextual(t)).toBe(true)
    for (const t of ['application/octet-stream', 'application/vnd.apache.parquet', 'image/png', 'application/zip']) expect(isTextual(t)).toBe(false)
  })
})
