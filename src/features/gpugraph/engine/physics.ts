import { DEFAULT_PHYSICS, farLevelFor, gridAround, gridShift, SOFTENING, type PhysicsParams } from '../../../core/packed/physics'
import { PHYSICS_WGSL, WORKGROUP } from './physics.wgsl'

/**
 * The live simulation on WebGPU. It owns the velocity, the cell pyramid,
 * the CSR and the held bitset on the device, and steps the model in
 * compute passes over the renderer's own position buffer — so a step is
 * a few dispatches and no copy, and the next draw shows it. Alpha lives
 * here (the CPU side of the model): each step cools it; `reheat` warms it
 * back up for a drag. `readback` copies the positions to the engine's
 * arrays when it needs them (the grid, picking, handing positions on).
 */

/** What the renderer lends the simulation. */
export interface ComputeTarget {
  device: GPUDevice
  posBuf: GPUBuffer
  flagBuf: GPUBuffer
  /** Bumped when the buffers are reallocated: the simulation rebinds. */
  generation: number
}

const PARAM_WORDS = 16 + 12 + 4 + 4
/** Per-iteration parameter slots in one uniform buffer (256-byte aligned, bound with a dynamic offset). */
const PARAM_STRIDE = 256
export const MAX_ITERATIONS_PER_STEP = 32
// The constants by value (the types package does not ship the globals to the test runner).
const BufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 }
const COMPUTE_STAGE = 4
const MAP_READ_MODE = 1

type Kernel = 'clear' | 'extent' | 'bin' | 'scanBlocks' | 'scanTop' | 'scanAdd' | 'scatter' | 'pyramid' | 'farField' | 'forces'

/** A device's physics kernels: the module, the layouts, and the pipelines once they are compiled. */
interface Kernels {
  module: GPUShaderModule
  layout0: GPUBindGroupLayout
  layoutFar: GPUBindGroupLayout
  layoutForces: GPUBindGroupLayout
  layoutScatter: GPUBindGroupLayout
  layout1: GPUBindGroupLayout
  pipelines: Record<Kernel, GPUComputePipeline> | null
  ready: Promise<Record<Kernel, GPUComputePipeline>>
}
const compiled = new WeakMap<GPUDevice, Kernels>()

/**
 * The physics kernels for a device, compiled once and off the main thread. Made one by one the way they used to be
 * (`createComputePipeline`), the first start of a run waited on the GPU process to compile them all — two seconds
 * and more at a million nodes, the page frozen, every time the shader had changed. The engine asks for them as soon
 * as its WebGPU backend exists, so they are usually ready before anyone presses Physics; a run that starts sooner
 * waits for them without stepping.
 */
export function physicsKernels(d: GPUDevice): Kernels {
  const had = compiled.get(d)
  if (had) return had
  const module = d.createShaderModule({ code: PHYSICS_WGSL })
  const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: COMPUTE_STAGE, buffer: { type } })
  const common: GPUBindGroupLayoutEntry[] = [{ binding: 0, visibility: COMPUTE_STAGE, buffer: { type: 'uniform', hasDynamicOffset: true } }, storage(1, 'storage'), storage(2, 'read-only-storage'), storage(3, 'read-only-storage'), storage(4, 'storage'), storage(6, 'read-only-storage'), storage(7, 'read-only-storage')]
  // The cells are atomics while they are built (clear, bin, pyramid) and plain vec4 reads after; the far field is written
  // by one kernel and read by the next: three layouts over the same buffers, one per usage.
  const layout0 = d.createBindGroupLayout({ entries: [...common, storage(5, 'storage')] })
  const layoutFar = d.createBindGroupLayout({ entries: [...common, storage(9, 'read-only-storage'), storage(10, 'storage')] })
  const layoutForces = d.createBindGroupLayout({ entries: [...common, storage(9, 'read-only-storage'), storage(11, 'read-only-storage')] })
  // The scatter counts on the cells' cursors and writes the sorted positions after the far field's cells.
  const layoutScatter = d.createBindGroupLayout({ entries: [...common, storage(5, 'storage'), storage(10, 'storage')] })
  const layout1 = d.createBindGroupLayout({ entries: [storage(0, 'uniform')] })
  const make = (entryPoint: string, l: GPUBindGroupLayout) => d.createComputePipelineAsync({ layout: d.createPipelineLayout({ bindGroupLayouts: [l, layout1] }), compute: { module, entryPoint } })
  const list: [Kernel, string, GPUBindGroupLayout][] = [
    ['clear', 'clear', layout0], ['extent', 'extentPass', layout0], ['bin', 'bin', layout0], ['scanBlocks', 'scanBlocks', layout0], ['scanTop', 'scanTop', layout0], ['scanAdd', 'scanAdd', layout0],
    ['scatter', 'scatter', layoutScatter], ['pyramid', 'pyramid', layout0], ['farField', 'farField', layoutFar], ['forces', 'forces', layoutForces],
  ]
  const k: Kernels = { module, layout0, layoutFar, layoutForces, layoutScatter, layout1, pipelines: null, ready: null! }
  k.ready = Promise.all(list.map(([name, entry, l]) => make(entry, l).then((p) => [name, p] as const))).then((made) => (k.pipelines = Object.fromEntries(made) as Record<Kernel, GPUComputePipeline>))
  // Nobody may be waiting yet: a failure is reported to the run that meets it.
  k.ready.catch(() => undefined)
  compiled.set(d, k)
  return k
}

export class GpuPhysics {
  params: PhysicsParams
  alpha: number
  /** Iterations stepped since start. */
  iterations = 0
  /** Milliseconds the last step's encoding took on the CPU. */
  lastEncodeMs = 0
  /** GPU milliseconds per iteration, from timestamp queries when the device has them (else NaN). */
  gpuMsPerIteration = NaN
  private querySet: GPUQuerySet | null = null
  private wallPending = false
  /** Resolves with the milliseconds per iteration of the latest submit, once measured. */
  private lastTiming: Promise<number> | null = null
  /** Whether a timestamp query has ever come back positive; until then the wall clock stands in. */
  private timestampsWork = false
  private queryResolve: GPUBuffer | null = null
  private queryRead: GPUBuffer | null = null
  private queryPending = false
  private target: ComputeTarget
  private generation = -1
  private nodeCount = 0
  private cellCount = 0
  private farCells = 0
  private farLevel = 0
  private finest = 0
  private kernels: Kernels
  private paramBuf: GPUBuffer
  private paramData = new ArrayBuffer(PARAM_WORDS * 4)
  private velBuf: GPUBuffer | null = null
  private cellBuf: GPUBuffer | null = null
  private farBuf: GPUBuffer | null = null
  private offsetBuf: GPUBuffer | null = null
  private neighborBuf: GPUBuffer | null = null
  private heldBuf: GPUBuffer | null = null
  private levelBufs: GPUBuffer[] = []
  private levelGroups: GPUBindGroup[] = []
  private group0: GPUBindGroup | null = null
  private groupFar: GPUBindGroup | null = null
  private groupScatter: GPUBindGroup | null = null
  private groupForces: GPUBindGroup | null = null
  /** Staging buffers for the copies back, two so one can be in flight while the next is asked for. */
  private readBufs: (GPUBuffer | null)[] = [null, null]
  private readBusy = [false, false]
  private levels = 0
  private side = 0

  /** Called once with the reason when the physics cannot run (a shader that does not compile); `failed` stays set. */
  onError: ((message: string) => void) | null = null
  failed: string | null = null
  private fail(message: string) {
    if (this.failed) return
    this.failed = message
    this.onError?.(message)
  }

  constructor(target: ComputeTarget, params: Partial<PhysicsParams> = {}) {
    this.target = target
    this.params = { ...DEFAULT_PHYSICS, ...params }
    this.alpha = this.params.alpha
    const d = target.device
    this.kernels = physicsKernels(d)
    // A shader that does not compile fails silently at dispatch time: read the log and say so.
    void this.kernels.module.getCompilationInfo().then((info) => {
      const errors = info.messages.filter((m) => m.type === 'error')
      if (errors.length) this.fail(`physics shader: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`)
    })
    this.kernels.ready.catch((err) => this.fail(`physics pipelines: ${err instanceof Error ? err.message : String(err)}`))
    // Everything the kernels write can be copied out: a check (`readBuffer` in a driver script) reads it back.
    this.paramBuf = d.createBuffer({ size: PARAM_STRIDE * MAX_ITERATIONS_PER_STEP, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST | BufferUsage.COPY_SRC })
    if (d.features.has('timestamp-query')) {
      this.querySet = d.createQuerySet({ type: 'timestamp', count: 2 })
      this.queryResolve = d.createBuffer({ size: 16, usage: 0x0200 /* QUERY_RESOLVE */ | BufferUsage.COPY_SRC })
      this.queryRead = d.createBuffer({ size: 16, usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ })
    }
    for (let l = 0; l < 12; l++) {
      const b = d.createBuffer({ size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST })
      d.queue.writeBuffer(b, 0, new Uint32Array([l, 0, 0, 0]))
      this.levelBufs.push(b)
      this.levelGroups.push(d.createBindGroup({ layout: this.kernels.layout1, entries: [{ binding: 0, resource: { buffer: b } }] }))
    }
  }

  /**
   * (Re)load the graph: the CSR (symmetric, from the packed graph), how many
   * nodes, the held bitset. Velocities start at zero; alpha restarts.
   */
  load(nodeCount: number, offsets: Uint32Array, neighbors: Uint32Array, heldWords: Uint32Array) {
    const d = this.target.device
    this.nodeCount = nodeCount
    const g = gridAround(1, this.params.dims, this.params.linkDistance, nodeCount)
    this.levels = g.levels
    this.side = g.side
    this.cellCount = g.cells
    this.farLevel = farLevelFor(g, nodeCount)
    const farSide = g.levelSide[this.farLevel]
    this.farCells = this.params.dims === 3 ? farSide ** 3 : farSide ** 2
    this.velBuf?.destroy()
    this.cellBuf?.destroy()
    this.offsetBuf?.destroy()
    this.neighborBuf?.destroy()
    this.heldBuf?.destroy()
    this.velBuf = d.createBuffer({ size: Math.max(16, nodeCount * 16), usage: BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC })
    // One extra cell: its first word is the extent. Then the finest cells' starts (one more than cells), cursors,
    // and the prefix sum's per-workgroup totals.
    const finest = (this.finest = g.levelSide[0] ** this.params.dims)
    this.cellBuf = d.createBuffer({ size: (this.cellCount + 1) * 16 + Math.ceil((2 * finest + 1 + Math.ceil(finest / WORKGROUP)) / 4) * 16, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC })
    this.farBuf?.destroy()
    // The far field's cells, then the positions sorted by finest cell (one vec4 a node).
    this.farBuf = d.createBuffer({ size: this.farCells * 48 + Math.max(1, nodeCount) * 16, usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC })
    this.offsetBuf = d.createBuffer({ size: Math.max(16, offsets.byteLength), usage: BufferUsage.STORAGE | BufferUsage.COPY_DST })
    this.neighborBuf = d.createBuffer({ size: Math.max(16, neighbors.byteLength), usage: BufferUsage.STORAGE | BufferUsage.COPY_DST })
    this.heldBuf = d.createBuffer({ size: Math.max(16, heldWords.byteLength), usage: BufferUsage.STORAGE | BufferUsage.COPY_DST })
    d.queue.writeBuffer(this.offsetBuf, 0, offsets)
    d.queue.writeBuffer(this.neighborBuf, 0, neighbors)
    d.queue.writeBuffer(this.heldBuf, 0, heldWords)
    this.generation = -1
    this.alpha = this.params.alpha
    this.iterations = 0
    // The uniform parts that do not change per step.
    const u32 = new Uint32Array(this.paramData)
    u32[0] = nodeCount
    u32[1] = this.params.dims
    u32[2] = g.side
    u32[3] = g.levels
    u32[12] = g.cells
    u32[13] = this.farCells
    u32[15] = this.farLevel
    for (let l = 0; l < 12; l++) u32[16 + l] = l < g.levels ? g.levelStart[l] : 0
  }

  /** The held bitset changed (a pin, a drag). */
  setHeld(heldWords: Uint32Array) {
    if (!this.heldBuf) return
    if (heldWords.byteLength > this.heldBuf.size) {
      this.heldBuf.destroy()
      this.heldBuf = this.target.device.createBuffer({ size: heldWords.byteLength, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST })
      this.generation = -1
    }
    this.target.device.queue.writeBuffer(this.heldBuf, 0, heldWords)
  }

  /** Warm the run back up (a drag, a change). */
  reheat(alpha = this.params.alpha) {
    this.alpha = Math.max(this.alpha, alpha)
  }
  /** Whether the kernels are compiled (`physicsKernels`): until then a step does nothing. */
  get ready(): boolean {
    return !!this.kernels.pipelines
  }
  get cooled(): boolean {
    return this.alpha < this.params.alphaMin
  }

  private bind() {
    if (this.generation === this.target.generation && this.group0) return
    const d = this.target.device
    const common: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.paramBuf, size: PARAM_WORDS * 4 } },
      { binding: 1, resource: { buffer: this.target.posBuf } },
      { binding: 2, resource: { buffer: this.target.flagBuf } },
      { binding: 3, resource: { buffer: this.heldBuf! } },
      { binding: 4, resource: { buffer: this.velBuf! } },
      { binding: 6, resource: { buffer: this.offsetBuf! } },
      { binding: 7, resource: { buffer: this.neighborBuf! } },
    ]
    this.group0 = d.createBindGroup({ layout: this.kernels.layout0, entries: [...common, { binding: 5, resource: { buffer: this.cellBuf! } }] })
    this.groupFar = d.createBindGroup({ layout: this.kernels.layoutFar, entries: [...common, { binding: 9, resource: { buffer: this.cellBuf! } }, { binding: 10, resource: { buffer: this.farBuf! } }] })
    this.groupScatter = d.createBindGroup({ layout: this.kernels.layoutScatter, entries: [...common, { binding: 5, resource: { buffer: this.cellBuf! } }, { binding: 10, resource: { buffer: this.farBuf! } }] })
    this.groupForces = d.createBindGroup({ layout: this.kernels.layoutForces, entries: [...common, { binding: 9, resource: { buffer: this.cellBuf! } }, { binding: 11, resource: { buffer: this.farBuf! } }] })
    this.generation = this.target.generation
  }

  /** Encode and submit `n` iterations (at most MAX_ITERATIONS_PER_STEP) as one command buffer. Returns false when cooled (nothing submitted). */
  step(n = 1): boolean {
    const pipelines = this.kernels.pipelines
    if (!this.velBuf || this.nodeCount === 0 || this.cooled || this.failed || !pipelines) return false
    const t0 = performance.now()
    this.bind()
    const d = this.target.device
    const p = this.params
    const f32 = new Float32Array(this.paramData)
    const groups = (count: number) => Math.max(1, Math.ceil(count / WORKGROUP))
    const count = Math.max(1, Math.min(MAX_ITERATIONS_PER_STEP, n))
    // Every iteration's parameters (alpha differs) go up first, one slot each.
    let iterations = 0
    for (let it = 0; it < count; it++) {
      if (this.cooled) break
      f32[4] = p.repulsion * p.linkDistance ** p.dims
      f32[5] = p.linkDistance
      f32[6] = p.linkStrength
      f32[7] = p.gravity
      f32[8] = p.damping
      f32[9] = this.alpha
      f32[10] = p.maxStep
      f32[11] = p.linkDistance * 4
      f32[14] = ((p.softening ?? SOFTENING) * p.linkDistance) ** 2
      // The grid's shift for this iteration: the same hash of the iteration count as the CPU's (gridShift).
      const shift = gridShift(this.iterations + it)
      f32[28] = shift[0]
      f32[29] = shift[1]
      f32[30] = shift[2]
      f32[31] = p.linkJitter ?? 0
      f32[32] = p.springJitter ?? 0
      d.queue.writeBuffer(this.paramBuf, it * PARAM_STRIDE, this.paramData)
      this.alpha += (p.alphaTarget - this.alpha) * p.alphaDecay
      iterations++
    }
    const timed = !!this.querySet && !this.queryPending
    const enc = d.createCommandEncoder()
    for (let it = 0; it < iterations; it++) {
      const first = it === 0, last = it === iterations - 1
      const pass = enc.beginComputePass(timed && (first || last) ? { timestampWrites: { querySet: this.querySet!, ...(first ? { beginningOfPassWriteIndex: 0 } : {}), ...(last ? { endOfPassWriteIndex: 1 } : {}) } } : undefined)
      pass.setBindGroup(0, this.group0!, [it * PARAM_STRIDE])
      pass.setBindGroup(1, this.levelGroups[0])
      pass.setPipeline(pipelines.clear)
      pass.dispatchWorkgroups(groups(this.cellCount * 4 + 1))
      pass.setPipeline(pipelines.extent)
      pass.dispatchWorkgroups(groups(this.nodeCount))
      pass.setPipeline(pipelines.bin)
      pass.dispatchWorkgroups(groups(this.nodeCount))
      pass.setPipeline(pipelines.scanBlocks)
      pass.dispatchWorkgroups(groups(this.finest))
      pass.setPipeline(pipelines.scanTop)
      pass.dispatchWorkgroups(1)
      pass.setPipeline(pipelines.scanAdd)
      pass.dispatchWorkgroups(groups(this.finest))
      pass.setBindGroup(0, this.groupScatter!, [it * PARAM_STRIDE])
      pass.setPipeline(pipelines.scatter)
      pass.dispatchWorkgroups(groups(this.nodeCount))
      pass.setBindGroup(0, this.group0!, [it * PARAM_STRIDE])
      pass.setPipeline(pipelines.pyramid)
      for (let l = 1; l < this.levels; l++) {
        const s = this.side >> l
        pass.setBindGroup(1, this.levelGroups[l])
        pass.dispatchWorkgroups(groups(p.dims === 3 ? s * s * s : s * s))
      }
      pass.setBindGroup(1, this.levelGroups[0])
      pass.setBindGroup(0, this.groupFar!, [it * PARAM_STRIDE])
      pass.setPipeline(pipelines.farField)
      pass.dispatchWorkgroups(groups(this.farCells))
      pass.setBindGroup(0, this.groupForces!, [it * PARAM_STRIDE])
      pass.setPipeline(pipelines.forces)
      pass.dispatchWorkgroups(groups(this.nodeCount))
      pass.end()
    }
    if (timed) {
      enc.resolveQuerySet(this.querySet!, 0, 2, this.queryResolve!, 0)
      enc.copyBufferToBuffer(this.queryResolve!, 0, this.queryRead!, 0, 16)
    }
    d.queue.submit([enc.finish()])
    this.iterations += iterations
    this.lastEncodeMs = performance.now() - t0
    const per = iterations
    if (timed) {
      this.queryPending = true
      this.lastTiming = this.queryRead!.mapAsync(MAP_READ_MODE).then(() => {
        const t = new BigUint64Array(this.queryRead!.getMappedRange())
        const ns = Number(t[1] - t[0])
        this.queryRead!.unmap()
        if (ns > 0) {
          this.gpuMsPerIteration = ns / 1e6 / per
          this.timestampsWork = true
        }
        return this.gpuMsPerIteration
      }).catch(() => this.gpuMsPerIteration).finally(() => (this.queryPending = false))
    }
    // Without timestamps (or while they read as zero — some drivers do), the
    // wall time from submit to done stands in: it counts the queue ahead of
    // the physics too, which is the frame's cost anyway.
    if (!this.wallPending && !this.timestampsWork) {
      this.wallPending = true
      const submitted = performance.now()
      const wall = d.queue.onSubmittedWorkDone().then(() => {
        if (!this.timestampsWork) this.gpuMsPerIteration = (performance.now() - submitted) / per
        return this.gpuMsPerIteration
      }).catch(() => this.gpuMsPerIteration).finally(() => (this.wallPending = false))
      if (!timed) this.lastTiming = wall
    }
    return true
  }

  /**
   * The cost of an iteration with the GPU to itself: `n` iterations now, and
   * their measured milliseconds each once they are done. In a frame the pass
   * shares the GPU with the draw and its timestamps count the sharing, so
   * the loop plans with this number and only reports the other.
   */
  async calibrate(n = 4): Promise<number> {
    if (!this.step(n)) return NaN
    await this.target.device.queue.onSubmittedWorkDone().catch(() => {})
    return this.lastTiming ? await this.lastTiming : this.gpuMsPerIteration
  }

  /** A copy of one of the simulation's buffers (`cells`, `far`, `vel`, `params`), for checks. */
  async readBuffer(which: 'cells' | 'far' | 'vel' | 'params'): Promise<ArrayBuffer> {
    const d = this.target.device
    const buf = which === 'cells' ? this.cellBuf : which === 'far' ? this.farBuf : which === 'vel' ? this.velBuf : this.paramBuf
    if (!buf) return new ArrayBuffer(0)
    const rb = d.createBuffer({ size: buf.size, usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ })
    const enc = d.createCommandEncoder()
    enc.copyBufferToBuffer(buf, 0, rb, 0, buf.size)
    d.queue.submit([enc.finish()])
    await rb.mapAsync(MAP_READ_MODE)
    const out = rb.getMappedRange().slice(0)
    rb.unmap()
    rb.destroy()
    return out
  }

  /**
   * Copy the positions back into `posr` (x, y, z, r per node). Resolves when the copy has landed, or at once with
   * false when both staging buffers are still mapped from earlier copies (two may be in flight, so a copy every
   * frame never waits on the last).
   */
  async readback(posr: Float32Array): Promise<boolean> {
    const d = this.target.device
    const bytes = this.nodeCount * 16
    if (!bytes) return false
    let slot = -1
    for (let k = 0; k < this.readBufs.length; k++) if (!this.readBusy[k]) { slot = k; break }
    if (slot < 0) return false
    let buf = this.readBufs[slot]
    if (!buf || buf.size < bytes) {
      buf?.destroy()
      buf = this.readBufs[slot] = d.createBuffer({ size: bytes, usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ })
    }
    this.readBusy[slot] = true
    try {
      const enc = d.createCommandEncoder()
      enc.copyBufferToBuffer(this.target.posBuf, 0, buf, 0, bytes)
      d.queue.submit([enc.finish()])
      await buf.mapAsync(MAP_READ_MODE, 0, bytes)
      posr.set(new Float32Array(buf.getMappedRange(0, bytes)).subarray(0, this.nodeCount * 4))
      buf.unmap()
      return true
    } finally {
      this.readBusy[slot] = false
    }
  }

  /**
   * Copy back the positions of a few nodes only — the labels on screen — into `posr` at their own places. A frame
   * of labels needs a few hundred positions, not the eight megabytes of a whole copy at half a million nodes: the
   * sorted indices go as one copy per contiguous run into a small staging buffer. `skip(i)` leaves a node's
   * position alone (held: the engine's is newer). Resolves false when both staging buffers are still in flight.
   */
  async gather(indices: Uint32Array, posr: Float32Array, skip: (i: number) => boolean): Promise<boolean> {
    const d = this.target.device
    const sorted = indices.filter((i) => i < this.nodeCount).sort()
    const count = sorted.length
    if (!count) return true
    let slot = -1
    for (let k = 0; k < this.gatherBufs.length; k++) if (!this.gatherBusy[k]) { slot = k; break }
    if (slot < 0) return false
    const bytes = count * 16
    let buf = this.gatherBufs[slot]
    if (!buf || buf.size < bytes) {
      buf?.destroy()
      buf = this.gatherBufs[slot] = d.createBuffer({ size: Math.max(bytes, 4096), usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ })
    }
    this.gatherBusy[slot] = true
    try {
      const enc = d.createCommandEncoder()
      let k = 0
      while (k < count) {
        let j = k + 1
        while (j < count && sorted[j] === sorted[j - 1] + 1) j++
        enc.copyBufferToBuffer(this.target.posBuf, sorted[k] * 16, buf, k * 16, (j - k) * 16)
        k = j
      }
      d.queue.submit([enc.finish()])
      await buf.mapAsync(MAP_READ_MODE, 0, bytes)
      const got = new Float32Array(buf.getMappedRange(0, bytes))
      for (let n = 0; n < count; n++) {
        const i = sorted[n]
        if (skip(i)) continue
        posr[i * 4] = got[n * 4]
        posr[i * 4 + 1] = got[n * 4 + 1]
        posr[i * 4 + 2] = got[n * 4 + 2]
      }
      buf.unmap()
      return true
    } finally {
      this.gatherBusy[slot] = false
    }
  }
  private gatherBufs: (GPUBuffer | null)[] = [null, null]
  private gatherBusy = [false, false]

  destroy() {
    // A map in flight rejects when its buffer goes: the readers catch it.
    for (const b of [this.velBuf, this.cellBuf, this.farBuf, this.offsetBuf, this.neighborBuf, this.heldBuf, ...this.readBufs, ...this.gatherBufs, this.paramBuf, ...this.levelBufs, this.queryResolve, this.queryRead]) b?.destroy()
    // The timestamps too: a simulation is made anew on every start (a rebuild with the switch on is one), on a device
    // that lives as long as the view.
    this.querySet?.destroy()
    this.querySet = this.queryResolve = this.queryRead = null
    this.velBuf = this.cellBuf = this.offsetBuf = this.neighborBuf = this.heldBuf = null
    this.readBufs = [null, null]
    this.gatherBufs = [null, null]
  }
}
