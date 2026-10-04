// PDF fixtures built byte by byte, for any test that needs a real file to read.
// They live outside src/ so they are neither bundled into the plugin nor
// counted in its coverage, which is also why Node's zlib is fine here.

/**
 * Node's built-ins, reached at run time rather than imported. The project
 * type-checks without Node's types, which is what stops src/ leaning on them by
 * accident, and an import here would need those types for the whole program.
 */
interface Builtins {
  getBuiltinModule(id: 'node:zlib'): {
    deflateSync(data: Uint8Array): Uint8Array
    inflateRawSync(
      data: Uint8Array,
      opts: { info: true; finishFlush?: number }
    ): { buffer: Uint8Array; engine: { bytesWritten: number } }
    constants: { Z_SYNC_FLUSH: number }
  }
  getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL): Uint8Array }
  getBuiltinModule(id: 'node:v8'): { setFlagsFromString(flags: string): void }
  getBuiltinModule(id: 'node:vm'): { runInNewContext(code: string): unknown }
  memoryUsage(): { heapUsed: number }
}
const node = (globalThis as unknown as { process: Builtins }).process

/** Strings as one byte per character (latin1, masked), concatenated with any binary parts. */
export function bytes(...parts: (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? Uint8Array.from(p, (c) => c.charCodeAt(0) & 0xff) : p))
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** A zlib stream (header, deflate body, Adler-32), which is what /FlateDecode holds. */
export function zlib(data: string | Uint8Array): Uint8Array {
  return new Uint8Array(node.getBuiltinModule('node:zlib').deflateSync(typeof data === 'string' ? bytes(data) : data))
}

export interface Obj {
  num: number
  /** The object's value; for a stream, a dictionary whose final `>>` gets /Length (and /Filter) written in. */
  body: string
  stream?: string | Uint8Array
  /** Deflate the stream data and declare /FlateDecode. */
  flate?: boolean
  /** Written verbatim instead of `n 0 obj … endobj`; the xref still points at where it starts. */
  raw?: string
}

export interface BuildOptions {
  root?: number
  /** Extra entries written inside the trailer dictionary (or the xref stream's). */
  trailer?: string
  header?: string
  /** Junk in front of the header; offsets are then counted from the header, as Acrobat does. */
  prefix?: string
  xrefStream?: boolean
  noStartxref?: boolean
  tail?: string
}

function objectBytes(o: Obj): Uint8Array {
  if (o.raw !== undefined) return bytes(o.raw)
  if (o.stream === undefined) return bytes(`${o.num} 0 obj\n${o.body}\nendobj\n`)
  const data = o.flate ? zlib(o.stream) : typeof o.stream === 'string' ? bytes(o.stream) : o.stream
  const close = o.body.lastIndexOf('>>')
  const dict = `${o.body.slice(0, close)} /Length ${data.length}${o.flate ? ' /Filter /FlateDecode' : ''} >>${o.body.slice(close + 2)}`
  return bytes(`${o.num} 0 obj\n${dict}\nstream\n`, data, '\nendstream\nendobj\n')
}

/**
 * A whole file: prefix, header, objects, then a classic xref table and trailer
 * whose offsets are real — or, with xrefStream, an /XRef stream object standing
 * in for both — then startxref, %%EOF and the tail.
 *
 * Offsets are counted from the %PDF header, which is byte 0 unless a prefix is
 * given: that is how a reader locates objects in a file with junk in front.
 */
export function buildPdf(objects: Obj[], opts: BuildOptions = {}): Uint8Array {
  const root = opts.root ?? 1
  const extra = opts.trailer ?? ''
  const parts: Uint8Array[] = [bytes(`${opts.header ?? '%PDF-1.7'}\n`)]
  const offsets = new Map<number, number>()
  let at = parts[0].length
  let size = 1
  for (const o of objects) {
    const b = objectBytes(o)
    offsets.set(o.num, at)
    parts.push(b)
    at += b.length
    size = Math.max(size, o.num + 1)
  }
  let tail: string
  if (opts.xrefStream) {
    const num = size
    offsets.set(num, at)
    const xref = objectBytes({
      num,
      body: `<< /Type /XRef /Size ${num + 1} /Root ${root} 0 R /W [1 4 2] ${extra} >>`,
      stream: ''
    })
    parts.push(xref)
    tail = ''
  } else {
    const rows = ['xref', `0 ${size}`, '0000000000 65535 f ']
    for (let n = 1; n < size; n++) {
      const off = offsets.get(n)
      rows.push(off === undefined ? '0000000000 65535 f ' : `${String(off).padStart(10, '0')} 00000 n `)
    }
    tail = `${rows.join('\n')}\ntrailer\n<< /Size ${size} /Root ${root} 0 R ${extra} >>\n`
  }
  const xrefAt = opts.xrefStream ? (offsets.get(size) ?? 0) : at
  tail += opts.noStartxref ? '%%EOF\n' : `startxref\n${xrefAt}\n%%EOF\n`
  return bytes(opts.prefix ?? '', ...parts, tail, opts.tail ?? '')
}

/** An object stream holding `members`, with the /N and /First its header needs. */
export function objStm(num: number, members: { num: number; body: string }[], flate = true): Obj {
  let pairs = ''
  let data = ''
  for (const m of members) {
    pairs += `${m.num} ${data.length} `
    data += `${m.body}\n`
  }
  return { num, body: `<< /Type /ObjStm /N ${members.length} /First ${pairs.length} >>`, stream: pairs + data, flate }
}

export interface OnePageOptions {
  fonts?: string
  extra?: Obj[]
  pageExtra?: string
  xrefStream?: boolean
}

const HELVETICA = '<< /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> >>'

/** Catalog 1, pages 2, page 3, content 4 (deflated); `extra` objects number from 5. */
export function onePage(content: string, opts: OnePageOptions = {}): Uint8Array {
  return buildPdf(
    [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        num: 3,
        body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font ${opts.fonts ?? HELVETICA} >> /Contents 4 0 R ${opts.pageExtra ?? ''} >>`
      },
      { num: 4, body: '<< >>', stream: content, flate: true },
      ...(opts.extra ?? [])
    ],
    { xrefStream: opts.xrefStream }
  )
}

/** A real PDF from test/fixtures/pdf, as its bytes. */
export function fixture(name: string): Uint8Array {
  return new Uint8Array(node.getBuiltinModule('node:fs').readFileSync(new URL(`fixtures/pdf/${name}`, import.meta.url)))
}

/**
 * DecompressionStream('deflate-raw') as Chromium 151 to 154 behave on bytes
 * past the end of the stream, which Node's does not: the write carrying them
 * fails, and the output that write made is lost with it. (Chromium loses what
 * it had queued and not yet handed over; losing all of it is the worst case.)
 * Every other write's output comes out as it goes in.
 *
 * ponytail: the whole input so far is inflated again on every write, which
 * keeps the model plain and makes it quadratic, so keep its inputs to a few KB.
 */
class ChromiumInflate extends TransformStream<Uint8Array, Uint8Array> {
  constructor() {
    const zlib = node.getBuiltinModule('node:zlib')
    let seen: Uint8Array = new Uint8Array(0)
    let made = 0
    super({
      transform(chunk, controller) {
        seen = bytes(seen, chunk)
        const r = zlib.inflateRawSync(seen, { info: true, finishFlush: zlib.constants.Z_SYNC_FLUSH })
        if (r.engine.bytesWritten < seen.length) throw new TypeError('Junk found after end of compressed data.')
        controller.enqueue(r.buffer.subarray(made))
        made = r.buffer.length
      },
      flush() {
        // Throws on a stream that never reached its end, as a real decompressor does.
        zlib.inflateRawSync(seen, { info: true })
      }
    })
  }
}

/**
 * What ChromiumInflate hands over from `body`, a raw deflate stream with junk
 * right after it, written in 1 KiB pieces: every piece's output but that of
 * the piece the junk starts in. It is the same on every run, which is what lets
 * a file write the size or checksum of it.
 */
export function keptByChromium(body: Uint8Array): Uint8Array {
  const zlib = node.getBuiltinModule('node:zlib')
  const start = Math.floor(body.length / 1024) * 1024
  const r = zlib.inflateRawSync(body.subarray(0, start), { info: true, finishFlush: zlib.constants.Z_SYNC_FLUSH })
  return new Uint8Array(r.buffer)
}

/**
 * `run`, with DecompressionStream counted: `passes` is how many were opened,
 * one per inflate pass. With `chromium` each is a ChromiumInflate.
 */
export async function inflating<T>(run: () => Promise<T>, chromium = false): Promise<{ value: T; passes: number }> {
  const saved = globalThis.DecompressionStream
  let passes = 0
  const counted = new Proxy(chromium ? ChromiumInflate : saved, {
    construct(target, args) {
      passes++
      return Reflect.construct(target, args) as object
    }
  })
  const install = (value: unknown): void => {
    Object.defineProperty(globalThis, 'DecompressionStream', { value, configurable: true, writable: true })
  }
  install(counted)
  try {
    return { value: await run(), passes }
  } finally {
    install(saved)
  }
}

/**
 * Heap bytes still held, after a full collection, by what `make` returns.
 * Node's gc is switched on at run time and reached through a new context,
 * since no flag reaches the test worker from here.
 */
export async function heapHeld<T>(make: () => T | Promise<T>): Promise<{ held: number; value: T }> {
  node.getBuiltinModule('node:v8').setFlagsFromString('--expose-gc')
  const gc = node.getBuiltinModule('node:vm').runInNewContext('gc') as () => void
  gc()
  const before = node.memoryUsage().heapUsed
  const value = await make()
  gc()
  return { held: node.memoryUsage().heapUsed - before, value }
}
