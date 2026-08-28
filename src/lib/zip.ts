/**
 * 极简 ZIP 打包器（仅 store 存储，不压缩）。
 * 用于在本应用内生成 EPUB / DOCX（二者本质都是 ZIP 包），零依赖。
 * 输出的字节结构符合 PKZIP 规范，主流阅读器 / Office 均可正常打开。
 */
function crc32(buf: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
  }
  return ~c >>> 0
}

export class ZipBuilder {
  private files: { name: string; data: Uint8Array; crc: number }[] = []
  private central: Uint8Array[] = []

  add(name: string, content: string | Uint8Array) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content
    this.files.push({ name, data, crc: crc32(data) })
  }

  build(): Uint8Array {
    const enc = new TextEncoder()
    const chunks: Uint8Array[] = []
    let offset = 0
    for (const f of this.files) {
      const nameBytes = enc.encode(f.name)
      const local = new Uint8Array(30 + nameBytes.length)
      const dv = new DataView(local.buffer)
      dv.setUint32(0, 0x04034b50, true)   // local file header sig
      dv.setUint16(4, 20, true)            // version needed
      dv.setUint16(6, 0, true)             // flags
      dv.setUint16(8, 0, true)             // method = store
      dv.setUint16(10, 0, true)            // mod time
      dv.setUint16(12, 0x21, true)         // mod date (1980-01-01)
      dv.setUint32(14, f.crc, true)
      dv.setUint32(18, f.data.length, true)
      dv.setUint32(22, f.data.length, true)
      dv.setUint16(26, nameBytes.length, true)
      dv.setUint16(28, 0, true)            // extra len
      local.set(nameBytes, 30)
      chunks.push(local, f.data)

      const cen = new Uint8Array(46 + nameBytes.length)
      const cd = new DataView(cen.buffer)
      cd.setUint32(0, 0x02014b50, true)    // central dir sig
      cd.setUint16(4, 20, true)            // version made by
      cd.setUint16(6, 20, true)            // version needed
      cd.setUint16(8, 0, true)
      cd.setUint16(10, 0, true)
      cd.setUint16(12, 0, true)
      cd.setUint16(14, 0x21, true)
      cd.setUint32(16, f.crc, true)
      cd.setUint32(20, f.data.length, true)
      cd.setUint32(24, f.data.length, true)
      cd.setUint16(28, nameBytes.length, true)
      cd.setUint16(30, 0, true)
      cd.setUint16(32, 0, true)
      cd.setUint16(34, 0, true)
      cd.setUint16(36, 0, true)
      cd.setUint32(38, 0, true)
      cd.setUint32(42, offset, true)
      cen.set(nameBytes, 46)
      this.central.push(cen)

      offset += local.length + f.data.length
    }

    const centralBytes = concat(this.central)
    const cdOffset = offset
    const cdSize = centralBytes.length
    const end = new Uint8Array(22)
    const ed = new DataView(end.buffer)
    ed.setUint32(0, 0x06054b50, true)      // end of central dir sig
    ed.setUint16(4, 0, true)
    ed.setUint16(6, 0, true)
    ed.setUint16(8, this.files.length, true)
    ed.setUint16(10, this.files.length, true)
    ed.setUint32(12, cdSize, true)
    ed.setUint32(16, cdOffset, true)
    ed.setUint16(20, 0, true)

    return concat([...chunks, centralBytes, end])
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let p = 0
  for (const part of parts) { out.set(part, p); p += part.length }
  return out
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
