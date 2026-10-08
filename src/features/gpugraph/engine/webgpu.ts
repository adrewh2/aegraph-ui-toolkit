import type { ComputeTarget } from './physics'
import { EDGE_QUAD_VERTICES, EDGE_SEGMENTS, type EdgeArrays, type FrameParams, type NodeArrays, type Renderer } from './types'

/**
 * The WebGPU backend: the same picture as `webgl2.ts` from the same
 * arrays. Nodes (position+radius, colour, flags) and edges (source, target,
 * colour, flags|width) are storage buffers. Quads (nodes, edges up close)
 * are instanced strips of four vertices; lines and arrowheads are plain
 * vertex runs, the shader dividing `vertex_index` into the edge and its end
 * (an instance of two vertices costs a GPU more than the vertices do). The
 * frame parameters are one uniform buffer with a slot per draw mode, bound
 * with a dynamic offset, so a frame is one render pass in one submit. The pipelines share two shader modules: nodes, edge lines,
 * edge quads, arrowheads, and the id passes for picking into a 16×16
 * texture copied to a mappable buffer; each exists with and without the
 * depth test (3D and 2D).
 */

const WGSL = /* wgsl */ `
struct Frame {
  vp: mat4x4f,
  view: vec2f, ortho: f32, sizeK: f32,
  minPx: f32, maxPx: f32, focus: f32, fadeAlpha: f32,
  edgeFadeAlpha: f32, edgeWidth: f32, edgeAlpha: f32, mode: u32,
  selColor: vec4f, hovColor: vec4f, pathColor: vec4f,
  stride: u32, edgeCount: u32, _p2: u32, _p3: u32,
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> posr: array<vec4f>;
@group(0) @binding(2) var<storage, read> colors: array<u32>;
@group(0) @binding(3) var<storage, read> flags: array<u32>;
@group(0) @binding(4) var<storage, read> edges: array<vec4u>;

fn unpack(c: u32) -> vec4f { return vec4f(f32(c & 255u), f32((c >> 8u) & 255u), f32((c >> 16u) & 255u), f32((c >> 24u) & 255u)) / 255.0; }
fn screenOf(c: vec4f) -> vec2f { let ndc = c.xy / c.w; return vec2f((ndc.x * 0.5 + 0.5) * F.view.x, (0.5 - ndc.y * 0.5) * F.view.y); }
fn clipFromScreen(px: vec2f, c: vec4f) -> vec4f { let ndc = vec2f(px.x / F.view.x * 2.0 - 1.0, 1.0 - px.y / F.view.y * 2.0); return vec4f(ndc * c.w, c.z, c.w); }
fn radiusPx(size: f32, w: f32) -> f32 { return clamp(size * F.sizeK / select(w, 1.0, F.ortho > 0.5), F.minPx, F.maxPx); }
fn idColor(id: u32) -> vec4f { let k = id + 1u; return vec4f(f32(k & 255u) / 255.0, f32((k >> 8u) & 255u) / 255.0, f32((k >> 16u) & 255u) / 255.0, 1.0); }

struct NodeOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f, @location(2) ring: f32, @location(3) radius: f32, @location(4) ringColor: vec4f, @location(5) @interpolate(flat) shape: u32 };

// The distance from the centre at which a shape's outline lies at the radius: a circle by length, a square by its half
// side, a diamond by its vertices at 1.25r (the quad is widened to hold them), a triangle by its circumradius.
fn shapeDist(uv: vec2f, shape: u32) -> f32 {
  if (shape == 1u) { return max(abs(uv.x), abs(uv.y)); }
  if (shape == 2u) { return (abs(uv.x) + abs(uv.y)) * 0.8; }
  if (shape == 3u) { return 2.0 * max(uv.y, max(dot(uv, vec2f(0.866, -0.5)), dot(uv, vec2f(-0.866, -0.5)))); }
  return length(uv);
}

// A quad is a strip of four vertices, one instance a node (or an edge): the corner from the vertex index.
fn corner4(v: u32) -> vec2f {
  if (v == 1u) { return vec2f(1.0, -1.0); }
  if (v == 2u) { return vec2f(-1.0, 1.0); }
  if (v == 3u) { return vec2f(1.0, 1.0); }
  return vec2f(-1.0, -1.0);
}

@vertex fn nodeVs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> NodeOut {
  var o: NodeOut;
  let p = posr[i]; let f = flags[i];
  let c4 = F.vp * vec4f(p.xyz, 1.0);
  if ((f & 1u) != 0u || c4.w <= 0.0) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
  var r = radiusPx(p.w, c4.w);
  let sel = (f & 2u) != 0u; let hov = (f & 4u) != 0u; let around = (f & 8u) != 0u; let path = (f & 32u) != 0u;
  let lit = sel || hov || around || path;
  if (sel || hov) { r += 1.5; }
  var c = unpack(colors[i]);
  if (F.focus > 0.5 && !lit) { c.a *= F.fadeAlpha; }
  o.ring = select(0.0, 1.0, sel || hov || path);
  o.ringColor = select(select(F.selColor, F.pathColor, path), F.hovColor, hov);
  o.shape = (f >> 8u) & 3u;
  var half = (r + 1.5 + select(0.0, 2.5, o.ring > 0.5)) * select(1.0, 1.25, o.shape == 2u);
  if (F.mode == 3u) { c = idColor(i); o.ring = 0.0; r = max(r, 3.0) + 1.0; half = r * select(1.0, 1.25, o.shape == 2u); }
  let k = corner4(v);
  let px = screenOf(c4) + k * half;
  o.pos = clipFromScreen(px, c4); o.uv = k * half; o.radius = r; o.color = c;
  return o;
}

@fragment fn nodeFs(in: NodeOut) -> @location(0) vec4f {
  let d = shapeDist(in.uv, in.shape);
  if (F.mode == 3u) { if (d > in.radius) { discard; } return in.color; }
  let aa = 0.75;
  let body = 1.0 - smoothstep(in.radius - aa, in.radius + aa, d);
  if (in.ring > 0.5) {
    let outer = in.radius + 2.5;
    let ring = (1.0 - smoothstep(outer - aa, outer + aa, d)) * smoothstep(in.radius + 0.5 - aa, in.radius + 0.5 + aa, d);
    let a = max(in.color.a * body, in.ringColor.a * ring);
    if (a <= 0.002) { discard; }
    let rgb = mix(in.color.rgb, in.ringColor.rgb, ring);
    return vec4f(rgb * a, a);
  }
  let a = in.color.a * body;
  if (a <= 0.002) { discard; }
  return vec4f(in.color.rgb * a, a);
}

struct EdgeOut { @builtin(position) pos: vec4f, @location(0) color: vec4f, @location(1) across: f32, @location(2) half: f32 };

@vertex fn edgeVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> EdgeOut {
  var o: EdgeOut;
  // Lines are a plain run of two vertices an edge, arrowheads of three; quads (and the pick pass) are instanced
  // strips of four. Every stride-th edge is drawn.
  let plain = F.mode == 0u || F.mode == 2u;
  let per = select(2u, 3u, F.mode == 2u);
  let i = select(ii, vi / per, plain) * F.stride;
  let v = select(vi, vi % per, plain);
  if (i >= F.edgeCount) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); o.half = 1.0; return o; }
  let e = edges[i];
  let s = e.x; let t = e.y; let ef = e.w;
  let fs = flags[s]; let ft = flags[t];
  let ps = posr[s]; let pt = posr[t];
  let cs = F.vp * vec4f(ps.xyz, 1.0); let ct = F.vp * vec4f(pt.xyz, 1.0);
  if (((fs | ft | ef) & 1u) != 0u || cs.w <= 0.0 || ct.w <= 0.0) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); o.half = 1.0; return o; }
  let a = screenOf(cs); let b = screenOf(ct);
  let endLit = ((fs | ft) & 38u) != 0u;
  let edgeLit = (ef & 38u) != 0u;
  let bothAround = ((fs & 8u) != 0u) && ((ft & 8u) != 0u);
  let path = (ef & 32u) != 0u;
  var w = F.edgeWidth * (f32(ef >> 16u) / 16.0);
  var c = unpack(e.z);
  if (F.mode == 3u) { c = idColor(i); w = max(w, 6.0); }
  else {
    c.a *= F.edgeAlpha;
    if (path) { c = F.pathColor; w += 1.5; }
    else if (edgeLit) { c.a = 1.0; w += 2.0; }
    else if (endLit) { c.a = 1.0; w += 1.0; }
    else if (F.focus > 0.5 && !bothAround) { c.a *= F.edgeFadeAlpha; }
  }
  o.color = c;
  let d = b - a; let len = length(d);
  let dir = select(vec2f(1.0, 0.0), d / len, len > 0.0001);
  let n = vec2f(-dir.y, dir.x);
  // A parallel edge bends: a quadratic through a control point off the midpoint (bits 8–15 of the flags, signed
  // 1/64ths of the length). Lines far out stay straight; quads walk the curve, arrowheads take its end tangent.
  let curv = f32((i32(ef << 16u)) >> 24u) / 64.0;
  let ctrl = (a + b) * 0.5 + n * curv * len;
  var px = a;
  var depthOf = cs;
  o.across = 0.0; o.half = 1.0;
  if (F.mode == 0u) { let atA = v == 0u; px = select(b, a, atA); depthOf = select(ct, cs, atA); }
  else if (F.mode == 2u) {
    let rt = radiusPx(pt.w, ct.w);
    let size = max(4.0, w * 3.0 + 3.0);
    let tail = b - ctrl; let tl = length(tail);
    let dirEnd = select(dir, tail / tl, curv != 0.0 && tl > 0.0001);
    let nEnd = vec2f(-dirEnd.y, dirEnd.x);
    let tip = b - dirEnd * (rt + 0.5);
    let base = tip - dirEnd * size;
    if (v == 0u) { px = tip; } else if (v == 1u) { px = base + nEnd * size * 0.5; } else { px = base - nEnd * size * 0.5; }
    depthOf = ct;
    if (len < rt + size + 2.0) { px = vec2f(-1e5, -1e5); }
  } else {
    let half = w * 0.5 + 0.75;
    o.half = half;
    let t = f32(v / 2u) / ${EDGE_SEGMENTS}.0;
    let u = 1.0 - t;
    let p = u * u * a + 2.0 * u * t * ctrl + t * t * b;
    let tan = 2.0 * u * (ctrl - a) + 2.0 * t * (b - ctrl);
    let tlen = length(tan);
    let tdir = select(dir, tan / tlen, tlen > 0.0001);
    let tn = vec2f(-tdir.y, tdir.x);
    depthOf = mix(cs, ct, t);
    let side = select(1.0, -1.0, (v & 1u) == 0u);
    px = p + tn * side * half;
    o.across = side * half;
  }
  o.pos = clipFromScreen(px, depthOf);
  return o;
}

@fragment fn edgeFs(in: EdgeOut) -> @location(0) vec4f {
  if (F.mode == 3u) { return in.color; }
  var a = in.color.a;
  if (F.mode == 1u) { a *= 1.0 - smoothstep(in.half - 1.5, in.half, abs(in.across)); }
  if (a <= 0.002) { discard; }
  return vec4f(in.color.rgb * a, a);
}
`

const UNIFORM_FLOATS = 16 + 12 + 12 + 4
/** One uniform slot per draw mode (lines, quads, arrows, pick), 256 bytes apart: the dynamic-offset alignment. */
const UNIFORM_SLOT = 256
const UNIFORM_SLOTS = 4
// The usage/stage constants of the WebGPU spec: TypeScript's DOM lib types the interfaces but not these globals.
const BufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 }
const ShaderStage = { VERTEX: 1, FRAGMENT: 2 }
const TextureUsage = { COPY_SRC: 1, RENDER_ATTACHMENT: 16 }
const MapMode = { READ: 1 }
const PICK = 16

const rgbaInto = (packed: number, out: Float32Array, at: number) => {
  out[at] = (packed & 255) / 255
  out[at + 1] = ((packed >>> 8) & 255) / 255
  out[at + 2] = ((packed >>> 16) & 255) / 255
  out[at + 3] = ((packed >>> 24) & 255) / 255
}

type PipeKey = 'node' | 'line' | 'quad' | 'arrow' | 'pickNode' | 'pickEdge'

export class WebGPURenderer implements Renderer {
  readonly kind = 'webgpu' as const
  readonly canvas: HTMLCanvasElement
  private device: GPUDevice
  private ctx: GPUCanvasContext
  private format: GPUTextureFormat
  private module: GPUShaderModule
  private layout: GPUPipelineLayout
  private uniform: GPUBuffer
  private uniformData = new Float32Array(UNIFORM_FLOATS)
  private uniformU32: Uint32Array
  private posBuf!: GPUBuffer
  private colorBuf!: GPUBuffer
  private flagBuf!: GPUBuffer
  private edgeBuf!: GPUBuffer
  private nodeCap = 0
  private edgeCap = 0
  private bindLayout: GPUBindGroupLayout
  private bindGroup: GPUBindGroup | null = null
  private pipes = new Map<string, GPURenderPipeline>()
  private depthTex: GPUTexture | null = null
  private pickTex: GPUTexture
  private pickDepth: GPUTexture
  private pickRead: GPUBuffer
  private pickVP = new Float32Array(16)
  private picking: Promise<number> | null = null
  drawCalls = 0

  static async create(canvas: HTMLCanvasElement, opts: { transparent?: boolean } = {}): Promise<WebGPURenderer> {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
    if (!gpu) throw new Error('WebGPU is not available')
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('No WebGPU adapter')
    // Timestamps, when the adapter has them: the physics measures its passes with them.
    const requiredFeatures: GPUFeatureName[] = adapter.features.has('timestamp-query') ? ['timestamp-query'] : []
    const device = await adapter.requestDevice({ requiredFeatures })
    return new WebGPURenderer(canvas, device, gpu.getPreferredCanvasFormat(), !!opts.transparent)
  }

  /** A transparent canvas clears to nothing and composes premultiplied (which is how the shaders blend already). */
  private readonly transparent: boolean

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice, format: GPUTextureFormat, transparent: boolean) {
    this.canvas = canvas
    this.device = device
    this.format = format
    this.transparent = transparent
    const ctx = (canvas as HTMLCanvasElement & { getContext(id: 'webgpu'): GPUCanvasContext | null }).getContext('webgpu')
    if (!ctx) throw new Error('WebGPU canvas context unavailable')
    this.ctx = ctx
    ctx.configure({ device, format, alphaMode: transparent ? 'premultiplied' : 'opaque' })
    this.uniformU32 = new Uint32Array(this.uniformData.buffer)
    this.uniform = device.createBuffer({ size: UNIFORM_SLOT * UNIFORM_SLOTS, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST })
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    })
    this.module = device.createShaderModule({ code: WGSL })
    this.layout = device.createPipelineLayout({ bindGroupLayouts: [this.bindLayout] })
    this.pickTex = device.createTexture({ size: [PICK, PICK], format: 'rgba8unorm', usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC })
    this.pickDepth = device.createTexture({ size: [PICK, PICK], format: 'depth24plus', usage: TextureUsage.RENDER_ATTACHMENT })
    this.pickRead = device.createBuffer({ size: 256 * PICK, usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ })
    this.allocate(1, 1)
  }

  /** A pipeline per (what, depth, target format), made on first use. */
  private pipe(key: PipeKey, depth: boolean, depthWrite: boolean): GPURenderPipeline {
    const id = `${key}|${depth ? 1 : 0}|${depthWrite ? 1 : 0}`
    let p = this.pipes.get(id)
    if (p) return p
    const blend: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }
    const pick = key === 'pickNode' || key === 'pickEdge'
    const node = key === 'node' || key === 'pickNode'
    const topology: GPUPrimitiveTopology = key === 'line' ? 'line-list' : key === 'arrow' ? 'triangle-list' : 'triangle-strip'
    p = this.device.createRenderPipeline({
      layout: this.layout,
      vertex: { module: this.module, entryPoint: node ? 'nodeVs' : 'edgeVs' },
      fragment: { module: this.module, entryPoint: node ? 'nodeFs' : 'edgeFs', targets: [{ format: pick ? 'rgba8unorm' : this.format, ...(pick ? {} : { blend }) }] },
      primitive: { topology },
      ...(depth ? { depthStencil: { format: 'depth24plus', depthWriteEnabled: depthWrite, depthCompare: 'less-equal' } } : {}),
    })
    this.pipes.set(id, p)
    return p
  }

  resize(width: number, height: number, dpr: number) {
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      this.depthTex?.destroy()
      this.depthTex = null
    }
  }
  private depthView(): GPUTextureView {
    if (!this.depthTex) this.depthTex = this.device.createTexture({ size: [this.canvas.width, this.canvas.height], format: 'depth24plus', usage: TextureUsage.RENDER_ATTACHMENT })
    return this.depthTex.createView()
  }

  allocate(nodes: number, edges: number) {
    const d = this.device
    const usage = BufferUsage.STORAGE | BufferUsage.COPY_DST
    let changed = false
    if (nodes > this.nodeCap || !this.posBuf) {
      this.nodeCap = Math.max(nodes, 1)
      this.posBuf?.destroy()
      this.colorBuf?.destroy()
      this.flagBuf?.destroy()
      // Positions are also read back (the physics copies them out), so COPY_SRC.
      this.posBuf = d.createBuffer({ size: this.nodeCap * 16, usage: usage | BufferUsage.COPY_SRC })
      this.generation++
      this.colorBuf = d.createBuffer({ size: this.nodeCap * 4, usage })
      // Flags start hidden (1) so unuploaded slots draw nothing.
      this.flagBuf = d.createBuffer({ size: this.nodeCap * 4, usage, mappedAtCreation: true })
      new Uint32Array(this.flagBuf.getMappedRange()).fill(1)
      this.flagBuf.unmap()
      changed = true
    }
    if (edges > this.edgeCap || !this.edgeBuf) {
      this.edgeCap = Math.max(edges, 1)
      this.edgeBuf?.destroy()
      this.edgeBuf = d.createBuffer({ size: this.edgeCap * 16, usage })
      changed = true
    }
    if (changed || !this.bindGroup) {
      this.bindGroup = d.createBindGroup({
        layout: this.bindLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniform, size: UNIFORM_FLOATS * 4 } },
          { binding: 1, resource: { buffer: this.posBuf } },
          { binding: 2, resource: { buffer: this.colorBuf } },
          { binding: 3, resource: { buffer: this.flagBuf } },
          { binding: 4, resource: { buffer: this.edgeBuf } },
        ],
      })
    }
  }

  /** The device and node buffers, for the physics to compute over; `generation` changes when the buffers do. */
  private generation = 0
  get compute(): ComputeTarget {
    // The target reads the renderer's buffers as they are now — `allocate` replaces them.
    const renderer = this // eslint-disable-line @typescript-eslint/no-this-alias
    return {
      device: this.device,
      get posBuf(): GPUBuffer {
        return renderer.posBuf
      },
      get flagBuf(): GPUBuffer {
        return renderer.flagBuf
      },
      get generation(): number {
        return renderer.generation
      },
    }
  }

  uploadNodes(a: NodeArrays, from: number, to: number, what: { posr?: boolean; color?: boolean; flags?: boolean }) {
    if (to <= from) return
    const q = this.device.queue
    if (what.posr) q.writeBuffer(this.posBuf, from * 16, a.posr, from * 4, (to - from) * 4)
    if (what.color) q.writeBuffer(this.colorBuf, from * 4, a.color, from, to - from)
    if (what.flags) q.writeBuffer(this.flagBuf, from * 4, a.flags, from, to - from)
  }
  uploadEdges(a: EdgeArrays, from: number, to: number) {
    if (to <= from) return
    this.device.queue.writeBuffer(this.edgeBuf, from * 16, a.data, from * 4, (to - from) * 4)
  }

  private writeUniform(slot: number, f: FrameParams, vp: Float32Array, width: number, height: number, mode: number, stride: number) {
    const u = this.uniformData
    u.set(vp, 0)
    u[16] = width
    u[17] = height
    u[18] = f.ortho ? 1 : 0
    u[19] = f.sizeK
    u[20] = f.nodeMinPx
    u[21] = f.nodeMaxPx
    u[22] = f.focus ? 1 : 0
    u[23] = f.fadeAlpha
    u[24] = f.edgeFadeAlpha
    u[25] = f.edgeWidthPx
    u[26] = f.edgeAlpha
    this.uniformU32[27] = mode
    rgbaInto(f.selectColor, u, 28)
    rgbaInto(f.hoverColor, u, 32)
    rgbaInto(f.pathColor, u, 36)
    this.uniformU32[40] = stride
    this.uniformU32[41] = f.edgeCount
    this.device.queue.writeBuffer(this.uniform, slot * UNIFORM_SLOT, u)
  }

  render(f: FrameParams) {
    if (!this.bindGroup) return
    this.drawCalls = 0
    const bg = this.transparent ? [0, 0, 0, 0] : [(f.background & 255) / 255, ((f.background >>> 8) & 255) / 255, ((f.background >>> 16) & 255) / 255, 1]
    const view = this.ctx.getCurrentTexture().createView()
    const depth = f.ortho ? null : this.depthView()
    const edges = f.edgeCount > 0
    const stride = Math.max(1, Math.floor(f.edgeStride || 1))
    const drawn = Math.ceil(f.edgeCount / stride)
    // The slots: 0 lines (and nodes, which read no mode), 1 quads, 2 arrowheads.
    this.writeUniform(0, f, f.viewProj, f.width, f.height, 0, stride)
    if (edges && f.lod !== 0) {
      this.writeUniform(1, f, f.viewProj, f.width, f.height, 1, stride)
      if (f.arrows) this.writeUniform(2, f, f.viewProj, f.width, f.height, 2, stride)
    }
    const enc = this.device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: bg }],
      ...(depth ? { depthStencilAttachment: { view: depth, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } } : {}),
    })
    const draw = (key: PipeKey, slot: number, count: number, depthWrite: boolean) => {
      pass.setPipeline(this.pipe(key, !!depth, depthWrite))
      pass.setBindGroup(0, this.bindGroup!, [slot * UNIFORM_SLOT])
      if (key === 'line') pass.draw(count * 2)
      else if (key === 'arrow') pass.draw(count * 3)
      else if (key === 'quad') pass.draw(EDGE_QUAD_VERTICES, count)
      else pass.draw(4, count)
      this.drawCalls++
    }
    const edgePasses = () => {
      if (!edges) return
      if (f.lod === 0) draw('line', 0, drawn, false)
      else {
        draw('quad', 1, drawn, false)
        if (f.arrows) draw('arrow', 2, drawn, false)
      }
    }
    if (f.ortho) {
      edgePasses()
      if (f.nodeCount > 0) draw('node', 0, f.nodeCount, false)
    } else {
      // 3D: nodes write depth first, so a line behind a node stops at its rim.
      if (f.nodeCount > 0) draw('node', 0, f.nodeCount, true)
      edgePasses()
    }
    pass.end()
    this.device.queue.submit([enc.finish()])
  }

  private async pickAt(f: FrameParams, x: number, y: number, what: 'nodes' | 'edges'): Promise<number> {
    if (!this.bindGroup) return -1
    if (this.picking) await this.picking.catch(() => -1)
    const run = async () => {
      const vp = this.pickVP
      vp.set(f.viewProj)
      const ndcX = (x / f.width) * 2 - 1, ndcY = 1 - (y / f.height) * 2
      const sx = f.width / PICK, sy = f.height / PICK
      for (let c = 0; c < 4; c++) {
        const cx = vp[c * 4], cy = vp[c * 4 + 1], cw = vp[c * 4 + 3]
        vp[c * 4] = (cx - ndcX * cw) * sx
        vp[c * 4 + 1] = (cy - ndcY * cw) * sy
      }
      const d = this.device
      const depth = f.ortho ? null : this.pickDepth.createView()
      const view = this.pickTex.createView()
      const count = what === 'edges' ? f.edgeCount : f.nodeCount
      if (count === 0) return -1
      this.writeUniform(3, f, vp, PICK, PICK, 3, 1)
      const enc = d.createCommandEncoder()
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        ...(depth ? { depthStencilAttachment: { view: depth, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } } : {}),
      })
      pass.setPipeline(this.pipe(what === 'edges' ? 'pickEdge' : 'pickNode', !!depth, true))
      pass.setBindGroup(0, this.bindGroup!, [3 * UNIFORM_SLOT])
      pass.draw(what === 'edges' ? EDGE_QUAD_VERTICES : 4, count)
      pass.end()
      enc.copyTextureToBuffer({ texture: this.pickTex }, { buffer: this.pickRead, bytesPerRow: 256 }, [PICK, PICK])
      d.queue.submit([enc.finish()])
      await this.pickRead.mapAsync(MapMode.READ)
      const p = new Uint8Array(this.pickRead.getMappedRange())
      let best = -1
      let bestD = Infinity
      const c = (PICK - 1) / 2
      for (let py = 0; py < PICK; py++) {
        for (let px = 0; px < PICK; px++) {
          const k = py * 256 + px * 4
          const id = p[k] | (p[k + 1] << 8) | (p[k + 2] << 16)
          if (!id) continue
          const dd = (px - c) ** 2 + (py - c) ** 2
          if (dd < bestD) {
            bestD = dd
            best = id - 1
          }
        }
      }
      this.pickRead.unmap()
      return best
    }
    this.picking = run()
    try {
      return await this.picking
    } finally {
      this.picking = null
    }
  }

  pickEdge(f: FrameParams, x: number, y: number): Promise<number> {
    return this.pickAt(f, x, y, 'edges')
  }
  pickNode(f: FrameParams, x: number, y: number): Promise<number> {
    return this.pickAt(f, x, y, 'nodes')
  }

  destroy() {
    this.posBuf?.destroy()
    this.colorBuf?.destroy()
    this.flagBuf?.destroy()
    this.edgeBuf?.destroy()
    this.uniform.destroy()
    this.pickTex.destroy()
    this.pickDepth.destroy()
    this.pickRead.destroy()
    this.depthTex?.destroy()
    this.ctx.unconfigure()
    // The device goes when the page is idle: destroying it waits for the queue to drain, seconds on a software GPU
    // with a city's worth of nodes in flight, and this runs inside the navigation that unmounted the view.
    const device = this.device
    whenIdle(() => device.destroy())
  }
}

/** Runs `fn` when the page is idle (or after a moment where idle callbacks are not a thing). */
function whenIdle(fn: () => void) {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback
  if (ric) ric(fn, { timeout: 5000 })
  else setTimeout(fn, 250)
}
