import { describe, expect, it } from 'vitest'
import { generateGraph } from '../../../core/packed/generate'
import { GraphEngine } from '../engine/engine'
import { BitSet } from '../../../core/packed/bitset'
import { N_AROUND, N_HIDDEN, N_HOVERED, N_LABEL, N_SELECTED } from '../engine/types'
import { Camera } from '../engine/camera'
import { OrbitCamera } from '../engine/camera3'
import { lodFor, regimeFor, spacingPx } from '../engine/lod'

/** An engine without a canvas: every data path, the camera, picking and selection work headless. */
function small(): GraphEngine {
  const e = new GraphEngine()
  e.camera.width = 800
  e.camera.height = 600
  e.beginUpdate()
  const a = e.setNode('a', { type: 'person', x: 0, y: 0, size: 5, color: '#ff0000', label: 'A' })
  const b = e.setNode('b', { type: 'person', x: 100, y: 0, size: 5, label: 'B' })
  const c = e.setNode('c', { type: 'work', x: 0, y: 100, size: 5, label: 'C' })
  e.setNode('d', { type: 'work', x: 100, y: 100, size: 5, label: 'D' })
  e.addEdge('ab', a, b, { type: 'knows', directed: true })
  e.addEdge('ac', a, c, { type: 'wrote' })
  e.endUpdate()
  return e
}

describe('GraphEngine', () => {
  it('interns ids to stable indices and keeps the flags in step', () => {
    const e = small()
    expect(e.nodeIndex('a')).toBe(0)
    expect(e.nodeIndex('d')).toBe(3)
    expect(e.nodeId(2)).toBe('c')
    expect(e.graph.degree[0]).toBe(2)
    expect(e.edgeIndex('ab')).toBe(0)
    expect(e.nodeFlags[0] & N_LABEL).toBe(N_LABEL)
    expect(e.nodeFlags[0] & N_HIDDEN).toBe(0)
    // Updating a node keeps its index; only what changed is written.
    expect(e.setNode('a', { color: '#00ff00', x: 5 })).toBe(0)
    expect(e.x(0)).toBe(5)
    expect(e.nodeTypes.name(e.graph.nodeType[2])).toBe('work')
    e.removeNode(1)
    expect(e.nodeIndex('b')).toBe(-1)
    expect(e.graph.hasEdge(0)).toBe(false)
    expect(e.graph.degree[0]).toBe(1)
    expect(e.nodeFlags[1] & N_HIDDEN).toBe(N_HIDDEN)
    // A new id takes the freed slot, clean.
    expect(e.setNode('z', { x: 1, y: 1 })).toBe(1)
    expect(e.nodeFlags[1] & N_HIDDEN).toBe(0)
    expect(e.graph.degree[1]).toBe(0)
  })

  it('selection is a bitset: flags change only for the nodes whose membership changed', () => {
    const e = small()
    let events = 0
    e.on('select', () => events++)
    e.setSelection([0], 'replace', 'click')
    expect(e.selectedCount()).toBe(1)
    expect(e.nodeFlags[0] & N_SELECTED).toBe(N_SELECTED)
    // Neighbours of the selection are marked "around".
    expect(e.nodeFlags[1] & N_AROUND).toBe(N_AROUND)
    expect(e.nodeFlags[2] & N_AROUND).toBe(N_AROUND)
    expect(e.nodeFlags[3] & N_AROUND).toBe(0)
    e.setSelection([3], 'toggle')
    expect(e.selectedCount()).toBe(2)
    e.setSelection([0], 'remove')
    expect(e.selectedCount()).toBe(1)
    expect(e.nodeFlags[0] & N_SELECTED).toBe(0)
    expect(e.nodeFlags[1] & N_AROUND).toBe(0)
    e.selectAll()
    expect(e.selectedCount()).toBe(4)
    e.clearSelection()
    expect(e.selectedCount()).toBe(0)
    e.selectNeighbors(0, 'replace')
    expect(Array.from(e.selectedIndices())).toEqual([0, 1, 2])
    expect(events).toBe(6)
    // Hover marks the node and its neighbours; leaving clears them but keeps the selection's own marks.
    e.setSelection([3])
    e.setHover(0)
    expect(e.hovered).toBe(0)
    expect(e.nodeFlags[0] & N_HOVERED).toBe(N_HOVERED)
    expect(e.nodeFlags[1] & N_AROUND).toBe(N_AROUND)
    e.setHover(-1)
    expect(e.nodeFlags[1] & N_AROUND).toBe(0)
    expect(e.nodeFlags[3] & N_SELECTED).toBe(N_SELECTED)
  })

  it('lights the selection’s neighbourhood as many links out as asked, and no further', () => {
    // A chain a–b–c–d–e: selecting a lights b at 1 hop, b and c at 2, all four at 6.
    const e = new GraphEngine()
    e.beginUpdate()
    const ix = ['a', 'b', 'c', 'd', 'e'].map((id, i) => e.setNode(id, { type: 't', x: i * 10, y: 0, size: 5 }))
    for (let i = 0; i < 4; i++) e.addEdge(`e${i}`, ix[i], ix[i + 1], { type: 'next' })
    e.endUpdate()
    const bits = new BitSet(8)
    bits.set(ix[0])
    e.setSelectionBits(bits)
    const lit = () => ix.filter((i) => e.nodeFlags[i] & N_AROUND).map((i) => e.nodeId(i))
    expect(lit()).toEqual(['b'])
    e.setHighlightHops(2)
    expect(lit()).toEqual(['b', 'c'])
    e.setHighlightHops(6)
    expect(lit()).toEqual(['b', 'c', 'd', 'e'])
    e.setHighlightHops(1)
    expect(lit()).toEqual(['b'])
  })

  it('filters by bitset and drops selected nodes that leave the picture', () => {
    const e = small()
    e.setSelection([0, 2])
    e.filterTypes(new Set([e.nodeTypes.lookup('person')]))
    expect(e.visibleCount()).toBe(2)
    expect(e.nodeFlags[2] & N_HIDDEN).toBe(N_HIDDEN)
    expect(Array.from(e.selectedIndices())).toEqual([0])
    e.filterTypes(null)
    expect(e.visibleCount()).toBe(4)
    e.filterTypes(null, 2)
    expect(e.visibleCount()).toBe(1)
  })

  it('picks through the grid in screen space and frames the graph', () => {
    const e = small()
    e.fit()
    const cam = e.camera
    expect(cam.fitScale).toBe(cam.scale)
    e.renderNow()
    const sx = cam.screenX(100), sy = cam.screenY(0)
    expect(e.pick(sx, sy)).toBe(1)
    expect(e.pick(sx + 40, sy + 40)).toBe(-1)
    const hits: number[] = []
    e.nodesInScreenRect(cam.screenX(-10), cam.screenY(-10), cam.screenX(110), cam.screenY(50), (i) => hits.push(i))
    expect(hits.sort()).toEqual([0, 1])
    // A drag moves one node by a world delta and re-indexes on commit.
    e.moveBy([1], 1, 50, 0)
    e.commit()
    expect(e.pick(cam.screenX(150), sy)).toBe(1)
    expect(e.pick(sx, sy)).toBe(-1)
    const box = e.extent()!
    expect(box.maxX).toBe(150)
  })

  it('frames a picture by its own extent however large its nodes are drawn; one node still gets a window', () => {
    // A 3D picture 120 units across whose hub is drawn at 16 px: thirty radii would be 480 units, and the fit used to
    // stop there — the same distance whatever the extent. Now the distance follows the extent.
    const at = (span: number) => {
      const e = new GraphEngine()
      e.setDims(3)
      e.camera.width = 800
      e.camera.height = 600
      e.camera3.width = 800
      e.camera3.height = 600
      e.beginUpdate()
      e.setNode('hub', { x: 0, y: 0, z: 0, size: 16 })
      e.setNode('a', { x: span, y: 0, z: 0, size: 4 })
      e.setNode('b', { x: 0, y: span, z: 0, size: 4 })
      e.endUpdate()
      e.fit()
      return e.camera3.distance
    }
    expect(at(120) / at(60)).toBeCloseTo(2, 5)
    // One node spans nothing: a finite window, not an infinite zoom.
    const one = new GraphEngine()
    one.camera.width = 800
    one.camera.height = 600
    one.beginUpdate()
    one.setNode('only', { x: 10, y: 10, size: 5 })
    one.endUpdate()
    one.fit()
    expect(Number.isFinite(one.camera.scale) && one.camera.scale > 0).toBe(true)
    expect(one.camera.scale).toBeLessThan(800 / (5 * 30) + 1e-9)
  })

  it('loads a packed graph wholesale', () => {
    const e = new GraphEngine()
    e.camera.width = 1000
    e.camera.height = 800
    const g = generateGraph({ nodes: 20000, edges: 50000, seed: 2 })
    const t0 = performance.now()
    e.loadPacked(g, { typeColors: [1, 2, 3] })
    e.fit()
    e.renderNow()
    const ms = performance.now() - t0
    expect(e.graph.nodeCount).toBe(20000)
    expect(e.nodeIndex('n123')).toBe(123)
    expect(e.nodeId(123)).toBe('n123')
    expect(e.labelFallback!(123)).toMatch(/ 123$/)
    expect(e.stats.nodesInView).toBeGreaterThan(19000)
    expect(e.stats.regime).toBeLessThanOrEqual(1)
    expect(ms).toBeLessThan(2000)
    e.selectNeighbors(0)
    expect(e.selectedCount()).toBe(e.graph.degree[0] + 1)
    e.setSelection([0, 1, 2], 'replace')
    e.setPath([0, 1], [0])
    expect(e.pathEdges).toEqual([0])
  })
})

describe('Camera and LOD', () => {
  it('converts both ways and zooms about a point', () => {
    const c = new Camera()
    c.width = 400
    c.height = 300
    c.fitBox(-100, -100, 100, 100, { padding: 0 })
    expect(c.scale).toBeCloseTo(1.5)
    expect(c.worldX(c.screenX(37))).toBeCloseTo(37)
    expect(c.worldY(c.screenY(-12))).toBeCloseTo(-12)
    const wx = c.worldX(50), wy = c.worldY(60)
    c.zoomAt(2, 50, 60)
    expect(c.worldX(50)).toBeCloseTo(wx)
    expect(c.worldY(60)).toBeCloseTo(wy)
    c.animateTo(0, 0, 1, 100)
    expect(c.animating).toBe(true)
    // The clock starts at the first tick (a glide begins when its first frame runs); the next tick, a second on, ends it.
    const t0 = performance.now()
    expect(c.tick(t0)).toBe(true)
    expect(c.tick(t0 + 1000)).toBe(false)
    expect(c.scale).toBe(1)
  })
  it('holds the picture still when the view grows beside it', () => {
    // A 400×300 view; a panel closes and the view is 600 wide, its left edge where it was.
    const c = new Camera()
    c.width = 400
    c.height = 300
    c.fitBox(-100, -100, 100, 100, { padding: 0 })
    const wx = c.worldX(120), wy = c.worldY(80)
    c.width = 600
    c.shiftBy(-100, 0)
    expect(c.worldX(120)).toBeCloseTo(wx)
    expect(c.worldY(80)).toBeCloseTo(wy)
    // A move in flight lands shifted by the same amount, so the fit it was making is not undone.
    c.animateTo(10, 20, 2, 100)
    c.shiftBy(30, -40)
    // The clock starts at the first tick (a glide begins when its first frame runs); the next tick, a second on, ends it.
    const t0 = performance.now()
    expect(c.tick(t0)).toBe(true)
    expect(c.tick(t0 + 1000)).toBe(false)
    expect(c.x).toBeCloseTo(10 - 30 / 2)
    expect(c.y).toBeCloseTo(20 - 40 / 2)
  })
  it('the orbit camera holds every depth still through a resize, and a fit brings the projection back', () => {
    const c = new OrbitCamera()
    c.width = 400
    c.height = 300
    c.fitSphere(0, 0, 0, 100)
    c.update()
    // Points at three depths: on the target plane, nearer the eye, farther.
    const v = c.view
    const pts = [
      { x: c.tx + v[0] * 20, y: c.ty + v[4] * 20, z: c.tz + v[8] * 20 },
      { x: c.tx + v[2] * 80 + v[0] * 30, y: c.ty + v[6] * 80 + v[4] * 30, z: c.tz + v[10] * 80 + v[8] * 30 },
      { x: c.tx - v[2] * 80 - v[1] * 40, y: c.ty - v[6] * 80 - v[5] * 40, z: c.tz - v[10] * 80 - v[9] * 40 },
    ]
    const at = (p: { x: number; y: number; z: number }) => {
      const o = { x: 0, y: 0 }
      c.project(p.x, p.y, p.z, o)
      return o
    }
    const before = pts.map(at)
    // Wider by 200 (left edge fixed) and taller by 100 (top edge fixed): the picture moves by (−100, −50) on the view.
    c.holdOnResize(600, 400, -100, -50)
    c.update()
    const after = pts.map(at)
    for (let i = 0; i < pts.length; i++) {
      expect(after[i].x).toBeCloseTo(before[i].x, 3)
      expect(after[i].y).toBeCloseTo(before[i].y, 3)
    }
    expect(c.focal).toBeGreaterThan(0)
    // A fit is a framing: the projection is canonical again, the sphere at the centre.
    c.fitSphere(0, 0, 0, 100)
    c.update()
    expect(c.focal).toBe(0)
    expect(c.offsetX).toBe(0)
    expect(at({ x: 0, y: 0, z: 0 }).x).toBeCloseTo(300, 3)
    // A nudge (a zoom) keeps the held projection; an animated framing ends canonical.
    c.holdOnResize(700, 400, -50, 0)
    c.animateTo({ distance: c.distance / 2 }, 0)
    expect(c.offsetX).toBe(-50)
    c.animateTo({ distance: c.distance, canonical: true }, 100)
    // The clock starts at the first tick (a glide begins when its first frame runs); the next tick, a second on, ends it.
    const t0 = performance.now()
    expect(c.tick(t0)).toBe(true)
    expect(c.tick(t0 + 1000)).toBe(false)
    expect(c.offsetX).toBe(0)
    expect(c.focal).toBe(0)
  })
  it('flies a long pan on the zoom-and-pan path: out over the middle, back in at the end, in a time the distance sets', () => {
    const c = new Camera()
    c.width = 400
    c.height = 300
    c.animateTo(0, 0, 1, 0)
    const t0 = performance.now()
    // Five screens to the right at the same zoom: an explicit `undefined` asks the path for the time.
    c.animateTo(2000, 0, 1, undefined)
    expect(c.animating).toBe(true)
    let ms = 0
    for (; ms < 2000; ms += 16) if (!c.tick(t0 + ms)) break
    expect(ms).toBeGreaterThan(400)
    expect(ms).toBeLessThanOrEqual(916)
    expect(c.x).toBe(2000)
    expect(c.scale).toBe(1)
    c.animateTo(0, 0, 1, 0)
    c.animateTo(2000, 0, 1, 600)
    c.tick(t0)
    c.tick(t0 + 300)
    expect(c.x).toBeCloseTo(1000, 6)
    expect(c.scale).toBeLessThan(0.5)
    // A pointer takes the camera back.
    c.panBy(1, 0)
    expect(c.animating).toBe(false)
  })
  it('regimes follow the space per node', () => {
    expect(regimeFor(spacingPx(1000, 1000, 200_000))).toBe(0)
    expect(regimeFor(spacingPx(1000, 1000, 5_000))).toBe(1)
    expect(regimeFor(spacingPx(1000, 1000, 800))).toBe(2)
    expect(regimeFor(spacingPx(1000, 1000, 50))).toBe(3)
    // A regime in force holds until the spacing is clear of its threshold by the margin, either way.
    expect(regimeFor(50, 2)).toBe(2)
    expect(regimeFor(56, 2)).toBe(3)
    expect(regimeFor(45, 3)).toBe(3)
    expect(regimeFor(41, 3)).toBe(2)
    expect(regimeFor(3, 3)).toBe(0)
    expect(lodFor(2, 500_000).labels).toBe('none')
    expect(lodFor(100, 10).arrows).toBe(true)
  })

  it('draws edges far out strongly enough to read: about 0.18 of a line each past 200k in view, sampled past 500k', () => {
    // Each edge's share of ink is the alpha a drawn edge gets over the stride that stands for it.
    const share = (edges: number) => {
      const l = lodFor(2, edges)
      return l.edgeAlpha / l.edgeStride
    }
    expect(lodFor(2, 400_000).edgeStride).toBe(1)
    expect(lodFor(2, 1_000_000).edgeStride).toBe(2)
    expect(lodFor(2, 2_500_000).edgeStride).toBe(5)
    for (const e of [300_000, 1_000_000, 2_500_000]) expect(share(e)).toBeCloseTo(0.18)
    // Fewer edges, each stronger; never past 0.9.
    expect(share(100_000)).toBeCloseTo(0.28)
    expect(share(10_000)).toBeCloseTo(0.45)
    expect(lodFor(2, 8_000_000).edgeAlpha).toBeLessThanOrEqual(0.9)
  })
})

describe('anyInView: whether a changed picture can keep its camera', () => {
  it('is true while a shown node is on screen, false when the view looks at nothing or only at hidden nodes', () => {
    const e = small()
    e.fit()
    expect(e.anyInView()).toBe(true)
    // Far away: nothing of the picture on screen.
    e.camera.panBy(1e6, 1e6)
    expect(e.anyInView()).toBe(false)
    // Zoomed onto 'a' alone: it is in view — until a filter keeps only the works, which are not.
    e.fit()
    e.camera.zoomAt(40, e.camera.screenX(0), e.camera.screenY(0))
    expect(e.anyInView()).toBe(true)
    const works = new BitSet(e.graph.nodeCount)
    works.set(e.nodeIndex('c'))
    works.set(e.nodeIndex('d'))
    e.setFilter(works)
    expect(e.anyInView()).toBe(false)
    e.setFilter(null)
    expect(e.anyInView()).toBe(true)
  })
})
