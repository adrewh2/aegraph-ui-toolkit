import { describe, expect, it } from 'vitest'
import { generateGraph } from '../generate'
import { PackedGraph } from '../graph'
import { accumulate, DEFAULT_PHYSICS, FarField, farLevelFor, gridAround, gridFor, PhysicsSim, repulsionAt, type PhysicsParams, coolingSteps, decayFor, gridShift, packingSpacing, shiftedGrid, shiftReach, linkRest, linkSpring, sortCells, NEAR_SAMPLES } from '../physics'
import { mulberry32 } from '../random'

/**
 * The force model: the grid pyramid's repulsion agrees with the direct
 * O(N²) sum (every cell counted once, near field exact-ish), springs pull
 * links to their length, a run cools and stops, held nodes stay put, and
 * two dimensions stay flat.
 */

const csrOf = (g: PackedGraph) => {
  g.compact()
  const N = g.nodeCount
  const offsets = new Uint32Array(N + 1)
  for (let i = 0; i < N; i++) g.forEachIncident(i, () => offsets[i + 1]++)
  for (let i = 0; i < N; i++) offsets[i + 1] += offsets[i]
  const neighbors = new Uint32Array(offsets[N])
  const fill = offsets.slice(0, N)
  for (let i = 0; i < N; i++) g.forEachIncident(i, (_e, o) => (neighbors[fill[i]++] = o))
  return { offsets, neighbors }
}

describe('the grid pyramid', () => {
  it('sums every node once: the repulsion on a node matches the direct sum within a few percent, in 3D and 2D', () => {
    for (const dims of [3, 2] as const) {
      const N = 3000
      const rand = mulberry32(7)
      const pos = new Float32Array(N * 3)
      for (let i = 0; i < N; i++) {
        pos[i * 3] = (rand() - 0.5) * 400
        pos[i * 3 + 1] = (rand() - 0.5) * 400
        pos[i * 3 + 2] = dims === 3 ? (rand() - 0.5) * 400 : 0
      }
      const g = gridFor(pos, () => true, N, dims, 12)
      const cells = new Int32Array(g.cells * 4)
      accumulate(g, pos, () => true, N, cells)
      // The counts at every level add up to N.
      for (let l = 0; l < g.levels; l++) {
        let n = 0
        const s = g.levelSide[l]
        const count = dims === 3 ? s * s * s : s * s
        for (let c = 0; c < count; c++) n += cells[(g.levelStart[l] + c) * 4]
        expect(n, `level ${l}`).toBe(N)
      }
      const out = new Float64Array(3)
      for (const level of [0, 1, 2]) {
      const far = new FarField(g, cells, level)
      let worst = 0
      for (const i of [0, 17, 501, 1200, 2999]) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
        repulsionAt(g, cells, far, 36, x, y, z, out, 1)
        let fx = 0, fy = 0, fz = 0, scale = 0
        for (let j = 0; j < N; j++) {
          if (j === i) continue
          const dx = x - pos[j * 3], dy = y - pos[j * 3 + 1], dz = z - pos[j * 3 + 2]
          const d2 = dx * dx + dy * dy + dz * dz + 36
          const w = dims === 3 ? 1 / (d2 * Math.sqrt(d2)) : 1 / d2
          fx += dx * w
          fy += dy * w
          fz += dz * w
          scale += Math.sqrt(d2) * w
        }
        // The pushes of a cloud largely cancel: the error is measured against the size of the terms, not their net.
        const err = Math.hypot(out[0] - fx, out[1] - fy, out[2] - fz) / scale
        worst = Math.max(worst, err)
        if (dims === 2) expect(out[2]).toBe(0)
      }
      // The near field is exact per node; the far field is cell centroids with a first-order expansion, which
      // loses a little with the level's cell size.
      expect(worst, `dims ${dims} far level ${level}`).toBeLessThan(level < 2 ? 0.05 : 0.08)
      }
    }
  })

  it('a grid fits its points with a margin and never shrinks below a few link lengths', () => {
    const g = gridAround(0, 3, 12)
    expect(g.half).toBe(48)
    expect(g.side).toBe(64)
    expect(g.levels).toBe(7)
    expect(g.cells).toBe(64 ** 3 + 32 ** 3 + 16 ** 3 + 8 ** 3 + 4 ** 3 + 2 ** 3 + 1)
    const flat = gridAround(100, 2, 12)
    expect([flat.side, flat.levels, flat.half]).toEqual([256, 9, 105])
    // About two nodes per cell, never above the cap.
    expect(gridAround(0, 3, 12, 400).side).toBe(16)
    expect(gridAround(0, 3, 12, 200_000).side).toBe(64)
    expect(gridAround(0, 2, 12, 400).side).toBe(32)
    expect(gridAround(0, 2, 12, 1_000_000).side).toBe(256)
    // The far field's level: the finest for a million nodes in 64³, one up for two hundred thousand.
    expect(farLevelFor(gridAround(0, 3, 12, 1_000_000), 1_000_000)).toBe(0)
    expect(farLevelFor(gridAround(0, 3, 12, 200_000), 200_000)).toBe(1)
    expect(farLevelFor(gridAround(0, 3, 12, 3000), 3000)).toBe(2)
  })
})

describe('the simulation', () => {
  const setup = (dims: 2 | 3, params: Partial<PhysicsParams> = {}) => {
    const spec = generateGraph({ nodes: 400, edges: 800, seed: 3 })
    const g = PackedGraph.fromArrays({ nodeType: spec.nodeType, edgeSource: spec.edgeSource, edgeTarget: spec.edgeTarget, edgeType: spec.edgeType })
    const { offsets, neighbors } = csrOf(g)
    const pos = new Float32Array(g.nodeCount * 3)
    const rand = mulberry32(1)
    for (let i = 0; i < g.nodeCount; i++) {
      pos[i * 3] = (rand() - 0.5) * 50
      pos[i * 3 + 1] = (rand() - 0.5) * 50
      pos[i * 3 + 2] = dims === 3 ? (rand() - 0.5) * 50 : 0
    }
    return { g, sim: new PhysicsSim(g.nodeCount, offsets, neighbors, pos, { ...DEFAULT_PHYSICS, dims, ...params }), offsets, neighbors }
  }
  const meanLink = (sim: PhysicsSim) => {
    let sum = 0, n = 0
    for (let i = 0; i < sim.nodeCount; i++)
      for (let k = sim.offsets[i]; k < sim.offsets[i + 1]; k++) {
        const j = sim.neighbors[k]
        sum += Math.hypot(sim.positions[i * 3] - sim.positions[j * 3], sim.positions[i * 3 + 1] - sim.positions[j * 3 + 1], sim.positions[i * 3 + 2] - sim.positions[j * 3 + 2])
        n++
      }
    return sum / n
  }
  // Real work on real volumes: what it costs is the machine's business, so the harness is given room and the
  // assertions below say what actually has to hold. A bare timeout here would only ever measure the load.
  it('brings a random graph\'s links toward their length, cools and stops', () => {
    const { sim } = setup(3)
    const before = meanLink(sim)
    // Until alpha is under a tenth (at the default cooling), then on to the end.
    sim.step(Math.ceil(Math.log(0.1) / Math.log(1 - DEFAULT_PHYSICS.alphaDecay)))
    const after = meanLink(sim)
    // Links settle in the neighbourhood of the rest length (a dense random graph cannot reach it exactly).
    expect(Math.abs(after - DEFAULT_PHYSICS.linkDistance)).toBeLessThan(Math.abs(before - DEFAULT_PHYSICS.linkDistance))
    expect(after).toBeGreaterThan(DEFAULT_PHYSICS.linkDistance * 0.8)
    expect(after).toBeLessThan(DEFAULT_PHYSICS.linkDistance * 3)
    expect(sim.alpha).toBeLessThan(0.1)
    sim.step(coolingSteps(DEFAULT_PHYSICS))
    expect(sim.cooled).toBe(true)
    // Nothing flew away: every node within the box the last grid computed.
    for (let i = 0; i < sim.nodeCount; i++) expect(Math.abs(sim.positions[i * 3])).toBeLessThan(sim.grid!.half)
    // Cooled means a step is a no-op; reheating moves again.
    const snap = sim.positions.slice()
    sim.step(5)
    expect(sim.positions).toEqual(snap)
    sim.reheat()
    sim.step(5)
    expect(sim.positions).not.toEqual(snap)
  }, 30_000)
  it('held nodes stay where they are; hidden nodes take no part; two dimensions stay flat', () => {
    const { sim } = setup(2)
    sim.state[0] |= 2
    sim.state[1] = 0
    const x0 = sim.positions[0], y0 = sim.positions[1], x1 = sim.positions[3]
    sim.step(30)
    expect([sim.positions[0], sim.positions[1]]).toEqual([x0, y0])
    expect(sim.positions[3]).toBe(x1)
    for (let i = 0; i < sim.nodeCount; i++) expect(sim.positions[i * 3 + 2]).toBe(0)
    expect(sim.velocity[2]).toBe(0)
  })
  it('a hub with many links is not folded onto its neighbours: the 1/√degree weight', () => {
    // A star: one hub, 60 leaves; the leaves must end up spread around the hub near the link length, not on top of it.
    const N = 61
    const offsets = new Uint32Array(N + 1)
    offsets[1] = 60
    for (let i = 1; i < N; i++) offsets[i + 1] = offsets[i] + 1
    const neighbors = new Uint32Array(120)
    for (let k = 0; k < 60; k++) {
      neighbors[k] = k + 1
      neighbors[60 + k] = 0
    }
    const pos = new Float32Array(N * 3)
    const rand = mulberry32(2)
    for (let i = 1; i < N; i++) for (let a = 0; a < 3; a++) pos[i * 3 + a] = (rand() - 0.5) * 4
    const sim = new PhysicsSim(N, offsets, neighbors, pos, { ...DEFAULT_PHYSICS, dims: 3 })
    sim.step(300)
    let minD = Infinity, maxD = 0
    for (let i = 1; i < N; i++) {
      const d = Math.hypot(pos[i * 3] - pos[0], pos[i * 3 + 1] - pos[1], pos[i * 3 + 2] - pos[2])
      minD = Math.min(minD, d)
      maxD = Math.max(maxD, d)
    }
    expect(minD).toBeGreaterThan(DEFAULT_PHYSICS.linkDistance * 0.5)
    expect(maxD).toBeLessThan(DEFAULT_PHYSICS.linkDistance * 8)
  })
})

describe('a simulation that meets a position that is not a number', () => {
  it('restarts that node near the centre and keeps every other node finite — one NaN no longer reaches them all', () => {
    for (const dims of [2, 3] as const) {
      const N = 400
      const rand = mulberry32(3)
      const g = new PackedGraph()
      for (let i = 0; i < N; i++) g.addNode(0)
      for (let i = 1; i < N; i++) g.addEdge(i, Math.floor(rand() * i), 0)
      const { offsets, neighbors } = csrOf(g)
      const pos = new Float32Array(N * 3)
      for (let i = 0; i < N; i++) {
        pos[i * 3] = (rand() - 0.5) * 300
        pos[i * 3 + 1] = (rand() - 0.5) * 300
        pos[i * 3 + 2] = dims === 3 ? (rand() - 0.5) * 300 : 0
      }
      pos[5 * 3] = NaN
      pos[9 * 3 + 1] = Infinity
      const sim = new PhysicsSim(N, offsets, neighbors, pos, { ...DEFAULT_PHYSICS, dims })
      sim.step(200)
      for (let i = 0; i < N * 3; i++) expect(Number.isFinite(sim.positions[i])).toBe(true)
      // The box was set by the finite nodes, not by the one at infinity.
      expect(sim.grid!.half).toBeLessThan(1e4)
    }
  })
})

describe('the defaults', () => {
  it('cool in about 1,500 iterations, and pack at the spacing the engine keeps a picture by', () => {
    expect(coolingSteps(DEFAULT_PHYSICS)).toBeGreaterThan(1200)
    expect(coolingSteps(DEFAULT_PHYSICS)).toBeLessThan(2000)
    expect(coolingSteps({ ...DEFAULT_PHYSICS, alphaDecay: decayFor(DEFAULT_PHYSICS, 300) })).toBe(300)
    // The measured point: repulsion 0.2 and gravity 0.25 pack at 1.5 link distances; weaker gravity packs looser.
    expect(packingSpacing({ repulsion: 0.2, gravity: 0.25 }, 2)).toBeCloseTo(1.5)
    expect(packingSpacing({ repulsion: 0.2, gravity: 0.1 }, 2)).toBeCloseTo(1.5 * Math.sqrt(2.5))
    expect(packingSpacing({ repulsion: 0.2, gravity: 0.1 }, 3)).toBeCloseTo(1.5 * Math.cbrt(2.5))
  })
})

describe('the grid moves every iteration', () => {
  it('by a deterministic shift within its reach, the box grown so every node is still inside', () => {
    expect(gridShift(7)).toEqual(gridShift(7))
    expect(gridShift(7)).not.toEqual(gridShift(8))
    for (let it = 0; it < 500; it++) for (const s of gridShift(it)) expect(Math.abs(s)).toBeLessThanOrEqual(1)
    for (const dims of [2, 3] as const) {
      const rand = mulberry32(5)
      const N = 2000
      const pos = new Float32Array(N * 3)
      for (let i = 0; i < N * 3; i++) pos[i] = (rand() - 0.5) * 1000
      if (dims === 2) for (let i = 0; i < N; i++) pos[i * 3 + 2] = 0
      const base = gridFor(pos, () => true, N, dims, 12)
      for (let it = 0; it < 50; it++) {
        const g = shiftedGrid(base, gridShift(it))
        // The shift stays within the reach, in cells; every node is inside the moved box (one check per shift: a
        // hundred thousand expect() calls were seconds of harness under a loaded run).
        expect(Math.abs(g.cx) / g.cell).toBeLessThanOrEqual(shiftReach(g.side) + 1e-9)
        let outside = 0
        for (let i = 0; i < N; i++) {
          if (Math.abs(pos[i * 3] - g.cx) > g.half || Math.abs(pos[i * 3 + 1] - g.cy) > g.half || (dims === 3 && Math.abs(pos[i * 3 + 2] - g.cz) > g.half)) outside++
        }
        expect(outside).toBe(0)
      }
    }
    // A small grid moves less: never more than an eighth of its side.
    expect(shiftReach(8)).toBe(1)
    expect(shiftReach(256)).toBe(4)
  }, 30_000)
})

describe('a dense cluster settles as a cloud, not a crystal', () => {
  it('links differ by a hash of their ends: the same from either end, within their range, not all alike', () => {
    const p = DEFAULT_PHYSICS
    const rests = new Set<number>(), springs = new Set<number>()
    for (let i = 0; i < 50; i++)
      for (let j = i + 1; j < 50; j++) {
        expect(linkRest(p, i, j)).toBe(linkRest(p, j, i))
        expect(linkSpring(p, i, j)).toBe(linkSpring(p, j, i))
        expect(Math.abs(linkRest(p, i, j) / p.linkDistance - 1)).toBeLessThanOrEqual(p.linkJitter)
        expect(Math.abs(linkSpring(p, i, j) - 1)).toBeLessThanOrEqual(p.springJitter)
        rests.add(linkRest(p, i, j))
        springs.add(linkSpring(p, i, j))
      }
    expect(rests.size).toBeGreaterThan(1000)
    expect(springs.size).toBeGreaterThan(1000)
    expect(linkRest({ ...p, linkJitter: 0 }, 3, 9)).toBe(p.linkDistance)
    expect(linkSpring({ ...p, springJitter: 0 }, 3, 9)).toBe(1)
  })

  it('a node\'s own cell pushes it node by node: exact up to the sample count, right on average beyond it', () => {
    // A clump of nodes near the origin and one far away, so the clump shares a cell or two of a large box.
    const N = 401
    const rand = mulberry32(3)
    const pos = new Float32Array(N * 3)
    pos[(N - 1) * 3] = 4000
    const g = gridFor(pos, () => true, N, 2, 12)
    // In the middle of one cell (the box is set by the far node).
    const mid = -g.half + (Math.floor(g.half / g.cell) + 0.5) * g.cell
    for (let i = 0; i < N - 1; i++) {
      pos[i * 3] = mid + (rand() - 0.5) * 6
      pos[i * 3 + 1] = mid + (rand() - 0.5) * 6
    }
    const cells = new Int32Array(g.cells * 4)
    accumulate(g, pos, () => true, N, cells)
    const members = sortCells(g, pos, () => true, N, cells)
    // Every node is in its cell's run, once.
    expect(members.start[members.start.length - 1]).toBe(N)
    const far = new FarField(g, cells, farLevelFor(g, N))
    const direct = (i: number) => {
      let fx = 0, fy = 0
      for (let j = 0; j < N; j++) {
        const dx = pos[i * 3] - pos[j * 3], dy = pos[i * 3 + 1] - pos[j * 3 + 1]
        const d2 = dx * dx + dy * dy + 1
        fx += dx / d2
        fy += dy / d2
      }
      return [fx, fy]
    }
    const out = new Float64Array(3)
    for (const i of [0, 57, 222]) {
      const x = pos[i * 3] - g.cx, y = pos[i * 3 + 1] - g.cy
      const [ex, ey] = direct(i)
      // The clump is more than NEAR_SAMPLES a cell: one iteration's sample is noisy, the mean over many is the sum.
      let mx = 0, my = 0
      const seeds = 400
      for (let s = 0; s < seeds; s++) {
        repulsionAt(g, cells, far, 1, x, y, 0, out, 1, { members, node: i, seed: s * 7919 })
        mx += out[0] / seeds
        my += out[1] / seeds
      }
      expect(Math.hypot(mx - ex, my - ey) / Math.hypot(ex, ey), `node ${i}`).toBeLessThan(0.1)
      // The centroid of the others (what the cell stood for before) pushes far less than they do one by one.
      repulsionAt(g, cells, far, 1, x, y, 0, out, 1)
      expect(Math.hypot(out[0] - ex, out[1] - ey)).toBeGreaterThan(Math.hypot(mx - ex, my - ey))
    }
    expect(NEAR_SAMPLES).toBeGreaterThanOrEqual(8)
  })

  it('a hub\'s leaves are not a crystal: their nearest-neighbour distances vary as a cloud\'s do', () => {
    // A hub and 1,200 leaves in two dimensions, run until cool. Identical springs pack the leaves in shells, every
    // leaf the same distance from its nearest (a spread of about 5%); springs that differ leave a cloud (about 40%;
    // points at random are 52%).
    const spread = (springJitter: number) => {
      const L = 1200, N = L + 1
      const offsets = new Uint32Array(N + 1), neighbors = new Uint32Array(2 * L)
      offsets[1] = L
      for (let i = 1; i <= L; i++) {
        neighbors[i - 1] = i
        neighbors[L + i - 1] = 0
        offsets[i + 1] = L + i
      }
      const pos = new Float32Array(N * 3)
      for (let i = 0; i < N; i++) {
        pos[i * 3] = Math.cos(i * 2.4) * Math.sqrt(i) * 3
        pos[i * 3 + 1] = Math.sin(i * 2.4) * Math.sqrt(i) * 3
      }
      const sim = new PhysicsSim(N, offsets, neighbors, pos, { ...DEFAULT_PHYSICS, dims: 2, springJitter })
      while (!sim.cooled) sim.step(100)
      const nn: number[] = []
      for (let i = 1; i < N; i += 5) {
        let best = Infinity
        for (let j = 1; j < N; j++) if (j !== i) best = Math.min(best, Math.hypot(pos[i * 3] - pos[j * 3], pos[i * 3 + 1] - pos[j * 3 + 1]))
        nn.push(best)
      }
      const mean = nn.reduce((a, b) => a + b, 0) / nn.length
      return Math.sqrt(nn.reduce((s, d) => s + (d - mean) ** 2, 0) / nn.length) / mean
    }
    expect(spread(0)).toBeLessThan(0.15)
    expect(spread(DEFAULT_PHYSICS.springJitter)).toBeGreaterThan(0.25)
  }, 60_000)
})
