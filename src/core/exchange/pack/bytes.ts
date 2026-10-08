/**
 * The byte-level tools of the packed format: a growable output buffer with
 * LEB128 varints, and a reader over a Uint8Array. Nothing here knows about
 * entities.
 */

export class ByteWriter {
  private buf: Uint8Array
  private view: DataView
  pos = 0

  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity)
    this.view = new DataView(this.buf.buffer)
  }

  /** Room for `n` more bytes. */
  ensure(n: number) {
    if (this.pos + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.pos + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  u8(v: number) {
    this.ensure(1)
    this.buf[this.pos++] = v
  }

  /** Unsigned LEB128, up to 2^53. */
  uvar(v: number) {
    this.ensure(8)
    while (v >= 0x80) {
      this.buf[this.pos++] = (v % 0x80) | 0x80
      v = Math.floor(v / 0x80)
    }
    this.buf[this.pos++] = v
  }

  /** Signed, zigzag-encoded varint. */
  svar(v: number) {
    this.uvar(v >= 0 ? v * 2 : -v * 2 - 1)
  }

  f64(v: number) {
    this.ensure(8)
    this.view.setFloat64(this.pos, v, true)
    this.pos += 8
  }

  bytes(b: Uint8Array) {
    this.ensure(b.length)
    this.buf.set(b, this.pos)
    this.pos += b.length
  }

  /** Reserve `n` bytes and return their offset, to be filled in later (a length prefix). */
  reserve(n: number): number {
    this.ensure(n)
    const at = this.pos
    this.pos += n
    return at
  }

  u32At(at: number, v: number) {
    this.view.setUint32(at, v, true)
  }

  /** Encode a string straight into the buffer; returns the byte length written. */
  utf8(s: string): number {
    // Worst case three bytes per UTF-16 unit.
    this.ensure(s.length * 3)
    const { written } = ENCODER.encodeInto(s, this.buf.subarray(this.pos))
    this.pos += written
    return written
  }

  /** The bytes written so far (a view, not a copy). */
  result(): Uint8Array {
    return this.buf.subarray(0, this.pos)
  }
}

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

export class ByteReader {
  pos = 0
  readonly buf: Uint8Array
  private view: DataView

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  /** Reading past the end is a truncated or corrupt pack: an error, never a silent NaN or a varint that loops forever. */
  need(n: number) {
    if (this.pos + n > this.buf.length) throw new Error(`Corrupt pack: unexpected end at ${this.pos} (wanted ${n} more of ${this.buf.length} bytes)`)
  }

  u8(): number {
    this.need(1)
    return this.buf[this.pos++]
  }

  uvar(): number {
    // One bounds check per varint, at the end, not one per byte: a read past the end gives `undefined`, which fails
    // `< 0x80` and so runs the loop until the position is past the buffer — where the check catches it. A million
    // entities are a few million varints; this is the decoder's innermost loop.
    const buf = this.buf
    let pos = this.pos
    let b = buf[pos++]
    if (b < 0x80) {
      this.pos = pos
      return b
    }
    let v = b & 0x7f
    let mul = 0x80
    for (;;) {
      b = buf[pos++]
      if (pos > buf.length) {
        this.pos = pos
        this.need(0)
      }
      v += (b & 0x7f) * mul
      if (b < 0x80) {
        this.pos = pos
        return v
      }
      mul *= 0x80
    }
  }

  svar(): number {
    const u = this.uvar()
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2
  }

  f64(): number {
    this.need(8)
    const v = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return v
  }

  u32(): number {
    this.need(4)
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  bytes(n: number): Uint8Array {
    this.need(n)
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  utf8(n: number): string {
    this.need(n)
    const s = DECODER.decode(this.buf.subarray(this.pos, this.pos + n))
    this.pos += n
    return s
  }

  get done() {
    return this.pos >= this.buf.length
  }
}

/**
 * A string table: every distinct string once, referenced by index. Written
 * as one UTF-8 block plus the strings' lengths in UTF-16 units, so the
 * reader decodes the block with a single TextDecoder call and slices —
 * far cheaper than one decode per string.
 */
export class StringTable {
  private index = new Map<string, number>()
  private list: string[] = []

  id(s: string): number {
    let i = this.index.get(s)
    if (i === undefined) {
      i = this.list.length
      this.index.set(s, i)
      this.list.push(s)
    }
    return i
  }

  get size() {
    return this.list.length
  }

  write(w: ByteWriter) {
    w.uvar(this.list.length)
    for (const s of this.list) w.uvar(s.length)
    const at = w.reserve(4)
    const start = w.pos
    // One block, one encode — the strings joined, not encoded one by one: an encoder call per string was a third
    // of writing a page of a city's worth of entities (their ids alone are that many strings).
    w.utf8(this.list.join(''))
    w.u32At(at, w.pos - start)
  }

  /**
   * The strings back, sliced from one decode of the block. V8 stores a string
   * one byte per character only when every character fits in Latin-1, and a
   * slice shares its parent's storage — so one em dash among two million
   * strings (a city's tree labels) made the whole block, and everything cut
   * from it, two bytes a character for as long as any entity lived: 60 MB
   * where 30 would do. When the block is not all ASCII, the ASCII strings are
   * joined into a block of their own and sliced from that, and only the few
   * others are decoded one by one.
   */
  static read(r: ByteReader): string[] {
    const n = r.uvar()
    // Every length is at least a byte: a count the rest of the file cannot hold is refused before anything is sized by it.
    if (n > r.buf.length - r.pos) throw new Error(`Corrupt pack: a string table of ${n} strings in ${r.buf.length - r.pos} bytes`)
    const lengths = new Array<number>(n)
    // A UTF-16 unit takes at least one byte of UTF-8, so the lengths together cannot pass the block's bytes.
    let total = 0
    for (let i = 0; i < n; i++) {
      lengths[i] = r.uvar()
      total += lengths[i]
    }
    const bytes = r.u32()
    r.need(bytes)
    if (total > bytes) throw new Error('Corrupt pack: the string table is shorter than its lengths say')
    const src = r.buf.subarray(r.pos, r.pos + bytes)
    r.pos += bytes
    let ascii = true
    for (let i = 0; i < src.length; i++)
      if (src[i] >= 0x80) {
        ascii = false
        break
      }
    const out = new Array<string>(n)
    if (ascii) {
      const all = DECODER.decode(src)
      let at = 0
      for (let i = 0; i < n; i++) {
        const len = lengths[i]
        out[i] = len === 0 ? '' : all.substring(at, at + len)
        at += len
      }
      return out
    }
    // Each string's bytes found by walking UTF-8 (a 4-byte sequence is two UTF-16 units); ASCII ones copied together.
    const plain = new Uint8Array(bytes)
    const plainAt = new Int32Array(n).fill(-1)
    let used = 0
    let p = 0
    for (let i = 0; i < n; i++) {
      const len = lengths[i]
      if (len === 0) {
        out[i] = ''
        continue
      }
      let q = p
      let units = 0
      let isAscii = true
      while (units < len) {
        // Checked as it walks: past the block, a length from the file would otherwise be counted out unit by unit.
        if (q >= src.length) throw new Error('Corrupt pack: the string table is shorter than its lengths say')
        const b = src[q]
        if (b < 0x80) {
          q++
          units++
        } else {
          isAscii = false
          const seq = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2
          q += seq
          units += seq === 4 ? 2 : 1
        }
      }
      if (isAscii) {
        plain.set(src.subarray(p, q), used)
        plainAt[i] = used
        used += len
      } else out[i] = DECODER.decode(src.subarray(p, q))
      p = q
      if (p > src.length) throw new Error('Corrupt pack: the string table is shorter than its lengths say')
    }
    const joined = DECODER.decode(plain.subarray(0, used))
    for (let i = 0; i < n; i++) if (plainAt[i] >= 0) out[i] = joined.substring(plainAt[i], plainAt[i] + lengths[i])
    return out
  }
}
