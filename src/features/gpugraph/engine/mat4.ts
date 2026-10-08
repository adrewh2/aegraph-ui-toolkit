/** The few 4×4 matrix operations the cameras need, column-major like the GPU expects, writing into caller-owned arrays. */
export type Mat4 = Float32Array

export function identity(out: Mat4): Mat4 {
  out.fill(0)
  out[0] = out[5] = out[10] = out[15] = 1
  return out
}

/** Orthographic projection of a 2D camera: world (x, y) → clip, y up, z ignored. */
export function ortho2d(out: Mat4, cx: number, cy: number, scale: number, width: number, height: number): Mat4 {
  identity(out)
  out[0] = (2 * scale) / width
  out[5] = (2 * scale) / height
  out[10] = 0
  out[12] = (-cx * 2 * scale) / width
  out[13] = (-cy * 2 * scale) / height
  return out
}

export function perspective(out: Mat4, fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2)
  out.fill(0)
  out[0] = f / aspect
  out[5] = f
  out[10] = (far + near) / (near - far)
  out[11] = -1
  out[14] = (2 * far * near) / (near - far)
  return out
}

export function lookAt(out: Mat4, ex: number, ey: number, ez: number, tx: number, ty: number, tz: number, ux: number, uy: number, uz: number): Mat4 {
  let zx = ex - tx, zy = ey - ty, zz = ez - tz
  let len = Math.hypot(zx, zy, zz) || 1
  zx /= len
  zy /= len
  zz /= len
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx
  len = Math.hypot(xx, xy, xz) || 1
  xx /= len
  xy /= len
  xz /= len
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx
  out[0] = xx
  out[1] = yx
  out[2] = zx
  out[3] = 0
  out[4] = xy
  out[5] = yy
  out[6] = zy
  out[7] = 0
  out[8] = xz
  out[9] = yz
  out[10] = zz
  out[11] = 0
  out[12] = -(xx * ex + xy * ey + xz * ez)
  out[13] = -(yx * ex + yy * ey + yz * ez)
  out[14] = -(zx * ex + zy * ey + zz * ez)
  out[15] = 1
  return out
}

export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3]
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
  }
  return out
}

/** Transform a point; returns clip w (≤ 0 means behind the camera) and writes x, y in NDC to out[0..1], depth to out[2]. */
export function project(m: Mat4, x: number, y: number, z: number, out: Float32Array): number {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14]
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
  const inv = cw !== 0 ? 1 / cw : 0
  out[0] = cx * inv
  out[1] = cy * inv
  out[2] = cz * inv
  return cw
}
