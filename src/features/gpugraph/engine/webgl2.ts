import { EDGE_QUAD_VERTICES, EDGE_SEGMENTS, TEX_SHIFT, TEX_WIDTH, type EdgeArrays, type FrameParams, type NodeArrays, type Renderer } from './types'

/**
 * The WebGL2 backend. Node data lives in three textures indexed by node
 * (position+radius RGBA32F, colour RGBA8, flags R32UI) and edges in one
 * instanced buffer of four u32 (source, target, colour, flags|width): the
 * node draw has no vertex attributes at all — `gl_InstanceID` looks the
 * node up — and the edge shader fetches its endpoints from the same
 * textures, so moving a node uploads one texel and no edge data. Per frame:
 * one edge draw (lines far out, anti-aliased quads closer), one arrow draw
 * when close, one node draw. Both dimensions go through one matrix; in 3D
 * the depth test orders nodes and edges. Picking renders ids into a 16×16
 * target centred on the pointer and reads it back.
 */

const COMMON = `
uniform mat4 uVP; uniform vec2 uView; uniform float uOrtho; uniform float uSizeK; uniform float uMinPx; uniform float uMaxPx;
vec2 screenOf(vec4 c) { vec2 ndc = c.xy / c.w; return vec2((ndc.x * 0.5 + 0.5) * uView.x, (0.5 - ndc.y * 0.5) * uView.y); }
vec4 clipFromScreen(vec2 px, vec4 c) { vec2 ndc = vec2(px.x / uView.x * 2.0 - 1.0, 1.0 - px.y / uView.y * 2.0); return vec4(ndc * c.w, c.z, c.w); }
float radiusPx(float size, float w) { return clamp(size * uSizeK / (uOrtho > 0.5 ? 1.0 : w), uMinPx, uMaxPx); }
vec4 idColor(int id) { int k = id + 1; return vec4(float(k & 255) / 255.0, float((k >> 8) & 255) / 255.0, float((k >> 16) & 255) / 255.0, 1.0); }
`

const NODE_VS = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform sampler2D uPos; uniform sampler2D uColor; uniform usampler2D uFlags;
uniform float uFocus; uniform float uFadeAlpha; uniform int uMode;
uniform vec4 uSelColor; uniform vec4 uHovColor; uniform vec4 uPathColor;
${COMMON}
out vec2 vUv; out vec4 vColor; out float vRing; out float vRadiusPx; out vec4 vRingColor; flat out uint vShape;
const vec2 corners[4] = vec2[4](vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0), vec2(1.0,1.0));
void main() {
  int i = gl_InstanceID;
  ivec2 tc = ivec2(i & ${TEX_WIDTH - 1}, i >> ${TEX_SHIFT});
  vec4 p = texelFetch(uPos, tc, 0);
  uint f = texelFetch(uFlags, tc, 0).r;
  vec4 c4 = uVP * vec4(p.xyz, 1.0);
  vShape = (f >> 8u) & 3u;
  if ((f & 1u) != 0u || c4.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); vColor = vec4(0.0); vRing = 0.0; vRadiusPx = 0.0; vRingColor = vec4(0.0); return; }
  float r = radiusPx(p.w, c4.w);
  bool sel = (f & 2u) != 0u; bool hov = (f & 4u) != 0u; bool around = (f & 8u) != 0u; bool path = (f & 32u) != 0u;
  bool lit = sel || hov || around || path;
  if (sel || hov) r += 1.5;
  vec4 c = texelFetch(uColor, tc, 0);
  if (uFocus > 0.5 && !lit) c.a *= uFadeAlpha;
  vRing = (sel || hov || path) ? 1.0 : 0.0;
  vRingColor = hov ? uHovColor : (path ? uPathColor : uSelColor);
  float widen = vShape == 2u ? 1.25 : 1.0;
  float hw = (r + 1.5 + (vRing > 0.5 ? 2.5 : 0.0)) * widen;
  if (uMode == 3) { c = idColor(i); vRing = 0.0; hw = (max(r, 3.0) + 1.0) * widen; }
  vec2 k = corners[gl_VertexID];
  vec2 px = screenOf(c4) + k * hw;
  gl_Position = clipFromScreen(px, c4);
  vUv = k * hw; vRadiusPx = uMode == 3 ? max(r, 3.0) + 1.0 : r; vColor = c;
}`

const NODE_FS = `#version 300 es
precision highp float; precision highp int;
uniform int uMode;
in vec2 vUv; in vec4 vColor; in float vRing; in float vRadiusPx; in vec4 vRingColor; flat in uint vShape;
out vec4 o;
// The distance at which a shape's outline lies at the radius: see shapeDist in the WGSL.
float shapeDist(vec2 uv, uint shape) {
  if (shape == 1u) return max(abs(uv.x), abs(uv.y));
  if (shape == 2u) return (abs(uv.x) + abs(uv.y)) * 0.8;
  if (shape == 3u) return 2.0 * max(uv.y, max(dot(uv, vec2(0.866, -0.5)), dot(uv, vec2(-0.866, -0.5))));
  return length(uv);
}
void main() {
  float d = shapeDist(vUv, vShape);
  if (uMode == 3) { if (d > vRadiusPx) discard; o = vColor; return; }
  float aa = 0.75;
  float body = 1.0 - smoothstep(vRadiusPx - aa, vRadiusPx + aa, d);
  if (vRing > 0.5) {
    float outer = vRadiusPx + 2.5;
    float ring = (1.0 - smoothstep(outer - aa, outer + aa, d)) * smoothstep(vRadiusPx + 0.5 - aa, vRadiusPx + 0.5 + aa, d);
    float a = max(vColor.a * body, vRingColor.a * ring);
    if (a <= 0.002) discard;
    o = vec4(mix(vColor.rgb, vRingColor.rgb, ring), a);
    return;
  }
  float a = vColor.a * body;
  if (a <= 0.002) discard;
  o = vec4(vColor.rgb, a);
}`

// Edges: `uMode` 0 = lines (2 vertices), 1 = quads (a strip of EDGE_QUAD_VERTICES along the curve), 2 = arrowheads (3), 3 = pick quads (wide, id colour).
const EDGE_VS = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform sampler2D uPos; uniform usampler2D uFlags;
uniform float uFocus; uniform float uFadeAlpha;
uniform float uWidth; uniform float uAlpha; uniform int uMode; uniform vec4 uPathColor; uniform vec4 uSelColor; uniform vec4 uHovColor;
uniform int uStride;
${COMMON}
in uvec4 aEdge;
out vec4 vColor; out float vAcross; out float vHalf;
vec4 unpack(uint c) { return vec4(float(c & 255u), float((c >> 8) & 255u), float((c >> 16) & 255u), float((c >> 24) & 255u)) / 255.0; }
void main() {
  uint s = aEdge.x, t = aEdge.y, ef = aEdge.w;
  ivec2 ts = ivec2(int(s) & ${TEX_WIDTH - 1}, int(s) >> ${TEX_SHIFT});
  ivec2 tt = ivec2(int(t) & ${TEX_WIDTH - 1}, int(t) >> ${TEX_SHIFT});
  uint fs = texelFetch(uFlags, ts, 0).r, ft = texelFetch(uFlags, tt, 0).r;
  vec4 ps = texelFetch(uPos, ts, 0), pt = texelFetch(uPos, tt, 0);
  vec4 cs = uVP * vec4(ps.xyz, 1.0), ct = uVP * vec4(pt.xyz, 1.0);
  if (((fs | ft | ef) & 1u) != 0u || cs.w <= 0.0 || ct.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec4(0.0); vAcross = 0.0; vHalf = 1.0; return; }
  vec2 a = screenOf(cs), b = screenOf(ct);
  bool endLit = ((fs | ft) & 38u) != 0u;
  bool edgeLit = (ef & 38u) != 0u;
  bool bothAround = ((fs & 8u) != 0u) && ((ft & 8u) != 0u);
  bool path = (ef & 32u) != 0u;
  float w = uWidth * (float(ef >> 16) / 16.0);
  vec4 c = unpack(aEdge.z);
  if (uMode == 3) { c = idColor(gl_InstanceID * uStride); w = max(w, 6.0); }
  else {
    c.a *= uAlpha;
    if (path) { c = uPathColor; w += 1.5; }
    else if (edgeLit) { c.a = 1.0; w += 2.0; }
    else if (endLit) { c.a = 1.0; w += 1.0; }
    else if (uFocus > 0.5 && !bothAround) c.a *= uFadeAlpha;
  }
  vColor = c;
  vec2 d = b - a; float len = length(d);
  vec2 dir = len > 0.0001 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  // A parallel edge bends: a quadratic through a control point off the midpoint (bits 8–15 of the flags, signed
  // 1/64ths of the length). Lines far out stay straight; quads walk the curve, arrowheads take its end tangent.
  float curv = float(int(ef << 16) >> 24) / 64.0;
  vec2 ctrl = (a + b) * 0.5 + n * curv * len;
  vec2 px; vec4 depthOf;
  if (uMode == 0) { bool atA = gl_VertexID == 0; px = atA ? a : b; depthOf = atA ? cs : ct; vAcross = 0.0; vHalf = 1.0; }
  else if (uMode == 2) {
    // Arrowhead: tip at the target's rim, base a little back along the edge.
    float rt = radiusPx(pt.w, ct.w);
    float size = max(4.0, w * 3.0 + 3.0);
    vec2 tail = b - ctrl; float tl = length(tail);
    vec2 dirEnd = (curv != 0.0 && tl > 0.0001) ? tail / tl : dir;
    vec2 nEnd = vec2(-dirEnd.y, dirEnd.x);
    vec2 tip = b - dirEnd * (rt + 0.5);
    vec2 base = tip - dirEnd * size;
    px = gl_VertexID == 0 ? tip : (gl_VertexID == 1 ? base + nEnd * size * 0.5 : base - nEnd * size * 0.5);
    depthOf = ct;
    vAcross = 0.0; vHalf = 1.0;
    if (len < rt + size + 2.0) px = vec2(-1e5);
  } else {
    float hw = w * 0.5 + 0.75;
    vHalf = hw;
    int v = gl_VertexID;
    float t = float(v / 2) / ${EDGE_SEGMENTS}.0;
    float u = 1.0 - t;
    vec2 p = u * u * a + 2.0 * u * t * ctrl + t * t * b;
    vec2 tan = 2.0 * u * (ctrl - a) + 2.0 * t * (b - ctrl);
    float tlen = length(tan);
    vec2 tdir = tlen > 0.0001 ? tan / tlen : dir;
    vec2 tn = vec2(-tdir.y, tdir.x);
    depthOf = mix(cs, ct, t);
    float side = (v & 1) == 0 ? -1.0 : 1.0;
    px = p + tn * side * hw;
    vAcross = side * hw;
  }
  gl_Position = clipFromScreen(px, depthOf);
}`

const EDGE_FS = `#version 300 es
precision highp float; precision highp int;
uniform int uMode;
in vec4 vColor; in float vAcross; in float vHalf;
out vec4 o;
void main() {
  if (uMode == 3) { o = vColor; return; }
  float a = vColor.a;
  if (uMode == 1) a *= 1.0 - smoothstep(vHalf - 1.5, vHalf, abs(vAcross));
  if (a <= 0.002) discard;
  o = vec4(vColor.rgb, a);
}`

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`GPU graph shader: ${gl.getShaderInfoLog(s)}`)
  return s
}
function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`GPU graph program: ${gl.getProgramInfoLog(p)}`)
  return p
}
const rgba = (packed: number, out: Float32Array) => {
  out[0] = (packed & 255) / 255
  out[1] = ((packed >>> 8) & 255) / 255
  out[2] = ((packed >>> 16) & 255) / 255
  out[3] = ((packed >>> 24) & 255) / 255
  return out
}
const PICK = 16
const NODE_UNIFORMS = ['uPos', 'uColor', 'uFlags', 'uVP', 'uView', 'uOrtho', 'uSizeK', 'uMinPx', 'uMaxPx', 'uFocus', 'uFadeAlpha', 'uMode', 'uSelColor', 'uHovColor', 'uPathColor']
const EDGE_UNIFORMS = ['uPos', 'uFlags', 'uVP', 'uView', 'uOrtho', 'uSizeK', 'uMinPx', 'uMaxPx', 'uFocus', 'uFadeAlpha', 'uWidth', 'uAlpha', 'uMode', 'uPathColor', 'uSelColor', 'uHovColor', 'uStride']

export class WebGL2Renderer implements Renderer {
  readonly kind = 'webgl2' as const
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private nodeProg: WebGLProgram
  private edgeProg: WebGLProgram
  private nodeU: Record<string, WebGLUniformLocation | null> = {}
  private edgeU: Record<string, WebGLUniformLocation | null> = {}
  private posTex: WebGLTexture
  private colorTex: WebGLTexture
  private flagTex: WebGLTexture
  private texRows = 0
  private edgeBuf: WebGLBuffer
  private edgeVao: WebGLVertexArrayObject
  private edgeLoc = 0
  private nodeVao: WebGLVertexArrayObject
  private edgeCapacity = 0
  private pickFbo: WebGLFramebuffer
  private pickTex: WebGLTexture
  private pickPixels = new Uint8Array(PICK * PICK * 4)
  private tmp = new Float32Array(4)
  private pickVP = new Float32Array(16)
  drawCalls = 0
  private lost = false

  /** A transparent canvas clears to nothing, so the picture composes over what is behind it (a map's tiles). */
  private readonly transparent: boolean

  constructor(canvas: HTMLCanvasElement, opts: { transparent?: boolean } = {}) {
    this.canvas = canvas
    this.transparent = !!opts.transparent
    const gl = canvas.getContext('webgl2', { alpha: this.transparent, antialias: false, depth: true, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' })
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
    })
    this.nodeProg = program(gl, NODE_VS, NODE_FS)
    this.edgeProg = program(gl, EDGE_VS, EDGE_FS)
    for (const n of NODE_UNIFORMS) this.nodeU[n] = gl.getUniformLocation(this.nodeProg, n)
    for (const n of EDGE_UNIFORMS) this.edgeU[n] = gl.getUniformLocation(this.edgeProg, n)
    this.posTex = gl.createTexture()!
    this.colorTex = gl.createTexture()!
    this.flagTex = gl.createTexture()!
    for (const t of [this.posTex, this.colorTex, this.flagTex]) {
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    this.edgeBuf = gl.createBuffer()!
    this.edgeVao = gl.createVertexArray()!
    gl.bindVertexArray(this.edgeVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf)
    const loc = gl.getAttribLocation(this.edgeProg, 'aEdge')
    this.edgeLoc = loc
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribIPointer(loc, 4, gl.UNSIGNED_INT, 16, 0)
    gl.vertexAttribDivisor(loc, 1)
    gl.bindVertexArray(null)
    this.nodeVao = gl.createVertexArray()!
    // Picking: a small RGBA8 + depth target.
    this.pickTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.pickTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PICK, PICK, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    const depth = gl.createRenderbuffer()!
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, PICK, PICK)
    this.pickFbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.disable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  resize(width: number, height: number, dpr: number) {
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  allocate(nodes: number, edges: number) {
    const gl = this.gl
    const rows = Math.max(1, Math.ceil(nodes / TEX_WIDTH))
    if (rows !== this.texRows) {
      this.texRows = rows
      gl.bindTexture(gl.TEXTURE_2D, this.posTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, null)
      gl.bindTexture(gl.TEXTURE_2D, this.colorTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TEX_WIDTH, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindTexture(gl.TEXTURE_2D, this.flagTex)
      // Fresh flag rows read as hidden until uploaded: the texture is created from a filled array.
      const hidden = new Uint32Array(TEX_WIDTH * rows).fill(1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, TEX_WIDTH, rows, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, hidden)
    }
    if (edges > this.edgeCapacity) {
      this.edgeCapacity = edges
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf)
      gl.bufferData(gl.ARRAY_BUFFER, edges * 16, gl.DYNAMIC_DRAW)
    }
  }

  /** Upload rows of a node texture covering [from, to): whole rows, since a range can span several. */
  private uploadRows(tex: WebGLTexture, format: number, type: number, data: Float32Array | Uint32Array | Uint8Array, comps: number, from: number, to: number) {
    const gl = this.gl
    const r0 = from >> TEX_SHIFT, r1 = (to - 1) >> TEX_SHIFT
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (r0 === r1) {
      const n = to - from
      gl.texSubImage2D(gl.TEXTURE_2D, 0, from & (TEX_WIDTH - 1), r0, n, 1, format, type, data.subarray(from * comps, (from + n) * comps))
      return
    }
    const start = r0 << TEX_SHIFT
    const rows = r1 - r0 + 1
    const end = Math.min((r1 + 1) << TEX_SHIFT, data.length / comps)
    const view = data.subarray(start * comps, end * comps)
    if (end - start === rows * TEX_WIDTH) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r0, TEX_WIDTH, rows, format, type, view)
    else {
      // The last row is partial: full rows first, then the tail.
      const full = rows - 1
      if (full > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r0, TEX_WIDTH, full, format, type, view.subarray(0, full * TEX_WIDTH * comps))
      const tail = end - (r1 << TEX_SHIFT)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r1, tail, 1, format, type, view.subarray(full * TEX_WIDTH * comps, (full * TEX_WIDTH + tail) * comps))
    }
  }

  uploadNodes(a: NodeArrays, from: number, to: number, what: { posr?: boolean; color?: boolean; flags?: boolean }) {
    if (to <= from || this.lost) return
    const gl = this.gl
    if (what.posr) this.uploadRows(this.posTex, gl.RGBA, gl.FLOAT, a.posr, 4, from, to)
    if (what.color) this.uploadRows(this.colorTex, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(a.color.buffer, a.color.byteOffset, a.color.length * 4), 4, from, to)
    if (what.flags) this.uploadRows(this.flagTex, gl.RED_INTEGER, gl.UNSIGNED_INT, a.flags, 1, from, to)
  }

  uploadEdges(a: EdgeArrays, from: number, to: number) {
    if (to <= from || this.lost) return
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf)
    gl.bufferSubData(gl.ARRAY_BUFFER, from * 16, a.data.subarray(from * 4, to * 4))
  }

  private bindCommon(u: Record<string, WebGLUniformLocation | null>, f: FrameParams, width: number, height: number, vp: Float32Array) {
    const gl = this.gl
    gl.uniformMatrix4fv(u.uVP, false, vp)
    gl.uniform2f(u.uView, width, height)
    gl.uniform1f(u.uOrtho, f.ortho ? 1 : 0)
    gl.uniform1f(u.uSizeK, f.sizeK)
    gl.uniform1f(u.uMinPx, f.nodeMinPx)
    gl.uniform1f(u.uMaxPx, f.nodeMaxPx)
    gl.uniform1f(u.uFocus, f.focus ? 1 : 0)
    gl.uniform4fv(u.uSelColor, rgba(f.selectColor, this.tmp))
    gl.uniform4fv(u.uHovColor, rgba(f.hoverColor, this.tmp))
    gl.uniform4fv(u.uPathColor, rgba(f.pathColor, this.tmp))
  }

  private bindTextures(u: Record<string, WebGLUniformLocation | null>, withColor: boolean) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.posTex)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.flagTex)
    gl.uniform1i(u.uPos, 0)
    gl.uniform1i(u.uFlags, 2)
    if (withColor) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.colorTex)
      gl.uniform1i(u.uColor, 1)
    }
  }

  private edgeStride = 1
  /** The edge attribute reads every n-th record (the VAO is bound). */
  private setEdgeStride(stride: number) {
    const gl = this.gl
    gl.uniform1i(this.edgeU.uStride, stride)
    if (stride === this.edgeStride) return
    this.edgeStride = stride
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf)
    gl.vertexAttribIPointer(this.edgeLoc, 4, gl.UNSIGNED_INT, 16 * stride, 0)
  }

  private drawEdges(f: FrameParams, width: number, height: number, vp: Float32Array, pick: boolean) {
    const gl = this.gl
    if (f.edgeCount === 0) return
    gl.useProgram(this.edgeProg)
    gl.bindVertexArray(this.edgeVao)
    this.bindTextures(this.edgeU, false)
    this.bindCommon(this.edgeU, f, width, height, vp)
    gl.uniform1f(this.edgeU.uFadeAlpha, f.edgeFadeAlpha)
    gl.uniform1f(this.edgeU.uWidth, f.edgeWidthPx)
    gl.uniform1f(this.edgeU.uAlpha, f.edgeAlpha)
    if (pick) {
      gl.uniform1i(this.edgeU.uMode, 3)
      this.setEdgeStride(1)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, EDGE_QUAD_VERTICES, f.edgeCount)
      this.drawCalls++
      return
    }
    // Every stride-th edge: the attribute steps through the buffer by that many records.
    const stride = Math.max(1, Math.floor(f.edgeStride || 1))
    const drawn = Math.ceil(f.edgeCount / stride)
    this.setEdgeStride(stride)
    if (f.lod === 0) {
      gl.uniform1i(this.edgeU.uMode, 0)
      gl.drawArraysInstanced(gl.LINES, 0, 2, drawn)
      this.drawCalls++
    } else {
      gl.uniform1i(this.edgeU.uMode, 1)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, EDGE_QUAD_VERTICES, drawn)
      this.drawCalls++
      if (f.arrows) {
        gl.uniform1i(this.edgeU.uMode, 2)
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, drawn)
        this.drawCalls++
      }
    }
  }

  private drawNodes(f: FrameParams, width: number, height: number, vp: Float32Array, pick: boolean) {
    const gl = this.gl
    if (f.nodeCount === 0) return
    gl.useProgram(this.nodeProg)
    gl.bindVertexArray(this.nodeVao)
    this.bindTextures(this.nodeU, true)
    this.bindCommon(this.nodeU, f, width, height, vp)
    gl.uniform1f(this.nodeU.uFadeAlpha, f.fadeAlpha)
    gl.uniform1i(this.nodeU.uMode, pick ? 3 : 0)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, f.nodeCount)
    this.drawCalls++
  }

  render(f: FrameParams) {
    if (this.lost) return
    const gl = this.gl
    this.drawCalls = 0
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    rgba(f.background, this.tmp)
    if (this.transparent) gl.clearColor(0, 0, 0, 0)
    else gl.clearColor(this.tmp[0], this.tmp[1], this.tmp[2], 1)
    if (f.ortho) {
      gl.disable(gl.DEPTH_TEST)
      gl.clear(gl.COLOR_BUFFER_BIT)
      this.drawEdges(f, f.width, f.height, f.viewProj, false)
      this.drawNodes(f, f.width, f.height, f.viewProj, false)
    } else {
      // 3D: nodes write depth, then edges are tested against them so a line behind a node stops at its rim.
      gl.enable(gl.DEPTH_TEST)
      gl.depthMask(true)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      this.drawNodes(f, f.width, f.height, f.viewProj, false)
      gl.depthMask(false)
      this.drawEdges(f, f.width, f.height, f.viewProj, false)
      gl.depthMask(true)
    }
    gl.bindVertexArray(null)
  }

  /** A 16×16 view centred on the pointer, the same matrix shifted: ids for colours, nearest to the centre wins. */
  private pickAt(f: FrameParams, x: number, y: number, what: 'nodes' | 'edges'): number {
    const gl = this.gl
    // Shift the projection so the pointer's NDC lands at the origin, then scale NDC so 16 px fill the target.
    const vp = this.pickVP
    vp.set(f.viewProj)
    const ndcX = (x / f.width) * 2 - 1, ndcY = 1 - (y / f.height) * 2
    const sx = f.width / PICK, sy = f.height / PICK
    // clip' = S · T · clip, applied on the left: rows 0 and 1 of the matrix.
    for (let c = 0; c < 4; c++) {
      const cx = vp[c * 4], cy = vp[c * 4 + 1], cw = vp[c * 4 + 3]
      vp[c * 4] = (cx - ndcX * cw) * sx
      vp[c * 4 + 1] = (cy - ndcY * cw) * sy
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo)
    gl.viewport(0, 0, PICK, PICK)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 0)
    if (f.ortho) {
      gl.disable(gl.DEPTH_TEST)
      gl.clear(gl.COLOR_BUFFER_BIT)
    } else {
      gl.enable(gl.DEPTH_TEST)
      gl.depthMask(true)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    }
    if (what === 'edges') this.drawEdges(f, PICK, PICK, vp, true)
    else this.drawNodes(f, PICK, PICK, vp, true)
    gl.readPixels(0, 0, PICK, PICK, gl.RGBA, gl.UNSIGNED_BYTE, this.pickPixels)
    gl.enable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindVertexArray(null)
    let best = -1
    let bestD = Infinity
    const p = this.pickPixels
    const c = (PICK - 1) / 2
    for (let py = 0; py < PICK; py++) {
      for (let px = 0; px < PICK; px++) {
        const k = (py * PICK + px) * 4
        const id = p[k] | (p[k + 1] << 8) | (p[k + 2] << 16)
        if (!id) continue
        const d = (px - c) ** 2 + (py - c) ** 2
        if (d < bestD) {
          bestD = d
          best = id - 1
        }
      }
    }
    return best
  }

  pickEdge(f: FrameParams, x: number, y: number): Promise<number> {
    if (this.lost || f.edgeCount === 0) return Promise.resolve(-1)
    return Promise.resolve(this.pickAt(f, x, y, 'edges'))
  }
  pickNode(f: FrameParams, x: number, y: number): Promise<number> {
    if (this.lost || f.nodeCount === 0) return Promise.resolve(-1)
    return Promise.resolve(this.pickAt(f, x, y, 'nodes'))
  }

  destroy() {
    const gl = this.gl
    gl.deleteProgram(this.nodeProg)
    gl.deleteProgram(this.edgeProg)
    gl.deleteTexture(this.posTex)
    gl.deleteTexture(this.colorTex)
    gl.deleteTexture(this.flagTex)
    gl.deleteTexture(this.pickTex)
    gl.deleteBuffer(this.edgeBuf)
    gl.deleteFramebuffer(this.pickFbo)
    gl.deleteVertexArray(this.edgeVao)
    gl.deleteVertexArray(this.nodeVao)
    // Losing the context frees the GPU side at once rather than when the canvas is collected, but on a software GPU
    // it took seconds for a city's worth of nodes — and it ran inside the navigation that unmounted the view (a kept
    // page evicted by the next one). It happens when the page is idle instead; nothing reads the context after this.
    whenIdle(() => gl.getExtension('WEBGL_lose_context')?.loseContext())
  }
}

/** Runs `fn` when the page is idle (or after a moment where idle callbacks are not a thing). */
function whenIdle(fn: () => void) {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback
  if (ric) ric(fn, { timeout: 5000 })
  else setTimeout(fn, 250)
}
