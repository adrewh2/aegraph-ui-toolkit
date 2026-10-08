import { NEAR_SAMPLES, SHIFT_CELLS } from '../../../core/packed/physics'
/**
 * The physics kernels — the same model as `core/packed/physics.ts`, in WGSL.
 * One iteration is a sequence of dispatches in one compute pass:
 *
 *   clear     zero the cell sums and the extent
 *   extent    max |coordinate| over the nodes that take part → the box
 *   bin       every node adds itself to its finest cell (atomics, fixed point)
 *   scan      where each finest cell's run of nodes starts (a prefix sum, three dispatches)
 *   scatter   every node copies its position into its cell's run
 *   pyramid   each level sums its children (one dispatch per level)
 *   farField  every cell of the far level (the finest, or a coarser one for
 *             a small graph): the levels above it as the ring sum at the
 *             cell's centre, with its Jacobian (a first-order expansion)
 *   forces    every node: the 3×3×3 finest cells exactly, the rings up to
 *             the far level as point sums, then the far expansions of the
 *             nearest far cells blended at the node; springs over the CSR;
 *             gravity; integrate; write the position back
 *
 * Positions are the renderer's own `posr` buffer, so the next draw sees the
 * step without a copy. Node flags decide who takes part (not hidden); the
 * held bitset who is read but never moved. The cells are one buffer bound
 * twice: as atomics while they are built, as plain vec4 reads after; the
 * word after the last cell holds the extent (a stage may bind eight storage
 * buffers, so it shares). After it: each finest cell's start in the sorted
 * run (cells + 1 words), then the cursors the scatter counts with; the
 * sorted positions live after the far field's cells, in its buffer.
 */

export const WORKGROUP = 256

export const PHYSICS_WGSL = /* wgsl */ `
struct Params {
  nodeCount: u32,
  dims: u32,
  side: u32,
  levels: u32,
  repulsion: f32,
  linkDistance: f32,
  linkStrength: f32,
  gravity: f32,
  damping: f32,
  alpha: f32,
  maxStep: f32,
  minHalf: f32,
  cellCount: u32,
  farCells: u32,
  eps2: f32,
  farLevel: u32,
  starts: array<vec4u, 3>,
  /** The grid's shift this iteration as a fraction of its reach (core/packed/physics.ts › gridShift); w: linkJitter. */
  shift: vec4f,
  /** x: springJitter (core/packed/physics.ts › linkSpring); the rest unused. */
  extra: vec4f,
}
struct Level { level: u32, _a: u32, _b: u32, _c: u32 }

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> posr: array<vec4f>;
@group(0) @binding(2) var<storage, read> flags: array<u32>;
@group(0) @binding(3) var<storage, read> held: array<u32>;
@group(0) @binding(4) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> cells: array<atomic<i32>>;
@group(0) @binding(6) var<storage, read> offsets: array<u32>;
@group(0) @binding(7) var<storage, read> neighbors: array<u32>;
// The same cells, read whole: the far-field and forces layouts bind this in place of the atomic view.
@group(0) @binding(9) var<storage, read> cellsRO: array<vec4i>;
// Per far-level cell: (Fx, Fy, Fz, Jxx), (Jyy, Jzz, Jxy, Jxz), (Jyz, 0, 0, 0).
@group(0) @binding(10) var<storage, read_write> far: array<vec4f>;
@group(0) @binding(11) var<storage, read> farRO: array<vec4f>;
@group(1) @binding(0) var<uniform> L: Level;

const FIXED: f32 = 1024.0;
const N_HIDDEN: u32 = 1u;

fn takesPart(i: u32) -> bool { return (flags[i] & N_HIDDEN) == 0u; }
fn isHeld(i: u32) -> bool { return ((held[i >> 5u] >> (i & 31u)) & 1u) == 1u; }
fn three() -> bool { return P.dims == 3u; }
/**
 * Whether a float is a number: its exponent is not all ones (∞ and NaN). By the bits, because WGSL lets a compiler
 * assume there are no NaNs, and a comparison such as \`x != x\` may be folded away.
 */
fn finite(x: f32) -> bool { return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u; }
fn finiteAt(p: vec3f) -> bool { return finite(p.x) && finite(p.y) && (!three() || finite(p.z)); }
/** The CPU's \`jitter\` (core/packed/physics.ts): a small offset in [-0.5, 0.5) for node i, axis k. */
fn jitter(i: u32, k: u32) -> f32 {
  var h = ((i + 1u) * 0x9e3779b1u) ^ ((k + 1u) * 0x85ebca6bu);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  return f32(h) / 4294967296.0 - 0.5;
}

/** The half-extent of the box: the largest |coordinate| seen, with a margin, never below minHalf. */
fn boxHalf() -> f32 {
  let m = bitcast<f32>(atomicLoad(&cells[P.cellCount * 4u]));
  return max(m * 1.05, P.minHalf) / (1.0 - 2.0 * reach() / f32(P.side));
}
/** The same, from the plain view of the cells. */
fn boxHalfRO() -> f32 {
  let m = bitcast<f32>(cellsRO[P.cellCount].x);
  return max(m * 1.05, P.minHalf) / (1.0 - 2.0 * reach() / f32(P.side));
}
/**
 * The grid moves every iteration (core/packed/physics.ts › SHIFT_CELLS, shiftedGrid): up to \`reach\` finest cells,
 * the box grown to hold it. Binning and the forces read a node at its position minus the shift; springs, gravity and
 * the step are in the world's coordinates.
 */
fn reach() -> f32 { return min(${SHIFT_CELLS}.0, f32(P.side) / 8.0); }
fn shiftOf(half: f32) -> vec3f {
  var s = P.shift.xyz * reach() * (2.0 * half / f32(P.side));
  if (!three()) { s.z = 0.0; }
  return s;
}
fn levelStart(l: u32) -> u32 { return P.starts[l >> 2u][l & 3u]; }
fn levelSide(l: u32) -> u32 { return P.side >> l; }
fn cellIndex(l: u32, x: i32, y: i32, z: i32) -> u32 {
  let s = i32(levelSide(l));
  let local = select(y * s + x, (z * s + y) * s + x, three());
  return levelStart(l) + u32(local);
}
fn cellCoord(v: f32, half: f32, cellScale: f32) -> i32 {
  return clamp(i32(floor((v + half) * cellScale)), 0, i32(P.side) - 1);
}

@compute @workgroup_size(${WORKGROUP})
fn clear(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i <= P.cellCount * 4u) { atomicStore(&cells[i], 0); }
}

var<workgroup> wgMax: atomic<u32>;
@compute @workgroup_size(${WORKGROUP})
fn extentPass(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) lid: u32) {
  if (lid == 0u) { atomicStore(&wgMax, 0u); }
  workgroupBarrier();
  let i = id.x;
  // A coordinate that is not a number does not set the box: one NaN there and every node's force is NaN next.
  if (i < P.nodeCount && takesPart(i) && finiteAt(posr[i].xyz)) {
    let p = posr[i];
    var m = max(abs(p.x), abs(p.y));
    if (three()) { m = max(m, abs(p.z)); }
    // Positive floats order as their bits do; the workgroup reduces first so the one global word is not a hot spot.
    atomicMax(&wgMax, bitcast<u32>(m));
  }
  workgroupBarrier();
  if (lid == 0u) { atomicMax(&cells[P.cellCount * 4u], bitcast<i32>(atomicLoad(&wgMax))); }
}

/** The finest cell a node falls in this iteration. */
fn finestCell(p: vec3f, half: f32) -> u32 {
  let cellScale = f32(P.side) / (2.0 * half);
  let cx = cellCoord(p.x, half, cellScale);
  let cy = cellCoord(p.y, half, cellScale);
  let cz = select(0, cellCoord(p.z, half, cellScale), three());
  return cellIndex(0u, cx, cy, cz);
}
/** The finest level's cell count, and where the runs' starts and the scatter's cursors are in the cells' words. */
fn finestCount() -> u32 { return levelStart(1u); }
fn startsAt() -> u32 { return (P.cellCount + 1u) * 4u; }
fn cursorsAt() -> u32 { return startsAt() + finestCount() + 1u; }
/** The sorted positions, after the far field's cells in its buffer. */
fn membersAt() -> u32 { return P.farCells * 3u; }

@compute @workgroup_size(${WORKGROUP})
fn bin(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.nodeCount || !takesPart(i) || !finiteAt(posr[i].xyz)) { return; }
  let half = boxHalf();
  let p = posr[i].xyz - shiftOf(half);
  let c = finestCell(p, half) * 4u;
  // The scatter reads the cell from here rather than working it out again: two kernels may round the same sums
  // differently (a fused multiply-add in one), and a node on a cell's edge would then be counted in one cell and
  // written into the next one's run. The velocity's fourth word is free until the forces write it back.
  vel[i].w = f32(c / 4u);
  let scale = FIXED / half;
  atomicAdd(&cells[c], 1);
  atomicAdd(&cells[c + 1u], i32(round(p.x * scale)));
  atomicAdd(&cells[c + 2u], i32(round(p.y * scale)));
  atomicAdd(&cells[c + 3u], i32(round(select(0.0, p.z, three()) * scale)));
}

// The runs' starts: an exclusive prefix sum of the finest counts, in three dispatches — each workgroup scans its
// stretch of cells (scanBlocks), one scans the stretches' totals (scanTop), each stretch adds what came before (scanAdd).
fn blocksAt() -> u32 { return cursorsAt() + finestCount(); }
fn blockCount() -> u32 { return (finestCount() + ${WORKGROUP - 1}u) / ${WORKGROUP}u; }
var<workgroup> sums: array<u32, ${WORKGROUP}>;
/** An inclusive scan of \`sums\` across the workgroup (every thread calls it). */
fn scanShared(t: u32) {
  for (var off = 1u; off < ${WORKGROUP}u; off <<= 1u) {
    var v = 0u;
    if (t >= off) { v = sums[t - off]; }
    workgroupBarrier();
    sums[t] += v;
    workgroupBarrier();
  }
}
@compute @workgroup_size(${WORKGROUP})
fn scanBlocks(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) t: u32) {
  let c = wg.x * ${WORKGROUP}u + t;
  var own = 0u;
  if (c < finestCount()) { own = u32(atomicLoad(&cells[c * 4u])); }
  sums[t] = own;
  workgroupBarrier();
  scanShared(t);
  if (c < finestCount()) { atomicStore(&cells[startsAt() + c], i32(sums[t] - own)); }
  if (t == ${WORKGROUP - 1}u) { atomicStore(&cells[blocksAt() + wg.x], i32(sums[t])); }
}
@compute @workgroup_size(${WORKGROUP})
fn scanTop(@builtin(local_invocation_index) t: u32) {
  let n = blockCount();
  let chunk = (n + ${WORKGROUP - 1}u) / ${WORKGROUP}u;
  let a = min(t * chunk, n);
  let b = min(a + chunk, n);
  var own = 0u;
  for (var k = a; k < b; k++) { own += u32(atomicLoad(&cells[blocksAt() + k])); }
  sums[t] = own;
  workgroupBarrier();
  scanShared(t);
  var run = sums[t] - own;
  for (var k = a; k < b; k++) {
    let v = u32(atomicLoad(&cells[blocksAt() + k]));
    atomicStore(&cells[blocksAt() + k], i32(run));
    run += v;
  }
  if (t == ${WORKGROUP - 1}u) { atomicStore(&cells[startsAt() + finestCount()], i32(sums[t])); }
}
@compute @workgroup_size(${WORKGROUP})
fn scanAdd(@builtin(global_invocation_id) id: vec3u) {
  let c = id.x;
  if (c >= finestCount()) { return; }
  let at = u32(atomicLoad(&cells[startsAt() + c])) + u32(atomicLoad(&cells[blocksAt() + c / ${WORKGROUP}u]));
  atomicStore(&cells[startsAt() + c], i32(at));
  atomicStore(&cells[cursorsAt() + c], i32(at));
}

@compute @workgroup_size(${WORKGROUP})
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.nodeCount || !takesPart(i) || !finiteAt(posr[i].xyz)) { return; }
  let c = u32(vel[i].w);
  let k = u32(atomicAdd(&cells[cursorsAt() + c], 1));
  far[membersAt() + k] = vec4f(posr[i].xyz, 0.0);
}

@compute @workgroup_size(${WORKGROUP})
fn pyramid(@builtin(global_invocation_id) id: vec3u) {
  let l = L.level;
  let s = levelSide(l);
  let count = select(s * s, s * s * s, three());
  let i = id.x;
  if (i >= count) { return; }
  let x = i32(i % s);
  let y = i32((i / s) % s);
  let z = select(0, i32(i / (s * s)), three());
  var n = 0; var sx = 0; var sy = 0; var sz = 0;
  let zc = select(1, 2, three());
  for (var kz = 0; kz < zc; kz++) {
    for (var ky = 0; ky < 2; ky++) {
      for (var kx = 0; kx < 2; kx++) {
        // A level's side is a power of two: every child exists.
        let c = cellIndex(l - 1u, x * 2 + kx, y * 2 + ky, z * 2 + kz) * 4u;
        n += atomicLoad(&cells[c]);
        sx += atomicLoad(&cells[c + 1u]);
        sy += atomicLoad(&cells[c + 2u]);
        sz += atomicLoad(&cells[c + 3u]);
      }
    }
  }
  let p = cellIndex(l, x, y, z) * 4u;
  atomicStore(&cells[p], n);
  atomicStore(&cells[p + 1u], sx);
  atomicStore(&cells[p + 2u], sy);
  atomicStore(&cells[p + 3u], sz);
}

/** One far cell's centroid, seen from q: the force and the Jacobian's six numbers. */
fn sampleFar(l: u32, cx: i32, cy: i32, cz: i32, q: vec3f, invScale: f32, F: ptr<function, vec3f>, Jd: ptr<function, vec3f>, Jo: ptr<function, vec3f>) {
  let s = i32(levelSide(l));
  if (cx < 0 || cy < 0 || cz < 0 || cx >= s || cy >= s || (three() && cz >= s)) { return; }
  let cell = cellsRO[cellIndex(l, cx, cy, cz)];
  let n = cell.x;
  if (n == 0) { return; }
  var d = q - vec3f(cell.yzw) * (invScale / f32(n));
  if (!three()) { d.z = 0.0; }
  let d2 = dot(d, d) + P.eps2;
  // Three dimensions: n·d/|d|³, Jacobian n(I/|d|³ − 3ddᵀ/|d|⁵); two: n·d/|d|², Jacobian n(I/|d|² − 2ddᵀ/|d|⁴) — |d|² softened.
  let inv = select(f32(n) / d2, f32(n) / (d2 * sqrt(d2)), three());
  *F += d * inv;
  let k = select(2.0, 3.0, three()) * inv / d2;
  *Jd += vec3f(inv) - k * d * d;
  *Jo -= k * vec3f(d.x * d.y, d.x * d.z, d.y * d.z);
}

// The ring walk — at each level the coarse cells outside the finer 3×3×3 block, the children of those straddling
// it — is written out twice below, once per accumulator (WGSL has no function pointers).

@compute @workgroup_size(${WORKGROUP})
fn farField(@builtin(global_invocation_id) id: vec3u) {
  let c0 = id.x;
  if (c0 >= P.farCells) { return; }
  let L = P.farLevel;
  let s = i32(levelSide(L));
  let fx = i32(c0 % u32(s));
  let fy = i32((c0 / u32(s)) % u32(s));
  let fz = select(0, i32(c0 / u32(s * s)), three());
  // Only the nodes of this cell and its neighbours read this expansion: none there, nothing to compute.
  var wanted = false;
  let zr = select(0, 1, three());
  for (var dz = -zr; dz <= zr && !wanted; dz++) {
    for (var dy = -1; dy <= 1 && !wanted; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let cx = fx + dx; let cy = fy + dy; let cz = fz + dz;
        if (cx < 0 || cy < 0 || cz < 0 || cx >= s || cy >= s || (three() && cz >= s)) { continue; }
        if (cellsRO[cellIndex(L, cx, cy, cz)].x != 0) { wanted = true; break; }
      }
    }
  }
  if (!wanted) { return; }
  let half = boxHalfRO();
  let invScale = half / FIXED;
  let cell = 2.0 * half / f32(P.side) * f32(1u << L);
  var q = vec3f(-half) + (vec3f(f32(fx), f32(fy), f32(fz)) + 0.5) * cell;
  if (!three()) { q.z = 0.0; }
  var F = vec3f(0.0); var Jd = vec3f(0.0); var Jo = vec3f(0.0);
  var fx0 = fx; var fy0 = fy; var fz0 = fz;
  for (var l = L + 1u; l < P.levels; l++) {
    let cx = fx0 >> 1; let cy = fy0 >> 1; let cz = fz0 >> 1;
    for (var dz = -zr; dz <= zr; dz++) {
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let px = cx + dx; let py = cy + dy; let pz = cz + dz;
          // The parent's children in fine coordinates: [px*2, px*2+1]; the fine block: [fx0-1, fx0+1].
          let ox = px * 2 + 1 >= fx0 - 1 && px * 2 <= fx0 + 1;
          let oy = py * 2 + 1 >= fy0 - 1 && py * 2 <= fy0 + 1;
          let oz = !three() || (pz * 2 + 1 >= fz0 - 1 && pz * 2 <= fz0 + 1);
          if (!(ox && oy && oz)) {
            sampleFar(l, px, py, pz, q, invScale, &F, &Jd, &Jo);
          } else {
            let zc = select(1, 2, three());
            for (var kz = 0; kz < zc; kz++) {
              for (var ky = 0; ky < 2; ky++) {
                for (var kx = 0; kx < 2; kx++) {
                  let ax = px * 2 + kx; let ay = py * 2 + ky; let az = pz * 2 + kz;
                  let inside = ax >= fx0 - 1 && ax <= fx0 + 1 && ay >= fy0 - 1 && ay <= fy0 + 1 && (!three() || (az >= fz0 - 1 && az <= fz0 + 1));
                  if (!inside) { sampleFar(l - 1u, ax, ay, az, q, invScale, &F, &Jd, &Jo); }
                }
              }
            }
          }
        }
      }
    }
    fx0 = cx; fy0 = cy; fz0 = cz;
  }
  far[c0 * 3u] = vec4f(F, Jd.x);
  far[c0 * 3u + 1u] = vec4f(Jd.y, Jd.z, Jo.x, Jo.y);
  far[c0 * 3u + 2u] = vec4f(Jo.z, 0.0, 0.0, 0.0);
}

/**
 * The node's own cell, one by one (core/packed/physics.ts › NEAR_SAMPLES): all of it up to that many, else that many
 * in a row from a hashed place, scaled up. The node itself is among them, at no distance, and adds nothing.
 */
fn cellMates(c: u32, n: u32, pw: vec3f, i: u32) -> vec3f {
  let at = startsAt() + c;
  let s0 = u32(cellsRO[at >> 2u][at & 3u]);
  let take = min(n, ${NEAR_SAMPLES}u);
  var o = 0u;
  if (n > take) {
    // The CPU's nearSeed: the bits of this iteration's shift.
    let seed = (bitcast<u32>(P.shift.x) ^ bitcast<u32>(P.shift.y)) ^ 0x5bd1e995u;
    o = min(n - 1u, u32((jitter(i, seed) + 0.5) * f32(n)));
  }
  let base = membersAt() + s0;
  var acc = vec3f(0.0);
  for (var k = 0u; k < take; k++) {
    var m = o + k;
    if (m >= n) { m -= n; }
    var d = pw - farRO[base + m].xyz;
    if (!three()) { d.z = 0.0; }
    let d2 = dot(d, d) + P.eps2;
    acc += d * select(1.0 / d2, 1.0 / (d2 * sqrt(d2)), three());
  }
  return acc * (f32(n) / f32(take));
}

/** One cell's centroid pushing the node at p (point sum, no expansion). */
fn sampleNear(l: u32, cx: i32, cy: i32, cz: i32, p: vec3f, invScale: f32, acc: ptr<function, vec3f>) {
  let s = i32(levelSide(l));
  if (cx < 0 || cy < 0 || cz < 0 || cx >= s || cy >= s || (three() && cz >= s)) { return; }
  let cell = cellsRO[cellIndex(l, cx, cy, cz)];
  let n = cell.x;
  if (n == 0) { return; }
  var d = p - vec3f(cell.yzw) * (invScale / f32(n));
  if (!three()) { d.z = 0.0; }
  let d2 = dot(d, d) + P.eps2;
  *acc += d * select(f32(n) / d2, f32(n) / (d2 * sqrt(d2)), three());
}

@compute @workgroup_size(${WORKGROUP})
fn forces(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= P.nodeCount || !takesPart(i) || isHeld(i)) { return; }
  let half = boxHalfRO();
  let invScale = half / FIXED;
  let cellScale = f32(P.side) / (2.0 * half);
  let s = i32(P.side);
  var p = posr[i].xyz;
  if (!three()) { p.z = 0.0; }
  // A node that is somewhere impossible starts again near the centre, still (as on the CPU).
  if (!finiteAt(p)) {
    let r = vec3f(jitter(i, 0u), jitter(i, 1u), select(0.0, jitter(i, 2u), three())) * P.linkDistance;
    posr[i] = vec4f(r, posr[i].w);
    vel[i] = vec4f(0.0);
    return;
  }
  // The world position (springs, gravity, the step) and the position on this iteration's shifted grid.
  let pw = p;
  p = p - shiftOf(half);
  var f = vec3f(0.0);
  // The near field: the 3×3×3 finest cells, the node's own without itself.
  let fx0 = cellCoord(p.x, half, cellScale);
  let fy0 = cellCoord(p.y, half, cellScale);
  let fz0 = select(0, cellCoord(p.z, half, cellScale), three());
  let zr = select(0, 1, three());
  for (var dz = -zr; dz <= zr; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let cx = fx0 + dx; let cy = fy0 + dy; let cz = fz0 + dz;
        if (cx < 0 || cy < 0 || cz < 0 || cx >= s || cy >= s || (three() && cz >= s)) { continue; }
        let cell = cellsRO[cellIndex(0u, cx, cy, cz)];
        let n = cell.x;
        if (n == 0) { continue; }
        if (dx == 0 && dy == 0 && dz == 0) {
          f += cellMates(cellIndex(0u, cx, cy, cz), u32(n), pw, i);
          continue;
        }
        let m = vec3f(cell.yzw) * invScale;
        var d = p - m / f32(n);
        if (!three()) { d.z = 0.0; }
        let d2 = dot(d, d) + P.eps2;
        f += d * select(f32(n) / d2, f32(n) / (d2 * sqrt(d2)), three());
      }
    }
  }
  // The rings the far field does not hold, as point sums at the node.
  let L = P.farLevel;
  var rx = fx0; var ry = fy0; var rz = fz0;
  for (var l = 1u; l <= L; l++) {
    let cx = rx >> 1; let cy = ry >> 1; let cz = rz >> 1;
    for (var dz = -zr; dz <= zr; dz++) {
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let px = cx + dx; let py = cy + dy; let pz = cz + dz;
          let ox = px * 2 + 1 >= rx - 1 && px * 2 <= rx + 1;
          let oy = py * 2 + 1 >= ry - 1 && py * 2 <= ry + 1;
          let oz = !three() || (pz * 2 + 1 >= rz - 1 && pz * 2 <= rz + 1);
          if (!(ox && oy && oz)) {
            sampleNear(l, px, py, pz, p, invScale, &f);
          } else {
            let zc = select(1, 2, three());
            for (var kz = 0; kz < zc; kz++) {
              for (var ky = 0; ky < 2; ky++) {
                for (var kx = 0; kx < 2; kx++) {
                  let ax = px * 2 + kx; let ay = py * 2 + ky; let az = pz * 2 + kz;
                  let inside = ax >= rx - 1 && ax <= rx + 1 && ay >= ry - 1 && ay <= ry + 1 && (!three() || (az >= rz - 1 && az <= rz + 1));
                  if (!inside) { sampleNear(l - 1u, ax, ay, az, p, invScale, &f); }
                }
              }
            }
          }
        }
      }
    }
    rx = cx; ry = cy; rz = cz;
  }
  // The far field: the expansions of the nearest far cells' centres (four, eight in three dimensions), each
  // carried to the node, blended by the node's position between them — continuous across cell boundaries, so
  // nothing settles on the grid's lines.
  let farSide = i32(levelSide(L));
  let cellSize = 2.0 * half / f32(P.side) * f32(1u << L);
  let g = (p + half) / cellSize - 0.5;
  let b0 = vec3i(floor(g));
  let t = g - vec3f(b0);
  let zc = select(1, 2, three());
  for (var kz = 0; kz < zc; kz++) {
    for (var ky = 0; ky < 2; ky++) {
      for (var kx = 0; kx < 2; kx++) {
        let w = select(1.0 - t.x, t.x, kx == 1) * select(1.0 - t.y, t.y, ky == 1) * select(1.0, select(1.0 - t.z, t.z, kz == 1), three());
        if (w == 0.0) { continue; }
        let cc = clamp(b0 + vec3i(kx, ky, kz), vec3i(0), vec3i(farSide - 1));
        let c0 = cellIndex(L, cc.x, cc.y, select(0, cc.z, three())) - levelStart(L);
        let a = farRO[c0 * 3u]; let b = farRO[c0 * 3u + 1u]; let c = farRO[c0 * 3u + 2u];
        var o = p - (vec3f(-half) + (vec3f(cc) + 0.5) * cellSize);
        if (!three()) { o.z = 0.0; }
        f += w * (a.xyz + vec3f(a.w * o.x + b.z * o.y + b.w * o.z, b.z * o.x + b.x * o.y + c.x * o.z, b.w * o.x + c.x * o.y + b.y * o.z));
      }
    }
  }
  f *= P.repulsion;
  // Springs over the CSR.
  let start = offsets[i]; let end = offsets[i + 1u];
  let deg = f32(end - start);
  for (var k = start; k < end; k++) {
    let j = neighbors[k];
    if (!takesPart(j)) { continue; }
    var q = posr[j].xyz;
    if (!three()) { q.z = 0.0; }
    let d = q - pw;
    let len = length(d) + 1e-6;
    let degJ = f32(offsets[j + 1u] - offsets[j]);
    // The link's own strength (core/packed/physics.ts › linkSpring): the other hash of its ends.
    let w = P.linkStrength * (1.0 + P.extra.x * 2.0 * jitter(max(i, j), min(i, j))) / sqrt(min(deg, degJ));
    // The link's own rest length (core/packed/physics.ts › linkRest): the same hash of its ends as on the CPU.
    let rest = P.linkDistance * (1.0 + P.shift.w * 2.0 * jitter(min(i, j), max(i, j)));
    f += d * ((len - rest) * w / len);
  }
  // Gravity.
  f -= pw * P.gravity;
  // Integrate.
  var v = (vel[i].xyz + f) * P.damping;
  if (!three()) { v.z = 0.0; }
  let speed = length(v);
  // A force that is not a number moves nothing and is forgotten (as on the CPU).
  if (!finite(speed)) { vel[i] = vec4f(0.0); return; }
  let maxStep = P.maxStep * P.linkDistance;
  if (speed > maxStep) { v *= maxStep / speed; }
  vel[i] = vec4f(v, 0.0);
  let np = pw + v * P.alpha;
  posr[i] = vec4f(np.x, np.y, select(posr[i].z, np.z, three()), posr[i].w);
}
`
