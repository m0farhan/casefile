/**
 * MD5, hand-written, because WebCrypto does not implement it.
 *
 * Not for security — MD5 is broken for that and nothing here treats it as a
 * guarantee. It is here because a large part of the malware-lookup world is
 * still keyed on it: MalwareBazaar, a lot of vendor reports, and PhishTool's
 * own attachment model all carry md5 beside sha1 and sha256, and an analyst
 * who has to re-hash a file elsewhere to paste it into a lookup has been given
 * two of the three answers.
 *
 * RFC 1321. Verified against that document's own test vectors in md5.test.ts;
 * a hash that is subtly wrong is worse than no hash at all, because it looks
 * like an answer.
 */

const S = Uint8Array.from([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
  11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
])

/**
 * K[i] = floor(2^32 × abs(sin(i + 1))), precomputed as RFC 1321 specifies.
 * Stored as signed 32-bit, which keeps the same 32 bits, so every sum below
 * stays in the integer arithmetic V8 compiles well.
 */
const K = new Int32Array(64)
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)

/** Which message word each of the 64 steps reads, per RFC 1321's four rounds. */
const G = new Uint8Array(64)
for (let i = 0; i < 64; i++) G[i] = i < 16 ? i : i < 32 ? (5 * i + 1) % 16 : i < 48 ? (3 * i + 5) % 16 : (7 * i) % 16

/**
 * The running state and the current block's 16 words. Module-level because
 * md5() is synchronous and nothing can run between its first block and its
 * last, so one set is enough and none is allocated per call.
 */
const st = new Int32Array(4)
const m = new Int32Array(16)

/**
 * One 64-byte block, read from `src` at `off`, folded into the state.
 *
 * A small function of its own, with `|0` arithmetic throughout, because that
 * is what V8 optimises: the same rounds written inline in one long function
 * with `>>> 0` took about six times as long on a 23MB file (about 380 ms
 * against 60 in node), and this runs over every byte of every attachment on
 * each re-analysis.
 */
function block(src: Uint8Array, off: number): void {
  for (let i = 0, o = off; i < 16; i++, o += 4) {
    m[i] = src[o] | (src[o + 1] << 8) | (src[o + 2] << 16) | (src[o + 3] << 24)
  }
  let a = st[0]
  let b = st[1]
  let c = st[2]
  let d = st[3]
  for (let i = 0; i < 64; i++) {
    let f: number
    if (i < 16) f = (b & c) | (~b & d)
    else if (i < 32) f = (d & b) | (~d & c)
    else if (i < 48) f = b ^ c ^ d
    else f = c ^ (b | ~d)
    const x = (a + f + K[i] + m[G[i]]) | 0
    const s = S[i]
    a = d
    d = c
    c = b
    b = (b + ((x << s) | (x >>> (32 - s)))) | 0
  }
  st[0] = (st[0] + a) | 0
  st[1] = (st[1] + b) | 0
  st[2] = (st[2] + c) | 0
  st[3] = (st[3] + d) | 0
}

/** Hex MD5 of the given bytes. */
export function md5(bytes: Uint8Array): string {
  st[0] = 0x67452301
  st[1] = 0xefcdab89
  st[2] = 0x98badcfe
  st[3] = 0x10325476

  // Every whole block is read where it lies; copying a 30MB attachment just
  // to pad its last few bytes would double the memory for nothing.
  const n = bytes.length
  const whole = n - (n % 64)
  for (let off = 0; off < whole; off += 64) block(bytes, off)

  // Padding: the rest of the message, a 1 bit, zeroes, then the length in
  // bits as a 64-bit little-endian integer — one block, or two when the rest
  // leaves no room for the length.
  const rest = n - whole
  const tail = new Uint8Array(rest < 56 ? 64 : 128)
  tail.set(bytes.subarray(whole))
  tail[rest] = 0x80
  const view = new DataView(tail.buffer)
  // Only the low 32 bits of the length are written as a number; the high word
  // is written separately so a file over 512MB still lengths correctly.
  view.setUint32(tail.length - 8, (n * 8) >>> 0, true)
  view.setUint32(tail.length - 4, Math.floor(n / 536870912) >>> 0, true)
  for (let off = 0; off < tail.length; off += 64) block(tail, off)

  const out = new DataView(new ArrayBuffer(16))
  for (let i = 0; i < 4; i++) out.setInt32(i * 4, st[i], true)
  return [...new Uint8Array(out.buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
