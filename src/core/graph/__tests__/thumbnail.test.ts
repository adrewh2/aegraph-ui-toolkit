import { describe, expect, it } from 'vitest'
import { createEntity, createRelationship } from '../../entity/entity'
import { EntityStore } from '../../entity/store'
import { TypeRegistry } from '../../entity/typeRegistry'
import { plotContextFor } from '../../../features/plots/plotContext'
import { buildPlot, type PlotSpec } from '../plot'
import { projectionFromPositions } from '../projection'
import { graphThumbnailSvg, isImageUrl, plotPreview, plotThumbnailSvg, scenePreview, sceneThumbnailSvg, svgDataUrl } from '../thumbnail'

/** The pictures on the Scenes and Charts cards, drawn from what an entity holds — no canvas, so the headless engine draws them too. */
function fixture() {
  const store = new EntityStore()
  const seg = (id: string, created: string, region: string, chars: number) => store.upsert(createEntity({ id, type: 'segment', label: id, data: { region, chars }, meta: { createdAt: created, updatedAt: created, source: 'test' } }))
  seg('s1', '2024-01-05T10:00:00Z', 'tools', 1200)
  seg('s2', '2024-01-20T10:00:00Z', 'tools', 3000)
  seg('s3', '2024-02-02T10:00:00Z', 'life', 500)
  seg('s4', '2024-04-01T10:00:00Z', 'life', 4000)
  store.upsert(createRelationship({ id: 'r1', type: 'next', source: { id: 's1' }, target: { id: 's2' } }))
  store.upsert(createRelationship({ id: 'r2', type: 'next', source: { id: 's2' }, target: { id: 's3' } }))
  return { store, ctx: plotContextFor(store, new TypeRegistry(store)) }
}

const marks = (svg: string | null, tag: string) => (svg?.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length

describe('card pictures', () => {
  it('draws every kind of chart the builder makes, as marks only', () => {
    const { ctx } = fixture()
    const kinds: PlotSpec[] = [
      { selector: { types: ['segment'] }, traces: [{ kind: 'bar', x: 'data.region' }] },
      { selector: { types: ['segment'] }, traces: [{ kind: 'line', x: 'meta.createdAt', bin: 'month' }] },
      { selector: { types: ['segment'] }, traces: [{ kind: 'area', x: 'meta.createdAt', bin: 'month', group: 'data.region' }] },
      { selector: { types: ['segment'] }, traces: [{ kind: 'scatter', x: 'data.chars', y: 'data.chars' }] },
      { selector: { types: ['segment'] }, traces: [{ kind: 'histogram', x: 'data.chars' }] },
      { selector: { types: ['segment'] }, traces: [{ kind: 'box', y: 'data.chars', group: 'data.region' }] },
      { selector: { types: ['segment'] }, traces: [{ kind: 'heatmap', x: 'meta.createdAt', bin: 'month', y: 'data.region' }] },
      { selector: { types: ['segment'] }, traces: [{ kind: 'pie', x: 'data.region' }] },
    ]
    for (const spec of kinds) {
      const svg = plotThumbnailSvg(buildPlot(spec, ctx))
      expect(svg, spec.traces[0].kind).toMatch(/^<svg [^>]*viewBox="0 0 320 200"/)
      expect(svg).not.toContain('NaN')
      expect(svg).not.toContain('<text') // a glance: no labels
    }
    // Two regions: a bar each; a pie's two slices.
    expect(plotThumbnailSvg(buildPlot(kinds[0], ctx))!.match(/h[\d.]+v/g)).toHaveLength(2)
    expect(marks(plotThumbnailSvg(buildPlot(kinds[7], ctx)), 'path')).toBe(2)
    expect(marks(plotThumbnailSvg(buildPlot(kinds[3], ctx)), 'circle')).toBe(4)
  })

  it('refuses a colour from data that is not one, and says so with nothing when there is nothing to draw', () => {
    const svg = plotThumbnailSvg({ data: [{ type: 'bar', x: ['a'], y: [1], marker: { color: 'red"/><script>alert(1)</script>' } }] })
    expect(svg).not.toContain('<script')
    expect(plotThumbnailSvg({ data: [] })).toBeNull()
    expect(graphThumbnailSvg([], [])).toBeNull()
  })

  it('draws a graph scene from its saved layout, and a placed scene from its boxes', () => {
    const { store } = fixture()
    const layout = createEntity({ type: 'layout', label: 'l', data: { positions: { s1: { x: 0, y: 0 }, s2: { x: 10, y: 5 }, s3: { x: 20, y: -5 } } } })
    store.upsert(layout)
    const scene = createEntity({ type: 'scene:unigraph', label: 'g', data: { renderer: '2d', layoutId: layout.id } })
    store.upsert(scene)
    const g = sceneThumbnailSvg(scene, store)
    expect(marks(g, 'circle')).toBe(3)
    expect(g!.match(/M[\d.]+ [\d.]+L/g)).toHaveLength(2) // the two relationships among them
    // No layout saved (the app computes it on open): no picture, the card keeps its icon.
    expect(sceneThumbnailSvg(createEntity({ type: 'scene:unigraph', label: 'x', data: { renderer: '2d' } }), store)).toBeNull()

    const placed = projectionFromPositions('p', { s1: { x: 100, y: 100 }, s2: { x: 400, y: 100 } })
    expect(marks(sceneThumbnailSvg(placed, store), 'rect')).toBe(2)
  })

  it('keeps a stored picture, and makes a data: URL an <img> can show', () => {
    const { store } = fixture()
    const jpeg = 'data:image/jpeg;base64,AAAA'
    expect(scenePreview(createEntity({ type: 'scene', label: 's', data: { preview: jpeg } }), store)).toBe(jpeg)
    const url = svgDataUrl('<svg/>')
    expect(isImageUrl(url)).toBe(true)
    expect(decodeURIComponent(url.split(',')[1])).toBe('<svg/>')
    expect(isImageUrl('javascript:alert(1)')).toBe(false)
    expect(isImageUrl(plotPreview({ data: [{ type: 'bar', x: ['a', 'b'], y: [1, 2] }] }))).toBe(true)
  })

  it('stays small on a big graph: sampled marks', () => {
    const points = Array.from({ length: 20000 }, (_, i) => ({ id: `n${i}`, x: Math.cos(i) * i, y: Math.sin(i) * i, type: i % 3 ? 'a' : 'b' }))
    const edges = Array.from({ length: 20000 }, (_, i): [string, string] => [`n${i}`, `n${(i * 7) % 20000}`])
    const svg = graphThumbnailSvg(points, edges)!
    expect(marks(svg, 'circle')).toBeLessThanOrEqual(1500)
    expect(svg.length).toBeLessThan(120_000)
  })
})
