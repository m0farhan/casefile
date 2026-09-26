// ZIP fixtures built byte by byte, for any test that needs a real archive to
// read. They live outside src/ so they are neither bundled into the plugin nor
// counted in its coverage.

const enc = new TextEncoder()

/** A fixed-size header, written field by field — the same way the reader reads it back. */
export function header(size: number, fill: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size)
  fill(new DataView(bytes.buffer))
  return bytes
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export interface Part {
  name: string
  data: Uint8Array
  /** 0 stored, 8 deflate, anything else to exercise the naming. */
  method?: number
  /** General purpose flags — bit 0 is the encrypted bit. */
  flags?: number
  /** Declared uncompressed size, when it should differ from the payload length. */
  size?: number
  /** Declared compressed size in the central directory, when it should differ from the payload length. */
  compressed?: number
}

/** A real ZIP, assembled byte by byte: local headers, payloads, central directory, EOCD. */
export function zip(parts: Part[], comment = ''): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const part of parts) {
    const name = enc.encode(part.name)
    const method = part.method ?? 0
    const flags = part.flags ?? 0
    const size = part.size ?? part.data.length
    const local = header(30, (v) => {
      v.setUint32(0, 0x04034b50, true)
      v.setUint16(4, 20, true)
      v.setUint16(6, flags, true)
      v.setUint16(8, method, true)
      v.setUint32(18, part.data.length, true)
      v.setUint32(22, size, true)
      v.setUint16(26, name.length, true)
    })
    const central = header(46, (v) => {
      v.setUint32(0, 0x02014b50, true)
      v.setUint16(6, 20, true)
      v.setUint16(8, flags, true)
      v.setUint16(10, method, true)
      v.setUint32(20, part.compressed ?? part.data.length, true)
      v.setUint32(24, size, true)
      v.setUint16(28, name.length, true)
      v.setUint32(42, offset, true)
    })
    locals.push(local, name, part.data)
    centrals.push(central, name)
    offset += local.length + name.length + part.data.length
  }
  const directory = concat(centrals)
  const commentBytes = enc.encode(comment)
  const eocd = header(22, (v) => {
    v.setUint32(0, 0x06054b50, true)
    v.setUint16(8, parts.length, true)
    v.setUint16(10, parts.length, true)
    v.setUint32(12, directory.length, true)
    v.setUint32(16, offset, true)
    v.setUint16(20, commentBytes.length, true)
  })
  return concat([...locals, directory, eocd, commentBytes])
}

/**
 * Put bytes INSIDE the central directory, after the last entry record, and
 * count them in cdSize. Legal: APPNOTE 4.3.13 puts the archive-signature
 * record there, and writers pad — so cdSize covering bytes the entry walk does
 * not consume is an ordinary complete archive, not a short listing.
 */
export function padCentralDirectory(bytes: Uint8Array, extra: Uint8Array): Uint8Array {
  const out = concat([bytes.subarray(0, bytes.length - 22), extra, bytes.subarray(bytes.length - 22)])
  const eocd = new DataView(out.buffer, out.length - 22)
  eocd.setUint32(12, eocd.getUint32(12, true) + extra.length, true)
  return out
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  void (async () => {
    await writer.write(new Uint8Array(data))
    await writer.close()
  })()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}
