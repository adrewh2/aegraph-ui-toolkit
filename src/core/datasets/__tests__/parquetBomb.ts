/**
 * A Parquet file written by hand, for the tests of what a file may claim: one REQUIRED BYTE_ARRAY column `a`, a
 * PLAIN dictionary page of one value `valueBytes` long, and an RLE_DICTIONARY data page whose single RLE run repeats
 * index 0 `pageValues` times — while the footer says the file holds `rows` rows. A few hundred bytes can claim
 * billions of values, or a value repeated down a hundred thousand rows.
 */
class Thrift {
  b: number[] = []
  last: number[] = [0]
  varint(n: bigint | number) {
    let v = BigInt(n)
    while (v >= 0x80n) {
      this.b.push(Number(v & 0x7fn) | 0x80)
      v >>= 7n
    }
    this.b.push(Number(v))
  }
  zz(n: number | bigint) {
    const v = BigInt(n)
    this.varint(v >= 0n ? v << 1n : (-v << 1n) - 1n)
  }
  field(id: number, type: number) {
    const d = id - this.last[this.last.length - 1]
    if (d > 0 && d <= 15) this.b.push((d << 4) | type)
    else {
      this.b.push(type)
      this.zz(id)
    }
    this.last[this.last.length - 1] = id
  }
  i32(id: number, v: number) {
    this.field(id, 5)
    this.zz(v)
  }
  i64(id: number, v: number) {
    this.field(id, 6)
    this.zz(v)
  }
  str(id: number, s: string) {
    this.field(id, 8)
    const e = Buffer.from(s)
    this.varint(e.length)
    this.b.push(...e)
  }
  struct(id: number, f: () => void) {
    this.field(id, 12)
    this.last.push(0)
    f()
    this.b.push(0)
    this.last.pop()
  }
  list(id: number, et: number, n: number, each: (i: number) => void) {
    this.field(id, 9)
    if (n < 15) this.b.push((n << 4) | et)
    else {
      this.b.push(0xf0 | et)
      this.varint(n)
    }
    for (let i = 0; i < n; i++) each(i)
  }
  element(f: () => void) {
    this.last.push(0)
    f()
    this.b.push(0)
    this.last.pop()
  }
  bytes() {
    return Buffer.from(this.b)
  }
}

export function parquetBomb(valueBytes: number, rows: number, pageValues = rows): Uint8Array {
  const value = Buffer.alloc(valueBytes, 0x41)
  const dictBody = Buffer.concat([Buffer.from(new Uint32Array([valueBytes]).buffer), value])
  const dh = new Thrift()
  dh.i32(1, 2)
  dh.i32(2, dictBody.length)
  dh.i32(3, dictBody.length)
  dh.struct(7, () => {
    dh.i32(1, 1)
    dh.i32(2, 0)
  })
  dh.b.push(0)
  const rle = new Thrift()
  rle.b.push(1)
  rle.varint(pageValues * 2)
  rle.b.push(0)
  const dataBody = rle.bytes()
  const ph = new Thrift()
  ph.i32(1, 0)
  ph.i32(2, dataBody.length)
  ph.i32(3, dataBody.length)
  ph.struct(5, () => {
    ph.i32(1, pageValues)
    ph.i32(2, 8)
    ph.i32(3, 3)
    ph.i32(4, 3)
  })
  ph.b.push(0)
  const magic = Buffer.from('PAR1')
  const dictOff = 4
  const dictPage = Buffer.concat([dh.bytes(), dictBody])
  const dataOff = dictOff + dictPage.length
  const dataPage = Buffer.concat([ph.bytes(), dataBody])
  const total = dictPage.length + dataPage.length
  const m = new Thrift()
  m.i32(1, 1)
  m.list(2, 12, 2, (i) =>
    m.element(() => {
      if (i === 0) {
        m.str(4, 'schema')
        m.i32(5, 1)
      } else {
        m.i32(1, 6)
        m.i32(3, 0)
        m.str(4, 'a')
      }
    }),
  )
  m.i64(3, rows)
  m.list(4, 12, 1, () =>
    m.element(() => {
      m.list(1, 12, 1, () =>
        m.element(() => {
          m.i64(2, dictOff)
          m.struct(3, () => {
            m.i32(1, 6)
            m.list(2, 5, 2, (i) => m.zz(i ? 8 : 0))
            m.list(3, 8, 1, () => {
              m.varint(1)
              m.b.push(0x61)
            })
            m.i32(4, 0)
            m.i64(5, rows)
            m.i64(6, 100)
            m.i64(7, total)
            m.i64(9, dataOff)
            m.i64(11, dictOff)
          })
        }),
      )
      m.i64(2, total)
      m.i64(3, rows)
    }),
  )
  m.b.push(0)
  const footer = m.bytes()
  return new Uint8Array(Buffer.concat([magic, dictPage, dataPage, footer, Buffer.from(new Uint32Array([footer.length]).buffer), magic]))
}
